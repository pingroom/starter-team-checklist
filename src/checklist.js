import { createHash, randomUUID } from 'node:crypto';
import { openState, publishOutput } from './storage.js';
const hash = (text) => createHash('sha256').update(text).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const uuid = (x) => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const ascii = (x, max) => typeof x === 'string' && x.length > 0 && x.length <= max && /^[\x20-\x7e]+$/.test(x) && x === x.trim();
const dateShape = (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(x) && Number.isFinite(Date.parse(x));
function date(x) {
  if (!dateShape(x)) return false;
  const year = Number(x.slice(0, 4)), month = Number(x.slice(5, 7)), day = Number(x.slice(8, 10));
  return year >= 1000 && month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
    && Number(x.slice(11, 13)) < 24 && Number(x.slice(14, 16)) < 60 && Number(x.slice(17, 19)) < 60;
}
export function validateChecklist(raw) {
  if (!object(raw) || Object.keys(raw).sort().join(',') !== 'checklistId,items,title'
    || typeof raw.checklistId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.checklistId)
    || !ascii(raw.title, 40) || !Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 25
    || raw.items.some((item) => !ascii(item, 80)) || new Set(raw.items).size !== raw.items.length) {
    throw new Error('Expected checklistId (1–64 letters/digits/_/-), title (1–40 printable ASCII), and 1–25 distinct items (1–80 printable ASCII). No edge spaces or extra fields.');
  }
  return { checklistId: raw.checklistId, title: raw.title, items: [...raw.items] };
}
/** Listing rooms does not mark notifications read; human members exclude robot memberships. */
export function assertSharedRoom(rooms, code) {
  const room = Array.isArray(rooms) ? rooms.find((r) => typeof r?.invite_code === 'string' && r.invite_code.toUpperCase() === code) : null;
  const humans = new Set((Array.isArray(room?.members) ? room.members : []).filter((m) => uuid(m?.user_id)).map((m) => m.user_id.toLowerCase()));
  if (!room || room.type !== 'standard' || room.is_public !== false || humans.size < 2) throw new Error('Use a granted standard private room with at least two human members and visible membership.');
}
export function requestFor(checklist, correlation) {
  const data = { checklist: { items: checklist.items.map((text) => ({ text })) },
    starter: { kind: 'team-checklist-v1', checklist_id: checklist.checklistId, source_hash: hash(JSON.stringify(checklist)) } };
  // PHP json_encode escapes '/' even for this ASCII-only input.
  if (Buffer.byteLength(JSON.stringify(data).replaceAll('/', '\\/')) > 8192) throw new Error('Structured data exceeds the server limit.');
  return { title: checklist.title, message: 'Check each item after you complete it. Shared ticks cannot be undone.', data, correlation_id: correlation };
}
function verifyNotification(n, state, room) {
  const expected = state.request;
  if (!object(n) || !uuid(n.id) || (state.notificationId !== null && n.id !== state.notificationId)
    || n.room?.invite_code?.toUpperCase() !== room || n.room?.type !== 'standard' || n.room?.is_public !== false
    || n.notification_title !== expected.title || n.message !== expected.message || n.correlation_id !== expected.correlation_id
    || n.requires_ack !== false || n.is_urgent !== false || n.is_handoff !== false || n.question !== null
    || n.reply_to !== null || n.audience_mode !== null || n.target_user_id !== null || !date(n.created_at)
    || !object(n.data) || Object.keys(n.data).sort().join(',') !== 'checklist,starter'
    || !object(n.data.starter) || n.data.starter.kind !== expected.data.starter.kind
    || n.data.starter.checklist_id !== expected.data.starter.checklist_id || n.data.starter.source_hash !== expected.data.starter.source_hash
    || Object.keys(n.data.starter).sort().join(',') !== 'checklist_id,kind,source_hash'
    || !object(n.data.checklist) || Object.keys(n.data.checklist).join(',') !== 'items'
    || !Array.isArray(n.data.checklist.items) || n.data.checklist.items.length !== expected.data.checklist.items.length
    || n.data.checklist.items.some((item, i) => !object(item) || Object.keys(item).join(',') !== 'text' || item.text !== expected.data.checklist.items[i].text)) {
    throw new Error('Notification does not match the saved checklist, private room, or policy. No completion recorded.');
  }
  const raw = n.checklist_state;
  if (raw !== undefined && raw !== null && (!object(raw) || !Array.isArray(raw.ticks))) throw new Error('Malformed checklist state.');
  const ticks = raw?.ticks ?? [];
  if (ticks.length > expected.data.checklist.items.length) throw new Error('Too many checklist ticks.');
  const seen = new Set();
  return ticks.map((tick) => {
    if (!object(tick) || !Number.isInteger(tick.index) || tick.index < 0 || tick.index >= expected.data.checklist.items.length
      || seen.has(tick.index) || !date(tick.checked_at) || Date.parse(tick.checked_at) < Date.parse(n.created_at)
      || !uuid(tick.checked_by?.id) || typeof tick.checked_by.name !== 'string' || tick.checked_by.name.length > 256) {
      throw new Error('Invalid, duplicate, or redacted checklist tick. No completion recorded.');
    }
    seen.add(tick.index);
    return { index: tick.index, text: expected.data.checklist.items[tick.index].text,
      checkedAt: tick.checked_at, checkedBy: { id: tick.checked_by.id.toLowerCase() } };
  }).sort((a, b) => a.index - b.index);
}
function validateState(state, binding, checklist) {
  if (!object(state) || state.version !== 1 || state.binding !== binding || state.checklistId !== checklist.checklistId
    || !['sending', 'posted'].includes(state.phase) || !date(state.createdAt)
    || typeof state.correlation !== 'string' || !state.correlation.startsWith('checklist-') || !uuid(state.correlation.slice(10))
    || !equal(state.request, requestFor(checklist, state.correlation))
    || (state.phase === 'sending' ? state.notificationId !== null : !uuid(state.notificationId))) {
    throw new Error('Invalid state or changed checklist, room, or connection. Restore the original configuration; use a new ID for new work.');
  }
}
/** One bounded operation. Only publish can send; check reads fresh state and never ticks an item. */
export async function runChecklist({ client, checklist: raw, token, room, directory, receiptDirectory, operation = 'check', attachId }) {
  const checklist = validateChecklist(raw);
  if (typeof token !== 'string' || !token.trim() || typeof room !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(room)) throw new Error('Provide a complete connection.');
  room = room.toUpperCase();
  if (!['publish', 'check', 'find-id'].includes(operation) || (attachId !== undefined && (operation !== 'check' || !uuid(attachId)))) throw new Error('Invalid operation or notification UUID.');
  const binding = hash(JSON.stringify({ checklist, room, credentialHash: hash(token), policy: 'team-checklist-v1' }));
  const store = await openState(directory, hash(checklist.checklistId));
  try {
    let state = await store.read();
    if (state) validateState(state, binding, checklist);
    if (!state && operation !== 'publish') throw new Error('Publish this checklist first; no local send exists to observe or recover.');
    if (state && operation === 'publish') return { status: state.phase === 'sending' ? 'send_unknown' : 'already_published', notificationId: state.notificationId };
    assertSharedRoom(await client.rooms.list(), room);
    if (!state) {
      const correlation = `checklist-${randomUUID()}`;
      state = { version: 1, checklistId: checklist.checklistId, binding, correlation,
        request: requestFor(checklist, correlation), createdAt: new Date().toISOString(), phase: 'sending', notificationId: null };
      await store.write(state); // Persist before POST: errors and crashes must never silently resend.
      let sent;
      try { sent = await client.broadcast(room, state.request); }
      catch { return { status: 'send_unknown', notificationId: null }; }
      if (!uuid(sent?.id)) return { status: 'send_unknown', notificationId: null };
      state.notificationId = sent.id; state.phase = 'posted'; await store.write(state);
      return { status: 'published', notificationId: state.notificationId };
    }
    if (operation === 'find-id') {
      const candidates = [];
      for (let page = 1; page <= 5; page++) {
        // The history endpoint accepts a page size of at most 25.
        const result = await client.notifications.list({ page, limit: 25 });
        if (!Array.isArray(result?.data)) throw new Error('Invalid notification history response.');
        for (const n of result.data) if (uuid(n?.id) && n.correlation_id === state.correlation) candidates.push(n.id);
        if (result.data.length < 25) break;
      }
      return { status: 'candidates', notificationIds: [...new Set(candidates)], note: 'Recent visible history only. Candidates are not verified; absence does not prove the send failed.' };
    }
    if (state.phase === 'sending' && !attachId) return { status: 'send_unknown', notificationId: null };
    if (attachId && state.notificationId && attachId !== state.notificationId) throw new Error('Already tracking a different notification.');
    const notification = await client.notifications.getNotification(attachId ?? state.notificationId);
    if (attachId && notification?.id !== attachId) throw new Error('Returned notification ID differs from the recovery ID.');
    const ticks = verifyNotification(notification, state, room);
    if (state.phase === 'sending') { state.notificationId = notification.id; state.phase = 'posted'; await store.write(state); }
    if (ticks.length < checklist.items.length) return { status: 'pending', notificationId: state.notificationId, checked: ticks.length, total: checklist.items.length, ticks };
    const receipt = { version: 1, status: 'complete', checklistId: checklist.checklistId, title: checklist.title,
      room, notificationId: state.notificationId, sourceHash: state.request.data.starter.source_hash, createdAt: notification.created_at, items: ticks };
    const receiptPath = await publishOutput(receiptDirectory, `${checklist.checklistId}.json`, receipt);
    return { status: 'complete', notificationId: state.notificationId, receiptPath, receipt };
  } finally { await store.close(); }
}
