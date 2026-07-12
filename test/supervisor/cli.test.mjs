import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from '../../scripts/supervisor/config.mjs';
import { runCli } from '../../scripts/supervisor/cli.mjs';
import { defaultState } from '../../scripts/supervisor/state-store.mjs';

function harness() {
  let config = defaultConfig();
  let state = defaultState();
  const calls = [];
  const deps = {
    configStore: { read: async () => config, write: async (next) => { config = next; return next; } },
    stateStore: { read: async () => structuredClone(state), update: async (fn) => { state = await fn(structuredClone(state)); state.revision += 1; return state; } },
    install: async () => { calls.push('install'); return { code: 'action:supervisor-installed' }; },
    uninstall: async () => { calls.push('uninstall'); return { code: 'action:supervisor-uninstalled' }; },
    repair: async () => { calls.push('repair'); return { code: 'action:supervisor-repaired' }; },
    installStatus: async () => ({ installed: true, scheduler: { intervalSeconds: 60 } }),
    reconcile: async () => { calls.push('reconcile'); return { code: 'skip:no-active-run' }; },
    now: () => 20_000,
    output: [],
    writeOutput(text) { this.output.push(text); },
  };
  return { deps, calls, get config() { return config; }, get state() { return state; }, set state(next) { state = next; } };
}

test('configure validates values and status reports effective interval', async () => {
  const h = harness();
  assert.equal((await runCli(['configure', '--window-mode', 'auto'], h.deps)).code, 0);
  assert.equal(h.config.windowMode, 'auto');
  const status = await runCli(['status', '--json'], h.deps);
  assert.equal(status.code, 0);
  const value = JSON.parse(h.deps.output.at(-1));
  assert.equal(value.scheduler.intervalSeconds, 60);
  assert.equal(value.config.windowMode, 'auto');
});

test('enable and disable persist config and trigger-now clears quota backoff', async () => {
  const h = harness();
  await runCli(['disable'], h.deps);
  assert.equal(h.config.enabled, false);
  await runCli(['enable'], h.deps);
  assert.equal(h.config.enabled, true);
  const state = defaultState();
  state.runs.one = {
    runId: 'one', state: 'RATE_LIMITED', quotaRejections: { consecutive: 3, backoffLevel: 1, nextProbeAt: 99_000, lastNotifiedAt: 1 },
    scheduledResumeAt: 99_000, scheduleState: 'pending',
  };
  h.state = state;
  await runCli(['trigger-now', '--run-id', 'one'], h.deps);
  assert.equal(h.state.runs.one.quotaRejections.consecutive, 0);
  assert.equal(h.state.runs.one.scheduledResumeAt, 20_000);
  assert.ok(h.calls.includes('reconcile'));
});

test('internal register transition and lease commands update one run', async () => {
  const h = harness();
  const args = ['register', '--run-id', 'one', '--session-id', '00000000-0000-4000-8000-000000000001', '--cwd', 'C:\\repo', '--ledger', 'C:\\repo\\.afk\\afk-ledger.md'];
  assert.equal((await runCli(args, h.deps)).code, 0);
  assert.equal(h.state.runs.one.state, 'RUNNING');
  assert.equal((await runCli(['lease', '--run-id', 'one'], h.deps)).code, 0);
  assert.ok(h.state.runs.one.lease.expiresAt > 20_000);
  assert.equal((await runCli(['lease', '--run-id', 'one'], h.deps)).code, 0);
  assert.equal((await runCli(['transition', '--run-id', 'one', '--state', 'COMPLETED'], h.deps)).code, 0);
  assert.equal(h.state.runs.one.state, 'COMPLETED');
});

test('register resolves a recent SessionStart observation for the cwd', async () => {
  const h = harness();
  h.state.sessions['C:\\repo'] = { sessionId: '00000000-0000-4000-8000-000000000001', observedAt: 19_999 };
  const result = await runCli(['register', '--run-id', 'one', '--cwd', 'C:\\repo', '--ledger', 'C:\\repo\\.afk\\afk-ledger.md'], h.deps);
  assert.equal(result.code, 0);
  assert.equal(h.state.runs.one.sessionId, '00000000-0000-4000-8000-000000000001');
});

test('unknown commands and missing runs emit distinct errors', async () => {
  const h = harness();
  assert.equal((await runCli(['unknown'], h.deps)).code, 2);
  assert.match(h.deps.output.at(-1), /error:unknown-command/);
  assert.equal((await runCli(['trigger-now', '--run-id', 'missing'], h.deps)).code, 1);
  assert.match(h.deps.output.at(-1), /skip:run-not-registered/);
});
