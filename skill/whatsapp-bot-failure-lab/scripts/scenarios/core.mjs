// Core scenarios (free, MIT). Each run() returns { status, summary, evidence? }.
// Statuses: pass | fail | warn | inconclusive | skip.

export const ok2xx = (d) => !d.error && d.status >= 200 && d.status < 300;
export const is5xxOrDead = (d) => !!d.error || d.status >= 500;

// Shared duplicate check: compares replies against the baseline and, when the
// bot reports side effects, looks for the same key processed twice.
export function judgeDuplicate(t, user, deliveries, label) {
  const replies = t.messagesTo([user]).length;
  const base = t.baseline.repliesPerMessage;
  const dupEffects = duplicateEffectKeys(t.effects());
  const failedAcks = deliveries.filter((d) => !ok2xx(d));
  if (dupEffects.length) {
    return { status: 'fail', summary: `${label}: the same message was processed more than once (side effect ${dupEffects.join(', ')}). Replies to the user: ${replies} (single delivery: ${base}).` };
  }
  if (replies > base) {
    return { status: 'fail', summary: `${label}: the user got ${replies} replies, but a single delivery produces ${base}. The bot does not de-duplicate by message id, so Meta re-deliveries cause double replies.` };
  }
  if (replies === 0) {
    return { status: 'inconclusive', summary: `${label}: no reply at all within the window, so de-duplication could not be judged.` };
  }
  if (replies < base) {
    return { status: 'inconclusive', summary: `${label}: no excess replies (${replies}), but fewer than a single delivery produced in the baseline (${base}), so the result is not comparable. Reply counts may vary for this bot; consider the side-effect hook.` };
  }
  if (failedAcks.length) {
    return { status: 'warn', summary: `${label}: no double reply, but ${failedAcks.length} re-delivery request(s) were not acknowledged with 2xx (${failedAcks.map((d) => d.error || d.status).join(', ')}). Meta keeps retrying unacknowledged deliveries; answer 200 for duplicates you ignore.` };
  }
  return { status: 'pass', summary: `${label}: ${replies} repl${replies === 1 ? 'y' : 'ies'}, same as a single delivery.` };
}

