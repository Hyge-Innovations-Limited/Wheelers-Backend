# Payments (Paystack)

Wheelers holds a naira **ledger** in Postgres and uses Paystack for the two
moments real money crosses the boundary: a bank transfer **in**, and a bank
transfer **out**. Everything between — ride holds, driver earnings, fees,
refunds — is ledger-only.

## Money model

- Every user gets one **dedicated virtual account** (a real bank account
  number, Wema or Titan). Transfers into it pool in the single **Paystack
  balance**. There are no per-user cash balances at the provider.
- Withdrawals are **Paystack transfers** drawn from that same balance.
- Who owns what is the ledger's job. The invariant the system is built around:

  > sum of all wallet balances (users + platform) = Paystack balance

  Every provider fee is booked, so this holds to the kobo. `scripts/audit-money.mjs`
  reads the Paystack balance live and checks it.

## Fees

| Moment | What happens | Ledger rows |
| --- | --- | --- |
| Deposit of ₦A, Paystack keeps ₦P | User is credited ₦A − 20 − P. Wheelers keeps a flat **₦20** and always nets exactly that. | `DEPOSIT` credit (user), `PLATFORM_FEE` credit (platform) |
| Withdrawal of ₦W | User is debited ₦W. No Wheelers fee, no minimum beyond ₦50. Paystack's transfer fee (₦10 / ₦25 / ₦50) comes out of the platform wallet at settlement. | `WITHDRAWAL` debit (user), `PROVIDER_FEE` debit (platform) |

The depositor carries Paystack's cut (about 1%, capped) as well as the ₦20, so
a ₦10,000 deposit credits ₦9,880. `DEPOSIT_PROVIDER_FEE_PAID_BY=platform` makes
Wheelers absorb Paystack's cut instead: the user then loses only ₦20, and the
cut is booked as a `PROVIDER_FEE` debit on the platform wallet — which is
allowed to go negative, so the books say honestly when fees paid exceed fees
earned. Transfer fees on withdrawals are always absorbed that way.

## Flow

```
bank transfer ─► Paystack ─► POST /webhooks/paystack   (api-gateway)
                               verify HMAC-SHA512 signature
                               READ THE TRANSACTION BACK from Paystack
                               publish VIRTUAL_ACCOUNT_CREDITED
                             ─► wallet-service: split + credit, one DB transaction

withdraw ─► submitWithdrawal()  (app route and WhatsApp share it)
              check the Paystack float · reserve funds
              create transfer, reference = withdrawal request id
           ─► transfer.success / transfer.failed / transfer.reversed webhook
           ─► payment-service reconciler re-checks anything quiet for 10 min
```

Rules the code holds to:

1. **One reference.** A deposit is `data.reference`; a payout is our own
   withdrawal id. The ledger's unique key on that reference is the guard
   against double credit — Redis dedup is only a fast path.
2. **The webhook body is a hint.** Amount, fee and status are read back from
   Paystack before money moves.
3. **Release only when the transfer cannot exist.** A timeout keeps the money
   reserved; the reconciler asks Paystack by reference and settles or releases.

## Configuration

| Variable | Notes |
| --- | --- |
| `PAYSTACK_SECRET_KEY` | **Required** by api-gateway and payment-service. `sk_test_…` or `sk_live_…`. Also signs webhooks — there is no separate webhook secret. |
| `PAYSTACK_DVA_BANK` | `wema-bank` (default) or `titan-paystack`. Ignored on a test key, which always uses Paystack's `test-bank`. |
| `DEPOSIT_FEE_NGN` | Default `20`. |
| `DEPOSIT_PROVIDER_FEE_PAID_BY` | `user` (default) or `platform`. |
| `WITHDRAWAL_MIN_NGN` | Default `50`. |

In the Paystack dashboard:

- **Settings → API Keys & Webhooks → Webhook URL:** `https://app.wheelersng.com/webhooks/paystack`
- **Settings → Preferences → "Confirm transfers before sending": OFF.** While it
  is on, Paystack answers every transfer with `otp` and no withdrawal can
  complete. The code reports this loudly and releases the user's money. Never
  finalise such a transfer by hand afterwards — its funds were already released.

## Scripts

| Command | What it does |
| --- | --- |
| `node scripts/run-with-env.cjs node scripts/provision-deposit-accounts.mjs` | Dry run: who still needs a Paystack account. `--confirm` provisions them. Safe to re-run. |
| `node scripts/run-with-env.cjs node scripts/audit-money.mjs` | Replays every wallet and compares the whole ledger to the live Paystack balance. |
| `node scripts/run-with-env.cjs node scripts/reset-wallets.mjs` | **One-time, pre-launch.** Dry run by default. Rebuilds running totals, records any unexplained balance as an explicit `ADJUSTMENT` row, and zeroes every wallet (`--keep=<userId>,…` to carry some over). Refuses while money is in flight; snapshots to `logs/` first. |

## Tests

| Command | Needs |
| --- | --- |
| `npm run test:payments` | `DATABASE_URL` for the end-to-end ledger test; the unit tests need nothing. |
| `PAYSTACK_SECRET_KEY=sk_test_… npm run test:payments:live` | A test key. Talks to Paystack's real test API; refuses a live key. |

## Wallet pages and the PIN

Deposits and withdrawals from WhatsApp happen on two Wheelers-branded pages
(`apps/api-gateway/widget/wallet/`), opened inside WhatsApp from a button. The
bot no longer takes bank details in chat: anything typed there stays in the
chat history for whoever holds the phone.

- **Links** carry a token that names one purpose (`deposit` or `withdraw`),
  lives 15 minutes, and cannot be used as a login token. It rides in the URL
  `#fragment`, which browsers never send to a server or a referrer; the page
  wipes it from the address bar on load.
- **PIN**: 4 digits, scrypt-hashed, required for every withdrawal. The check
  lives inside `submitWithdrawal` and defaults to *required*, so no route can
  reach the money around it. The mobile app uses the transitional `if_set`
  policy until its PIN screens ship.
- **Guessing**: 5 wrong PINs lock withdrawals for 30 minutes. The count is on
  the account and incremented atomically, so neither a fresh link nor a burst
  of parallel guesses gets under it.
- **Forgot PIN**: with a verified recovery email, a code is emailed and there
  is no delay. Without one, the reset is allowed but made worthless to a
  thief: withdrawals pause 24 hours, then for 7 days money may only go to a
  bank account that user has been paid at before. The rider is told on
  WhatsApp and can reply **FREEZE** to lock withdrawals until support lifts it.
- **Admin**: `POST /admin/users/:id/withdrawals/freeze` and `…/unfreeze`.

## Capacity

| Command | What it answers |
| --- | --- |
| `node scripts/load-test.mjs` | How fast is each endpoint? GET-only, safe on live. |
| `node scripts/load-test.mjs --ramp` | How much traffic before it struggles? Stops itself at 2% errors or p95 > 3s. |
| `node scripts/run-with-env.cjs node scripts/db-capacity.mjs` | Will Postgres keep up? Connection pools vs `max_connections`, locks, cache, unindexed scans. Read-only. |
