import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { LOCK_FILE } from './constants.mjs';

const OWNER_FILE = 'owner.json';

export class LockHeldError extends Error {
  constructor(message = 'skip:state-lock-held') {
    super(message);
    this.name = 'LockHeldError';
    this.code = 'LOCK_HELD';
  }
}

// Windows reports a just-unlinked file as EPERM rather than EEXIST or ENOENT
// while its deletion is pending, so a lock built on creating and deleting a file
// cannot tell "held" from "free" from "failed". A directory can: mkdir is atomic
// and exclusive everywhere, and neither mkdir nor rm holds a file handle, so
// there is no delete-pending state to misread.
export const CONTENDED = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function ownerOf(dir) {
  try { return JSON.parse(await readFile(join(dir, OWNER_FILE), 'utf8')); } catch { return null; }
}

async function discard(dir) {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
}

// A read that fails is never evidence that the lock is free: the holder may be
// between creating the directory and writing its record. Only a record that can
// be read and shown to be expired, or a directory older than a whole lock
// lifetime, may be reclaimed — so a crashed holder cannot wedge the supervisor
// forever, and a live one cannot be robbed.
async function reclaimable(dir, now, ttlMs) {
  const owner = await ownerOf(dir);
  if (Number.isFinite(owner?.expiresAt)) return owner.expiresAt <= now();
  const stats = await stat(dir).catch(() => null);
  // A lock we cannot even stat is not a lock we may take. If it truly vanished,
  // the next mkdir succeeds anyway; guessing "free" here would hand the critical
  // section to a second caller and silently drop a state update.
  return stats ? now() - stats.mtimeMs >= ttlMs : false;
}

async function acquire(dir, token, expiresAt, now, ttlMs) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await mkdir(dir);
    } catch (error) {
      // A lock the previous holder is still removing reports as EPERM, not
      // EEXIST. That is contention: the caller waits and retries. Raising it
      // would fail a state transaction, and reading it as a free lock would let
      // a second caller into the critical section.
      if (CONTENDED.has(error.code)) throw new LockHeldError();
      if (error.code !== 'EEXIST') throw error;
      if (!await reclaimable(dir, now, ttlMs)) throw new LockHeldError();
      try { await discard(dir); } catch (discardError) {
        if (CONTENDED.has(discardError.code)) throw new LockHeldError();
        throw discardError;
      }
      continue;
    }
    try {
      await writeFile(join(dir, OWNER_FILE), `${JSON.stringify({ token, expiresAt })}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      // Without a record the lock would look held until its lifetime expired.
      await discard(dir).catch(() => {});
      throw error;
    }
    return;
  }
  throw new LockHeldError();
}

async function release(dir, token) {
  const owner = await ownerOf(dir);
  if (owner?.token !== token) return;
  // The transaction already committed. A lock this holder cannot remove right
  // now expires on its own, so raising here would reject a completed write.
  try { await discard(dir); } catch { /* reclaimed by TTL */ }
}

export async function withFileLock(options, callback) {
  const root = options.root;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 30_000;
  const token = randomUUID();
  const dir = join(root, LOCK_FILE);
  await mkdir(root, { recursive: true });
  await acquire(dir, token, now() + ttlMs, now, ttlMs);
  try {
    return await callback({ token, expiresAt: now() + ttlMs });
  } finally {
    await release(dir, token);
  }
}
