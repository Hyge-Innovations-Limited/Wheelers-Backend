import { userClient, virtualAccountClient, walletClient } from '@wheleers/db';
import { DEPOSIT_FEE_NOTICE } from '@wheleers/config';
import { createLocalAccessToken } from '../auth/local';
import { GroqClient, type GroqClientConfig } from './groq.client';
import { WHATSAPP_SYSTEM_PROMPT } from './whatsapp-system-prompt';
import { loadRiderMemory, rememberExchange, renderRiderMemory } from './rider-memory';
import type {
  LlmChatMessage,
  WhatsappBotUserContext,
  WhatsappConversationMessage,
} from './types';

export interface WhatsappBotConfig extends GroqClientConfig {
  jwtSecret: string;
  appBaseUrl?: string;
}

export interface WhatsappBotRequest {
  userId: string;
  phone: string;
  profileName?: string;
  incomingMessage: string;
  isNewUser: boolean;
  recentMessages: WhatsappConversationMessage[];
}

function cleanMessage(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 1_500);
}

function firstName(name: string | null | undefined, fallback: string): string {
  const normalized = name?.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return fallback;
  }

  return normalized.split(/\s+/)[0] ?? fallback;
}

function buildFallbackReply(context: WhatsappBotUserContext): string {
  const name = firstName(context.name, context.phone);

  if (context.isNewUser) {
    return `Hi ${name}! Welcome to Wheelers 🚗\n\nNeed help booking a ride?`;
  }

  return `Hi ${name}! Need a ride? Where are you headed?`;
}

function buildContextMessage(context: WhatsappBotUserContext): string {
  const lines = [
    'Current Wheelers user context:',
    `- userId: ${context.userId}`,
    `- name: ${context.name ?? 'unknown'}`,
    `- phone: ${context.phone}`,
    `- new WhatsApp account this message: ${context.isNewUser ? 'yes' : 'no'}`,
    `- rider KYC status: ${context.riderKycStatus}`,
    `- fiat wallet exists: ${context.hasFiatWallet ? 'yes' : 'no'}`,
  ];

  if (context.walletBalanceNgn !== null) {
    lines.push(`- wallet balance: ₦${context.walletBalanceNgn.toLocaleString()}`);
  }

  lines.push(`- virtual account exists: ${context.hasVirtualAccount ? 'yes' : 'no'}`);

  if (context.virtualAccountDetails) {
    lines.push(`- virtual account for deposits (share when user asks to deposit/top up/fund wallet):`);
    lines.push(`  Bank: ${context.virtualAccountDetails.bankName}`);
    lines.push(`  Account Number: \`${context.virtualAccountDetails.accountNumber}\` (format with backticks so user can copy)`);
    lines.push(`  Account Name: ${context.virtualAccountDetails.accountName}`);
    if (DEPOSIT_FEE_NOTICE) {
      lines.push(`  Deposit charges: do NOT bring these up or itemise them. To add money, send the rider to the Add money page — it tells them the exact amount to send for what they want in their wallet. ONLY if they ask directly about charges, answer truthfully in one line: ${DEPOSIT_FEE_NOTICE}`);
    }
  }

  if (context.riderKycStatus !== 'VERIFIED' && context.kycLink) {
    lines.push(`- KYC verification link (only share if the user asks about KYC/verification): ${context.kycLink}`);
  }

  lines.push('');
  lines.push('KYC is optional. Do NOT push verification unless the user asks about it.');
  lines.push('Use this context to answer, but do not reveal internal IDs.');
  return lines.join('\n');
}

function clampWhatsappReply(reply: string): string {
  const trimmed = reply.trim();
  if (trimmed.length <= 1_500) {
    return trimmed;
  }

  return `${trimmed.slice(0, 1_497).trim()}...`;
}

export class WhatsappBotService {
  private readonly groq: GroqClient;
  private readonly jwtSecret: string;
  private readonly appBaseUrl: string | undefined;

  constructor(config: WhatsappBotConfig) {
    this.groq = new GroqClient(config);
    this.jwtSecret = config.jwtSecret;
    this.appBaseUrl = config.appBaseUrl;
  }

  private buildKycLink(userId: string): string | null {
    if (!this.appBaseUrl) return null;
    const token = createLocalAccessToken(userId, this.jwtSecret);
    return `${this.appBaseUrl}/widget/index.html?token=${token}&apiBase=${this.appBaseUrl}`;
  }

  async generateReply(request: WhatsappBotRequest): Promise<string> {
    const [user, virtualAccount, wallet, memory] = await Promise.all([
      userClient.findById(request.userId),
      virtualAccountClient.findByUserId(request.userId),
      walletClient.findByUserId(request.userId),
      loadRiderMemory(request.userId).catch(() => null),
    ]);
    const kycStatus = String(user.riderKycStatus ?? 'NONE');
    const context: WhatsappBotUserContext = {
      userId: request.userId,
      name: user.name ?? request.profileName ?? null,
      phone: request.phone,
      isNewUser: request.isNewUser,
      riderKycStatus: kycStatus,
      hasFiatWallet: Boolean(wallet),
      walletBalanceNgn: wallet ? Number(wallet.balanceNgn) : null,
      hasVirtualAccount: Boolean(virtualAccount),
      virtualAccountDetails: virtualAccount ? {
        bankName: virtualAccount.bankName,
        accountNumber: virtualAccount.accountNumber,
        accountName: virtualAccount.accountName,
      } : null,
      kycLink: kycStatus !== 'VERIFIED' ? this.buildKycLink(request.userId) : null,
    };

    if (!this.groq.configured) {
      return buildFallbackReply(context);
    }

    const userMessage = cleanMessage(request.incomingMessage) || 'User sent an empty WhatsApp message.';
    // The durable transcript is longer than the Redis window; prefer it.
    const history = memory?.transcript?.length ? memory.transcript : request.recentMessages;
    const messages: LlmChatMessage[] = [
      { role: 'system', content: WHATSAPP_SYSTEM_PROMPT },
      { role: 'system', content: buildContextMessage(context) },
      ...(memory ? [{ role: 'system' as const, content: renderRiderMemory(memory) }] : []),
      ...history.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      { role: 'user', content: userMessage },
    ];

    try {
      const reply = await this.groq.complete(messages);
      const finalReply = reply ? clampWhatsappReply(reply) : buildFallbackReply(context);
      rememberExchange(this.groq, request.userId, request.incomingMessage, finalReply);
      return finalReply;
    } catch (error) {
      console.warn('[whatsapp] Groq reply failed', {
        userId: request.userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return buildFallbackReply(context);
    }
  }
}
