import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecklist, validateChecklist } from '../src/checklist.js';
import { offline, sample, room, tick, ID, PERSON_B } from '../src/offline.js';
import { loadCredentials, loadConfig, root } from '../src/config.js';
import { readBounded } from '../src/io.js';

async function setup(t, hooks = {}) {
  const base = await mkdtemp(join(tmpdir(), 'checklist-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const mock = offline(hooks);
  const opts = { client: mock.client, token: 'offline-token', room: 'DEMO', checklist: structuredClone(sample), directory: join(base, 'state'), receiptDirectory: join(base, 'receipts') };
  return { ...mock, base, opts, run: (extra = {}) => runChecklist({ ...opts, ...extra }) };
}
const completed = (n) => Response.json({ ...n, checklist_state: { ticks: [tick(1, PERSON_B), tick(0)] } });
const postCount = (calls) => calls.filter((c) => c.method === 'POST').length;
async function stateFile(directory) { return join(directory, (await readdir(directory)).find((n) => n.endsWith('.json'))); }

test('real SDK publishes exact checklist once and reports fresh partial then attributed completion', async (t) => {
  let ticks = [];
  const f = await setup(t, { onRead: (n) => Response.json({ ...n, checklist_state: { ticks } }) });
  assert.equal((await f.run({ operation: 'publish' })).status, 'published');
  assert.equal((await f.run()).status, 'pending');
  ticks = [tick(1, PERSON_B)];
  const partial = await f.run(); assert.equal(partial.checked, 1); assert.equal(partial.total, 2);
  await assert.rejects(stat(f.opts.receiptDirectory), { code: 'ENOENT' });
  ticks.push(tick(0));
  const result = await f.run(); assert.equal(result.status, 'complete');
  assert.deepEqual(result.receipt.items.map((i) => [i.index, i.checkedBy.id]), [[0, tick(0).checked_by.id], [1, PERSON_B]]);
  assert.deepEqual(JSON.parse(await readFile(result.receiptPath, 'utf8')), result.receipt);
  assert.equal((await f.run({ operation: 'publish' })).status, 'already_published');
  assert.equal(postCount(f.calls), 1);
  assert.deepEqual(f.calls.find((c) => c.method === 'POST').body.data.checklist.items, sample.items.map((text) => ({ text })));
  assert.ok(f.calls.every((c) => !c.path.includes('/checklist/')));
});

test('sending state is durable before POST and contains no plaintext token', async (t) => {
  let f;
  f = await setup(t, { onSend: async (n) => {
    const bytes = await readFile(await stateFile(f.opts.directory), 'utf8');
    assert.equal(JSON.parse(bytes).phase, 'sending'); assert.equal(bytes.includes('offline-token'), false);
    return Response.json(n, { status: 201 });
  } });
  await f.run({ operation: 'publish' });
});

test('lost send response is not retried and explicit verified ID recovers', async (t) => {
  const f = await setup(t, { onSend: () => { throw new Error('Response lost'); }, onRead: completed });
  assert.equal((await f.run({ operation: 'publish' })).status, 'send_unknown');
  assert.equal((await f.run({ operation: 'publish' })).status, 'send_unknown');
  assert.equal((await f.run()).status, 'send_unknown');
  assert.deepEqual((await f.run({ operation: 'find-id' })).notificationIds, [ID]);
  assert.equal((await f.run({ attachId: ID })).status, 'complete');
  assert.equal(postCount(f.calls), 1);
});

test('recovery refuses a mismatched correlation and preserves uncertain state', async (t) => {
  const f = await setup(t, { onSend: () => { throw new Error('Lost'); }, onRead: (n) => completed({ ...n, correlation_id: 'different' }) });
  await f.run({ operation: 'publish' });
  await assert.rejects(f.run({ attachId: ID }), /does not match/);
  assert.equal(JSON.parse(await readFile(await stateFile(f.opts.directory))).phase, 'sending');
});

for (const [label, change] of [
  ['changed item', (n) => { n.data.checklist.items[0].text = 'Different'; }],
  ['changed source hash', (n) => { n.data.starter.source_hash = '0'.repeat(64); }],
  ['wrong room', (n) => { n.room.invite_code = 'OTHER'; }],
  ['public notification room', (n) => { n.room.is_public = true; }],
  ['question payload', (n) => { n.question = { id: ID }; }],
  ['targeted solo fallback', (n) => { n.audience_mode = 'targeted'; }],
  ['wrong raw title', (n) => { n.notification_title = 'Other'; }],
]) {
  test(`fresh check rejects ${label}`, async (t) => {
    const f = await setup(t, { onRead: (n) => { change(n); return completed(n); } });
    await f.run({ operation: 'publish' }); await assert.rejects(f.run(), /does not match/);
  });
}

for (const [label, ticks] of [
  ['duplicate index', [tick(0), tick(0)]],
  ['fractional index', [tick(0.5), tick(1)]],
  ['out-of-range index', [tick(0), tick(2)]],
  ['redacted actor', [{ ...tick(0), checked_by: null }, tick(1)]],
  ['name-only actor', [{ ...tick(0), checked_by: { name: 'Alex' } }, tick(1)]],
  ['nil actor UUID', [tick(0, '00000000-0000-0000-0000-000000000000'), tick(1)]],
  ['invalid time', [{ ...tick(0), checked_at: 'later' }, tick(1)]],
  ['impossible date', [{ ...tick(0), checked_at: '2026-02-31T05:00:00Z' }, tick(1)]],
  ['time before send', [{ ...tick(0), checked_at: '2026-10-17T05:00:00Z' }, tick(1)]],
]) {
  test(`no receipt for ${label}`, async (t) => {
    const f = await setup(t, { onRead: (n) => Response.json({ ...n, checklist_state: { ticks } }) });
    await f.run({ operation: 'publish' }); await assert.rejects(f.run(), /Invalid, duplicate, or redacted/);
    await assert.rejects(stat(f.opts.receiptDirectory), { code: 'ENOENT' });
  });
}

test('malformed checklist state is not treated as pending', async (t) => {
  const f = await setup(t, { onRead: (n) => Response.json({ ...n, checklist_state: {} }) });
  await f.run({ operation: 'publish' }); await assert.rejects(f.run(), /Malformed/);
});

test('same human may complete all items; receipt is not a quorum', async (t) => {
  const f = await setup(t, { onRead: (n) => Response.json({ ...n, checklist_state: { ticks: [tick(0), tick(1)] } }) });
  await f.run({ operation: 'publish' }); assert.equal((await f.run()).status, 'complete');
});

test('display-name changes do not alter stable completion receipt', async (t) => {
  let name = 'Alex';
  const f = await setup(t, { onRead: (n) => Response.json({ ...n, checklist_state: { ticks: [tick(0), tick(1)].map((x) => ({ ...x, checked_by: { ...x.checked_by, name } })) } }) });
  await f.run({ operation: 'publish' }); const a = await f.run(); name = 'New display name';
  assert.deepEqual((await f.run()).receipt, a.receipt);
});

test('access failure after completion never returns the historical receipt as current success', async (t) => {
  let permitted = true;
  const f = await setup(t, { onRead: (n) => permitted ? completed(n) : Response.json({ message: 'No longer visible' }, { status: 403 }) });
  await f.run({ operation: 'publish' }); const first = await f.run(); permitted = false;
  await assert.rejects(f.run()); assert.equal(JSON.parse(await readFile(first.receiptPath)).status, 'complete');
});

test('removed notification returns an error, not a stale completion or replacement send', async (t) => {
  const f = await setup(t, { onRead: () => Response.json({ message: 'Not found' }, { status: 404 }) });
  await f.run({ operation: 'publish' }); await assert.rejects(f.run()); assert.equal(postCount(f.calls), 1);
});

test('private-to-public change is refused before fetching a notification', async (t) => {
  let publicRoom = false;
  const f = await setup(t, { onRooms: () => [{ ...room, is_public: publicRoom }] });
  await f.run({ operation: 'publish' }); publicRoom = true;
  await assert.rejects(f.run(), /standard private/);
  assert.equal(f.calls.filter((c) => c.path.includes(`/notifications/${ID}`)).length, 0);
});

test('single-person room cannot publish', async (t) => {
  const f = await setup(t, { onRooms: () => [{ ...room, members: [room.members[0]] }] });
  await assert.rejects(f.run({ operation: 'publish' }), /at least two/); assert.equal(postCount(f.calls), 0);
});

test('payload, room, and credential changes cannot reuse a checklist ID', async (t) => {
  const f = await setup(t); await f.run({ operation: 'publish' });
  for (const change of [{ token: 'different' }, { room: 'OTHER' }, { checklist: { ...sample, title: 'Different' } }]) await assert.rejects(f.run(change), /changed checklist/);
  assert.equal(postCount(f.calls), 1);
});

test('exclusive state lock prevents a concurrent send', async (t) => {
  const f = await setup(t); await mkdir(f.opts.directory); await writeFile(join(f.opts.directory, '.lock'), 'busy');
  await assert.rejects(f.run({ operation: 'publish' }), /locked/); assert.equal(f.calls.length, 0);
});

test('corrupt state is preserved and cannot trigger a replacement', async (t) => {
  const f = await setup(t); await f.run({ operation: 'publish' });
  const path = await stateFile(f.opts.directory); await writeFile(path, '{bad');
  await assert.rejects(f.run({ operation: 'publish' }), /Invalid state/); assert.equal(await readFile(path, 'utf8'), '{bad'); assert.equal(postCount(f.calls), 1);
});

test('conflicting receipt is never overwritten', async (t) => {
  const f = await setup(t, { onRead: completed }); await f.run({ operation: 'publish' }); const result = await f.run();
  await writeFile(result.receiptPath, 'different'); await assert.rejects(f.run(), /different contents/);
  assert.equal(await readFile(result.receiptPath, 'utf8'), 'different');
});

test('state and receipts are private on POSIX', async (t) => {
  const f = await setup(t, { onRead: completed }); await f.run({ operation: 'publish' }); const result = await f.run();
  if (process.platform !== 'win32') {
    assert.equal((await stat(await stateFile(f.opts.directory))).mode & 0o777, 0o600);
    assert.equal((await stat(result.receiptPath)).mode & 0o777, 0o600);
    assert.equal((await stat(f.opts.directory)).mode & 0o777, 0o700);
  }
});

test('strict input rejects trimming, Unicode, duplicate items, excessive items, and extra keys', () => {
  for (const raw of [null, { ...sample, title: ' title' }, { ...sample, items: ['Item '] }, { ...sample, items: ['\u200bItem'] },
    { ...sample, items: ['same', 'same'] }, { ...sample, items: Array.from({ length: 26 }, (_, i) => `Item${i}`) }, { ...sample, extra: true }]) assert.throws(() => validateChecklist(raw));
});

test('environment credentials are an all-or-nothing override', async (t) => {
  const f = await setup(t); const path = join(f.base, 'credentials.json'); await writeFile(path, JSON.stringify({ token: 'saved', room: 'demo' }));
  assert.deepEqual(await loadCredentials({}, path), { token: 'saved', room: 'DEMO' });
  assert.deepEqual(await loadCredentials({ PINGROOM_TOKEN: 'new', PINGROOM_ROOM: 'team' }, path), { token: 'new', room: 'TEAM' });
  await assert.rejects(loadCredentials({ PINGROOM_TOKEN: 'new' }, path), /both nonblank/);
  await assert.rejects(loadCredentials({ PINGROOM_TOKEN: '', PINGROOM_ROOM: '' }, path), /both nonblank/);
});

test('configuration resolves paths against project and ignores caller working directory', async () => {
  const c = await loadConfig({ PINGROOM_TOKEN: 'offline', PINGROOM_ROOM: 'demo', STATE_DIR: 'test-state', RECEIPT_DIR: 'test-receipts' });
  assert.equal(c.directory, join(root, 'test-state')); assert.equal(c.receiptDirectory, join(root, 'test-receipts'));
  assert.equal(c.checklist.checklistId, 'onboarding-guide-042');
});

test('bounded reads reject bytes over limit', async (t) => {
  const f = await setup(t); const path = join(f.base, 'large'); await writeFile(path, 'x'.repeat(100));
  await assert.rejects(readBounded(path, 99), /exceeds/); assert.equal((await readBounded(path, 100)).length, 100);
});

test('SDK timeout preserves pending tracking and makes no completion claim', async (t) => {
  const f = await setup(t, { timeoutMs: 30, onRead: (_n, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  await f.run({ operation: 'publish' }); await assert.rejects(f.run());
  assert.equal(JSON.parse(await readFile(await stateFile(f.opts.directory))).phase, 'posted');
});
