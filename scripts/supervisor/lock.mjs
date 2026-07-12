import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { LOCK_FILE } from './constants.mjs';

export class LockHeldError extends Error {
  constructor(message = 'skip:recovery-lease-held') {
    super(message);
    this.name = 'LockHeldError';
    this.code = 'LOCK_HELD';
  }
}

// Creating the lock file and writing its record are two steps. If the record
// were written in place, a concurrent acquirer could read the file between them,
// see empty content, judge it corrupt, and steal a lock that is alive. The
// record is therefore written to a private file and published with link(), which
// fails when the lock exists and otherwise makes it visible fully written.
async function publish(path, record) {
  const temp = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temp, path);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  } finally {
    try { await unlink(temp); } catch { /* the record is published or discarded */ }
  }
}

async function acquire(path, token, expiresAt, now) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await publish(path, { token, expiresAt })) return;
    let lock;
    try { lock = JSON.parse(await readFile(path, 'utf8')); } catch { lock = null; }
    if (Number.isFinite(lock?.expiresAt) && lock.expiresAt > now()) throw new LockHeldError();
    try { await unlink(path); } catch (unlinkError) {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    }
  }
  throw new LockHeldError();
}

async function release(path, token) {
  let lock;
  try { lock = JSON.parse(await readFile(path, 'utf8')); } catch { return; }
  if (lock.token !== token) return;
  try { await unlink(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function withFileLock(options, callback) {
  const root = options.root;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 30_000;
  const token = randomUUID();
  const path = join(root, LOCK_FILE);
  await mkdir(root, { recursive: true });
  await acquire(path, token, now() + ttlMs, now);
  try {
    return await callback({ token, expiresAt: now() + ttlMs });
  } finally {
    await release(path, token);
  }
}
