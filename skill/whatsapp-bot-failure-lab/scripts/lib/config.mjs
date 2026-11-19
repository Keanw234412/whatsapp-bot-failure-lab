// Loads lab.config.json. Secrets are referenced as "env:NAME" so the config
// file can be committed without them.
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';

export const DEFAULTS = {
  mode: 'cloud-api',
  webhookUrl: 'http://127.0.0.1:3000/webhook',
  mockPort: 8788,
  graphVersion: 'v21.0',
  phoneNumberId: '100000000000001',
  businessNumber: '15550100000',
  wabaId: '200000000000001',
  appSecret: null, // "env:WA_APP_SECRET" to enable signing + signature scenarios
  verifyToken: null, // "env:WA_VERIFY_TOKEN" to enable the GET handshake check
  accessToken: null, // "env:WA_TOKEN": if set, the mock rejects sends without this bearer token
  baselineText: 'Halo, saya mau tanya jam buka toko.',
  timing: {
    replyTimeoutMs: 15000, // how long to wait for the first reply in the baseline
    quietMs: 1200, // a scenario ends after this long without new outbound traffic...
    minWaitMs: null, // ...but never before this (default: 2x baseline latency + 800ms)
    maxWaitMs: 20000, // hard cap per observation window
    ackTimeoutMs: 15000, // webhook request timeout
    ackMaxMs: 2000, // acknowledgments slower than this fail the ack-latency check
  },
  policies: {
    maxSendAttemptsOnPermanentError: 3,
    burst: null, // { messages: 5, maxReplies: 2 }
    staleMessages: null, // "ignore" to require no reply to a 2-day-old message
  },
  handoff: null, // { trigger: "admin", expectReply: "(?i)admin|CS", silentAfter: true }
  start: null, // { command: "node bot.js", cwd: ".", env: { GRAPH_API_URL: "{{MOCK_URL}}" }, readyTimeoutMs: 20000 }
};

export async function loadConfig(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`Config not found: ${path}. Run "node lab.mjs init" first.`);
    throw e;
  }
  let user;
  try {
    user = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Config ${path} is not valid JSON: ${e.message}`);
  }
  return resolveConfig(user);
}

export function resolveConfig(user = {}) {
  const cfg = {
    ...DEFAULTS,
    ...user,
    timing: { ...DEFAULTS.timing, ...(user.timing || {}) },
    policies: { ...DEFAULTS.policies, ...(user.policies || {}) },
  };
  for (const key of ['appSecret', 'verifyToken', 'accessToken']) cfg[key] = resolveSecret(cfg[key], key);
  if (cfg.mode !== 'cloud-api') throw new Error(`mode "${cfg.mode}" is not supported in this version (only "cloud-api").`);
  let u;
  try {
    u = new URL(cfg.webhookUrl);
  } catch {
    throw new Error(`webhookUrl is not a valid URL: ${cfg.webhookUrl}`);
  }
  cfg.webhookIsLocal = isLoopback(u.hostname);
  if (cfg.handoff?.expectReply) cfg.handoff.expectReplyRe = toRegex(cfg.handoff.expectReply);
  return cfg;
}

function resolveSecret(v, key) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new Error(`${key} must be a string like "env:NAME"`);
  if (v.startsWith('env:')) {
    const name = v.slice(4);
    const val = process.env[name];
    if (!val) throw new Error(`${key} refers to environment variable ${name}, which is not set.`);
    return val;
  }
  return v; // literal value (discouraged for real secrets; fine for test values)
}

// Only literal loopback addresses and "localhost" count. Host names such as
// 127.example.com or *.localhost are not trusted, because DNS decides where
// they point.
export function isLoopback(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost') return true;
  const v = isIP(h);
  if (v === 4) return h.split('.')[0] === '127';
  if (v === 6) return h === '::1' || h === '0:0:0:0:0:0:0:1';
  return false;
}

// Accepts "/re/flags", "(?i)re" or a plain string (matched case-insensitively).
export function toRegex(s) {
  const m = /^\/(.*)\/([a-z]*)$/.exec(s);
  if (m) return new RegExp(m[1], m[2]);
  if (s.startsWith('(?i)')) return new RegExp(s.slice(4), 'i');
  return new RegExp(s, 'i');
}

export function sampleConfig() {
  return {
    webhookUrl: 'http://127.0.0.1:3000/webhook',
    mockPort: 8788,
    graphVersion: 'v21.0',
    phoneNumberId: '100000000000001',
    businessNumber: '15550100000',
    appSecret: 'env:WA_APP_SECRET',
    verifyToken: 'env:WA_VERIFY_TOKEN',
    baselineText: 'Halo, saya mau tanya jam buka toko.',
    timing: { replyTimeoutMs: 15000, ackMaxMs: 2000 },
    policies: { maxSendAttemptsOnPermanentError: 3, burst: null, staleMessages: null },
    handoff: null,
    start: null,
  };
}
