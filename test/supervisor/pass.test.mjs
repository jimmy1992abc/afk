import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from '../../scripts/supervisor/config.mjs';
import { defaultState } from '../../scripts/supervisor/state.mjs';
import { decide, resolveReset, runPass } from '../../scripts/supervisor/pass.mjs';

const config = defaultConfig();
const NOW = 1_800_000_000;
const WINDOW = 18_000;

function state(overrides = {}) {
  return { ...defaultState(), ...overrides };
}

test('resolveReset: which reset, and how sure', () => {
  const cases = [
    ['nothing observed', { observation: null, stopFailure: null, state: state() }, null],
    ['a healthy session reports a reset time; that alone is not exhaustion',
      { observation: { fiveHourResetAt: NOW + 900, fiveHourUsedPercentage: 40, observedAt: NOW }, stopFailure: null, state: state() }, null],
    ['an exhausted exact snapshot',
      { observation: { fiveHourResetAt: NOW + 900, fiveHourUsedPercentage: 99, observedAt: NOW }, stopFailure: null, state: state() },
      { resetAt: NOW + 900, confidence: 'exact' }],
    ['a StopFailure alone: reset is at most one window later',
      { observation: null, stopFailure: { limitedAt: NOW }, state: state() },
      { resetAt: NOW + WINDOW, confidence: 'estimated' }],
    ['a StopFailure tightened by the known window anchor',
      { observation: null, stopFailure: { limitedAt: NOW }, state: state({ windowAnchorAt: NOW - 7_200 }) },
      { resetAt: NOW - 7_200 + WINDOW, confidence: 'estimated' }],
    ['an anchor from a previous window does not apply',
      { observation: null, stopFailure: { limitedAt: NOW }, state: state({ windowAnchorAt: NOW - WINDOW - 50 }) },
      { resetAt: NOW + WINDOW, confidence: 'estimated' }],
    ['an exact reading for the same episode beats the estimate',
      { observation: { fiveHourResetAt: NOW + 3_000, fiveHourUsedPercentage: null, observedAt: NOW }, stopFailure: { limitedAt: NOW - 60 }, state: state() },
      { resetAt: NOW + 3_000, confidence: 'exact' }],
    ['a newer StopFailure episode beats a stale exact snapshot',
      { observation: { fiveHourResetAt: NOW - 40_000, fiveHourUsedPercentage: 99, observedAt: NOW - 44_000 }, stopFailure: { limitedAt: NOW }, state: state() },
      { resetAt: NOW + WINDOW, confidence: 'estimated' }],
  ];
  for (const [name, input, expected] of cases) {
    assert.deepEqual(resolveReset({ ...input, config }), expected, name);
  }
});

test('decide: the gates, in order', () => {
  const exhausted = { fiveHourResetAt: NOW - 200, fiveHourUsedPercentage: 99, observedAt: NOW - 3_000 };
  const cases = [
    ['disabled', { config: { ...config, enabled: false } }, 'skip:disabled'],
    ['no evidence', { observation: null }, 'skip:no-limit-observed'],
    ['already handled', { state: state({ handledResetAt: NOW - 200 }) }, 'skip:reset-already-handled'],
    ['not yet due', { observation: { ...exhausted, fiveHourResetAt: NOW + 600 } }, 'skip:reset-not-due'],
    ['too long past: written off, never fired', { observation: { ...exhausted, fiveHourResetAt: NOW - config.staleResetSeconds - 1 } }, 'action:mark-stale'],
    ['attempts cap', { state: state({ attempts: Array.from({ length: config.maxAttemptsPerReset }, () => ({ at: NOW - 60, resetAt: NOW - 200, result: 'failure' })) }) }, 'skip:attempts-exhausted'],
    ['retry backoff', { state: state({ nextAttemptAt: NOW + 120 }) }, 'skip:retry-backoff'],
    ['fire', {}, 'action:activate'],
  ];
  for (const [name, overrides, expected] of cases) {
    const input = {
      observation: exhausted, stopFailure: null, state: state(), config, now: NOW,
      ...overrides,
    };
    assert.equal(decide(input).code, expected, name);
  }
});

function harness({ observation, stopFailure, initial = state(), activate }) {
  const writes = [];
  const notifications = [];
  let current = initial;
  return {
    writes,
    notifications,
    get state() { return current; },
    deps: {
      config,
      now: () => NOW,
      readObservation: async () => observation ?? null,
      readStopFailure: async () => stopFailure ?? null,
      readState: async () => current,
      writeState: async (next) => { writes.push(next); current = next; return next; },
      activate: activate ?? (async () => { throw new Error('activate must not be called'); }),
      notify: async (title, message) => { notifications.push({ title, message }); },
    },
  };
}

const EXHAUSTED = { fiveHourResetAt: NOW - 200, fiveHourUsedPercentage: 99, observedAt: NOW - 3_000 };

