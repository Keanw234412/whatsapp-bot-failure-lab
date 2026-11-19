// Scenario runner: delivers webhooks to the bot, watches the mock outbox and
// turns observations into pass / fail / warn / inconclusive / skip / error results.
import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { startMock } from './mock.mjs';
import { messageWebhook, statusWebhook, sign, wamid } from './cloudapi.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_RESPONSE_BYTES = 1024 * 1024;

export function checkScenarioIds(scenarios, only) {
  if (!only) return;
  const known = new Set(scenarios.map((s) => s.id));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new Error(`Unknown scenario id(s): ${unknown.join(', ')}. Run "lab.mjs list" to see the installed scenarios (Pro scenarios need the Pro pack).`);
  }
}

export async function runLab(cfg, scenarios, { log = () => {}, only = null, includeBotLog = false } = {}) {
  checkScenarioIds(scenarios, only);
  const redact = makeRedactor(cfg);
  let mock;
  try {
    mock = await startMock({ port: cfg.mockPort, accessToken: cfg.accessToken, phoneNumberId: cfg.phoneNumberId, redact });
  } catch (e) {
    if (e.code === 'EADDRINUSE') throw new Error(`Port ${cfg.mockPort} is already in use (another lab run, or the bot itself?). Set "mockPort" in the config to a free port and point the bot's GRAPH_API_URL there.`);
    throw e;
  }
  const graphUrl = mock.url;
  let bot = null;
  const results = [];
  const startedAt = new Date();
  const done = (aborted) => finish(cfg, results, startedAt, graphUrl, redact, { aborted, log: includeBotLog ? bot?.output : null });
  try {
    if (cfg.start) bot = await startBot(cfg, graphUrl, log);
    const t = new LabContext(cfg, mock, log);

    log(`Mock Graph API listening on ${graphUrl}`);
    const pre = await t.preflight();
    results.push(pre);
    if (pre.status !== 'pass') return done(true);

    for (const sc of scenarios) {
      if (only && !only.includes(sc.id)) continue;
      const skip = sc.requires?.(cfg) ?? null;
      if (skip) {
        results.push({ id: sc.id, title: sc.title, tier: sc.tier, status: 'skip', summary: skip, evidence: [] });
        continue;
      }
      log(`Running ${sc.id} ...`);
      await t.drain();
      mock.setFault(null);
      t.beginScenario();
      let r;
      try {
        r = await sc.run(t);
      } catch (e) {
        r = { status: 'error', summary: `Harness error (this is a lab problem, not a bot result): ${e.message}` };
      }
      mock.setFault(null);
      r = applyGlobalChecks(t, sc, r);
      results.push({ id: sc.id, title: sc.title, tier: sc.tier, ...r, evidence: [...(r.evidence || []), ...t.scenarioEvidence()] });
    }
    return done(false);
  } finally {
    if (bot) await bot.stop();
    await mock.close();
  }
}

// Checks that apply to every scenario: malformed outbound requests and messages
// sent to customers who are not part of the scenario (e.g. a stale "current user").
function applyGlobalChecks(t, sc, r) {
  if (!['pass', 'warn', 'inconclusive'].includes(r.status)) return r;
  const malformed = t.malformedOutbound();
  if (malformed.length) {
    return { ...r, status: 'fail', summary: `${r.summary} However, the bot sent ${malformed.length} invalid request(s) to the Graph API: ${malformed[0].problems.join('; ')}.` };
  }
  const strays = t.strayMessages();
  if (strays.length && (r.status !== 'inconclusive' || sc.silent)) {
    const msg = `The bot also sent ${strays.length} message(s) to customer(s) not involved in this scenario (${[...new Set(strays.map((s) => s.to))].join(', ')}), for example from a shared "current user" variable or a late retry.`;
    if (sc.silent) return { ...r, status: 'fail', summary: `${r.summary} ${msg}` };
    return { ...r, status: 'warn', summary: `${r.summary} ${msg}` };
  }
  return r;
}

function finish(cfg, results, startedAt, graphUrl, redact, extra) {
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const clean = results.map((r) => ({ ...r, summary: redact(r.summary), evidence: (r.evidence || []).map(redact) }));
  return {
    tool: 'whatsapp-bot-failure-lab',
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    webhookUrl: sanitizeUrl(cfg.webhookUrl),
    mockUrl: graphUrl,
    signing: !!cfg.appSecret,
    counts,
    aborted: extra.aborted,
    results: clean,
    botLogTail: extra.log ? tailLines(redact(extra.log()), 4000) : null,
  };
}

