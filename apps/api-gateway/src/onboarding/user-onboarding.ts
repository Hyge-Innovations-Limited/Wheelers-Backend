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
import { pouchNameParts, type PouchLiquifiaClient } from '@wheleers/pouch-client';
import type { GatewayPublisher } from '../websocket/publisher';

export interface UserOnboardingDeps {
  publisher: GatewayPublisher;
  pouchLiquifiaClient: PouchLiquifiaClient;
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

export async function provisionPouchAccount(
  pouch: PouchLiquifiaClient,
  userId: string,
  name: string | undefined,
  phone?: string,
): Promise<void> {
  const existingVirtualAccount = await virtualAccountClient.findByUserId(userId);
  if (existingVirtualAccount) {
    return;
  }

  const user = await userClient.findById(userId);
  // The display name keeps its emoji; Pouch gets the letters-only version.
  const { firstName, lastName } = pouchNameParts(name ?? user.name);
  const contactPhone = phone ?? user.phone ?? undefined;
  const contactEmail = user.email ?? undefined;

  // Pouch refuses to open a virtual account for a customer with neither a
  // phone nor an email. Fail here, with a message that says so, instead of
  // creating a contact-less Pouch customer that the VA call then rejects.
  if (!contactPhone && !contactEmail) {
    throw new Error('NO_CONTACT_INFO: user has no phone or email; provisioning will run once a phone is verified');
  }

  let pouchCustomerId = user.pouchCustomerId ?? undefined;
  if (pouchCustomerId) {
    // The customer was created on an earlier attempt — possibly before the
    // user had any contact info. Patch it so the VA call below can succeed.
    const remote = await pouch.getCustomer(pouchCustomerId).catch(() => null);
    if (remote && !remote.phone_number && !remote.email) {
      await pouch.updateCustomer(pouchCustomerId, { email: contactEmail, phoneNumber: contactPhone });
    }
  } else {
    try {
      const customer = await pouch.createCustomer({
        customerReference: userId,
        firstName,
        lastName,
        phoneNumber: contactPhone,
        email: contactEmail,
      });
      pouchCustomerId = customer.id;
    } catch (error) {
      // If customer already exists on Pouch, fetch by reference
      const isDuplicate = error instanceof Error && error.message.includes('DUPLICATE_CUSTOMER_REFERENCE');
      if (!isDuplicate) throw error;

      const existing = await pouch.findCustomerByReference(userId);
      if (!existing) throw error;
      pouchCustomerId = existing.id;

      // Patch missing contact info so virtual account creation succeeds
      const needsEmail = !existing.email && contactEmail;
      const needsPhone = !existing.phone_number && contactPhone;
      if (needsEmail || needsPhone) {
        await pouch.updateCustomer(pouchCustomerId, {
          email: needsEmail ? contactEmail : undefined,
          phoneNumber: needsPhone ? contactPhone : undefined,
        });
      }
    }

    await userClient.updatePouchCustomerId(userId, pouchCustomerId);
  }

  const va = await pouch.createVirtualAccount(pouchCustomerId, {
    country: 'NG',
    currency: 'NGN',
    idempotencyKey: `va-provision-${userId}`,
  });

  await virtualAccountClient.create({
    userId,
    pouchCustomerId,
    pouchVirtualAccountId: va.id,
    bankName: va.bank_name,
    accountNumber: va.account_number,
    accountName: va.account_name,
    currency: va.currency,
    country: va.country,
  }).catch((error) => {
    if (isUniqueConstraintError(error)) {
      return;
    }

    throw error;
  });

  console.info('[onboarding] pouch provisioning complete', {
    userId,
    pouchCustomerId,
    accountNumber: va.account_number,
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

    void provisionPouchAccount(
      params.deps.pouchLiquifiaClient,
      existing.id,
      existing.name ?? name,
      existing.phone ?? params.phone,
    ).catch((error) => {
      console.warn('[onboarding] pouch repair failed (non-blocking)', {
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

  void provisionPouchAccount(
    params.deps.pouchLiquifiaClient,
    created.id,
    created.name ?? undefined,
    created.phone ?? undefined,
  ).catch((error) => {
    console.warn('[onboarding] pouch provisioning failed (non-blocking)', {
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