test('a successful activation settles the reset and anchors the window at the request start', async () => {
  const h = harness({ observation: EXHAUSTED, activate: async () => ({ kind: 'success', startedAt: NOW - 2 }) });
  const result = await runPass(h.deps);
  assert.equal(result.code, 'result:activation-success');
  assert.equal(h.state.handledResetAt, NOW - 200);
  assert.equal(h.state.windowAnchorAt, NOW - 2, 'the window opens at the request START, not its finish');
  assert.equal(h.state.nextAttemptAt, null);
  assert.equal(h.state.attempts.length, 1);
});

test('a quota rejection means the estimate was early: back off, do not settle', async () => {
  const h = harness({
    observation: null, stopFailure: { limitedAt: NOW - WINDOW - 100 },
    activate: async () => ({ kind: 'quota', status: 429, startedAt: NOW }),
  });
  const result = await runPass(h.deps);
  assert.equal(result.code, 'result:activation-quota-rejected');
  assert.equal(h.state.handledResetAt, null, 'the reset stays open so a later pass retries');
  assert.equal(h.state.nextAttemptAt, NOW + config.retryBackoffSeconds[0]);

  // The second failure climbs the ladder.
  h.deps.now = () => NOW + config.retryBackoffSeconds[0] + 1;
  await runPass(h.deps);
  assert.equal(h.state.nextAttemptAt, NOW + config.retryBackoffSeconds[0] + 1 + config.retryBackoffSeconds[1]);
});

test('a stale reset is written off without spending a request', async () => {
  const h = harness({ observation: { ...EXHAUSTED, fiveHourResetAt: NOW - config.staleResetSeconds - 1 } });
  const result = await runPass(h.deps);
  assert.equal(result.code, 'skip:reset-stale');
  assert.equal(h.state.handledResetAt, NOW - config.staleResetSeconds - 1);
});

test('an exhausted reset notifies the operator exactly once', async () => {
  const spent = Array.from({ length: config.maxAttemptsPerReset }, () => ({ at: NOW - 60, resetAt: NOW - 200, result: 'failure' }));
  const h = harness({ observation: EXHAUSTED, initial: state({ attempts: spent }) });

  assert.equal((await runPass(h.deps)).code, 'skip:attempts-exhausted');
  assert.equal(h.notifications.length, 1, 'the operator hears about a dead reset once');
  assert.equal(h.state.notifiedAt, NOW);

  assert.equal((await runPass(h.deps)).code, 'skip:attempts-exhausted');
  assert.equal(h.notifications.length, 1, '...not once per minute for ever');

  // A drifting estimate must not re-arm it either: the suppression is by time,
  // not by which resetAt the notification happened to be filed under.
  const drifted = harness({
    observation: { ...EXHAUSTED, fiveHourResetAt: NOW - 170 },
    initial: state({ attempts: spent, notifiedAt: NOW - 60 }),
  });
  assert.equal((await runPass(drifted.deps)).code, 'skip:attempts-exhausted');
  assert.equal(drifted.notifications.length, 0, 'a 30s refinement is the same dead reset');
});

test('a refined estimate does not forget the attempts cap', async () => {
  // Attempts were keyed by exact resetAt equality, so thirty seconds of estimate
  // drift between passes read four spent attempts as zero and the cap restarted.
  // Attempts belong to a reset by TIME — consecutive resets are at least one full
  // window apart, so everything fired at-or-after this reset is this reset's.
  const spent = Array.from({ length: config.maxAttemptsPerReset }, () => ({ at: NOW - 60, resetAt: NOW - 200, result: 'quota' }));
  const h = harness({
    observation: { ...EXHAUSTED, fiveHourResetAt: NOW - 230 },   // refined by 30s
    initial: state({ attempts: spent }),
  });
  assert.equal((await runPass(h.deps)).code, 'skip:attempts-exhausted');
});

test('an exact reading at the very moment of the failure still beats the estimate', async () => {
  // The same-episode check used a strict `>`: at exact equality the exact reading
  // lost to the +5h estimate via later-reset-wins, and activation ran up to five
  // hours late on a boundary that real clocks do hit.
  const target = resolveReset({
    observation: { fiveHourResetAt: NOW, fiveHourUsedPercentage: null, observedAt: NOW },
    stopFailure: { limitedAt: NOW },
    state: state(),
    config,
  });
  assert.deepEqual(target, { resetAt: NOW, confidence: 'exact' });
});

test('a pass with nothing to do writes nothing', async () => {
  const h = harness({ observation: { ...EXHAUSTED, fiveHourResetAt: NOW + 600 } });
  assert.equal((await runPass(h.deps)).code, 'skip:reset-not-due');
  assert.deepEqual(h.writes, [], 'idle passes must not churn the state file');
});