// Removes configured secrets and anything that looks like a bearer token or
// signature from report text.
export function makeRedactor(cfg) {
  const secrets = [cfg.appSecret, cfg.verifyToken, cfg.accessToken].filter((s) => typeof s === 'string' && s.length >= 4);
  return (s) => {
    let out = String(s ?? '');
    for (const sec of secrets) out = out.split(sec).join('[redacted]');
    return out
      .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
      .replace(/sha256=[0-9a-f]{64}/gi, 'sha256=[redacted]')
      .replace(/\bEAA[A-Za-z0-9]{20,}/g, '[redacted-meta-token]');
  };
}

function tailLines(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(-n);
  const nl = cut.indexOf(String.fromCharCode(10));
  return nl >= 0 ? cut.slice(nl + 1) : '';
}

export function sanitizeUrl(s) {
  try {
    const u = new URL(s);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '[invalid url]';
  }
}

export class LabContext {
  constructor(cfg, mock, log) {
    this.cfg = cfg;
    this.mock = mock;
    this.log = log;
    this.baseline = null;
    this.mark = 0;
    this.deliveries = [];
    this.scenarioUsers = new Set();
    this.runTag = randomBytes(2).toString('hex');
    this.userSeq = 0;
  }

  // ---- identities and events ------------------------------------------------
  user() {
    // 1555xxxxxxx: fictional numbers, never a real customer.
    this.userSeq += 1;
    const n = (parseInt(this.runTag, 16) * 1000 + this.userSeq) % 10_000_000;
    const u = '1555' + String(n).padStart(7, '0');
    this.scenarioUsers.add(u);
    return u;
  }
  now() {
    return Math.floor(Date.now() / 1000);
  }
  event(from, type = 'text', extra = {}) {
    return { id: wamid(), from, timestamp: this.now(), type, name: 'Lab User', ...extra };
  }
  text(from, body, extra = {}) {
    return this.event(from, 'text', { text: body, ...extra });
  }
  ctx() {
    return { phoneNumberId: this.cfg.phoneNumberId, businessNumber: this.cfg.businessNumber, wabaId: this.cfg.wabaId };
  }
  messagePayload(...events) {
    const p = messageWebhook(events[0], this.ctx());
    for (const ev of events.slice(1)) p.entry[0].changes[0].value.messages.push(messageWebhook(ev, this.ctx()).entry[0].changes[0].value.messages[0]);
    const contacts = new Map();
    for (const ev of events) contacts.set(ev.from, { profile: { name: ev.name || 'Lab User' }, wa_id: ev.from });
    p.entry[0].changes[0].value.contacts = [...contacts.values()];
    return p;
  }
  statusPayload(st) {
    return statusWebhook({ timestamp: this.now(), ...st }, this.ctx());
  }

