import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { classifyOutbound, sign, messageWebhook } from '../skill/whatsapp-bot-failure-lab/scripts/lib/cloudapi.mjs';
import { resolveConfig, isLoopback, toRegex } from '../skill/whatsapp-bot-failure-lab/scripts/lib/config.mjs';
import { startMock } from '../skill/whatsapp-bot-failure-lab/scripts/lib/mock.mjs';
import { runLab } from '../skill/whatsapp-bot-failure-lab/scripts/lib/runner.mjs';
import { coreScenarios } from '../skill/whatsapp-bot-failure-lab/scripts/scenarios/core.mjs';

const MOCK_PORT = 18788;
const BOT_PORT = 13000;

// ---------- unit tests: harness pieces, independent of the demo bots ----------

test('classifyOutbound separates read receipts from replies and flags bad messages', () => {
  assert.equal(classifyOutbound({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.x' }).kind, 'receipt');
  const ok = classifyOutbound({ messaging_product: 'whatsapp', to: '+1 555 0100', type: 'text', text: { body: 'hi' } });
  assert.equal(ok.kind, 'message');
  assert.equal(ok.to, '15550100');
  assert.deepEqual(ok.problems, []);
  const long = classifyOutbound({ messaging_product: 'whatsapp', to: '1', type: 'text', text: { body: 'x'.repeat(4097) } });
  assert.match(long.problems.join(), /4097 chars/);
  assert.match(classifyOutbound({ messaging_product: 'whatsapp', type: 'text', text: { body: 'a' } }).problems.join(), /missing "to"/);
  assert.match(classifyOutbound({ to: '1', type: 'text', text: { body: 'a' } }).problems.join(), /messaging_product/);
});

test('sign() matches an independent HMAC-SHA256', () => {
  const body = '{"a":1}';
  assert.equal(sign(body, 's3cret'), 'sha256=' + createHmac('sha256', 's3cret').update(body).digest('hex'));
});

test('messageWebhook builds the Cloud API envelope', () => {
  const p = messageWebhook({ id: 'wamid.1', from: '15550000001', timestamp: 1, type: 'text', text: 'halo' }, { phoneNumberId: 'P', businessNumber: 'B', wabaId: 'W' });
  assert.equal(p.object, 'whatsapp_business_account');
  const v = p.entry[0].changes[0].value;
  assert.equal(p.entry[0].changes[0].field, 'messages');
  assert.equal(v.metadata.phone_number_id, 'P');
  assert.equal(v.messages[0].text.body, 'halo');
  assert.equal(v.contacts[0].wa_id, '15550000001');
});

test('config: env references, loopback detection, regex parsing', () => {
  delete process.env.LAB_TEST_MISSING;
  assert.throws(() => resolveConfig({ appSecret: 'env:LAB_TEST_MISSING' }), /LAB_TEST_MISSING/);
  process.env.LAB_TEST_SECRET = 'abc';
  assert.equal(resolveConfig({ appSecret: 'env:LAB_TEST_SECRET' }).appSecret, 'abc');
  assert.throws(() => resolveConfig({ mode: 'baileys' }), /not supported/);
  assert.equal(resolveConfig({ webhookUrl: 'https://bot.example.com/webhook' }).webhookIsLocal, false);
  for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]']) assert.equal(isLoopback(h), true, h);
  assert.equal(isLoopback('10.0.0.5'), false);
  assert.equal(toRegex('(?i)ADMIN').test('admin'), true);
  assert.equal(toRegex('/^x$/').test('X'), false);
});

test('mock: records sends, injects a one-shot fault, rejects bad tokens and unknown routes', async () => {
  const m = await startMock({ port: 0, accessToken: 'tok' });
  try {
    const send = (auth = 'Bearer tok') =>
      fetch(`${m.url}/v21.0/123/messages`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: '1555', type: 'text', text: { body: 'x' } }) });
    m.setFault({ to: '1555', code: 130429, httpStatus: 400, title: 'rate', remaining: 1 });
    const r1 = await send();
    assert.equal(r1.status, 400);
    assert.equal((await r1.json()).error.code, 130429);
    const r2 = await send();
    assert.equal(r2.status, 200);
    assert.match((await r2.json()).messages[0].id, /^wamid\./);
    assert.equal((await send('Bearer nope')).status, 401);
    assert.equal((await fetch(`${m.url}/somewhere`, { method: 'POST' })).status, 404);
    const kinds = m.records.map((r) => r.rejected ?? r.kind);
    assert.deepEqual(kinds, ['fault 130429', 'message', 'auth', 'unexpected']);
  } finally {
    await m.close();
  }
});

