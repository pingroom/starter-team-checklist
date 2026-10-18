import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecklist } from './checklist.js';
import { offline, sample, tick, PERSON_B } from './offline.js';
const directory = await mkdtemp(join(tmpdir(), 'checklist-demo-'));
try {
  let ticks = [];
  const mock = offline({ onRead: (n) => Response.json({ ...n, checklist_state: { ticks } }) });
  const options = { client: mock.client, checklist: sample, token: 'offline-token', room: 'DEMO', directory: join(directory, 'state'), receiptDirectory: join(directory, 'receipts') };
  console.log('Publish:', (await runChecklist({ ...options, operation: 'publish' })).status);
  ticks = [tick(0)];
  const pending = await runChecklist(options);
  console.log(`After first teammate: ${pending.status} (${pending.checked}/${pending.total})`);
  ticks.push(tick(1, PERSON_B));
  const complete = await runChecklist(options);
  console.log('After second teammate:', complete.status);
  console.log(JSON.stringify(complete.receipt, null, 2));
  console.log('Publish replay:', (await runChecklist({ ...options, operation: 'publish' })).status);
  console.log('Broadcast requests:', mock.calls.filter((c) => c.method === 'POST').length);
} finally { await rm(directory, { recursive: true, force: true }); }
