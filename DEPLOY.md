# Deploying the server — full command list

Run these on the box, from the repo root (`~/Wheelers-Backend`), top to bottom.
The order matters: nothing serves traffic against a schema it does not
understand, and nothing builds before the packages it imports.

---

## 1. Pull

```bash
cd ~/Wheelers-Backend
git pull origin main
```

## 2. Install

```bash
npm ci --include=dev
```

**`--include=dev` matters.** If `NODE_ENV=production` is set in your shell, a
plain `npm ci` skips devDependencies and the build dies with `tsc: not found`.

If `prisma: not found` still appears, install the CLI at the version the client
is on:

```bash
npm install prisma@5.22.0 -w @wheleers/db
```

> **Never a bare `npx prisma`.** With nothing installed, npx fetches the newest
> published CLI (`prisma@8.0.0-rc`) against a `@prisma/client` on **5.22.0** — a
> CLI three majors ahead will not generate a usable client. If you must use npx,
> pin it: `npx prisma@5.22.0 …`.
>
> Prefer the npm scripts anyway: they run through `scripts/run-with-env.cjs`,
> which reads `.env` and supplies `DATABASE_URL`. A bare
> `npx prisma migrate deploy` has no database URL and fails.

## 3. Generate the Prisma client

```bash
npm run db:generate
```

## 4. Build — packages first, then apps

```bash
npm run build
```

That is `build:packages` then `build:apps`, in this order (the apps import the
built packages, so the order is not optional):

**Packages:** `config` → `kafka-schemas` → `kafka-client` → `db` →
`multi-chain-wallet` → `payments`

**Apps:** `group-ride` → `notification-worker` → `analytics-worker` →
`payment-service` → `ride-service` → `wallet-service` → `api-gateway` →
`whatsapp-gateway` → `mcp-server`

To rebuild one thing after a small fix:

```bash
npm -w @wheleers/db run build
npm -w @wheleers/api-gateway run build
```

## 5. Apply the database migrations

```bash
npm run db:migrate:deploy
```

**Three migrations are pending on this release:**

| Migration | What it does |
| --- | --- |
| `20260826180000_add_safety_alerts` | The `SafetyAlert` table behind the emergency button |
| `20260826205000_interstate_booking_status_values` | Adds `PENDING_OFFER` / `OFFER_DECLINED` booking states |
| `20260826210000_interstate_bidding` | Adds the offer columns and backfills existing bookings |

The two interstate ones are split deliberately: Postgres refuses to use a new
enum value in the same transaction that created it, and Prisma runs each
migration file in one transaction. **Do not merge them back together.**

Confirm every one applied before restarting anything:

```bash
npx prisma@5.22.0 migrate status --schema packages/db/prisma/schema.prisma
```

## 6. Seed the interstate route catalogue

```bash
node scripts/seed-interstate-routes.mjs
```

Reference data, not demo data — idempotent (upserts by city pair) and safe on
production. Re-running it also tops the departure schedule back up.

**Without this the Travel form has nothing to offer and shows "No routes
available".** Run it once now, then whenever you add routes or want more days:

```bash
node scripts/seed-interstate-routes.mjs --days=30    # further ahead
node scripts/seed-interstate-routes.mjs --routes-only # skip the schedule
```

## 7. Restart

```bash
npm run pm2:restart
```

That is `pm2 restart ecosystem.config.cjs --update-env`, covering all nine
processes:

| Process | Port | Notes |
| --- | --- | --- |
| `api-gateway` | 3000 | HTTP + WebSocket. Everything the apps talk to. |
| `ride-service` | — | Matching, bidding, the stale-ride sweep |
| `group-ride` | — | Shared-ride matching |
| `payment-service` | — | Paystack payout tracking + reconciliation |
| `wallet-service` | — | Balances and holds |
| `notification-worker` | — | Push and WhatsApp fan-out |
| `analytics-worker` | — | Activity events the admin panel reads |
| `mcp-server` | 3020 | Remote MCP behind `mcp.wheelersng.com` |
| `whatsapp-gateway` | 3010 | Deprecated. Skip it if you keep it stopped. |

`--update-env` is not optional — without it pm2 keeps the environment from the
last boot and any `.env` change you just made is silently ignored.

Restarting one process only:

```bash
pm2 restart api-gateway --update-env
pm2 restart ride-service --update-env
pm2 restart mcp-server --update-env
```

First-ever start on a fresh box (and make it survive reboot):