// ---------- preflight diagnostics with tiny inline bots ----------

function inlineBot(handler) {
  const s = createServer(handler);
  return new Promise((r) => s.listen(BOT_PORT, '127.0.0.1', () => r(s)));
}
const fastCfg = (extra = {}) =>
  resolveConfig({ webhookUrl: `http://127.0.0.1:${BOT_PORT}/webhook`, mockPort: MOCK_PORT, timing: { replyTimeoutMs: 1500, quietMs: 300, maxWaitMs: 4000, ackMaxMs: 200 }, ...extra });

test('preflight explains when the bot sends to the wrong Graph path', async () => {
  const bot = await inlineBot((req, res) => {
    req.resume();
    req.on('end', () => {
      res.end('ok');
      fetch(`http://127.0.0.1:${MOCK_PORT}/messages`, { method: 'POST', body: '{}' }).catch(() => {});
    });
  });
  try {
    const rep = await runLab(fastCfg(), coreScenarios);
    assert.equal(rep.aborted, true);
    assert.equal(rep.results[0].status, 'fail');
    assert.match(rep.results[0].summary, /POST \/messages/);
  } finally {
    bot.closeAllConnections();
    await new Promise((r) => bot.close(r));
  }
});

test('preflight fails clearly when the webhook rejects normal messages', async () => {
  const bot = await inlineBot((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(403);
      res.end();
    });
  });
  try {
    const rep = await runLab(fastCfg(), coreScenarios);
    assert.equal(rep.aborted, true);
    assert.match(rep.results[0].summary, /HTTP 403/);
  } finally {
    bot.closeAllConnections();
    await new Promise((r) => bot.close(r));
  }
});

