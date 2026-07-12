import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LockHeldError, holdsLock, steal, withFileLock } from '../../scripts/supervisor/lock.mjs';
import { StateStore } from '../../scripts/supervisor/state-store.mjs';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'afk-supervisor-lock-'));
}

async function heldBy(root, owner) {
  const dir = join(root, 'state.lock');
  await mkdir(dir, { recursive: true });
  if (owner) await writeFile(join(dir, 'owner.json'), JSON.stringify(owner));
  return dir;
}

test('withFileLock releases the lock after success', async () => {
  const root = await tempRoot();
  assert.equal(await withFileLock({ root }, async () => 'ok'), 'ok');
  assert.equal(await withFileLock({ root }, async () => 'again'), 'again');
});

test('live lock is retained and reports its distinct reason', async () => {
  const root = await tempRoot();
  await heldBy(root, { token: 'live', expiresAt: Date.now() + 60_000 });
  await assert.rejects(() => withFileLock({ root }, async () => 'no'), LockHeldError);
});

test('stale lock is replaced', async () => {
  const root = await tempRoot();
  await heldBy(root, { token: 'old', expiresAt: 999 });
  assert.equal(await withFileLock({ root, now: () => 1_000 }, async () => 'ok'), 'ok');
});

test('a lock with no readable record counts as held rather than abandoned', async () => {
  const root = await tempRoot();
  // What a holder looks like between taking the lock and writing its record.
  // Reading that as a free lock lets a second caller into the critical section.
  await heldBy(root, null);
  await assert.rejects(() => withFileLock({ root }, async () => 'no'), LockHeldError);
});

test('a lock with no readable record is still reclaimed once it outlives a lock lifetime', async () => {
  const root = await tempRoot();
  await heldBy(root, null);
  const later = Date.now() + 60_000;
  assert.equal(await withFileLock({ root, now: () => later }, async () => 'ok'), 'ok');
});

test('a held lock names its holder', async () => {
  const root = await tempRoot();
  await withFileLock({ root }, async () => {
    const owner = JSON.parse(await readFile(join(root, 'state.lock', 'owner.json'), 'utf8'));
    assert.equal(typeof owner.token, 'string');
    assert.ok(Number.isFinite(owner.expiresAt));
  });
});

test('concurrent updates through the lock never lose a write', async () => {
  const root = await tempRoot();
  const store = new StateStore(root);
  await store.update((state) => state);
  await Promise.all(Array.from({ length: 12 }, () => store.update((state) => {
    state.usage.fiveHourUsedPercentage = (state.usage.fiveHourUsedPercentage ?? 0) + 1;
    return state;
  })));
  assert.equal((await store.read()).usage.fiveHourUsedPercentage, 12);
});

test('a holder can tell whether the lock still names it', async () => {
  // The fence a holder checks before committing. Two holders both pass the
  // revision compare and the loser's write vanishes with no error at all, so a
  // displaced holder has to be able to notice and retry.
  const root = await tempRoot();
  await withFileLock({ root }, async ({ token }) => {
    assert.equal(await holdsLock(root, token), true);
    assert.equal(await holdsLock(root, 'someone-else'), false);
  });
  assert.equal(await holdsLock(root, 'anyone'), false, 'a released lock names nobody');
});

test('a reclaim that finds a live lock puts it straight back', async () => {
  // The S1 interleaving: two contenders both read the same expired record and
  // both decide it is reclaimable. One reclaims and becomes the live holder; the
  // other now acts on its stale decision. Reclaiming by deleting destroys the
  // live lock and puts two callers in the critical section. Reclaiming by an
  // atomic rename lets the loser notice what it actually moved and give it back.
  const root = await tempRoot();
  const dir = join(root, 'state.lock');
  await heldBy(root, { token: 'live-holder', expiresAt: 1_000_000 });

  await assert.rejects(() => steal(dir, () => 1_000, 30_000), LockHeldError);

  const owner = JSON.parse(await readFile(join(dir, 'owner.json'), 'utf8'));
  assert.equal(owner.token, 'live-holder', 'the live holder must still own its lock');
  assert.ok(await stat(dir).then(() => true, () => false), 'and its directory must still exist');
});

test('a reclaim of a genuinely expired lock removes it', async () => {
  const root = await tempRoot();
  const dir = join(root, 'state.lock');
  await heldBy(root, { token: 'expired', expiresAt: 999 });
  await steal(dir, () => 1_000, 30_000);
  assert.equal(await stat(dir).then(() => true, () => false), false);
});

test('lock is released when callback throws', async () => {
  const root = await tempRoot();
  await assert.rejects(() => withFileLock({ root }, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await withFileLock({ root }, async () => 'recovered'), 'recovered');
});
