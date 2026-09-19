import { createHmac } from 'crypto';
import {
  CryptoWalletCreateRequestedEvent,
  UserCreatedEvent,
} from '@wheleers/kafka-schemas';
import {
  UserRole,
  userClient,
  virtualAccountClient,
  walletClient,
} from '@wheleers/db';
import { PaymentsApiError, bankNameParts, type PaymentsClient } from '@wheleers/payments';
import type { GatewayPublisher } from '../websocket/publisher';

export interface UserOnboardingDeps {
  publisher: GatewayPublisher;
  paymentsClient: PaymentsClient;
  jwtSecret: string;
}

export interface OnboardedUser {
  id: string;
  privyDid: string;
  name: string | null;
  phone: string | null;
  created: boolean;
}

export function buildWhatsappPrivyDid(phone: string): string {
  return `whatsapp:${phone}`;
}

export function normalizeOnboardingName(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > 80 ? trimmed.slice(0, 80).trim() : trimmed;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'P2002',
  );
}

function deriveCryptoWalletPassword(userId: string, jwtSecret: string): string {
  return createHmac('sha256', jwtSecret)
    .update(`wheelers:crypto-wallet:${userId}`)
    .digest('base64url');
}

async function ensureFiatWallet(userId: string): Promise<void> {
  await walletClient.create(userId).catch((error) => {
    if (isUniqueConstraintError(error)) {
      return;
    }

    throw error;
  });
}

/**
 * Give the user a bank account number they can fund their wallet through.
 * Safe to call any number of times: a live account short-circuits, and every
 * provider call underneath is idempotent (the customer is keyed by a synthetic
 * email derived from the user id, and a customer has exactly one account).
 *
 * The display name keeps its emoji; the provider only ever sees the
 * letters-only version.
 */
export async function provisionDepositAccount(
  payments: PaymentsClient,
  userId: string,
  name: string | undefined,
  phone?: string,
): Promise<void> {
  const existing = await virtualAccountClient.findByUserId(userId);
  if (existing) {
    return;
  }

  const user = await userClient.findById(userId);
  const { firstName, lastName } = bankNameParts(name ?? user.name);

  let customerId = user.providerCustomerId ?? undefined;
  if (!customerId) {
    const customer = await payments.createCustomer({
      customerReference: userId,
      firstName,
      lastName,
      phoneNumber: phone ?? user.phone ?? undefined,
    });
    customerId = customer.id;
    await userClient.updateProviderCustomerId(userId, customerId);
  }

  let account;
  try {
    account = await payments.createVirtualAccount(customerId);
  } catch (error) {
    // The provider may assign the account a moment later and announce it by
    // webhook (dedicatedaccount.assign.success), which saves it then.
    if (error instanceof PaymentsApiError && error.code === 'ACCOUNT_PENDING') {
      console.info('[onboarding] deposit account assignment pending', { userId, customerId });
      return;
    }
    throw error;
  }

  await virtualAccountClient.upsertForUser(userId, {
    providerCustomerId: customerId,
    providerAccountId: account.id,
    bankName: account.bank_name,
    accountNumber: account.account_number,
    accountName: account.account_name,
    currency: account.currency,
    country: account.country,
  });

  console.info('[onboarding] deposit account ready', {
    userId,
    customerId,
    bank: account.bank_name,
    accountNumber: account.account_number,
  });
}

async function requestCryptoWalletCreation(
  deps: Pick<UserOnboardingDeps, 'publisher' | 'jwtSecret'>,
  userId: string,
): Promise<void> {
  const event = CryptoWalletCreateRequestedEvent.parse({
    eventType: 'CRYPTO_WALLET_CREATE_REQUESTED',
    userId,
    password: deriveCryptoWalletPassword(userId, deps.jwtSecret),
    timestamp: new Date().toISOString(),
  });

  await deps.publisher.publishCryptoWalletEvent(event);
}

export async function onboardWhatsappUser(params: {
  phone: string;
  profileName?: string;
  deps: UserOnboardingDeps;
}): Promise<OnboardedUser> {
  const name = normalizeOnboardingName(params.profileName);
  const privyDid = buildWhatsappPrivyDid(params.phone);
  const existing = await userClient.findByPrivyDid(privyDid);
  if (existing) {
    await ensureFiatWallet(existing.id).catch((error) => {
      console.warn('[onboarding] wallet repair failed', {
        userId: existing.id,
        error: getErrorMessage(error),
      });
    });

    void provisionDepositAccount(
      params.deps.paymentsClient,
      existing.id,
      existing.name ?? name,
      existing.phone ?? params.phone,
    ).catch((error) => {
      console.warn('[onboarding] deposit account repair failed (non-blocking)', {
        userId: existing.id,
        error: getErrorMessage(error),
      });
    });

    return {
      id: existing.id,
      privyDid: existing.privyDid,
      name: existing.name,
      phone: existing.phone,
      created: false,
    };
  }

  let created;
  try {
    created = await userClient.create({
      privyDid,
      role: UserRole.RIDER,
      name,
      phone: params.phone,
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const racedUser = await userClient.findByPrivyDid(privyDid);
    if (!racedUser) {
      throw error;
    }

    return {
      id: racedUser.id,
      privyDid: racedUser.privyDid,
      name: racedUser.name,
      phone: racedUser.phone,
      created: false,
    };
  }

  const userCreatedEvent = UserCreatedEvent.parse({
    eventType: 'USER_CREATED',
    userId: created.id,
    privyDid: created.privyDid,
    role: UserRole.RIDER,
    name: created.name ?? undefined,
    authMethod: 'whatsapp',
    timestamp: new Date().toISOString(),
  });

  await params.deps.publisher.publishUserEvent(userCreatedEvent).catch((error) => {
    console.warn('[onboarding] user created event publish failed', {
      userId: created.id,
      error: getErrorMessage(error),
    });
  });

  await ensureFiatWallet(created.id).catch((error) => {
    console.warn('[onboarding] wallet creation failed', {
      userId: created.id,
      error: getErrorMessage(error),
    });
  });

  await requestCryptoWalletCreation(params.deps, created.id).catch((error) => {
    console.warn('[onboarding] crypto wallet request failed', {
      userId: created.id,
      error: getErrorMessage(error),
    });
  });

  void provisionDepositAccount(
    params.deps.paymentsClient,
    created.id,
    created.name ?? undefined,
    created.phone ?? undefined,
  ).catch((error) => {
    console.warn('[onboarding] deposit account provisioning failed (non-blocking)', {
      userId: created.id,
      error: getErrorMessage(error),
    });
  });

  return {
    id: created.id,
    privyDid: created.privyDid,
    name: created.name,
    phone: created.phone,
    created: true,
  };
}
