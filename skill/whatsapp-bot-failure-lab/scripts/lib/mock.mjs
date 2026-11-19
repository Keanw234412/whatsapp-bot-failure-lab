// Mock outbound side: impersonates the Graph API (POST /<version>/<phone_number_id>/messages
// and media lookups). Everything the bot sends is recorded so scenarios can
// assert on it. Invalid requests are rejected the way Graph rejects them, so a
// broken send path cannot establish a passing baseline.
import { createServer } from 'node:http';
import { classifyOutbound, wamid } from './cloudapi.mjs';

const MEDIA_BYTES = Buffer.from('LAB-FAKE-MEDIA');
const MAX_BODY = 512 * 1024;

export async function startMock({ port = 0, host = '127.0.0.1', accessToken = null, phoneNumberId = null, redact = (s) => s } = {}) {
  const records = [];
  // fault: null | { to, code, httpStatus, title, remaining } applied to sends to `to`
  let fault = null;

  const server = createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://mock');
      const path = url.pathname;
      const at = Date.now(); // absolute ms timestamp

      // Graph API: POST /vNN.N/<phone_id>/messages
      const m = path.match(/^\/(v\d+\.\d+)\/([^/]+)\/messages$/);
      if (req.method === 'POST' && m) {
        const base = { at, source: 'graph', version: m[1], phoneNumberId: m[2] };
        if (size > MAX_BODY) {
          records.push({ ...base, kind: 'invalid', problems: [`request body larger than ${MAX_BODY} bytes`] });
          return graphError(res, 413, 100, 'Request body too large');
        }
        const body = parseJson(raw);
        const rec = body == null ? { kind: 'invalid', problems: ['request body is not valid JSON'] } : classifyOutbound(body);
        // validate first (lengths etc.), then redact secrets before anything is stored or truncated
        if (typeof rec.text === 'string') rec.text = redact(rec.text);
        const full = { ...base, ...rec };
        if (accessToken && req.headers.authorization !== `Bearer ${accessToken}`) {
          records.push({ ...full, rejected: 'auth' });
          return graphError(res, 401, 190, 'Invalid OAuth access token.');
        }
        if (phoneNumberId && m[2] !== phoneNumberId) {
          records.push({ ...full, rejected: 'phone_number_id' });
          return graphError(res, 400, 100, `Unsupported post request. Object with ID '${m[2]}' does not exist (lab expects phone_number_id ${phoneNumberId}).`);
        }
        if (rec.kind === 'invalid' || rec.problems?.length) {
          records.push({ ...full, kind: rec.kind === 'receipt' ? 'receipt' : rec.kind, rejected: 'invalid' });
          return graphError(res, 400, 100, `(#100) Invalid parameter: ${(rec.problems || []).join('; ')}`);
        }
        if (fault && rec.kind === 'message' && rec.to === fault.to) {
          records.push({ ...full, rejected: `fault ${fault.code}`, faultCode: fault.code });
          const f = fault;
          if (f.remaining != null && --f.remaining <= 0) fault = null;
          return graphError(res, f.httpStatus, f.code, f.title);
        }
        records.push(full);
        if (rec.kind === 'receipt') return json(res, 200, { success: true });
        return json(res, 200, {
          messaging_product: 'whatsapp',
          contacts: [{ input: body?.to ?? '', wa_id: rec.to ?? '' }],
          messages: [{ id: wamid() }],
        });
      }

      // Graph API media lookup: GET /vNN.N/<media_id>
      const mm = path.match(/^\/(v\d+\.\d+)\/(\d{6,})$/);
      if (req.method === 'GET' && mm) {
        return json(res, 200, {
          messaging_product: 'whatsapp',
          url: `http://${req.headers.host}/lab-media/${mm[2]}`,
          mime_type: 'image/jpeg',
          sha256: 'lab',
          file_size: MEDIA_BYTES.length,
          id: mm[2],
        });
      }
      if (req.method === 'GET' && path.startsWith('/lab-media/')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(MEDIA_BYTES);
      }
      if (path === '/__lab/health') return json(res, 200, { ok: true });
      // Optional side-effect hook: the bot reports e.g. { kind: "order_created", key: "<inbound message id>", to: "<user>" }
      if (req.method === 'POST' && path === '/__lab/effect') {
        const body = parseJson(raw) || {};
        records.push({ at, source: 'effect', kind: 'effect', effect: String(body.kind ?? 'effect'), key: body.key != null ? String(body.key) : null, to: body.to ? String(body.to).replace(/[^\d]/g, '') : null });
        return json(res, 200, { ok: true });
      }

      records.push({ at, source: 'unknown', kind: 'unexpected', method: req.method, path });
      return graphError(res, 404, 100, `Unsupported request ${req.method} ${path} (WhatsApp Bot Failure Lab mock)`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address();
  return {
    url: `http://${host}:${addr.port}`,
    port: addr.port,
    records,
    setFault(f) {
      fault = f ? { ...f } : null;
    },
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function graphError(res, status, code, message) {
  json(res, status, { error: { message, type: 'OAuthException', code, error_data: { messaging_product: 'whatsapp', details: message }, fbtrace_id: 'LAB' } });
}