export function duplicateEffectKeys(effects) {
  const seen = new Map();
  for (const e of effects) {
    if (!e.key) continue;
    const k = `${e.effect}:${e.key}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
}

export const coreScenarios = [
  {
    id: 'verify-handshake',
    title: 'Webhook verification handshake (GET hub.challenge)',
    tier: 'core',
    requires: (cfg) => (cfg.verifyToken ? null : 'verifyToken not configured'),
    async run(t) {
      const challenge = String(Math.floor(Math.random() * 1e9));
      const good = await t.getVerify(t.cfg.verifyToken, challenge);
      const bad = await t.getVerify(t.cfg.verifyToken + '-wrong', challenge + '1');
      const evidence = [
        `GET with correct token: ${good.error ? 'ERROR ' + good.error : 'HTTP ' + good.status} body=${JSON.stringify(good.body.slice(0, 40))}`,
        `GET with wrong token: ${bad.error ? 'ERROR ' + bad.error : 'HTTP ' + bad.status} body=${JSON.stringify(bad.body.slice(0, 40))}`,
      ];
      if (good.status !== 200 || good.body !== challenge) {
        return { status: 'fail', summary: 'The correct verify token did not get the plain hub.challenge back with HTTP 200, so Meta cannot subscribe this webhook.', evidence };
      }
      if (bad.status === 200 && bad.body.includes(challenge + '1')) {
        return { status: 'fail', summary: 'A wrong verify token was accepted. Anyone could subscribe their own app to this endpoint; compare hub.verify_token before echoing the challenge.', evidence };
      }
      return { status: 'pass', summary: 'Correct token echoes the challenge; a wrong token is refused.', evidence };
    },
  },

  {
    id: 'duplicate-sequential',
    title: 'Meta re-delivers the same message (sequential duplicates)',
    tier: 'core',
    async run(t) {
      const u = t.user();
      const ev = t.text(u, t.cfg.baselineText);
      const payload = t.messagePayload(ev);
      const ds = [await t.deliver(payload, { label: 'original' })];
      await t.observe([u], { until: (m) => m.length >= 1 });
      ds.push(await t.deliver(payload, { label: 're-delivery #1 (same message id)' }));
      ds.push(await t.deliver(payload, { label: 're-delivery #2 (same message id)' }));
      await t.observe([u]);
      return judgeDuplicate(t, u, ds, 'Two re-deliveries after the reply');
    },
  },

  {
    id: 'status-only',
    title: 'Status-only webhooks (sent / delivered / read) get no reply',
    tier: 'core',
    silent: true, // any outbound message during this scenario is a failure
    async run(t) {
      const u = t.user();
      const ds = [];
      for (const status of ['sent', 'delivered', 'read']) ds.push(await t.deliver(t.statusPayload({ status, recipient: u }), { label: `status ${status}` }));
      const { messages } = await t.observe([u]);
      const bad = ds.filter((d) => !ok2xx(d));
      if (messages.length) {
        return { status: 'fail', summary: `The bot sent ${messages.length} message(s) in response to delivery receipts. It treats status webhooks as incoming messages; check value.messages exists before replying.` };
      }
      if (bad.length) {
        return { status: 'fail', summary: `Status webhooks were answered with ${bad.map((d) => d.error || d.status).join(', ')}. Meta re-sends unacknowledged events and may disable the webhook; return 200 and ignore them.` };
      }
      return { status: 'pass', summary: `3 status webhooks acknowledged with 2xx and no message sent (observed for ${t.minWait()}ms).` };
    },
  },

  {
    id: 'malformed-recovery',
    title: 'Malformed and unexpected payloads do not break the bot',
    tier: 'core',
    async run(t) {
      const ctxValue = { messaging_product: 'whatsapp', metadata: { display_phone_number: t.cfg.businessNumber, phone_number_id: t.cfg.phoneNumberId } };
      const cases = [
        { label: 'invalid JSON', raw: '{"object":"whatsapp_business_account","entry":[' },
        { label: 'empty object', raw: '{}' },
        { label: 'empty entry list', payload: { object: 'whatsapp_business_account', entry: [] } },
        { label: 'change without messages or statuses', payload: { object: 'whatsapp_business_account', entry: [{ id: t.cfg.wabaId, changes: [{ field: 'messages', value: ctxValue }] }] } },
        { label: 'other webhook field (account_update)', payload: { object: 'whatsapp_business_account', entry: [{ id: t.cfg.wabaId, changes: [{ field: 'account_update', value: { phone_number: t.cfg.businessNumber, event: 'VERIFIED_ACCOUNT' } }] }] } },
      ];
      const ds = [];
      for (const c of cases) ds.push(await t.deliver(c.payload ?? null, { raw: c.raw ?? null, label: c.label }));
      const crashed = ds.filter(is5xxOrDead);
      const rec = await t.recovery();
      if (!rec.ok) {
        return { status: 'fail', summary: `After malformed input the bot no longer answers a normal message (${rec.delivery.error || 'HTTP ' + rec.delivery.status}, ${rec.replies} replies). It probably crashed or got stuck.` };
      }
      if (crashed.length) {
        return { status: 'fail', summary: `${crashed.length} malformed payload(s) caused a server error or dropped connection: ${crashed.map((d) => `${d.label} -> ${d.error || d.status}`).join('; ')}. Validate the shape and answer 200 (or 400) instead of throwing.` };
      }
      const redirects = ds.filter((d) => d.status >= 300 && d.status < 400);
      if (redirects.length) return { status: 'warn', summary: `Malformed payloads were answered with redirects (${redirects.map((d) => d.status).join(', ')}). Meta does not follow redirects; answer 200 or 400 directly.` };
      return { status: 'pass', summary: `${cases.length} malformed/unexpected payloads answered without 5xx (${ds.map((d) => d.status).join(', ')}), and the bot still replies normally afterwards.` };
    },
  },

  {
    id: 'ack-latency',
    title: 'Webhook is acknowledged quickly (process after 200 OK)',
    tier: 'core',
    async run(t) {
      const u = t.user();
      const d = await t.deliver(t.messagePayload(t.text(u, t.cfg.baselineText)), { label: 'normal text' });
      await t.observe([u], { until: (m) => m.length >= 1 });
      const max = t.cfg.timing.ackMaxMs;
      const worst = Math.max(d.ms, t.baseline.ackMs);
      if (!ok2xx(d)) return { status: 'fail', summary: `Normal message not acknowledged (${d.error || 'HTTP ' + d.status}).` };
      if (worst > max) {
        return { status: 'fail', summary: `The webhook took ${worst}ms to answer (limit ${max}ms). The bot does its work (LLM call, database, sending) before replying 200, so slow moments trigger Meta re-deliveries and duplicate replies. Acknowledge first, then process in the background or a queue.` };
      }
      return { status: 'pass', summary: `Acknowledged in ${d.ms}ms (baseline ${t.baseline.ackMs}ms, limit ${max}ms).` };
    },
  },
];
