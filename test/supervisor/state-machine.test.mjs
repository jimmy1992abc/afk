import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from '../../scripts/supervisor/config.mjs';
import { defaultState } from '../../scripts/supervisor/state-store.mjs';
import { selectCandidate, transitionRun } from '../../scripts/supervisor/state-machine.mjs';

const config = defaultConfig();
const now = 20_000;

function run(overrides = {}) {
  return {
    runId: 'run-1', sessionId: '00000000-0000-4000-8000-000000000001',
    state: 'RUNNING', lastHeartbeatAt: now - 2_000, nextExpectedTickAt: now - 500,
    firstRateLimitedAt: null, rateLimitedUntil: null, scheduledResumeAt: null,
    scheduledResetAt: null, scheduleState: null, scheduleConfidence: null,
    lease: { attemptId: null, token: null, lastRenewedAt: null, expiresAt: null },
    retry: { attempts: 0, nextAttemptAt: null },
    quotaRejections: { consecutive: 0, backoffLevel: 0, nextProbeAt: null },
    ...overrides,
  };
}

function stateWith(item) {
  const state = defaultState();
  state.runs[item.runId] = item;
  return state;
}

test('run transitions enforce terminal states', () => {
  assert.equal(transitionRun(run(), 'RATE_LIMITED').state, 'RATE_LIMITED');
  assert.equal(transitionRun(run({ state: 'RECOVERING' }), 'RUNNING').state, 'RUNNING');
  assert.throws(() => transitionRun(run({ state: 'COMPLETED' }), 'RUNNING'), /invalid run transition/);
});

test('stale anchor falls back to first-rate-limit upper bound', () => {
  const item = run({
    state: 'RATE_LIMITED', firstRateLimitedAt: 10_000, rateLimitedUntil: null,
    scheduledResumeAt: null, scheduledResetAt: null,
  });
  const state = stateWith(item);
  state.usage.windowAnchorAt = 1_000;
  const decision = selectCandidate(state, {}, config, 28_100);
  assert.equal(decision.runId, 'run-1');
  assert.equal(decision.dueAt, 28_000 + config.graceSeconds);
});

test('post-reset heartbeat satisfies a due schedule', () => {
  const item = run({ scheduledResetAt: 19_000, scheduledResumeAt: 19_100, scheduleState: 'pending' });
  const decision = selectCandidate(stateWith(item), { heartbeats: { 'run-1': 19_001 } }, config, now);
  assert.equal(decision.code, 'skip:heartbeat-satisfied-reset');
  assert.equal(decision.kind, 'handle');
});

test('fresh pre-reset heartbeat defers without discarding schedule', () => {
  const item = run({ scheduledResetAt: 19_900, scheduledResumeAt: 19_950, scheduleState: 'pending' });
  const decision = selectCandidate(stateWith(item), { heartbeats: { 'run-1': 19_800 } }, config, now);
  assert.equal(decision.code, 'skip:heartbeat-fresh');
});

test('active lease capacity and seven-day suppression have distinct skips', () => {
  const leased = stateWith(run({ lease: { attemptId: 'a', token: 't', expiresAt: now + 10 } }));
  assert.equal(selectCandidate(leased, {}, config, now).code, 'skip:concurrency-exhausted');
  const weekly = stateWith(run());
  weekly.usage.sevenDaySuppressedUntil = now + 10;
  assert.equal(selectCandidate(weekly, {}, config, now).code, 'skip:seven-day-limit');
});

test('quota backoff and estimate-not-due have distinct skips', () => {
  const backedOff = stateWith(run({ quotaRejections: { consecutive: 3, backoffLevel: 1, nextProbeAt: now + 10 } }));
  assert.equal(selectCandidate(backedOff, {}, config, now).code, 'skip:quota-backoff');
  const estimate = stateWith(run({ state: 'RATE_LIMITED', rateLimitedUntil: now + 10, resetConfidence: 'estimated' }));
  assert.equal(selectCandidate(estimate, {}, config, now).code, 'skip:estimate-not-due');
});

test('exhausted ordinary recovery attempts are not selected again', () => {
  const exhausted = stateWith(run({ state: 'FAILED', retry: { attempts: config.maxRecoveryAttempts, nextAttemptAt: null } }));
  assert.equal(selectCandidate(exhausted, {}, config, now).code, 'skip:recovery-attempts-exhausted');
});
