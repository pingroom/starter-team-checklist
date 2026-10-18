import { PingRoom } from '@pingroom/sdk';
export const ID = 'ab08f0a3-80b9-4b18-a502-5432da167b29';
export const PERSON_A = 'a89fbac6-a02f-4848-a3b7-94c47184a537';
export const PERSON_B = 'e1d0375b-9042-42d8-82ac-c61b6c4b7738';
export const sample = { checklistId: 'guide-042', title: 'Check the onboarding guide', items: ['Verify the installation steps', 'Check the troubleshooting links'] };
export const room = { id: '3d60c74a-925f-4c23-a13a-1cb3bf0396d8', invite_code: 'DEMO', name: 'Team', type: 'standard', is_public: false,
  members: [{ user_id: PERSON_A, role: 'owner' }, { user_id: PERSON_B, role: 'member' }] };
export const tick = (index, id = PERSON_A) => ({ index, checked_at: '2026-10-18T05:10:00+00:00', checked_by: { id, name: id === PERSON_A ? 'Alex' : 'Blair' } });
/** Real SDK, fully local HTTP transport. No credential lookup or network fallback. */
export function offline({ onSend, onRead, onRooms, timeoutMs = 5000 } = {}) {
  const calls = [];
  let notification;
  const client = new PingRoom({ token: 'offline-token', baseUrl: 'https://checklist.invalid', timeoutMs,
    fetch: async (url, init) => {
      const u = new URL(url);
      if (u.origin !== 'https://checklist.invalid') throw new Error('Unexpected offline origin.');
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ method: init.method, path: u.pathname, query: u.search, body, headers: init.headers });
      if (init.method === 'GET' && u.pathname === '/api/agent/rooms') return Response.json(onRooms ? await onRooms() : [room]);
      if (init.method === 'POST' && u.pathname === '/api/agent/rooms/DEMO/notifications') {
        notification = { id: ID, message: body.message, notification_title: body.title, data: body.data, correlation_id: body.correlation_id,
          room, created_at: '2026-10-18T05:00:00.000000Z', requires_ack: false, is_urgent: false, is_handoff: false, question: null,
          audience_mode: null, target_user_id: null, reply_to: null };
        return onSend ? await onSend(structuredClone(notification), init.signal) : Response.json(notification, { status: 201 });
      }
      if (init.method === 'GET' && u.pathname === `/api/agent/notifications/${ID}` && notification) {
        return onRead ? await onRead(structuredClone(notification), init.signal) : Response.json(notification);
      }
      if (init.method === 'GET' && u.pathname === '/api/agent/notifications') return Response.json({ data: notification ? [notification] : [] });
      throw new Error('Unexpected offline request.');
    } });
  return { client, calls };
}
