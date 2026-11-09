# Wheelers admin panel

The operator view: who is on the platform, what they did, and where the money
went. Backend endpoints live in `apps/api-gateway/src/http/admin-metrics.route.ts`
(queries in `packages/db/src/clients/admin-metrics.client.ts`); the UI is
`Wheelers-Frontend/app/admin/(panel)/`.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /admin/users?role=&q=&sort=&limit=&offset=` | **User directory.** Every rider and driver with per-row aggregates: rides completed/cancelled, spend (or driver earnings), wallet balance, join date, last ride. `role=all\|rider\|driver`, `sort=recent\|rides\|spend\|name`, `q` searches name, phone, email, username or exact id. |
| `GET /admin/users/:userId` | **One person, everything.** Profile, wallet + lifetime totals by transaction type, virtual account, driver record with vehicle/rating/earnings, ride stats, 15 recent rides (trips driven for drivers), 25 transactions, withdrawals, and the activity timeline. |
| `GET /admin/metrics/overview` | Every headline number: users, drivers, rides by status with today/7d/30d windows, and money drawn from the ledger. |
| `GET /admin/metrics/timeseries?days=30` | Gap-free daily buckets: signups, rides requested/completed/cancelled, gross, fees, deposits. |
| `GET /admin/metrics/cancellations` | Grouped `cancelReason` — why requests fail. |
| `GET /admin/metrics/group-rides` | The group-ride funnel: requested → selfie → matching → grouped → booked, plus face-verification states, groups formed, average group size and time to match. |
| `GET /admin/rides?status=&q=&limit=&offset=` | Filterable, paged ride table (replaces the fixed top-20). |

All require admin auth (JWT from `POST /admin/login`, or the bootstrap
`x-admin-key`), same as the existing admin routes.

**Money comes from the `Transaction` ledger, not from ride columns.** Ride rows
only carry a fare once a ride completes, so a settlement backlog used to read as
"no revenue". Completed-ride counts and gross are both windowed on `completedAt`
so the two never disagree.

## UI

`/admin/dashboard` — money, rides and people at a glance; requests-vs-completed
and gross-per-day charts (inline SVG, no charting dependency); why requests fail;
money movement; withdrawal states.

`/admin/dashboard/users` — the directory. Search, filter by rider/driver, sort,
paginate. `/admin/dashboard/users/:id` — the drill-down, with Trips / Money /
Activity tabs.

**`/admin/dashboard/group-rides`** is the dedicated page (and a nav item); a
condensed version of the same numbers sits on the overview between Rides and
People. Group ride is a funnel,
not a count: a request must clear a verification selfie, become matchable, find
someone going the same way, then convert. Reporting only "requests" hides which
step loses people — and the selfie is comfortably the biggest drop-off
(~28% never take it). The section shows that funnel step by step alongside
match rate, groups formed, average group size and time to match.

`/admin/dashboard/rides` — filterable ride table. `/admin/dashboard/drivers` —
the KYC review queue (unchanged).

### Removed

- **`/admin`** — a server component with **no auth at all** that dumped every
  waitlist row (name, email, phone) to anyone who loaded the URL. Deleted.
- **`/admin/drivers/*` (legacy)** — duplicate KYC screens that had operators paste
  the raw bootstrap `ADMIN_API_KEY` into a browser form and kept it in
  localStorage. Deleted; the reviewed flow at `/admin/dashboard/drivers` remains.
- **`/admin/dashboard/activity`** — did nothing until you pasted a raw user id.
  Activity is now a tab on each user's profile, where it is actually reachable.
- **`/admin/dashboard/riders`** — a top-10 leaderboard masquerading as a directory.
  Superseded by `/admin/dashboard/users?role=rider`.

> `.env` in Wheelers-Frontend is committed with a live Neon connection string,
> `ADMIN_API_KEY` and an OpenRouteService key. Rotate all three.

## Demo seed

`scripts/seed-demo.mjs` writes a realistic 9-month history so the panel has
something true to show.

```sh
node scripts/seed-demo.mjs --dry-run          # plan only, touches nothing
node scripts/seed-demo.mjs --confirm          # write it
node scripts/seed-demo.mjs --purge --confirm  # remove it again
```

Options: `--target=88000000 --days=270 --riders=2000 --drivers=65 --seed=42
--database-url=…` (defaults to `DATABASE_URL`).

What it produces, at the defaults:

- ~2,065 people (2,000 riders, 65 drivers) arriving on a growth curve
- ~12,000 **attempted** rides → ~8,800 completed (73%), the rest cancelled —
  ~1,800 of those because no driver ever accepted
- ~₦86.8M gross across 270 days, avg fare ~₦9,800 (₦6k–₦14k band), ~33
  completed rides/day
- Real Lagos routes: distance drives the fare (₦300/km), fare drives duration
- ~35,000 ledger rows — deposits fund riders, ride payments debit them, drivers
  are paid out and withdraw to banks, the platform wallet accrues fees

The fee split is the same calculation production uses (4% fee + ₦30 Lagos levy
+ ₦375 service fee), and balances are replayed in chronological order, so
`balanceAfterNgn` on every transaction is arithmetically true and rider debits
reconcile exactly against driver payouts + platform fees.

Everything it creates is tagged with a `seed:` privyDid prefix, which is what
`--purge` keys off — it cannot touch real accounts.
