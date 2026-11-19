# WhatsApp Bot Failure Lab

[English](README.md) · [Bahasa Indonesia](README.id.md)

**Reproduce the bugs that make WhatsApp bots embarrass you in front of customers, on your laptop, before
launch.** Double replies when Meta retries a webhook. Crashes on delivery receipts. Slow acknowledgments that
trigger more retries. Forged requests that make your bot send messages. Replies that go to the wrong customer.

The lab plays Meta: it sends real-shaped WhatsApp Cloud API webhooks to your locally running bot and
impersonates the Graph API, so the messages your bot sends are captured and checked. Nothing reaches real
WhatsApp as long as all of the bot's send paths point at the mock and it runs with test credentials. Zero dependencies, Node.js 22+.

It ships as an agent skill (`SKILL.md`) for Claude Code, Codex, Cursor and other agents: the agent wires your
bot to the mock, runs the lab, explains each failure with evidence and helps you fix it. You can also run it
directly from the command line or in CI.

## What it finds

The included demo bot (`examples/buggy-bot.mjs`) is written the way many first versions are:

```
PASS  preflight-baseline: Baseline: 1 reply per message; first reply after ~2574ms; webhook acknowledged in 2577ms.
FAIL  verify-handshake: A wrong verify token was accepted. Anyone could subscribe their own app to this endpoint.
FAIL  duplicate-sequential: Two re-deliveries after the reply: the same message was processed more than once
      (side effect ticket_created:wamid.LAB… x3). Replies to the user: 3 (single delivery: 1).
FAIL  status-only: Status webhooks were answered with 500, 500, 500. Meta re-sends unacknowledged events.
FAIL  malformed-recovery: 5 malformed payload(s) caused a server error or dropped connection.
FAIL  ack-latency: The webhook took 2577ms to answer (limit 2000ms). Acknowledge first, then process.
```

The same bot with the fixes applied (`examples/fixed-bot.mjs`):

```
PASS  preflight-baseline, verify-handshake, duplicate-sequential, status-only, malformed-recovery, ack-latency
6 pass, 0 fail
```

Try it yourself:

```bash
npm run demo:buggy
npm run demo:fixed
```

## Quick start with your bot

1. Make your bot's Graph API base URL configurable, e.g.
   `const GRAPH = process.env.GRAPH_API_URL ?? 'https://graph.facebook.com'`
   (see [references/setup.md](skill/whatsapp-bot-failure-lab/references/setup.md) for Express, FastAPI, Go, ...).
2. Start the bot locally with test values:
   `GRAPH_API_URL=http://127.0.0.1:8788 WA_APP_SECRET=lab-secret WA_VERIFY_TOKEN=lab-verify npm start`
3. Run the lab:

```bash
node skill/whatsapp-bot-failure-lab/scripts/lab.mjs init   # creates lab.config.json
# set webhookUrl, appSecret and verifyToken (test values) in lab.config.json
node skill/whatsapp-bot-failure-lab/scripts/lab.mjs run
```

Results are printed and written to `wa-lab-report/report.md` and `report.json`. The exit code is non-zero
when a scenario fails, so it works in CI (`start` in the config lets the lab start and stop your bot).

### As an agent skill

Copy `skill/whatsapp-bot-failure-lab/` into your agent's skills folder (for Claude Code:
`~/.claude/skills/whatsapp-bot-failure-lab/`) and ask: *"Test my WhatsApp bot for duplicate replies and
webhook failures."*

## Scenarios

| Scenario | Free | Pro |
|---|:-:|:-:|
| Preflight: the bot answers through the mock (baseline for every other check) | ✓ | ✓ |
| Webhook verification handshake, wrong verify token refused | ✓ | ✓ |
| Meta re-delivers the same message | ✓ | ✓ |
| Status webhooks (sent / delivered / read) get no reply and no 5xx | ✓ | ✓ |
| Malformed and unexpected payloads, then the bot still works | ✓ | ✓ |
| Webhook acknowledged quickly | ✓ | ✓ |
| Same message delivered 3x at the same moment (race) | | ✓ |
| Re-delivery while the first copy is still processing | | ✓ |
| One webhook carrying several messages | | ✓ |
| Forged requests: missing / wrong / tampered signature | | ✓ |
| Two customers at once: no data leaks to the wrong person | | ✓ |
| Buttons, list replies, images, voice notes, documents, stickers, locations, reactions, unsupported types | | ✓ |
| 4,090-character messages with emoji (4,096 limit on replies) | | ✓ |
| Graph API rate limit (130429), then recovery | | ✓ |
| Permanent send errors (131026) without a retry storm | | ✓ |
| Asynchronous `failed` status (131047, 24-hour window) | | ✓ |
| Handoff to a human: bot stays quiet afterwards | | ✓ |
| Stale replays and message bursts (configurable policies) | | ✓ |
| Fix patterns for Node.js, Python and Go (`references/fixes.md`) | | ✓ |

The **Pro pack** (14 extra scenarios plus fix patterns) is sold on [Agensi](https://www.agensi.io). The free
edition in this repository is MIT-licensed and fully usable on its own.

## Honest limits

- Supports bots built on the **WhatsApp Cloud API** (Meta webhooks + Graph API). Baileys, whatsmeow,
  whatsapp-web.js and third-party gateways are not supported yet.
- Runs against a **local** bot. The lab refuses non-local webhook URLs unless you pass `--allow-remote` for a
  test deployment you control. Never point it at production.
- "No reply" means none was seen within the observation window. LLM-backed bots vary; the lab compares counts,
  recipients and order codes, not wording.
- Synthetic payloads follow the public webhook format. They do not reproduce Meta-side enforcement such as the
  real 24-hour window or template approval.
- All generated phone numbers are fictional `1555…` numbers. Do not paste real customer conversations into
  fixtures or reports.

## Development

```bash
npm test        # unit tests + end-to-end runs against both demo bots
npm run build   # dist/whatsapp-bot-failure-lab.zip (SKILL.md at the root)
```

## License

MIT for everything in this repository. The Pro pack has its own licence.
