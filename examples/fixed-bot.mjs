// The same bot with the failure modes fixed. Each fix is labelled with the bug
// number from buggy-bot.mjs. Still a demo: a real bot needs a durable
// de-duplication store and a real queue.
//
//   GRAPH_API_URL=http://127.0.0.1:8788 node examples/fixed-bot.mjs
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const GRAPH = process.env.GRAPH_API_URL;
const TOKEN = process.env.WA_TOKEN || 'test-token';
const VERSION = process.env.GRAPH_VERSION || 'v21.0';
const APP_SECRET = process.env.WA_APP_SECRET || null;
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || null;
const PHONE_ID = process.env.PHONE_NUMBER_ID || '100000000000001';
const THINK_MS = Number(process.env.BOT_THINK_MS || 2500);
const EFFECT_URL = process.env.LAB_EFFECT_URL || null;
const MAX_AGE_S = 24 * 3600;
if (!GRAPH) {
  console.error('Set GRAPH_API_URL (the lab mock, e.g. http://127.0.0.1:8788). Refusing to call the real Graph API.');
  process.exit(1);
}

// FIX 1: claim each message id synchronously before any await, so concurrent
// duplicates cannot both pass the check. (Use Redis SET NX / a unique DB key in production.)
const seen = new Map(); // id -> expiry ms
function claim(id) {
  const now = Date.now();
  if (seen.size > 10000) for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  if (seen.has(id)) return false;
  seen.set(id, now + 48 * 3600 * 1000);
  return true;
}
const handedOff = new Set();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://bot');
  if (req.method === 'GET' && url.pathname === '/webhook') {
    // FIX 9: only echo the challenge for our own verify token
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && VERIFY_TOKEN && url.searchParams.get('hub.verify_token') === VERIFY_TOKEN;
    res.writeHead(ok ? 200 : 403);
    return res.end(ok ? url.searchParams.get('hub.challenge') : 'forbidden');
  }
  if (req.method !== 'POST' || url.pathname !== '/webhook') {
    res.writeHead(404);
    return res.end();
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);

  // FIX 5: verify X-Hub-Signature-256 over the raw bytes
  if (APP_SECRET && !validSignature(raw, req.headers['x-hub-signature-256'])) {
    res.writeHead(401);
    return res.end('bad signature');
  }
  let body;
  try {
    body = JSON.parse(raw.toString('utf8')); // FIX 3
  } catch {
    res.writeHead(400);
    return res.end('invalid json');
  }
  // FIX 4: acknowledge first, work afterwards. Demo shortcut: a real bot stores the event
  // durably (queue / inbox table) BEFORE answering 200, or a crash loses it.
  res.writeHead(200);
  res.end('EVENT_RECEIVED');
  setImmediate(() => handle(body));
});

function validSignature(raw, header) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', APP_SECRET).update(raw).digest('hex'));
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function handle(body) {
  if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return;
  for (const entry of body.entry) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'messages') continue;
      // FIX 2: statuses (sent/delivered/read/failed) are not user messages
      // FIX 6: handle every message in the batch
      for (const msg of change.value?.messages ?? []) {
        if (!msg?.id || !msg?.from) continue;
        if (!claim(msg.id)) continue; // FIX 1
        processMessage(msg).catch((e) => console.error('process failed', e.message));
      }
    }
  }
}

async function processMessage(msg) {
  const from = msg.from; // FIX 7: per-message local state only
  if (Number(msg.timestamp) && Date.now() / 1000 - Number(msg.timestamp) > MAX_AGE_S) return; // ignore stale replays
  if (msg.type === 'reaction') return;
  if (handedOff.has(from)) return; // a human agent owns this conversation now
  if (msg.type === 'text' && /\b(admin|cs|manusia|operator)\b/i.test(msg.text?.body ?? '')) {
    handedOff.add(from);
    return send(from, 'Baik, kamu akan segera dihubungkan dengan admin kami.', msg.id);
  }
  const reply = await think(msg);
  if (EFFECT_URL) await fetch(EFFECT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ticket_created', key: msg.id, to: from }) }).catch(() => {});
  await send(from, reply, msg.id);
}

async function think(msg) {
  await new Promise((r) => setTimeout(r, THINK_MS));
  if (msg.type === 'text') return truncate(`Halo! Terima kasih, pesan kamu: "${msg.text?.body ?? ''}"`, 4096);
  if (msg.type === 'interactive' || msg.type === 'button') return 'Pilihan kamu sudah kami terima.';
  return 'Maaf, saya hanya bisa membaca pesan teks.';
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// FIX 8: retry only transient errors (rate limit 130429/131056, 5xx), with backoff and a cap
async function send(to, text, contextId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let r, data;
    try {
      r = await fetch(`${GRAPH}/${VERSION}/${PHONE_ID}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text }, ...(contextId ? { context: { message_id: contextId } } : {}) }),
      });
      data = await r.json().catch(() => ({}));
    } catch {
      r = null;
    }
    if (r?.ok) return;
    const code = data?.error?.code;
    const transient = !r || r.status >= 500 || code === 130429 || code === 131056 || code === 4;
    if (!transient) {
      console.error(`send to ${to} failed permanently: ${code ?? r?.status}`);
      return;
    }
    await new Promise((res) => setTimeout(res, 300 * 2 ** attempt));
  }
  console.error(`send to ${to} gave up after retries`);
}

server.listen(PORT, '127.0.0.1', () => console.log(`fixed bot on http://127.0.0.1:${PORT}/webhook`));
