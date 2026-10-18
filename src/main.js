import { PingRoom, PingRoomError } from '@pingroom/sdk';
import { loadEnv, loadConfig } from './config.js';
import { runChecklist } from './checklist.js';
try {
  loadEnv();
  const [operation, ...args] = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--attach-id' || operation !== 'check')) throw new Error('Use npm start, npm run check [-- --attach-id UUID], or npm run find-id.');
  const config = await loadConfig();
  const client = new PingRoom({ token: config.token, baseUrl: 'https://api.pingroom.io', timeoutMs: 5000 });
  const result = await runChecklist({ ...config, client, operation, attachId: args[1] });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'pending' ? 2 : result.status === 'send_unknown' ? 3 : 0;
} catch (error) {
  console.error(error instanceof PingRoomError ? 'PingRoom request failed. Check access, credentials, limits, and network; no completion was recorded.' : error.message);
  process.exitCode = 1;
}
