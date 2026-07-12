import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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

// Reclaiming by deleting the directory is not safe: `reclaimable()` is a read,
// so two contenders can both judge the same expired lock reclaimable, one of them
// reclaims and becomes the live holder, and the other's delete then destroys that
// live lock — putting two callers in the critical section.
//
// The steal is therefore an atomic rename. Only one contender can move a given
// directory, and the winner re-checks what it actually moved: if a live holder
// had recreated the lock in the meantime, the winner moved *their* directory and
// puts it straight back. Deleting only ever happens to a directory this process
// exclusively owns.
export async function steal(dir, now, ttlMs) {
  const tombstone = `${dir}.stale-${randomUUID()}`;
  try {
    await rename(dir, tombstone);
  } catch {
    // Another contender moved it first, or it is momentarily unmovable.
    throw new LockHeldError();
  }
  if (!await reclaimable(tombstone, now, ttlMs)) {
    try {
      await rename(tombstone, dir);
    } catch {
      // A third party took the vacant path while we were putting this back. The
      // tombstone is ours alone now and is not a lock, so it must not be left
      // behind: nothing else ever sweeps it.
      await discard(tombstone).catch(() => {});
    }
    throw new LockHeldError();
  }
  await discard(tombstone);
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
      await steal(dir, now, ttlMs);
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

// The last line of defence. Even an atomic steal leaves a hair-thin window in
// which a holder can be displaced, and two holders that both pass the revision
// compare-and-set lose a write silently. A holder that checks the lock still
// names it before committing turns that silent loss into a retry.
export async function holdsLock(root, token) {
  const owner = await ownerOf(join(root, LOCK_FILE));
  return owner?.token === token;
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