  // ---- delivery ---------------------------------------------------------------
  // signature: 'valid' (default when appSecret set) | 'none' | 'wrong' | 'tampered'
  async deliver(payload, { signature = 'valid', raw = null, label = null } = {}) {
    const body = raw ?? JSON.stringify(payload);
    const headers = { 'content-type': 'application/json', 'user-agent': 'facebookexternalua' };
    let sent = body;
    if (this.cfg.appSecret && signature !== 'none') {
      if (signature === 'valid') headers['x-hub-signature-256'] = sign(body, this.cfg.appSecret);
      else if (signature === 'wrong') headers['x-hub-signature-256'] = sign(body, this.cfg.appSecret + '-wrong');
      else if (signature === 'tampered') {
        headers['x-hub-signature-256'] = sign(body, this.cfg.appSecret);
        sent = body.replace(/"body":"/, '"body":"[tampered] ');
        if (sent === body) sent = body + ' ';
      }
    }
    const t0 = Date.now();
    const rec = { label: label ?? describe(payload, raw), status: null, ms: null, error: null, sentAt: t0 };
    const res = await httpRequest(this.cfg.webhookUrl, { method: 'POST', headers, body: sent, timeoutMs: this.cfg.timing.ackTimeoutMs });
    rec.status = res.status;
    rec.error = res.error;
    rec.ms = Date.now() - t0;
    this.deliveries.push(rec);
    return rec;
  }

  async getVerify(token, challenge) {
    const u = new URL(this.cfg.webhookUrl);
    u.searchParams.set('hub.mode', 'subscribe');
    u.searchParams.set('hub.verify_token', token);
    u.searchParams.set('hub.challenge', challenge);
    const res = await httpRequest(u, { method: 'GET', timeoutMs: this.cfg.timing.ackTimeoutMs });
    return { status: res.status, body: res.body.trim(), error: res.error };
  }

  // Fault injection scoped to one recipient, so late traffic from other
  // customers cannot consume or trigger it.
  setFault(to, fault) {
    this.mock.setFault(fault ? { ...fault, to } : null);
  }

  // ---- observation --------------------------------------------------------------
  beginScenario() {
    this.mark = this.mock.records.length;
    this.deliveries = [];
    this.scenarioUsers = new Set();
  }
  since() {
    return this.mock.records.slice(this.mark);
  }
  // Waits for outbound traffic to `users` to settle.
  // - Without `until`: ends after minWaitMs AND quietMs without new traffic.
  // - With `until`: once the condition holds, keeps watching until there has been
  //   no new traffic for max(quietMs, time it took to satisfy the condition) AND at
  //   least minWait() (2x reply latency + 800ms) has passed, so a slower second
  //   reply is still counted. minWaitMs is then only the give-up time when the
  //   condition never holds.
  // Always ends at maxWaitMs.
  async observe(users, { minWaitMs = this.minWait(), until = null } = {}) {
    const set = new Set(users);
    const t0 = Date.now();
    const { quietMs, maxWaitMs } = this.cfg.timing;
    let lastCount = -1;
    let lastChange = Date.now();
    let satisfiedAfter = null;
    for (;;) {
      const recs = this.since().filter((r) => r.to && set.has(r.to));
      if (recs.length !== lastCount) {
        lastCount = recs.length;
        lastChange = Date.now();
      }
      const now = Date.now();
      const elapsed = now - t0;
      if (until) {
        if (satisfiedAfter == null && until(this.messagesTo(users))) satisfiedAfter = elapsed;
        if (satisfiedAfter != null && elapsed >= this.minWait() && now - lastChange >= Math.max(quietMs, satisfiedAfter)) break;
        if (satisfiedAfter == null && elapsed >= minWaitMs && now - lastChange >= quietMs) break;
      } else if (elapsed >= minWaitMs && now - lastChange >= quietMs) break;
      if (elapsed >= maxWaitMs) break;
      await sleep(50);
    }
    return { messages: this.messagesTo(users), waitedMs: Date.now() - t0 };
  }
  messagesTo(users) {
    const set = new Set(users);
    return this.since().filter((r) => r.kind === 'message' && r.to && set.has(r.to) && !r.rejected);
  }
  attemptsTo(users) {
    const set = new Set(users);
    return this.since().filter((r) => r.kind === 'message' && r.to && set.has(r.to));
  }
  strayMessages() {
    return this.since().filter((r) => r.kind === 'message' && r.to && !this.scenarioUsers.has(r.to));
  }
  effects() {
    return this.since().filter((r) => r.kind === 'effect');
  }
  malformedOutbound() {
    return this.since().filter((r) => r.kind !== 'receipt' && r.kind !== 'effect' && r.kind !== 'unexpected' && r.problems?.length);
  }
  unexpectedRequests() {
    return this.mock.records.filter((r) => r.kind === 'unexpected');
  }
  minWait() {
    if (this.cfg.timing.minWaitMs != null) return this.cfg.timing.minWaitMs;
    const lat = this.baseline?.latencyMs ?? 1500;
    return Math.min(2 * lat + 800, this.cfg.timing.maxWaitMs);
  }
  async drain() {
    // Let late traffic from the previous scenario land before the next mark:
    // wait until the mock has been quiet for quietMs (bounded by maxWaitMs).
    const t0 = Date.now();
    let last = this.mock.records.length;
    let lastChange = Date.now();
    while (Date.now() - t0 < this.cfg.timing.maxWaitMs) {
      await sleep(100);
      if (this.mock.records.length !== last) {
        last = this.mock.records.length;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= this.cfg.timing.quietMs) break;
    }
  }

  // A fresh user sends the baseline text; the bot must still answer. Used after
  // hostile input to prove the bot is still working.
  async recovery() {
    const u = this.user();
    const d = await this.deliver(this.messagePayload(this.text(u, this.cfg.baselineText)), { label: 'recovery: normal text from a new user' });
    const { messages } = await this.observe([u], { minWaitMs: Math.max(this.minWait(), (this.baseline?.latencyMs ?? 1000) * 3), until: (m) => m.length >= 1 });
    return { ok: !d.error && d.status >= 200 && d.status < 300 && messages.length >= 1, delivery: d, replies: messages.length };
  }

  scenarioEvidence() {
    const ev = [];
    for (const d of this.deliveries) ev.push(`webhook ${d.label}: ${d.error ? 'ERROR ' + d.error : 'HTTP ' + d.status} in ${d.ms}ms`);
    for (const r of this.since()) {
      if (r.kind === 'message') ev.push(`outbound ${r.rejected ? '(rejected: ' + r.rejected + ') ' : ''}to ${r.to}: ${r.type}${r.text != null ? ' "' + trunc(r.text, 80) + '"' : ''}`);
      else if (r.kind === 'invalid') ev.push(`invalid outbound request: ${r.problems.join('; ')}`);
      else if (r.kind === 'effect') ev.push(`side effect ${r.effect} key=${r.key}`);
      else if (r.kind === 'unexpected') ev.push(`unexpected request to mock: ${r.method} ${r.path}`);
    }
    return ev;
  }

  // ---- preflight ------------------------------------------------------------------
  async preflight() {
    const id = 'preflight-baseline';
    const title = 'Preflight: bot answers a normal message through the mock';
    this.beginScenario();
    const u = this.user();
    const ev = this.text(u, this.cfg.baselineText);
    const t0 = Date.now();
    const d = await this.deliver(this.messagePayload(ev), { label: 'baseline text' });
    if (d.error || d.status < 200 || d.status >= 300) {
      return { id, title, tier: 'core', status: 'fail', summary: `The webhook did not accept a normal message (${d.error || 'HTTP ' + d.status}). Check webhookUrl${this.cfg.appSecret ? ' and appSecret' : ''}.`, evidence: this.scenarioEvidence() };
    }
    const { messages } = await this.observe([u], { minWaitMs: this.cfg.timing.replyTimeoutMs, until: (m) => m.length >= 1 });
    const fail = (summary) => ({ id, title, tier: 'core', status: 'fail', summary, evidence: this.scenarioEvidence() });
    const attempts = this.attemptsTo([u]);
    const wrongPhone = attempts.find((r) => r.rejected === 'phone_number_id');
    if (wrongPhone) {
      return fail(`The bot sends from phone_number_id ${wrongPhone.phoneNumberId}, but the lab's webhooks carry ${this.cfg.phoneNumberId}. Set "phoneNumberId" in the config to the id the bot uses (or make the bot reply from metadata.phone_number_id).`);
    }
    if (!messages.length) {
      let hint = `No accepted outbound message reached the mock within ${this.cfg.timing.replyTimeoutMs}ms. Point the bot's Graph API base URL at ${this.mock.url} (it must call ${this.mock.url}/<version>/<phone_number_id>/messages).`;
      const unexpected = this.unexpectedRequests();
      if (unexpected.length) hint += ` The mock did receive ${unexpected.map((r) => r.method + ' ' + r.path).join(', ')}.`;
      if (attempts.some((r) => r.rejected === 'auth')) hint += ' Sends were rejected because the bearer token did not match accessToken.';
      const invalid = this.malformedOutbound();
      if (invalid.length) hint += ` Invalid send requests: ${invalid[0].problems.join('; ')}.`;
      return fail(hint);
    }
    const strays = this.strayMessages();
    if (strays.length) return fail(`The bot answered the baseline message to a different number (${strays[0].to}) than the sender (${u}).`);
    this.baseline = { repliesPerMessage: messages.length, latencyMs: Math.max(1, messages[0].at - t0), ackMs: d.ms };
    const versions = [...new Set(messages.map((m) => m.version))];
    const vnote = versions.some((v) => v !== this.cfg.graphVersion) ? ` Note: the bot uses Graph API ${versions.join(', ')} (config says ${this.cfg.graphVersion}).` : '';
    return {
      id,
      title,
      tier: 'core',
      status: 'pass',
      summary: `Baseline: ${messages.length} repl${messages.length === 1 ? 'y' : 'ies'} per message; first reply after ~${this.baseline.latencyMs}ms; webhook acknowledged in ${d.ms}ms. Later checks compare against this.${vnote}`,
      evidence: this.scenarioEvidence(),
    };
  }
}

// One fresh connection per request (no keep-alive pool), like Meta's deliveries.
// Absolute deadline and a response size cap, so a misbehaving handler cannot
// hang the lab. Redirects are not followed.
function httpRequest(target, { method, headers = {}, body = null, timeoutMs }) {
  const u = typeof target === 'string' ? new URL(target) : target;
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    let done = false;
    let req;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      finish({ status: null, body: '', error: `no response within ${timeoutMs}ms` });
      req?.destroy();
    }, timeoutMs);
    req = mod.request(u, { method, headers: { ...headers, connection: 'close', ...(body != null ? { 'content-length': Buffer.byteLength(body) } : {}) }, agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) {
          finish({ status: res.statusCode, body: '', error: `response larger than ${MAX_RESPONSE_BYTES} bytes (aborted)` });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), error: null }));
      res.on('error', (e) => finish({ status: res.statusCode, body: '', error: e.code || e.message }));
    });
    req.on('error', (e) => finish({ status: null, body: '', error: e.code || e.message }));
    if (body != null) req.write(body);
    req.end();
  });
}

