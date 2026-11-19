// A deliberately buggy WhatsApp Cloud API bot, written the way many first
// versions are. Each bug is labelled; the lab should catch every one of them.
// Do not use this as a template.
//
//   GRAPH_API_URL=http://127.0.0.1:8788 node examples/buggy-bot.mjs
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const GRAPH = process.env.GRAPH_API_URL;
const TOKEN = process.env.WA_TOKEN || 'test-token';
const VERSION = process.env.GRAPH_VERSION || 'v21.0';
const THINK_MS = Number(process.env.BOT_THINK_MS || 2500); // pretend LLM / database call
const EFFECT_URL = process.env.LAB_EFFECT_URL || null;
if (!GRAPH) {
  console.error('Set GRAPH_API_URL (the lab mock, e.g. http://127.0.0.1:8788). Refusing to call the real Graph API.');
  process.exit(1);
}

let currentUser = null; // BUG 7: shared mutable state across requests -> replies go to the wrong person

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://bot');
  if (req.method === 'GET' && url.pathname === '/webhook') {
    // BUG 9: echoes the challenge without checking hub.verify_token
    res.writeHead(200);
    return res.end(url.searchParams.get('hub.challenge') || 'ok');
  }
  if (req.method !== 'POST' || url.pathname !== '/webhook') {
    res.writeHead(404);
    return res.end();
  }
  let raw = '';
  for await (const c of req) raw += c;
  try {
    const body = JSON.parse(raw); // BUG 3: invalid JSON throws -> 500
    // BUG 5: X-Hub-Signature-256 is never checked
    const value = body.entry[0].changes[0].value;
    const msg = value.messages[0]; // BUG 2: status webhooks have no messages -> TypeError -> 500
    // BUG 6: only the first message of a batched webhook is handled
    // BUG 1: no de-duplication by msg.id, so Meta re-deliveries are answered again
    currentUser = msg.from;
    const reply = await think(msg); // BUG 4: slow work happens before the 200 OK
    if (EFFECT_URL) await fetch(EFFECT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ticket_created', key: msg.id, to: msg.from }) }).catch(() => {});
    await send(currentUser, reply);
    res.writeHead(200);
    res.end('EVENT_RECEIVED');
  } catch (e) {
    res.writeHead(500);
    res.end('error: ' + e.message);
  }
});

async function think(msg) {
  await new Promise((r) => setTimeout(r, THINK_MS));
  if (msg.type === 'text') return `Halo! Terima kasih, pesan kamu: "${msg.text.body}"`;
  return 'Maaf, saya hanya bisa membaca pesan teks.';
}

async function send(to, text) {
  // BUG 8: retries every error forever-ish, including permanent ones
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${GRAPH}/${VERSION}/${process.env.PHONE_NUMBER_ID || '100000000000001'}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
    });
    if (r.ok) return;
  }
}

server.listen(PORT, '127.0.0.1', () => console.log(`buggy bot on http://127.0.0.1:${PORT}/webhook`));
