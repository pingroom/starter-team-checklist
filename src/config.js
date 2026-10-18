import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validateChecklist } from './checklist.js';
import { readBounded } from './io.js';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const credentialsPath = resolve(root, '.pingroom/credentials.json');
export function loadEnv() {
  try { process.loadEnvFile(resolve(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read project .env.'); }
}
export async function loadCredentials(env = process.env, path = credentialsPath) {
  let token, room;
  if (env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined) { token = env.PINGROOM_TOKEN; room = env.PINGROOM_ROOM; }
  else {
    try { ({ token, room } = JSON.parse(await readBounded(path, 16_384))); }
    catch { throw new Error('Run npm run connect or supply a complete environment credential pair.'); }
  }
  if (typeof token !== 'string' || !token.trim() || typeof room !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(room.trim())) throw new Error('Provide both nonblank PINGROOM_TOKEN and PINGROOM_ROOM; partial pairs never borrow saved values.');
  return { token: token.trim(), room: room.trim().toUpperCase() };
}
export async function loadConfig(env = process.env) {
  const path = resolve(root, env.CHECKLIST_FILE || 'checklist.json');
  return { ...await loadCredentials(env), checklist: validateChecklist(JSON.parse(await readBounded(path, 16_384))),
    directory: resolve(root, env.STATE_DIR || '.checklists'), receiptDirectory: resolve(root, env.RECEIPT_DIR || 'receipts') };
}
