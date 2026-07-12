import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LockHeldError, withFileLock } from '../../scripts/supervisor/lock.mjs';

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

test('lock is released when callback throws', async () => {
  const root = await tempRoot();
  await assert.rejects(() => withFileLock({ root }, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await withFileLock({ root }, async () => 'recovered'), 'recovered');
});
