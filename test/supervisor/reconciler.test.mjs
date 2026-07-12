import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { defaultConfig } from '../../scripts/supervisor/config.mjs';
import { reconcileOnce } from '../../scripts/supervisor/reconciler.mjs';
import { StateStore } from '../../scripts/supervisor/state-store.mjs';

const now = 20_000;

async function harness(run, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'afk-supervisor-reconcile-'));
  const store = new StateStore(root);
  await store.update((state) => ({ ...state, runs: { [run.runId]: run } }));
  const spawnCalls = [];
  return {
    store,
    spawnCalls,
    deps: {
      store, config: defaultConfig(), now: () => now,
      readObservationBatch: async () => [], commitObservationBatch: async () => {},
      readHeartbeats: async () => ({}), readLedgerHeartbeat: async () => null,
      spawnRunner: (attempt) => { spawnCalls.push(attempt); return { unref() {} }; },
      randomUUID: () => 'attempt-1',
      ...overrides,
    },
  };
}

function run(overrides = {}) {
  return {
    runId: 'run-1', sessionId: '00000000-0000-4000-8000-000000000001',
    state: 'RUNNING', cwd: 'C:\\repo', ledgerPath: 'C:\\repo\\.afk\\afk-ledger.md',
    lastHeartbeatAt: now - 2_000, nextExpectedTickAt: now - 500,
    scheduledResetAt: null, scheduledResumeAt: null, scheduleState: null,
    lease: { attemptId: null, token: null, expiresAt: null }, retry: { attempts: 0, nextAttemptAt: null },
    quotaRejections: { consecutive: 0, backoffLevel: 0, nextProbeAt: null },
    ...overrides,
  };
}

test('reconciler leases and detached-spawns one stale run', async () => {
  const h = await harness(run());
  const result = await reconcileOnce(h.deps);
  assert.equal(result.code, 'action:runner-started');
  assert.equal(h.spawnCalls.length, 1);
  assert.equal((await h.store.read()).runs['run-1'].state, 'RECOVERING');
});

test('fresh heartbeat after provisional selection prevents spawn', async () => {
  const h = await harness(run(), { readLedgerHeartbeat: async () => now });
  const result = await reconcileOnce(h.deps);
  assert.equal(result.code, 'skip:heartbeat-fresh');
  assert.equal(h.spawnCalls.length, 0);
});

test('post-reset heartbeat handles schedule without spawn', async () => {
  const h = await harness(run({ scheduledResetAt: now - 100, scheduledResumeAt: now - 10, scheduleState: 'pending' }), {
    readLedgerHeartbeat: async () => now - 50,
  });
  const result = await reconcileOnce(h.deps);
  assert.equal(result.code, 'skip:heartbeat-satisfied-reset');
  assert.equal(h.spawnCalls.length, 0);
  assert.equal((await h.store.read()).runs['run-1'].scheduleState, 'handled');
});

test('dry run reports action without writing lease or spawning', async () => {
  const h = await harness(run(), { dryRun: true });
  const before = await h.store.read();
  const result = await reconcileOnce(h.deps);
  assert.equal(result.code, 'action:would-start-runner');
  assert.equal(h.spawnCalls.length, 0);
  assert.equal((await h.store.read()).runs['run-1'].lease.attemptId, before.runs['run-1'].lease.attemptId);
});
