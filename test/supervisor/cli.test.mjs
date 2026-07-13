import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from '../../scripts/supervisor/config.mjs';
import { defaultState } from '../../scripts/supervisor/state.mjs';
import { runCli } from '../../scripts/supervisor/cli.mjs';

const NOW = 1_800_000_000;

function harness(overrides = {}) {
  let config = defaultConfig();
  let state = defaultState();
  const calls = [];
  const deps = {
    configStore: { read: async () => config, write: async (next) => { config = next; return next; } },
    now: () => NOW,
    preflight: async () => ({ claudePath: 'C:\\Tools\\claude.exe', authenticated: true }),
    install: async () => { calls.push('install'); return { code: 'action:supervisor-installed' }; },
    uninstall: async () => { calls.push('uninstall'); return { code: 'action:supervisor-uninstalled' }; },
    installStatus: async () => ({ installed: true, scheduler: { registered: true, intervalSeconds: 60 } }),
    readObservation: async () => null,
    readStopFailure: async () => null,
    readState: async () => state,
    writeState: async (next) => { state = next; return next; },
    activate: async () => ({ kind: 'success', startedAt: NOW - 1 }),
    runPass: async () => ({ code: 'skip:no-limit-observed' }),
    notify: async () => {},
    output: [],
    writeOutput(text) { this.output.push(text); },
    ...overrides,
  };
  return { deps, calls, get config() { return config; }, get state() { return state; }, set state(next) { state = next; } };
}

test('setup verifies claude, records its path, and installs', async () => {
  const h = harness();
  assert.equal((await runCli(['setup'], h.deps)).code, 0);
  assert.equal(h.config.claudePath, 'C:\\Tools\\claude.exe');
  assert.ok(h.calls.includes('install'));
});

test('enable and disable persist the flag', async () => {
  const h = harness();
  await runCli(['disable'], h.deps);
  assert.equal(h.config.enabled, false);
  await runCli(['enable'], h.deps);
  assert.equal(h.config.enabled, true);
});

test('next-reset reports only a future, unhandled reset', async () => {
  // The afk skill aims its next tick "shortly after" whatever this reports. A
  // past or already-settled reset would aim the tick at an instant that already
  // happened, and the tick would spin on immediate retries.
  const future = { fiveHourResetAt: NOW + 3_000, fiveHourUsedPercentage: 99, observedAt: NOW - 60 };

  const h = harness({ readObservation: async () => future });
  assert.equal((await runCli(['next-reset'], h.deps)).code, 0);
  const reported = JSON.parse(h.deps.output.at(-1));
  assert.equal(reported.resetAt, NOW + 3_000);
  assert.equal(reported.confidence, 'exact');
  assert.equal(reported.now, NOW);

  const past = harness({ readObservation: async () => ({ ...future, fiveHourResetAt: NOW - 300 }) });
  assert.equal((await runCli(['next-reset'], past.deps)).code, 1);
  assert.equal(JSON.parse(past.deps.output.at(-1)).resetAt, null, 'a past reset is not aimable');

  const handled = harness({ readObservation: async () => future });
  handled.state = { ...handled.state, handledResetAt: NOW + 3_000 };
  assert.equal((await runCli(['next-reset'], handled.deps)).code, 1);
  assert.equal(JSON.parse(handled.deps.output.at(-1)).resetAt, null, 'a settled reset is not aimable');
});

test('trigger-now fires one activation and records only a success', async () => {
  const h = harness();
  assert.equal((await runCli(['trigger-now'], h.deps)).code, 0);
  assert.match(h.deps.output.at(-1), /result:activation-success/);
  assert.equal(h.state.windowAnchorAt, NOW - 1, 'anchored at the request start');
  assert.equal(h.state.nextAttemptAt, null);

  const rejected = harness({ activate: async () => ({ kind: 'quota', status: 429, startedAt: NOW }) });
  const before = rejected.state;
  assert.equal((await runCli(['trigger-now'], rejected.deps)).code, 1);
  assert.match(rejected.deps.output.at(-1), /result:activation-quota-rejected/);
  assert.deepEqual(rejected.state, before, 'a rejected manual trigger changes nothing');
});

test('status bundles config, state, scheduler, and the next reset', async () => {
  const h = harness({ readObservation: async () => ({ fiveHourResetAt: NOW + 900, fiveHourUsedPercentage: 99, observedAt: NOW }) });
  assert.equal((await runCli(['status', '--json'], h.deps)).code, 0);
  const value = JSON.parse(h.deps.output.at(-1));
  assert.equal(value.scheduler.registered, true);
  assert.equal(value.nextReset.resetAt, NOW + 900);
  assert.equal(value.config.enabled, true);
});

test('an unknown command fails loudly', async () => {
  const h = harness();
  assert.equal((await runCli(['frobnicate'], h.deps)).code, 2);
  assert.match(h.deps.output.at(-1), /error:unknown-command/);
});