test('a busy mock port gives an actionable error', async () => {
  const blocker = createServer().listen(MOCK_PORT, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  try {
    await assert.rejects(runLab(fastCfg(), coreScenarios), /mockPort/);
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

// ---------- end-to-end: every planted bug is caught, every fix passes ----------

function demoCfg(bot) {
  return resolveConfig({
    webhookUrl: `http://127.0.0.1:${BOT_PORT}/webhook`,
    mockPort: MOCK_PORT,
    appSecret: 'demo-app-secret',
    verifyToken: 'demo-verify-token',
    timing: { replyTimeoutMs: 8000, quietMs: 400, maxWaitMs: 8000, ackMaxMs: 200 },
    start: {
      command: `node examples/${bot}-bot.mjs`,
      env: { PORT: String(BOT_PORT), BOT_THINK_MS: '300', GRAPH_API_URL: '{{MOCK_URL}}', LAB_EFFECT_URL: '{{MOCK_URL}}/__lab/effect', WA_APP_SECRET: 'demo-app-secret', WA_VERIFY_TOKEN: 'demo-verify-token' },
    },
  });
}
const byId = (rep) => Object.fromEntries(rep.results.map((r) => [r.id, r.status]));

test('buggy bot: each core scenario catches its planted bug', { timeout: 120000 }, async () => {
  const rep = await runLab(demoCfg('buggy'), coreScenarios);
  assert.deepEqual(byId(rep), {
    'preflight-baseline': 'pass',
    'verify-handshake': 'fail',
    'duplicate-sequential': 'fail',
    'status-only': 'fail',
    'malformed-recovery': 'fail',
    'ack-latency': 'fail',
  });
});

test('fixed bot: all core scenarios pass', { timeout: 120000 }, async () => {
  const rep = await runLab(demoCfg('fixed'), coreScenarios);
  for (const r of rep.results) assert.equal(r.status, 'pass', `${r.id}: ${r.summary}`);
});

// ---------- regressions from review ----------

import { makeRedactor, checkScenarioIds } from '../skill/whatsapp-bot-failure-lab/scripts/lib/runner.mjs';

test('loopback check does not trust host names that merely start with 127.', () => {
  for (const h of ['127.attacker.example', '127.0.0.1.nip.io', 'evil.localhost', 'localhost.evil.com']) assert.equal(isLoopback(h), false, h);
  assert.equal(resolveConfig({ webhookUrl: 'https://127.attacker.example/webhook' }).webhookIsLocal, false);
});

test('unknown --only ids are rejected before anything runs', () => {
  assert.throws(() => checkScenarioIds(coreScenarios, ['duplicate-sequentail']), /Unknown scenario id\(s\): duplicate-sequentail/);
  assert.doesNotThrow(() => checkScenarioIds(coreScenarios, ['status-only']));
});

test('redactor removes configured secrets, bearer tokens and signatures', () => {
  const r = makeRedactor({ appSecret: 'app-secret-123', verifyToken: 'verify-xyz', accessToken: null });
  const out = r('secret app-secret-123 token verify-xyz Authorization: Bearer EAAGabcdefghijklmnopqrstuvwxyz0123 sha256=' + 'a'.repeat(64));
  assert.doesNotMatch(out, /app-secret-123|verify-xyz|EAAGabc|a{64}/);
});

test('outbound validation rejects incomplete templates, unknown types and invalid JSON', async () => {
  assert.match(classifyOutbound({ messaging_product: 'whatsapp', to: '1', type: 'template', template: {} }).problems.join(), /template.name/);
  assert.match(classifyOutbound({ messaging_product: 'whatsapp', to: '1', type: 'carrier_pigeon' }).problems.join(), /unsupported message type/);
  const m = await startMock({ port: 0, phoneNumberId: '100000000000001' });
  try {
    const post = (path, body) => fetch(`${m.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal((await post('/v21.0/100000000000001/messages', '{not json')).status, 400);
    assert.equal((await post('/v21.0/999/messages', JSON.stringify({ messaging_product: 'whatsapp', to: '1', type: 'text', text: { body: 'x' } }))).status, 400);
    assert.deepEqual(m.records.map((r) => r.rejected), ['invalid', 'phone_number_id']);
  } finally {
    await m.close();
  }
});

// A configurable Cloud API bot for harness tests.
function cloudBot({ replies = 1, gapMs = 0, onStatus = null } = {}) {
  let lastUser = null;
  return inlineBot((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      res.end('ok');
      let v;
      try {
        v = JSON.parse(raw).entry[0].changes[0].value;
      } catch {
        return;
      }
      const send = (to, text) =>
        fetch(`http://127.0.0.1:${MOCK_PORT}/v21.0/100000000000001/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }) }).catch(() => {});
      if (v.statuses && onStatus === 'reply-to-last' && lastUser) return send(lastUser, 'status triggered reply');
      const msg = v.messages?.[0];
      if (!msg) return;
      lastUser = msg.from;
      for (let i = 0; i < replies; i++) {
        if (i) await new Promise((r) => setTimeout(r, gapMs));
        await send(msg.from, `reply ${i + 1}`);
      }
    });
  });
}

test('baseline counts a slower second reply (observe does not stop too early)', async () => {
  const bot = await cloudBot({ replies: 2, gapMs: 700 });
  try {
    const rep = await runLab(fastCfg({ timing: { replyTimeoutMs: 3000, quietMs: 300, maxWaitMs: 6000 } }), coreScenarios, { only: ['ack-latency'] });
    assert.match(rep.results[0].summary, /Baseline: 2 replies per message/);
  } finally {
    bot.closeAllConnections();
    await new Promise((r) => bot.close(r));
  }
});

test('status-only fails when a receipt makes the bot message a different customer', async () => {
  const bot = await cloudBot({ onStatus: 'reply-to-last' });
  try {
    const rep = await runLab(fastCfg({ timing: { replyTimeoutMs: 3000, quietMs: 300, maxWaitMs: 6000 } }), coreScenarios, { only: ['status-only'] });
    const r = rep.results.find((x) => x.id === 'status-only') ?? assert.fail(JSON.stringify(rep.results[0]));
    assert.equal(r.status, 'fail', r.summary);
    assert.match(r.summary, /not involved in this scenario/);
  } finally {
    bot.closeAllConnections();
    await new Promise((r) => bot.close(r));
  }
});

test('a secret inside long outbound text is redacted before truncation', async () => {
  const secret = 'S3CRET-abcdefghijklmnopqrstuvwxyz12';
  const bot = await inlineBot((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.end('ok');
      const msg = JSON.parse(raw).entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (msg) fetch(`http://127.0.0.1:${MOCK_PORT}/v21.0/100000000000001/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: msg.from, type: 'text', text: { body: 'x'.repeat(70) + secret } }) }).catch(() => {});
    });
  });
  try {
    const rep = await runLab(fastCfg({ appSecret: secret, timing: { replyTimeoutMs: 3000, quietMs: 300, maxWaitMs: 5000 } }), coreScenarios, { only: ['ack-latency'] });
    const text = JSON.stringify(rep);
    assert.doesNotMatch(text, /S3CRET-abcdefgh/);
  } finally {
    bot.closeAllConnections();
    await new Promise((r) => bot.close(r));
  }
});