function describe(payload, raw) {
  if (raw != null) return `raw ${JSON.stringify(trunc(raw, 40))}`;
  const v = payload?.entry?.[0]?.changes?.[0]?.value;
  if (v?.messages) return v.messages.map((m) => `${m.type} ${m.id.slice(-6)} from ${m.from}`).join(' + ');
  if (v?.statuses) return v.statuses.map((s) => `status ${s.status} for ${s.recipient_id}`).join(' + ');
  return 'payload';
}
function trunc(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---- optional: start the bot under test ------------------------------------------
async function startBot(cfg, mockUrl, log) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(cfg.start.env || {})) env[k] = String(v).replaceAll('{{MOCK_URL}}', mockUrl).replaceAll('{{GRAPH_VERSION}}', cfg.graphVersion);
  log(`Starting bot: ${cfg.start.command}`);
  // POSIX: own process group, so stop() can kill the shell and everything it started.
  const child = spawn(cfg.start.command, { cwd: cfg.start.cwd || process.cwd(), env, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const keep = (b) => {
    out += b.toString();
    // trim on a line boundary so a secret is never cut in half before redaction
    if (out.length > 20000) out = tailLines(out, 10000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = null;
  child.on('exit', (code) => (exited = code ?? 'signal'));
  const deadline = Date.now() + (cfg.start.readyTimeoutMs || 20000);
  for (;;) {
    if (exited !== null) throw new Error(`Bot exited (${exited}) before it was ready.\n${out.slice(-2000)}`);
    const probe = await httpRequest(cfg.webhookUrl, { method: 'GET', timeoutMs: 1000 });
    if (probe.status) break; // any HTTP answer means the server is listening
    if (Date.now() > deadline) {
      await kill(child);
      throw new Error(`Bot did not start listening on ${sanitizeUrl(cfg.webhookUrl)} in time.\n${out.slice(-2000)}`);
    }
    await sleep(200);
  }
  return { output: () => out, stop: () => kill(child) };
}

async function kill(child) {
  if (process.platform === 'win32') {
    // taskkill /T ends the whole tree even if the shell already exited
    await new Promise((r) => execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => r()));
    return;
  }
  // POSIX: the bot runs in its own process group (detached). Signal the group,
  // not just the shell, and escalate until no member is left.
  const groupAlive = () => {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const signal = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {}
  };
  signal('SIGTERM');
  const deadline = Date.now() + 3000;
  while (groupAlive() && Date.now() < deadline) await sleep(100);
  if (groupAlive()) {
    signal('SIGKILL');
    const hard = Date.now() + 2000;
    while (groupAlive() && Date.now() < hard) await sleep(100);
  }
}
