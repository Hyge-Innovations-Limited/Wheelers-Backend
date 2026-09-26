import { createWalletPageToken, DEPOSIT_PAGE_TOKEN_TTL_SECONDS, WALLET_PAGE_TOKEN_TTL_SECONDS, type WalletPageScope } from '../auth/local';
import { appendWhatsappConversation } from '../LLM/conversation-store';
import { MetaWhatsappRouteDeps } from './deps';
import { sendMetaLinkButton, sendWhatsappText } from './send';

/**
 * Money is handled on Wheelers' own page, not in the chat: bank details and a
 * PIN typed into WhatsApp would sit in the chat history for anyone holding the
 * phone. The link names one purpose and dies in 30 minutes; the token rides
 * in the #fragment, which browsers never send to a server or a referrer.
 */
export async function sendWalletPageButton(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  scope: WalletPageScope,
): Promise<void> {
  if (!deps.appBaseUrl) {
    await sendWhatsappText(deps, phone, incomingMessage, 'That is not available right now. Please try again shortly.');
    return;
  }
  const token = createWalletPageToken(user.id, scope, deps.jwtSecret, scope === 'deposit' ? DEPOSIT_PAGE_TOKEN_TTL_SECONDS : undefined);
  const url = `${deps.appBaseUrl.replace(/\/+$/, '')}/widget/wallet/${scope === 'deposit' ? 'deposit' : 'withdraw'}.html#t=${encodeURIComponent(token)}`;
  const body = scope === 'deposit'
    ? [
        '*Add money to your wallet*',
        '',
        'Tap below to get your Wheelers account number.',
        'Transfer from any bank app — it lands in your wallet by itself.',
      ].join('\n')
    : [
        '*Withdraw to your bank*',
        '',
        'Tap below, pick the amount and the account.',
        'Confirm with your wallet PIN and it is on its way.',
      ].join('\n');
  const minutes = (scope === 'deposit' ? DEPOSIT_PAGE_TOKEN_TTL_SECONDS : WALLET_PAGE_TOKEN_TTL_SECONDS) / 60;
  await sendMetaLinkButton(deps, phone, `${body}\n\n_This link is yours alone and works for ${minutes} minutes._`, scope === 'deposit' ? 'Add money' : 'Withdraw', url);
  await appendWhatsappConversation(deps.redisClient, phone, [
    { role: 'user', content: incomingMessage },
    { role: 'assistant', content: `[sent the ${scope} page button]` },
  ]);
}

/* ─── Group ride flow (plain chat — no Meta interactive flows) ─── */