```bash
npm run pm2:start
pm2 save
pm2 startup      # then run the line it prints
```

## 8. Check it came up

```bash
pm2 status
pm2 logs api-gateway --lines 50 --nostream
curl -s localhost:3000/health
```

Then prove the new routes are mounted. **401 is the right answer** — it means the
route exists and is asking for auth. A 404 means the build did not take:

```bash
curl -s -o /dev/null -w 'safety      %{http_code}\n' localhost:3000/safety/alerts/active
curl -s -o /dev/null -w 'offers      %{http_code}\n' localhost:3000/interstate/driver/offers
curl -s -o /dev/null -w 'vehicles    %{http_code}\n' localhost:3000/interstate/vehicles
curl -s -o /dev/null -w 'requests    %{http_code}\n' -X POST localhost:3000/interstate/requests
curl -s -o /dev/null -w 'admin-alert %{http_code}\n' localhost:3000/admin/alerts/count
```

---

## The whole thing, one block

```bash
cd ~/Wheelers-Backend
git pull origin main
npm ci --include=dev
npm run db:generate
npm run build
npm run db:migrate:deploy
node scripts/seed-interstate-routes.mjs
npm run pm2:restart
pm2 status
```

---

# Every script in the repo

## Run on production

| Script | When |
| --- | --- |
| `node scripts/seed-interstate-routes.mjs` | **Every deploy that changes routes, and once now.** Reference data, idempotent, safe. Without it Travel shows "No routes available". |
| `node scripts/run-with-env.cjs node scripts/audit-money.mjs` | Any time. Read-only — replays every wallet and compares the ledger to the live Paystack balance. |
| `node scripts/run-with-env.cjs node scripts/provision-deposit-accounts.mjs` | Any time. Dry run by default — lists users without a Paystack deposit account; `--confirm` creates them. See `docs/payments.md`. |
| `node scripts/meta-otp-template.mjs status` | When sign-in codes stop arriving. Prints the WABA id and template approval status. |
| `node scripts/whatsapp-profile.mjs` | When the WhatsApp business profile or display name needs changing. |
| `node scripts/mcp-smoke.mjs https://mcp.wheelersng.com` | After deploying the MCP server. Checks health, OAuth discovery and registration from outside. No login needed. |

## Run with care — these move real money

| Script | What it does |
| --- | --- |

## Never on production

| Script | What it does |
| --- | --- |
| `node scripts/seed-demo.mjs` | Writes nine months of **invented** riders, drivers, rides and money. |
| `node scripts/demo-live.mjs` | Long-running. Walks seeded people through real rides so the panel *moves*. |

## Local development only

| Script | What it does |
| --- | --- |
| `npm run infra:up` (`scripts/start-infra.sh`) | Brings up Postgres, Redis and Kafka in Docker. |
| `node scripts/admin-preview.mjs` | Serves just the admin API against Postgres, without needing Kafka/Redis/WebSocket. For driving the panel locally. |
| `scripts/run-with-env.cjs` | Not run directly. The wrapper every `db:*` npm script uses to load `.env` and supply `DATABASE_URL`. |

---

## Demo data — **never on production with real users**

```bash
node scripts/seed-demo.mjs      # nine months of invented history
node scripts/demo-live.mjs      # keeps it moving in real time
```

`seed-demo.mjs` writes invented riders, drivers, rides and money.
`demo-live.mjs` is the long-running companion that walks seeded people through
real rides, so a ride booked a minute ago sits in the live list and "completed
today" climbs while you watch.

Both are for a **demo database only**. Pointing them at production mixes
fabricated money into the same ledger the real numbers come from, and there is
no clean way to unpick it afterwards.

The panel itself needs no script to stay current: Overview, Rides and the alerts
bell re-read themselves every 20 seconds. Every figure comes from the live API —
a trip counts once it is actually booked and paid. Nothing is estimated.

---

## If something goes wrong

```bash
pm2 logs --err --lines 100 --nostream    # what actually broke
pm2 restart all --update-env             # after fixing .env
```

A migration that fails halfway leaves the schema between versions. **Do not
restart the apps until `prisma migrate status` reports everything applied.**

## Reminders

- Never put a `#` comment on the same line as a value in `.env`. pm2's env
  loader does not strip them, so `MCP_PUBLIC_URL=https://... # note` becomes
  part of the URL.
- The admin panel (Wheelers-Frontend) and the mobile app deploy separately.
  This file covers the API and its workers only.
