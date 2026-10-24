# Mail service

Wheelers' own mail. It sends from our own server: each email is built, DKIM-signed and queued, then delivered straight to the recipient's mail server. Deliveries are retried, paced per provider (Gmail, Microsoft, Yahoo…) and stopped for addresses that bounced. It also receives: an inbox for our mailboxes, plus the bounces, spam complaints and DMARC reports that come back. No outside mail provider, no API key.

It runs on its own and is not wired into the api-gateway yet. Our services will call its internal API (`POST /send`) when we switch over.

```
caller ──POST /send──► outbox: check, build, sign, store (MailMessage + one MailDelivery per recipient)
                          │
                 worker: due deliveries (SKIP LOCKED) → MX → paced per provider → SMTP on port 25
                          │                  delivered │ 4xx: later │ 5xx: bounced (+ suppressed if the address is gone)
                          ▼
the world ──SMTP 25──► inbound: our domains only (never a relay) → SPF/DKIM/DMARC → stored
                          ├─ to a mailbox → the inbox (threads, attachments, reply)
                          ├─ a bounce (to b+<delivery>@bounce…) → that delivery bounced
                          ├─ a complaint (ARF) → no more marketing to them
                          └─ a DMARC report → kept
```

## Parts (`src/`)

| File | What it does |
|---|---|
| `config.ts` | The `MAIL_*` settings. Refuses to start with an open API that has no token |
| `outbox.ts` | `enqueue`: checks the email, builds it (HTML plus a text version), DKIM-signs it, applies idempotency and the suppression list |
| `worker.ts` | Delivery: claims due deliveries, routes them, paces each provider, retries, bounces, frees deliveries a dead worker left behind, cleans up old mail |
| `route.ts` | MX lookup: preference order, implicit MX, null MX, no-such-domain, IPv4 only, a cache |
| `smtp-client.ts` | One delivery attempt: EHLO, STARTTLS, MAIL FROM (the bounce address, VERP), RCPT, DATA |
| `inbound.ts` | The receiving SMTP server and how it sorts what arrives |
| `reports.ts` | Reading bounce reports (DSN, RFC 3464) and complaints (ARF, RFC 5965) |
| `inbox.ts` | The inbox: list, read, threads, attachments, mark, delete, reply |
| `api.ts` | The internal API (list at the top of the file) |
| `records.ts`, `dkim.ts`, `cli.ts` | DNS records, DKIM keys, the command line |

## Setting it up on a server

1. **A server with port 25 open and reverse DNS you can set.** Use its own small VPS, not the API box. Hetzner (after the first invoice), OVH or Vultr (on request) allow this. Google Cloud and DigitalOcean usually block port 25. Check the IP on Spamhaus, Barracuda and SpamCop first.
2. **A DKIM key, kept outside git:**
   `npm -w @wheleers/mail-service run cli -- dkim-keygen /home/wheelers/mail/dkim-s2026q4.key`
3. **`.env`:** the `MAIL_*` lines in `.env.example`.
4. **DNS:** `npm -w @wheleers/mail-service run cli -- dns` prints every record: A, PTR (set at the host), SPF for the bounce domain, DKIM, DMARC and MX for the inbound domains. Leave the root domain's SPF and MX (Zoho) alone.
5. **Port 25:** either `sudo setcap cap_net_bind_service=+ep $(which node)` once, or `MAIL_SMTP_PORT=2525` with the firewall forwarding 25 to it.
6. **Mailboxes:** `npm -w @wheleers/mail-service run cli -- mailbox add support@mail.wheelersng.com "Wheelers support"`
7. **Start it:** `npm -w @wheleers/mail-service run build && npm -w @wheleers/mail-service start` (a pm2 entry comes when we switch over).
8. **Register the domain** with Google Postmaster Tools, Microsoft SNDS and JMRP, and Yahoo's complaint feedback loop (point it at `postmaster@bounce…`).

## Warm-up

