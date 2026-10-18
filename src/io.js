import { open } from 'node:fs/promises';
/** Limit bytes actually read, including when a file grows after its stat. */
export async function readBounded(path, limit) {
  const file = await open(path, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error('Expected a regular file.');
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > limit) throw new Error(`File exceeds ${limit} bytes.`);
    return buffer.subarray(0, used).toString('utf8');
  } finally { await file.close(); }
}
