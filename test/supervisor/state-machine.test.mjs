import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from '../../scripts/supervisor/config.mjs';
import { defaultState } from '../../scripts/supervisor/state-store.mjs';
import { pruneState, selectCandidate, transitionRun } from '../../scripts/supervisor/state-machine.mjs';

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

test('seven-day suppression also blocks empty-window activation', () => {
  const state = defaultState();
  state.usage = {
    ...state.usage, confidence: 'exact', fiveHourResetAt: 19_000, sevenDaySuppressedUntil: 500_000,
  };
  const decision = selectCandidate(state, {}, { ...config, windowMode: 'auto' }, now);
  assert.equal(decision.code, 'skip:seven-day-limit');
});

test('a healthy run never starves the other due runs behind it', () => {
  // Ordered first by scheduledResumeAt, still working, so not itself recoverable.
  const busy = run({
    runId: 'busy', scheduledResumeAt: 100, scheduledResetAt: now - 5, scheduleState: 'pending',
    lastHeartbeatAt: now - 10,
  });
  const stranded = run({
    runId: 'stranded', sessionId: '00000000-0000-4000-8000-000000000002',
    state: 'RATE_LIMITED', rateLimitedUntil: now - 1_000, resetConfidence: 'exact',
    lastHeartbeatAt: now - config.heartbeatStaleSeconds - 1,
  });
  const state = stateWith(busy);
  state.runs.stranded = stranded;
  const decision = selectCandidate(state, {}, config, now);
  assert.equal(decision.kind, 'invoke');
  assert.equal(decision.runId, 'stranded');
});

test('a heartbeat from the future is a clock artefact, not progress', () => {
  const item = run({
    lastHeartbeatAt: now + 10_000,
    scheduledResumeAt: now - 100, scheduledResetAt: now - 200, scheduleState: 'pending',
  });
  const decision = selectCandidate(stateWith(item), {}, config, now);
  assert.equal(decision.kind, 'invoke', 'a future heartbeat must not mark the run fresh for ever');
});

test('a running activation occupies the one invocation slot', () => {
  // Its Claude child lives as long as any recovery. Counting only run leases
  // would let a run be leased alongside it, so two Claudes run at once.
  const state = stateWith(run({ lastHeartbeatAt: now - config.heartbeatStaleSeconds - 1, nextExpectedTickAt: null }));
  state.activation = { ...state.activation, inProgress: true, expiresAt: now + 180 };
  assert.equal(selectCandidate(state, {}, config, now).code, 'skip:concurrency-exhausted');
});

test('a run whose state the code does not know is never selected', () => {
  // Selecting it reaches transitionRun, which throws, and the exception escapes
  // the store update and kills every reconcile pass from then on.
  const item = run({ state: 'NONSENSE', lastHeartbeatAt: now - 99_999, nextExpectedTickAt: null });
  assert.doesNotThrow(() => selectCandidate(stateWith(item), {}, config, now));
  assert.notEqual(selectCandidate(stateWith(item), {}, config, now).kind, 'invoke');
});

test('activeRunRecovery off actually stops recovering runs', () => {
  // It was validated, settable, and documented — and read by nothing.
  const item = run({ lastHeartbeatAt: now - 99_999, nextExpectedTickAt: null });
  assert.equal(selectCandidate(stateWith(item), {}, config, now).kind, 'invoke');
  assert.equal(
    selectCandidate(stateWith(item), {}, { ...config, activeRunRecovery: 'off' }, now).code,
    'skip:recovery-disabled',
  );
});

test('a run that exhausted its retries is eventually pruned', () => {
  // FAILED is not TERMINAL, so without this it survives every prune and grows the
  // state without bound on any machine that never sees an exact reset.
  const state = defaultState();
  state.runs.spent = run({
    runId: 'spent', state: 'FAILED', retry: { attempts: 3, nextAttemptAt: null },
    updatedAt: now - config.terminalRunRetentionSeconds - 1,
  });
  pruneState(state, config, now);
  assert.equal(state.runs.spent, undefined);
});

test('a failed run waits out its retry backoff', () => {
  const item = run({ state: 'FAILED', retry: { attempts: 1, nextAttemptAt: now + 300 } });
  const decision = selectCandidate(stateWith(item), {}, config, now);
  assert.equal(decision.code, 'skip:retry-backoff');
  assert.equal(decision.dueAt, now + 300);
});

test('a run still inside its tick grace is left alone', () => {
  const item = run({ lastHeartbeatAt: now - config.heartbeatStaleSeconds - 1, nextExpectedTickAt: now - 10 });
  assert.equal(selectCandidate(stateWith(item), {}, config, now).code, 'skip:tick-grace');
});

test('the rolling cap stops a fifth window activation in 24 hours', () => {
  const state = defaultState();
  state.usage = { ...state.usage, confidence: 'exact', fiveHourResetAt: now - 200 };
  state.activation.activationAttempts = [now - 100, now - 200, now - 300, now - 400];
  const decision = selectCandidate(state, {}, { ...config, windowMode: 'auto' }, now);
  assert.equal(decision.code, 'skip:rolling-activation-cap');
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

test('retention prunes old terminal runs, sessions, and activation attempts', () => {
  const state = stateWith(run({ state: 'COMPLETED', updatedAt: now - config.terminalRunRetentionSeconds - 1 }));
  state.sessions.old = { observedAt: now - config.registrationRecoveryMaxAgeSeconds - 1 };
  state.activation.activationAttempts = [now - 86_401, now - 1];
  const next = pruneState(state, config, now);
  assert.deepEqual(next.runs, {});
  assert.deepEqual(next.sessions, {});
  assert.deepEqual(next.activation.activationAttempts, [now - 1]);
});

test('empty exact reset selects configured notification or activation', () => {
  const state = defaultState();
  state.usage = { ...state.usage, confidence: 'exact', fiveHourResetAt: now - config.graceSeconds };
  assert.equal(selectCandidate(state, {}, config, now).code, 'action:notify-window-reset');
  assert.equal(selectCandidate(state, {}, { ...config, windowMode: 'auto' }, now).code, 'action:activate-window');
});

test('expired activation lease is cleared for retry', () => {
  const state = defaultState();
  state.activation = { ...state.activation, inProgress: true, attemptId: 'old', token: 'token', expiresAt: now - 1 };
  pruneState(state, config, now);
  assert.equal(state.activation.inProgress, false);
  assert.equal(state.activation.lastResult, 'error:activation-lease-expired');
});
