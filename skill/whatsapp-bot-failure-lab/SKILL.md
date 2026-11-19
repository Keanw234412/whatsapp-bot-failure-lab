---
name: whatsapp-bot-failure-lab
description: Reproduce the failures that make WhatsApp Cloud API bots send double replies, answer the wrong customer, crash on status webhooks or forged requests, hammer the Graph API after errors, or talk over a human agent. Runs a local mock Graph API plus realistic Meta webhook deliveries against the user's locally running bot, reports pass/fail with evidence, then helps fix the code. Use when the user builds, debugs or hardens a WhatsApp bot (Cloud API / Meta webhooks), sees duplicate or missing replies, or wants a pre-launch reliability check.
---

# WhatsApp Bot Failure Lab

You test the user's WhatsApp Cloud API bot by playing Meta: the lab sends real-shaped webhooks to the bot
and impersonates the Graph API so the messages the bot sends are captured. Nothing reaches real WhatsApp **as long as every
outbound path (all SDKs, workers, scheduled jobs) points at the mock and the bot runs with test credentials**; the
preflight only proves that the main reply path does.

Scope: bots that receive **WhatsApp Cloud API webhooks** over HTTP and send through the **Graph API
`/messages` endpoint**, running locally. Libraries such as Baileys, whatsmeow or whatsapp-web.js (WhatsApp Web
protocol) and third-party gateways are not supported in this version; say so instead of improvising.

Requires Node.js 22+. The lab has no dependencies and makes no network calls except to the bot's local webhook
URL and its own loopback mock.

## 1. Understand the bot (read, don't change yet)

Find in the code:
- the webhook route (e.g. `POST /webhook`) and port, and the GET verification handler;
- where outbound messages are sent: the Graph base URL (`https://graph.facebook.com`), API version, phone
  number id, and how the access token is passed;
- whether `X-Hub-Signature-256` is checked (needs the app secret) and the verify-token variable;
- handoff-to-human logic and its trigger words, if any.

## 2. Point the bot at the mock

The bot must send to `http://127.0.0.1:8788` instead of `https://graph.facebook.com`, keeping the
`/<version>/<phone_number_id>/messages` path.
- If the base URL already comes from an environment variable, use it.
- Otherwise propose the smallest change: read the base URL from an env var such as `GRAPH_API_URL`, defaulting
  to the real one. Show the diff and apply it only after the user agrees. Never point a production deployment
  at the mock, and never run the lab against a production webhook.
- Use **test values** for secrets (e.g. `WA_APP_SECRET=lab-secret`) when starting the bot for the lab, never
  the production app secret or access token.
- Stub or shorten slow external calls (LLM, payment) only if the user wants faster runs; the lab works with
  real latency too.

## 3. Configure and run

```bash
node "<skill-dir>/scripts/lab.mjs" init            # writes lab.config.json in the current folder
node "<skill-dir>/scripts/lab.mjs" run             # or: run --only duplicate-sequential,status-only
node "<skill-dir>/scripts/lab.mjs" list            # all scenarios
```

Edit `lab.config.json`:
- `webhookUrl`: the bot's local webhook (loopback only; `--allow-remote` exists for a test deployment the user
  owns and controls).
- `phoneNumberId`: the phone number id the bot sends from (the lab rejects sends from any other id).
- `appSecret`, `verifyToken`: `"env:NAME"` references or test literals. Leave `null` to skip signature and
  handshake scenarios (they are reported as SKIP, never as PASS).
- `baselineText`: a normal customer question the bot always answers.
- `handoff`: `{ "trigger": "...", "expectReply": "regex", "silentAfter": true }` if the bot hands off to humans.
- `policies.staleMessages: "ignore"` and `policies.burst: { "messages": 5, "maxReplies": 2 }` only if the user
  wants those behaviours enforced; they are product decisions, so ask.
- `start`: optional `{ "command": "npm start", "env": { "GRAPH_API_URL": "{{MOCK_URL}}" } }` lets the lab
  start and stop the bot itself (useful in CI). Otherwise ask the user to start the bot with the env set.

If the bot creates orders, tickets or other records, the strongest duplicate check comes from reporting them:
in test mode the bot can `POST {MOCK_URL}/__lab/effect` with `{ "kind": "order_created", "key": "<inbound message id>" }`.
Offer this; it is optional.

The run writes `wa-lab-report/report.md` and `report.json`. Exit codes: 0 ok, 1 a scenario failed (add `--strict`
to also fail on WARN/INCONCLUSIVE), 2 harness or config error (including unknown `--only` ids), 3 preflight failed.

## 4. Report

- Start with one line: counts per result and the baseline (replies per message, reply latency, ack time).
- If preflight fails, fix that first (usually the Graph base URL or signature secret); nothing else ran.
- For each FAIL and WARN, explain the customer-visible effect in plain words (e.g. "customers get the same
  answer twice when Meta retries"), cite the evidence lines, and point to the code responsible.
- ERROR means the lab itself broke; report it as a lab problem, not a bot result.
- INCONCLUSIVE means the lab could not observe enough (for example the bot never echoes content, so data
  isolation cannot be proven). Say what is missing; never present it as a pass.
- Results describe what happened within the observation window on this machine, not a guarantee.

## 5. Fix (when the user asks)

Propose concrete code changes for the failures, smallest first. If `references/fixes.md` is present, follow
its patterns. The usual fixes are:
- **Duplicates**: claim the message id atomically *before* any await (`SET key NX EX 172800` in Redis, or an
  insert into a table with a unique index), then process. An in-memory Set only works for one process.
- **Slow ack**: persist or enqueue the event (fast, durable), then return 200, then process. `setImmediate` is a
  development shortcut only: a crash after the 200 loses the message.
- **Status webhooks / other fields**: only treat `value.messages[]` as customer messages; ignore `statuses`.
- **Batches**: loop over every `entry`, `change` and `message`.
- **Signatures**: HMAC-SHA256 of the raw body with the app secret, constant-time compare, before parsing.
- **Cross-talk**: no module-level "current user" or shared conversation state; key everything by `wa_id`.
- **Send errors**: retry only transient errors (130429, 131056, 5xx) with backoff and a cap; never retry
  permanent 4xx errors.
- **Handoff**: a per-customer flag checked before every automated reply.

After the user approves the changes, apply them, re-run the lab, and show the before/after counts.

## Notes

- All phone numbers the lab generates are fictional `1555…` numbers. Do not paste real customer
  conversations into fixtures or reports.
- Reports contain outbound message text (truncated) and the fictional recipients. Configured secrets, bearer
  tokens and signatures are redacted, and the bot's own log is only included with `--include-bot-log`. Redaction
  is best-effort: review reports before sharing.
- See `references/setup.md` for framework-specific wiring (Express, Fastify, Next.js, FastAPI, Go).
