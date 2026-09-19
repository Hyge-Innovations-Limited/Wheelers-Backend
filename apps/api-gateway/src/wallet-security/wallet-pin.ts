import { walletSecurityClient } from '@wheleers/db';
import { hashPassword, verifyPassword } from '../auth/local';

export const PIN_LENGTH = 4;
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCK_SECONDS = 30 * 60;
/** After a reset nobody could verify: no withdrawals at all for this long… */
export const RESET_FREEZE_SECONDS = 24 * 60 * 60;
/** …and for this long afterwards, only to a bank account already paid before. */
export const RESET_RESTRICTION_SECONDS = 7 * 24 * 60 * 60;

export type WalletSecurityErrorCode =
  | 'PIN_INVALID_FORMAT'
  | 'PIN_TOO_GUESSABLE'
  | 'PIN_NOT_SET'
  | 'PIN_ALREADY_SET'
  | 'PIN_REQUIRED'
  | 'PIN_WRONG'
  | 'PIN_LOCKED'
  | 'WITHDRAWALS_FROZEN'
  | 'DESTINATION_RESTRICTED';

/** A refusal whose message is written for the user and safe to show as-is. */
export class WalletSecurityError extends Error {
  constructor(
    message: string,
    readonly code: WalletSecurityErrorCode,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'WalletSecurityError';
  }
}

/** The PINs a thief tries first. Four digits leave little room, so these go. */
const GUESSABLE = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '0123', '1212', '2580']);

export function assertValidNewPin(pin: unknown): asserts pin is string {
  if (typeof pin !== 'string' || !new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) {
    throw new WalletSecurityError(`Your PIN must be exactly ${PIN_LENGTH} digits.`, 'PIN_INVALID_FORMAT');
  }
  if (GUESSABLE.has(pin)) {
    throw new WalletSecurityError('That PIN is too easy to guess. Pick a different one.', 'PIN_TOO_GUESSABLE');
  }
}

const minutesUntil = (when: Date) => Math.max(1, Math.ceil((when.getTime() - Date.now()) / 60_000));

function describeWait(when: Date): string {
  const minutes = minutesUntil(when);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hours`;
}

/** First PIN only. Replacing one goes through the reset flow and its rules. */
export async function setInitialPin(userId: string, pin: unknown): Promise<void> {
  assertValidNewPin(pin);
  const state = await walletSecurityClient.getState(userId);
  if (state.walletPinHash) {
    throw new WalletSecurityError('You already have a PIN. Use "Forgot PIN" to change it.', 'PIN_ALREADY_SET');
  }
  await walletSecurityClient.setPin(userId, await hashPassword(pin));
}

/**
 * Check a PIN, counting failures on the ACCOUNT. scrypt makes each check
 * deliberately slow (~50ms), which is fine: it only runs on a withdrawal or
 * a settings change, never on a page view.
 */
export async function verifyPin(userId: string, pin: unknown): Promise<void> {
  const state = await walletSecurityClient.getState(userId);
  if (!state.walletPinHash) {
    throw new WalletSecurityError('Set a wallet PIN first.', 'PIN_NOT_SET');
  }
  if (state.walletPinLockedUntil && state.walletPinLockedUntil > new Date()) {
    throw new WalletSecurityError(
      `Too many wrong PINs. Try again in ${describeWait(state.walletPinLockedUntil)}.`,
      'PIN_LOCKED',
      { lockedUntil: state.walletPinLockedUntil.toISOString() },
    );
  }
  if (typeof pin !== 'string' || pin.length === 0) {
    throw new WalletSecurityError('Enter your wallet PIN.', 'PIN_REQUIRED');
  }

  if (await verifyPassword(pin, state.walletPinHash)) {
    await walletSecurityClient.clearFailedAttempts(userId);
    return;
  }

  const failure = await walletSecurityClient.recordFailedAttempt(userId, PIN_MAX_ATTEMPTS, PIN_LOCK_SECONDS);
  if (failure.lockedUntil) {
    throw new WalletSecurityError(
      `Too many wrong PINs. Withdrawals are locked for ${Math.round(PIN_LOCK_SECONDS / 60)} minutes.`,
      'PIN_LOCKED',
      { lockedUntil: failure.lockedUntil.toISOString(), justLocked: true },
    );
  }
  const left = PIN_MAX_ATTEMPTS - failure.attempts;
  throw new WalletSecurityError(
    `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
    'PIN_WRONG',
    { attemptsLeft: left },
  );
}