A new IP starts low and doubles while nothing is deferred. `MAIL_LIMITS` caps each provider per hour (for example `gmail=50,microsoft=30,yahoo=30,other=100`); raise it week by week. Send transactional mail only for the first 4 to 6 weeks. `GET /stats` shows delivered, deferred, bounced and **blocked** per provider. Blocked means refused because of us (spam, policy, a blocklist), so watch it.

## Built-in protections

- **Only our domain in From** (we sign as it), at most 50 recipients, 10 MB per email. Header line breaks are flattened, so nothing can be injected.
- **Marketing must carry a one-click unsubscribe** (RFC 8058, which Gmail and Yahoo require).
- **No resending to bounced addresses:** an address that does not exist is never sent to again (5.1.1 and similar). A refusal about us (5.7.x) bounces that email but keeps the address. A complaint stops marketing to that person, but not their receipts.
- **Pausing a provider:** one that says "too fast" (Gmail 421 4.7.28, Yahoo TSS04) gets nothing for 30 minutes.
- **Retries:** urgent mail in seconds, the rest at 5 minutes, then 15, 30, 1 h… until it expires (15 minutes for urgent, a day otherwise, 3 days for marketing).
- **After a crash:** a crashed worker's deliveries are taken again once their 30-minute lease runs out, but only if the message had not gone out (see below).
- **Receiving:** our domains only (554 for any other, so we are never an open relay), 550 for unknown mailboxes, and postmaster@ and abuse@ always. 30 connections a minute per IP. No AUTH. 25 MB per message. A message is stored before we answer 250. A bounce report only counts when it comes to a bounce address or from the null sender.
- **IPv4 only**, because Gmail refuses IPv6 mail from servers without IPv6 reverse DNS.

## Never twice, never the wrong one

Every way an email could go out twice, or go out wrong, and what stops it. Each case has a test.

| Case | What happens |
|---|---|
| The caller retries `/send` (timeout, a job run again) | `idempotencyKey` returns the first email. Give one per real event: `password_reset:<request id>` |
| No key, the same email again (a double tap, a retried call) | Same sender, recipients, subject and body within 10 minutes counts as the first email, even when five arrive at once (a lock). `allowRepeat: true` turns this off |
| The line drops after the whole message went out, before the server's answer | `UNCONFIRMED`: it most likely arrived, so it is **not** resent. We wait the full 10 minutes RFC 5321 allows for that answer before giving up |
| The worker dies mid-send | The moment the body has gone out is saved (`bodySentAt`). If the body had gone out, the delivery becomes `UNCONFIRMED`; if not, it is sent again |
| The database fails right after a successful send | Same rule: once the body has gone out, never again |
| Two workers | `FOR UPDATE SKIP LOCKED`: each delivery is held by one worker |
| A retry after "try later" | The same signed bytes and the same Message-ID, built once when queued. A retry never sends a changed or newer version |
| A sender resends us a message it already gave us (it never heard our 250) | The same Message-ID to the same mailbox within 30 days is kept once, even when both copies arrive at the same moment |
| A bounce or complaint report comes twice | Handled once (same rule) |
| Drafts | Never sent by themselves (an expired login or a closed tab leaves a draft). Every save names its version, and an older copy is refused with the newer one (`409 STALE`). Send names the version on screen, and the draft is claimed before the email is queued, so a late autosave cannot change it. Pressed twice or retried: one email. Changing a sent draft: `409 ALREADY_SENT`. If the process stops between the claim and the queue, pressing send again finishes that same email |
| An expired code | Urgent mail carries `expiresInMinutes`. Undelivered by then means `EXPIRED`, never a late code. Set it to the code's own lifetime |

**Webhooks (when we add them):** each event gets its own id, and receivers ignore an id they have seen. A webhook only *reports*. Retrying it, or processing it twice, can never send an email. The API only sends on `/send`, a reply or a draft send, all covered above.

## Tests

`node --env-file=.env --test test/mail-service.test.js` (needs the local Postgres; build `@wheleers/db` and this package first). The tests send real SMTP between our receiving server and a stand-in "internet" server on local ports.
