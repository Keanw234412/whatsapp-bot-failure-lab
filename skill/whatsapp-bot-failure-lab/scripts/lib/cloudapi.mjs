// Builders for WhatsApp Cloud API (Meta) webhook payloads and helpers for the
// outbound Graph API "messages" endpoint. Shapes follow the public webhook
// reference; every value here is synthetic.
import { createHmac, randomBytes } from 'node:crypto';

export function wamid() {
  return 'wamid.LAB' + randomBytes(12).toString('hex').toUpperCase();
}

// ev: normalized inbound event (see scenarios.mjs)
// ctx: { phoneNumberId, businessNumber, wabaId }
export function messageWebhook(ev, ctx) {
  const msg = {
    from: ev.from,
    id: ev.id,
    timestamp: String(ev.timestamp),
    type: ev.type,
  };
  if (ev.context) msg.context = ev.context;
  switch (ev.type) {
    case 'text':
      msg.text = { body: ev.text };
      break;
    case 'image':
      msg.image = { id: mediaId(), mime_type: 'image/jpeg', sha256: fakeSha(), ...(ev.caption ? { caption: ev.caption } : {}) };
      break;
    case 'audio':
      msg.audio = { id: mediaId(), mime_type: 'audio/ogg; codecs=opus', sha256: fakeSha(), voice: true };
      break;
    case 'document':
      msg.document = { id: mediaId(), mime_type: 'application/pdf', sha256: fakeSha(), filename: 'invoice.pdf' };
      break;
    case 'sticker':
      msg.sticker = { id: mediaId(), mime_type: 'image/webp', sha256: fakeSha(), animated: false };
      break;
    case 'location':
      msg.location = { latitude: -6.2, longitude: 106.816666, name: 'Monas', address: 'Jakarta' };
      break;
    case 'contacts':
      msg.contacts = [{ name: { formatted_name: 'Test Contact', first_name: 'Test' }, phones: [{ phone: '+1 555 010 9999', type: 'CELL' }] }];
      break;
    case 'reaction':
      msg.reaction = { message_id: ev.reactTo || wamid(), emoji: ev.emoji ?? '\u{1F44D}' };
      break;
    case 'interactive':
      msg.interactive =
        ev.interactiveType === 'list_reply'
          ? { type: 'list_reply', list_reply: { id: ev.buttonId || 'row_1', title: ev.text || 'Pilihan 1', description: 'Lab list row' } }
          : { type: 'button_reply', button_reply: { id: ev.buttonId || 'btn_1', title: ev.text || 'Ya' } };
      break;
    case 'button':
      msg.button = { payload: ev.buttonId || 'PAYLOAD_1', text: ev.text || 'Ya' };
      break;
    case 'unsupported':
      msg.errors = [{ code: 131051, title: 'Message type unknown', message: 'Message type unknown', error_data: { details: 'Message type is currently not supported.' } }];
      break;
    default:
      break;
  }
  const value = {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: ctx.businessNumber, phone_number_id: ctx.phoneNumberId },
    contacts: [{ profile: { name: ev.name || 'Lab User' }, wa_id: ev.from }],
    messages: [msg],
  };
  return envelope(value, ctx);
}

export function statusWebhook(st, ctx) {
  const status = {
    id: st.messageId || wamid(),
    status: st.status,
    timestamp: String(st.timestamp),
    recipient_id: st.recipient,
  };
  if (st.status === 'failed') {
    status.errors = [{ code: 131047, title: 'Re-engagement message', message: 'Re-engagement message', error_data: { details: 'Message failed to send because more than 24 hours have passed since the customer last replied to this number.' } }];
  } else {
    status.conversation = { id: 'conv' + randomBytes(6).toString('hex'), origin: { type: 'service' } };
    status.pricing = { billable: true, pricing_model: 'PMP', category: 'service' };
  }
  const value = {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: ctx.businessNumber, phone_number_id: ctx.phoneNumberId },
    statuses: [status],
  };
  return envelope(value, ctx);
}

function envelope(value, ctx) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: ctx.wabaId, changes: [{ value, field: 'messages' }] }],
  };
}

export function sign(rawBody, appSecret) {
  return 'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

// Classifies a JSON body POSTed by the bot to /<version>/<phone_id>/messages.
// Returns a normalized outbound record or null when it is not a user-visible
// message (read receipts and typing indicators are not replies).
export function classifyOutbound(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'invalid', problems: ['body is not a JSON object'] };
  if (body.status === 'read') {
    return { kind: 'receipt', messageId: body.message_id ?? null, typing: !!body.typing_indicator, problems: body.message_id ? [] : ['read receipt without message_id'] };
  }
  const to = typeof body.to === 'string' ? body.to.replace(/[^\d]/g, '') : null;
  const type = body.type || (body.text ? 'text' : 'unknown');
  const out = { kind: 'message', to, type, text: null, contextId: body.context?.message_id ?? null };
  if (type === 'text') out.text = typeof body.text?.body === 'string' ? body.text.body : null;
  else if (type === 'interactive') out.text = body.interactive?.body?.text ?? null;
  else if (type === 'template') out.text = `[template ${body.template?.name ?? '?'}]`;
  else if (body[type]?.caption) out.text = body[type].caption;
  const problems = [];
  if (body.messaging_product !== 'whatsapp') problems.push('messaging_product must be "whatsapp"');
  if (!to) problems.push('missing "to"');
  if (!SEND_TYPES.has(type)) problems.push(`unsupported message type "${type}"`);
  if (type === 'text') {
    if (out.text == null) problems.push('text message without text.body');
    else if (out.text.length > 4096) problems.push(`text.body is ${out.text.length} chars (limit 4096)`);
    else if (out.text.trim() === '') problems.push('empty text.body');
  } else if (type === 'template') {
    if (!body.template?.name) problems.push('template without template.name');
    if (!body.template?.language?.code) problems.push('template without template.language.code');
  } else if (type === 'interactive') {
    if (!body.interactive?.type) problems.push('interactive without interactive.type');
    if (!body.interactive?.action) problems.push('interactive without interactive.action');
    if (body.interactive?.type !== 'location_request_message' && !body.interactive?.body?.text) problems.push('interactive without body.text');
  } else if (MEDIA_TYPES.has(type)) {
    if (!body[type]?.id && !body[type]?.link) problems.push(`${type} without ${type}.id or ${type}.link`);
  } else if (type === 'reaction') {
    if (!body.reaction?.message_id) problems.push('reaction without reaction.message_id');
  } else if (type === 'location') {
    if (body.location?.latitude == null || body.location?.longitude == null) problems.push('location without latitude/longitude');
  }
  out.problems = problems;
  return out;
}

const MEDIA_TYPES = new Set(['image', 'audio', 'video', 'document', 'sticker']);
const SEND_TYPES = new Set(['text', 'template', 'interactive', 'reaction', 'location', 'contacts', ...MEDIA_TYPES]);

function mediaId() {
  return String(1e15 + Math.floor(Math.random() * 1e14));
}
function fakeSha() {
  return randomBytes(32).toString('base64');
}