export type PinPolicy =
  /** The PIN is mandatory; a user without one must set it first. */
  | 'required'
  /**
   * Transitional, for the mobile app until its PIN screens ship: a user who
   * HAS a PIN must give it; one who has none is let through as before.
   */
  | 'if_set';

/**
 * The single gate every withdrawal passes, called from inside the shared
 * withdrawal executor so no route can move money around it.
 */
export async function assertMayWithdraw(params: {
  userId: string;
  pin: unknown;
  policy: PinPolicy;
  bankCode: string;
  accountNumber: string;
}): Promise<void> {
  const state = await walletSecurityClient.getState(params.userId);
  const now = new Date();

  if (state.withdrawalsFrozenUntil && state.withdrawalsFrozenUntil > now) {
    throw new WalletSecurityError(
      state.withdrawalsFrozenReason === 'pin_reset'
        ? `For your safety, withdrawals are paused for ${describeWait(state.withdrawalsFrozenUntil)} after a PIN reset. Deposits and rides work as normal.`
        : 'Withdrawals are paused on your account. Contact Wheelers support to lift it.',
      'WITHDRAWALS_FROZEN',
      { frozenUntil: state.withdrawalsFrozenUntil.toISOString(), reason: state.withdrawalsFrozenReason },
    );
  }

  if (state.walletPinHash || params.policy === 'required') {
    await verifyPin(params.userId, params.pin);
  }

  if (state.withdrawalsRestrictedUntil && state.withdrawalsRestrictedUntil > now) {
    const known = await walletSecurityClient.hasWithdrawnTo(params.userId, params.bankCode, params.accountNumber);
    if (!known) {
      throw new WalletSecurityError(
        `After a PIN reset, money can only go to a bank account you have withdrawn to before. That lifts in ${describeWait(state.withdrawalsRestrictedUntil)}.`,
        'DESTINATION_RESTRICTED',
        { restrictedUntil: state.withdrawalsRestrictedUntil.toISOString() },
      );
    }
  }
}

/**
 * Replace a forgotten PIN.
 *
 * `verifiedByEmail` = the user proved control of their recovery email, a
 * second thing a phone thief is unlikely to hold — no delay. Otherwise the
 * only proof is the chat link, which a thief with the unlocked phone also has.
 * So an unverified reset is made WORTHLESS rather than hard: no withdrawals
 * for 24h, then a week of known destinations only. An honest user waits a
 * day; a thief gets nothing they can spend.
 */
export async function resetPin(
  userId: string,
  newPin: unknown,
  verifiedByEmail: boolean,
): Promise<{ frozenUntil: Date | null; restrictedUntil: Date | null }> {
  assertValidNewPin(newPin);
  await walletSecurityClient.setPin(userId, await hashPassword(newPin));
  if (verifiedByEmail) {
    return { frozenUntil: null, restrictedUntil: null };
  }

  const frozenUntil = new Date(Date.now() + RESET_FREEZE_SECONDS * 1000);
  const restrictedUntil = new Date(frozenUntil.getTime() + RESET_RESTRICTION_SECONDS * 1000);
  await walletSecurityClient.freezeWithdrawals(userId, frozenUntil, 'pin_reset');

  // "Known accounts only" needs a known account. Someone who has never been
  // paid out has none, and restricting them would lock them out for a week
  // with no way through — for them the 24h freeze is the whole protection.
  if (!(await walletSecurityClient.hasAnySettledWithdrawal(userId))) {
    return { frozenUntil, restrictedUntil: null };
  }
  await walletSecurityClient.restrictDestinations(userId, restrictedUntil);
  return { frozenUntil, restrictedUntil };
}
