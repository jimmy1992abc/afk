import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LockHeldError, withFileLock } from '../../scripts/supervisor/lock.mjs';
import { StateStore } from '../../scripts/supervisor/state-store.mjs';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'afk-supervisor-lock-'));
}

test('withFileLock releases the lock after success', async () => {
  const root = await tempRoot();
  assert.equal(await withFileLock({ root }, async () => 'ok'), 'ok');
  assert.equal(await withFileLock({ root }, async () => 'again'), 'again');
});

test('live lock is retained and reports its distinct reason', async () => {
  const root = await tempRoot();
  await writeFile(join(root, 'state.lock'), JSON.stringify({ token: 'live', expiresAt: Date.now() + 60_000 }));
  await assert.rejects(() => withFileLock({ root }, async () => 'no'), LockHeldError);
});

test('stale lock is replaced', async () => {
  const root = await tempRoot();
  await writeFile(join(root, 'state.lock'), JSON.stringify({ token: 'old', expiresAt: 999 }));
  const value = await withFileLock({ root, now: () => 1_000 }, async () => 'ok');
  assert.equal(value, 'ok');
});

test('a held lock is never observable as a partially written record', async () => {
  const root = await tempRoot();
  // The old lock created the file and wrote the record afterwards, so a
  // concurrent acquirer could read it empty, judge it corrupt, and steal a live
  // lock. The record must be complete the moment the lock path exists.
  await withFileLock({ root }, async () => {
    const record = JSON.parse(await readFile(join(root, 'state.lock'), 'utf8'));
    assert.equal(typeof record.token, 'string');
    assert.ok(Number.isFinite(record.expiresAt));
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

test('lock is released when callback throws', async () => {
  const root = await tempRoot();
  await assert.rejects(() => withFileLock({ root }, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await withFileLock({ root }, async () => 'recovered'), 'recovered');
});
