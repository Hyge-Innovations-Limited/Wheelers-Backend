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
| Deposit of ₦A, Paystack keeps ₦P | User is credited ₦A − 20. Wheelers keeps a flat **₦20**. Paystack's cut ₦P comes out of the platform wallet. | `DEPOSIT` credit (user), `PLATFORM_FEE` credit (platform), `PROVIDER_FEE` debit (platform) |
| Withdrawal of ₦W | User is debited ₦W. No Wheelers fee, no minimum beyond ₦50. Paystack's transfer fee (₦10 / ₦25 / ₦50) comes out of the platform wallet at settlement. | `WITHDRAWAL` debit (user), `PROVIDER_FEE` debit (platform) |

`DEPOSIT_PROVIDER_FEE_PAID_BY=user` makes the depositor carry Paystack's cut
as well, so Wheelers always nets exactly ₦20. The default (`platform`) means a
large deposit can cost Wheelers more than it earns: Paystack takes about 1%
(capped), so a ₦10,000 deposit earns ₦20 and costs ₦100. The platform wallet is
allowed to go negative so the books say so honestly.

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
| `DEPOSIT_PROVIDER_FEE_PAID_BY` | `platform` (default) or `user`. |
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

## Tests

| Command | Needs |
| --- | --- |
| `npm run test:payments` | `DATABASE_URL` for the end-to-end ledger test; the unit tests need nothing. |
| `PAYSTACK_SECRET_KEY=sk_test_… npm run test:payments:live` | A test key. Talks to Paystack's real test API; refuses a live key. |
