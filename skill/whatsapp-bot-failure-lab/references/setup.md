# Wiring a bot to the lab

The lab needs two things from the bot: a local webhook URL it can POST to, and a way to send outbound
messages to `http://127.0.0.1:8788/<version>/<phone_number_id>/messages` instead of
`https://graph.facebook.com/...`. Keep the default pointing at the real Graph API; only the test run sets the
override.

## Make the Graph base URL configurable

Node.js (fetch / axios):

```js
const GRAPH = process.env.GRAPH_API_URL ?? 'https://graph.facebook.com';
await fetch(`${GRAPH}/${VERSION}/${PHONE_NUMBER_ID}/messages`, { /* ... */ });
// axios: axios.create({ baseURL: process.env.GRAPH_API_URL ?? 'https://graph.facebook.com' })
```

Python (requests / httpx):

```python
GRAPH = os.getenv("GRAPH_API_URL", "https://graph.facebook.com")
httpx.post(f"{GRAPH}/{VERSION}/{PHONE_NUMBER_ID}/messages", json=payload, headers=headers)
```

Go:

```go
graph := os.Getenv("GRAPH_API_URL")
if graph == "" { graph = "https://graph.facebook.com" }
```

If a third-party SDK hard-codes the host and has no base-URL option, wrap the SDK's send call behind your own
function and point that function at the mock in test mode. Check the SDK documentation before assuming an
option exists.

## Keep the raw body for signature checks

`X-Hub-Signature-256` is an HMAC of the exact bytes Meta sent. Parse JSON only after verifying.

- Express: `app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf } }))`
- Fastify: register a content-type parser that keeps the buffer, or use `fastify-raw-body`.
- Next.js route handler: `const raw = await req.text()`, verify, then `JSON.parse(raw)`.
- FastAPI: `raw = await request.body()`, verify, then `json.loads(raw)`.
- Go net/http: `raw, _ := io.ReadAll(r.Body)`, verify, then `json.Unmarshal(raw, &v)`.

## Running

1. Start the bot locally with test values, for example:
   `GRAPH_API_URL=http://127.0.0.1:8788 WA_APP_SECRET=lab-secret WA_VERIFY_TOKEN=lab-verify npm start`
2. In `lab.config.json` set `webhookUrl`, and `appSecret` / `verifyToken` to the same test values.
3. `node <skill-dir>/scripts/lab.mjs run`

Or let the lab start the bot (`start.command` and `start.env` with `{{MOCK_URL}}`), which also works in CI.

## Limits

- The mock binds to 127.0.0.1. A bot inside Docker or a VM cannot reach it unless you run the lab in the same
  network namespace; run the bot directly on the host for the lab.
- LLM-backed bots give varying replies. The lab compares counts and recipients, not wording, except for the
  handoff regex and the cross-talk order codes.
- Media download, template sending and the real 24-hour window are not simulated end-to-end.
