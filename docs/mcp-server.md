# Wheelers MCP server (`apps/mcp-server`)

A remote [MCP](https://modelcontextprotocol.io) server that lets AI assistants
(Claude web/desktop/Code, and any other MCP host) act as a signed-in Wheelers
user: estimate and book rides, follow driver bids, accept/cancel, chat with the
driver, manage the wallet and withdrawals, referrals, scheduled and group rides,
and (for drivers) read stats/earnings.

It is a **thin client over `api-gateway`** — it holds no database access and no
platform secrets. Every action runs with the user's own gateway session, so
wallet holds, outbox events and notifications behave exactly as they do from
the mobile app.

```
Claude ──HTTPS──▶ mcp-server (:3020) ──HTTP──▶ api-gateway (:3000)  reads/writes
                        │                  ╰─WS─▶ api-gateway /ws     ride request / bids / accept / cancel / chat
                        ╰──▶ Redis   OAuth clients, codes, tokens, live ride state (bids etc.)
```

## Auth: OAuth 2.1 built in, sign-in by WhatsApp number

Claude.ai and Claude Desktop require OAuth 2.1 with PKCE and dynamic client
registration for remote servers, so the MCP server is its own authorization
server (`@modelcontextprotocol/sdk`'s `mcpAuthRouter`):

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-authorization-server` | AS metadata (RFC 8414) |
| `/.well-known/oauth-protected-resource[/mcp]` | Resource metadata (RFC 9728), also referenced from the `WWW-Authenticate` header on 401 |
| `POST /register` | Dynamic client registration — Claude registers itself |
| `GET /authorize` | Redirects to the hosted login page |
| `GET /oauth/login` | Hosted sign-in page (phone first; email/password as fallback) |
| `POST /oauth/login/phone`, `POST /oauth/login/phone/verify` | Phone sign-in: send code on WhatsApp → verify |
| `POST /oauth/login` | Email/username + password, or sign-up |
| `POST /token` | Code → tokens (PKCE verified), refresh-token rotation |
| `POST /revoke` | Token revocation |
| `POST /mcp` | The MCP endpoint (Streamable HTTP, stateless, JSON responses) |

**What the rider does:** Connect in Claude → our page opens → they type the
phone number they use with the Wheelers WhatsApp bot (any format; normalised
to E.164) → a 6-digit code arrives on WhatsApp → they enter it → back to
Claude, connected. No password, no app install.

**One account everywhere.** The gateway's new unauthenticated routes
`POST /auth/phone/login/send-otp` and `POST /auth/phone/login/verify-otp`
(`apps/api-gateway/src/http/phone-login.route.ts`) resolve the number to a
user in this order: (1) the WhatsApp identity `whatsapp:<phone>` — the account
the bot has been using; (2) an app account that verified that number;
(3) otherwise create the WhatsApp identity via the same `onboardWhatsappUser()`
a first WhatsApp message would (wallet, deposit account, USER_CREATED event). The
route then issues the standard 30-day gateway JWT. Codes are hashed in Redis,
expire after `WHATSAPP_OTP_TTL_SECONDS`, allow 5 attempts, and at most 5 delivered sends
per number per 10 minutes (failed deliveries don't count). Delivery goes over
the **Meta WhatsApp Cloud API** with the bot's own credentials
(`META_ACCESS_TOKEN` + `META_PHONE_NUMBER_ID`).

Meta only delivers free-form text to riders who messaged the business number
in the last 24 h. When it refuses (error 131047), the gateway answers
`409 OTP_WINDOW_CLOSED` with our WhatsApp number, and the login page shows a
one-tap **"Open WhatsApp & say hi to Wheelers"** (`wa.me` link) step followed
by "Send me a code" — no template needed, works for every rider. Riders who
chatted recently never see that step.

The proper long-term fix is an approved *Authentication* template
(`META_OTP_TEMPLATE_NAME` — the send code already supports it), but Meta
currently refuses to create that category on this WhatsApp Business Account
(error subcode 2388185 — account-level gate; UTILITY templates carrying a code
are auto-rejected as `INCORRECT_CATEGORY`). `scripts/meta-otp-template.mjs
status|create` registers it the moment Meta allows it.

Under the hood: `/authorize` → login page → gateway issues the rider's gateway
JWT → we mint a one-time auth code bound to it → Claude exchanges it for
opaque MCP tokens. Access tokens live `MCP_ACCESS_TOKEN_TTL_S` (default 24 h);
refresh tokens live as long as the gateway session (30 days), after which the
rider signs in again. Tokens are stored in Redis by SHA-256 hash.

**Claude Code shortcut:** a raw gateway JWT is also accepted as a bearer
(`MCP_ALLOW_GATEWAY_TOKENS=true`), verified via `GET /auth/me`:

```sh
claude mcp add --transport http wheelers https://mcp.wheelersng.com/mcp \
  --header "Authorization: Bearer <gateway access token>"
```

Without the header, `claude mcp add --transport http wheelers https://mcp.wheelersng.com/mcp`
runs the normal OAuth flow in the browser.

## Adding it to Claude

* **Claude.ai / Desktop:** Settings → Connectors → *Add custom connector* →
  URL `https://mcp.wheelersng.com/mcp`. No client id/secret needed (dynamic
  registration). Claude's callback is `https://claude.ai/api/mcp/auth_callback`.
* **Claude Code:** see above.

## Tools

| Area | Tools |
|---|---|
| Account | `get_my_profile`, `update_my_profile`, `get_notifications`, `mark_notifications_read`, `get_rider_kyc_status` |
| Rides | `resolve_location`, `estimate_ride`, `request_ride`, `get_ride_status`, `list_ride_offers`, `accept_ride_offer`, `counter_ride_offer`, `cancel_ride`, `get_ride_history`, `get_ride_messages`, `send_ride_message`, `rate_ride`, `open_dispute` |
| Scheduled | `schedule_ride`, `list_scheduled_rides`, `cancel_scheduled_ride` |
| Group rides | `request_group_ride`, `list_group_ride_requests`, `get_group_ride_request`, `cancel_group_ride_request` |
| Wallet | `get_wallet_overview`, `get_deposit_details`, `setup_deposit_account`, `list_wallet_transactions`, `search_banks`, `verify_bank_account`, `request_withdrawal`, `list_withdrawals`, `get_withdrawal` |
| Referrals | `get_referral_summary`, `apply_referral_code`, `list_my_referrals`, `list_referral_cashback`, `preview_referral_cashback` |
| Driver | `get_driver_stats`, `get_driver_earnings`, `get_driver_ride_history`, `get_driver_kyc_status` |

Locations accept either `{address}` (geocoded with `GOOGLE_MAPS_API_KEY`,
Nigeria-biased) or `{lat, lng}`. For booking, an ambiguous address returns the
candidates instead of guessing; the assistant asks the user and re-calls with
coordinates. Money-moving tools carry `destructiveHint` and their descriptions
tell the model to confirm with the user first; `request_withdrawal` requires
`confirm: true`.

Every tool reports gateway failures as MCP tool errors with the gateway's own
message and `code` — a failed action is never reported as success.

### How booking works (WebSocket ride session)

Ride request → bids → accept is WebSocket-only on the gateway. The MCP server
opens **one gateway socket per signed-in user** (same as the app) when a ride is
requested, sends commands over it, and records every inbound event
(`ride:counter_offer`, `ride:matched`, `ride:started`, `ride:completed`, …) to
Redis (`mcp:ride:<rideId>`). Later tool calls — which are stateless HTTP — read
that state. The socket reconnects with backoff while a ride is active and is
closed after 30 min idle. `get_ride_status` reopens it if it finds an active
ride with no live socket (e.g. after a restart).

Two small routes were added to `api-gateway` for this: `GET /rides/active` and
`GET /rides/:rideId` (rider or assigned driver only).

## Configuration

| Var | Default | Notes |
|---|---|---|
| `MCP_PORT` | `3020` | |
| `MCP_PUBLIC_URL` | — | **Required.** Exact public origin, e.g. `https://mcp.wheelersng.com`. Used as OAuth issuer. |
| `MCP_GATEWAY_BASE_URL` | `http://127.0.0.1:3000` | Where to reach api-gateway (pm2 sets it from `PORT`). |
| `MCP_GATEWAY_WS_URL` | derived (`ws://…/ws`) | |
| `REDIS_URL` | — | Shared with the other services. |
| `MCP_ACCESS_TOKEN_TTL_S` | `86400` | |
| `MCP_ALLOW_GATEWAY_TOKENS` | `true` | Accept raw gateway JWTs as bearers. |
| `MCP_CORS_ORIGINS` | `https://claude.ai,https://claude.com` | |
| `GOOGLE_MAPS_API_KEY` | — | Optional; without it tools need lat/lng. |

## Deploy (pm2 + nginx)

`ecosystem.config.cjs` already includes `mcp-server`. On the server:

```sh
git pull && npm install && npm run build && pm2 restart ecosystem.config.cjs --update-env
```

Add `MCP_PUBLIC_URL=https://mcp.wheelersng.com` to `.env`, point the DNS
record at the box, and terminate TLS in nginx:

```nginx
server {
  server_name mcp.wheelersng.com;
  listen 443 ssl http2;
  # ssl_certificate ... (certbot)

  location / {
    proxy_pass         http://127.0.0.1:3020;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;   # tool calls can wait on the gateway
    proxy_buffering    off;
  }
}
```

The `WWW-Authenticate` header must reach the client unchanged (some cloud
proxies rename it) — nginx passes it through.

## Test

```sh
npm run test:mcp-server
```

Boots the built server against an in-process fake gateway (HTTP + WebSocket)
and Redis, and walks the full path: discovery, dynamic registration, PKCE
authorize → phone sign-in (send code → wrong code → verify) and password
sign-in → code → tokens, MCP initialize/tools, ride request → bid →
accept → matched → cancel, refresh-token rotation, raw-JWT bearer.

## Known limits / next steps

* Riders outside Meta's 24 h window must tap "say hi to Wheelers" once before
  the code can be sent (until Meta allows an Authentication template on the
  account — see above).
* Driver **go-online / accept / GPS** stay in the driver app (they need a live
  location stream).
* Group-ride **face verification selfie** must be taken in the app.
* A pm2 restart drops open ride sockets; bids that arrive before
  `get_ride_status` reconnects are missed (the ride itself is unaffected).
* MCP access tokens are not revoked when the gateway token is revoked via
  `/auth/logout` (the gateway does not enforce its blacklist either).
