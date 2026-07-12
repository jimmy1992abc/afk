import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  StateConflictError,
  StateStore,
  defaultState,
  migrateState,
} from '../../scripts/supervisor/state-store.mjs';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'afk-supervisor-state-'));
}

test('default state is schema version one with revision zero', () => {
  const state = defaultState();
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.runs, {});
  assert.equal(state.usage.confidence, 'unknown');
});

test('write increments revision and rejects stale compare-and-set', async () => {
  const root = await tempRoot();
  const store = new StateStore(root);
  const initial = await store.read();
  const saved = await store.write({
    ...initial,
    usage: { ...initial.usage, confidence: 'estimated' },
  }, 0);

  assert.equal(saved.revision, 1);
  await assert.rejects(() => store.write(initial, 0), StateConflictError);
});

test('update retries a revision conflict and commits once', async () => {
  const root = await tempRoot();
  const store = new StateStore(root);
  let calls = 0;
  const saved = await store.update((state) => {
    calls += 1;
    return { ...state, activation: { ...state.activation, lastResult: 'ok' } };
  });

  assert.equal(calls, 1);
  assert.equal(saved.revision, 1);
  assert.equal(saved.activation.lastResult, 'ok');
});

test('two writers for one revision cannot both commit', async () => {
  const root = await tempRoot();
  const first = new StateStore(root);
  const second = new StateStore(root);
  const initial = await first.read();
  const results = await Promise.allSettled([
    first.write({ ...initial, marker: 'first' }, 0),
    second.write({ ...initial, marker: 'second' }, 0),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason instanceof StateConflictError).length, 1);
});

test('corrupt state is quarantined and fails closed to a clean state', async () => {
  const root = await tempRoot();
  await writeFile(join(root, 'state.json'), '{bad json', 'utf8');
  const store = new StateStore(root, { now: () => 1234 });
  const state = await store.read();

  assert.deepEqual(state, defaultState());
  const quarantined = await readFile(join(root, 'state.corrupt-1234.json'), 'utf8');
  assert.equal(quarantined, '{bad json');
});

test('migrateState preserves unknown fields and fills schema defaults', () => {
  const migrated = migrateState({ schemaVersion: 0, custom: { keep: true } });
  assert.equal(migrated.schemaVersion, 1);
  assert.deepEqual(migrated.custom, { keep: true });
  assert.deepEqual(migrated.runs, {});
});
