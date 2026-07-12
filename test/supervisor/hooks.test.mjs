import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { defaultConfig } from '../../scripts/supervisor/config.mjs';
import { handleHook } from '../../scripts/supervisor/hook-handler.mjs';
import { renderSupervisorLedgerBlock } from '../../scripts/supervisor/ledger.mjs';
import { StateStore } from '../../scripts/supervisor/state-store.mjs';

const now = 10_000;
const sessionId = '00000000-0000-4000-8000-000000000001';

async function harness(metadata = {}) {
  const root = await mkdtemp(join(tmpdir(), 'afk-supervisor-hooks-'));
  const cwd = join(root, 'repo');
  await mkdir(join(cwd, '.afk'), { recursive: true });
  const base = {
    schemaVersion: 1, runId: 'run-1', sessionId, state: 'RUNNING',
    heartbeatAt: now - 10, nextExpectedTickAt: now + 890, unfinished: true,
    ...metadata,
  };
  await writeFile(join(cwd, '.afk', 'afk-ledger.md'), renderSupervisorLedgerBlock(base), 'utf8');
  const store = new StateStore(join(root, 'global'));
  const spawnCalls = [];
  return {
    root, cwd, store, spawnCalls,
    deps: {
      store,
      config: defaultConfig(),
      now: () => now,
      spawn: (...args) => spawnCalls.push(args),
      readFile: async (path) => (await import('node:fs/promises')).readFile(path, 'utf8'),
    },
  };
}

function sessionStart(cwd) {
  return { hook_event_name: 'SessionStart', session_id: sessionId, cwd, transcript_path: 'ignored' };
}

test('SessionStart reconstructs only recent explicit unfinished runs', async () => {
  const active = await harness();
  assert.equal((await handleHook(sessionStart(active.cwd), active.deps)).code, 'action:run-reconstructed');
  assert.equal((await active.store.read()).runs['run-1'].state, 'RUNNING');
  assert.equal(active.spawnCalls.length, 0);

  const completed = await harness({ state: 'COMPLETED' });
  assert.equal((await handleHook(sessionStart(completed.cwd), completed.deps)).code, 'skip:ledger-not-recoverable');
  const old = await harness({ heartbeatAt: now - defaultConfig().registrationRecoveryMaxAgeSeconds - 1 });
  assert.equal((await handleHook(sessionStart(old.cwd), old.deps)).code, 'skip:ledger-stale');
});

test('SessionStart from supervisor resume updates metadata but never spawns', async () => {
  const active = await harness();
  await active.store.update((state) => ({
    ...state,
    runs: { 'run-1': { runId: 'run-1', sessionId, state: 'RUNNING', cwd: active.cwd } },
  }));
  const result = await handleHook({ ...sessionStart(active.cwd), source: 'resume' }, active.deps);
  assert.equal(result.code, 'action:run-reconciled');
  assert.equal(active.spawnCalls.length, 0);
});

test('rate-limit StopFailure records upper bound without spawning', async () => {
  const active = await harness();
  await handleHook(sessionStart(active.cwd), active.deps);
  const result = await handleHook({
    hook_event_name: 'StopFailure', session_id: sessionId, cwd: active.cwd,
    transcript_path: 'ignored', error: 'rate_limit', error_details: '429',
  }, active.deps);
  const run = (await active.store.read()).runs['run-1'];
  assert.equal(result.code, 'result:quota-rescheduled');
  assert.equal(run.state, 'RATE_LIMITED');
  assert.equal(run.firstRateLimitedAt, now);
  assert.equal(run.rateLimitedUntil, now + 18_000);
  assert.equal(active.spawnCalls.length, 0);
});

test('unrelated hook event and unregistered failure have distinct skips', async () => {
  const active = await harness();
  assert.equal((await handleHook({ hook_event_name: 'Stop' }, active.deps)).code, 'skip:hook-event-ignored');
  assert.equal((await handleHook({ hook_event_name: 'StopFailure', error: 'rate_limit', session_id: sessionId }, active.deps)).code, 'skip:run-not-registered');
});
