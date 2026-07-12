import { mkdir, open, readFile, unlink } from 'node:fs/promises';
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

async function acquire(path, token, expiresAt, now) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ token, expiresAt })}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let lock;
      try { lock = JSON.parse(await readFile(path, 'utf8')); } catch { lock = null; }
      if (Number.isFinite(lock?.expiresAt) && lock.expiresAt > now()) throw new LockHeldError();
      try { await unlink(path); } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      }
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
