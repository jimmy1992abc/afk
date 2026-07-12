import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from '../../scripts/supervisor/config.mjs';
import { defaultState } from '../../scripts/supervisor/state-store.mjs';
import { pruneState, repairClaim, repairGuard, runnability, selectCandidate, transitionRun } from '../../scripts/supervisor/state-machine.mjs';

const config = defaultConfig();
const now = 20_000;

function run(overrides = {}) {
  return {
    runId: 'run-1', sessionId: '00000000-0000-4000-8000-000000000001',
    state: 'RUNNING', lastHeartbeatAt: now - 2_000, nextExpectedTickAt: now - 500,
    firstRateLimitedAt: null, rateLimitedUntil: null, scheduledResumeAt: null,
    scheduledResetAt: null, scheduleState: null, scheduleConfidence: null,
    recoveryLease: { attemptId: null, token: null, lastRenewedAt: null, expiresAt: null, pid: null, startedAt: null },
    tickGuard: null,
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

test('a schedule with no reset is never satisfied by an arbitrary heartbeat', () => {
  // `heartbeat > null` is `heartbeat > 0` — always true. Without the finite check
  // any heartbeat at all satisfies a schedule that carries no reset, and the
  // pending resume is silently discarded.
  const item = run({
    scheduleState: 'pending', scheduledResumeAt: now - 10, scheduledResetAt: null,
    lastHeartbeatAt: now - config.heartbeatStaleSeconds - 1,
  });
  const decision = selectCandidate(stateWith(item), {}, config, now);
  assert.notEqual(decision.kind, 'handle');
  assert.equal(decision.kind, 'invoke');
});

test('an in-session lease is honoured, not judged bogus by the supervisor ceiling', () => {
  // The in-session tick leases for heartbeatStaleSeconds, far longer than any
  // supervisor lease. A ceiling drawn from the supervisor's own renewal settings
  // would call that lease a clock artefact and let the supervisor resume a run
  // the tick is actively working on.
  const item = run({
    state: 'RUNNING', lastHeartbeatAt: now - config.heartbeatStaleSeconds - 1, nextExpectedTickAt: null,
    tickGuard: { sessionId: '00000000-0000-4000-8000-000000000001', expiresAt: now + config.heartbeatStaleSeconds },
  });
  const decision = selectCandidate(stateWith(item), {}, config, now);
  assert.notEqual(decision.kind, 'invoke');
  assert.equal(decision.code, 'skip:tick-owns-run');
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

const EPOCH = 1_800_000_000; // the prune fixtures need a clock the retention window fits behind

test('pruning never deletes a run it is deliberately holding', () => {
  // The retention window is "how long a dead run is kept". It was also being used,
  // by accident, as "the longest a live run may wait" — and the two constants were
  // equal, so a run parked on the maximum quota probe was deleted at the exact
  // moment that probe became due: the mechanism meant to resume it destroyed it.
  // Pruning now asks the same runnability question the selector does, and a hold
  // with a future notBefore is waiting, not abandoned.
  const stale = EPOCH - config.terminalRunRetentionSeconds - 1;
  const parked = run({
    runId: 'parked', state: 'RATE_LIMITED',
    quotaRejections: { consecutive: 3, backoffLevel: 4, nextProbeAt: EPOCH + 500, lastNotifiedAt: null },
    updatedAt: stale, lastHeartbeatAt: stale, nextExpectedTickAt: null,
  });
  const weekly = run({
    runId: 'weekly', sessionId: '00000000-0000-4000-8000-000000000002', state: 'RATE_LIMITED',
    updatedAt: stale, lastHeartbeatAt: stale, nextExpectedTickAt: null,
  });
  const state = stateWith(parked);
  state.runs.weekly = weekly;
  state.usage.sevenDaySuppressedUntil = EPOCH + 500;

  pruneState(state, config, EPOCH, {});
  assert.ok(state.runs.parked, 'a run waiting out its quota probe must survive');
  assert.ok(state.runs.weekly, 'a run waiting out the weekly suppression must survive');

  // ...and a run with no hold at all, idle that long, really is abandoned.
  const dead = stateWith(run({ runId: 'gone', updatedAt: stale, lastHeartbeatAt: stale, nextExpectedTickAt: null }));
  pruneState(dead, config, EPOCH, {});
  assert.equal(dead.runs.gone, undefined, 'the prune must still actually prune');
});

test('an unverifiable claim holds its run, but not for ever', () => {
  // `unknown` re-armed its notBefore on every pass, so it was always in the future
  // and the run could never be pruned either. A recycled pid therefore wedged its
  // run permanently: never recovered, never reaped, and burning an OS probe every
  // pass until the end of time.
  //
  // A live runner renews its claim, and a renewed claim is unexpired — so it never
  // reaches this branch at all. A claim that has gone longer without a renewal than
  // a runner can even live has no runner behind it.
  const claim = (lastRenewedAt) => run({
    runId: 'held', state: 'RECOVERING',
    recoveryLease: { attemptId: 'a', token: 't', lastRenewedAt, expiresAt: EPOCH - 1, pid: 4242, startedAt: 1 },
    updatedAt: lastRenewedAt, lastHeartbeatAt: lastRenewedAt, nextExpectedTickAt: null,
  });
  const inputs = { unknownRuns: new Set(['held']) };

  const recent = claim(EPOCH - 30);
  assert.equal(runnability(recent, stateWith(recent), config, EPOCH, inputs).code, 'skip:runner-alive',
    'a claim that could still have a runner behind it is never double-driven');

  const ancient = claim(EPOCH - config.recoveryAttemptTimeoutSeconds - 1);
  assert.equal(runnability(ancient, stateWith(ancient), config, EPOCH, inputs).runnable, true,
    'past the longest a runner can live, an unrenewed claim is not a runner');
});

test('a tick guard we cannot believe still holds the run', () => {
  // The guard is the one claim that must fail CLOSED, and it was the one claim that
  // failed open. On the other side of it is an interactive Claude that a human may be
  // sitting in front of. The clamp that (rightly) disbelieves a RUNNER's lease from a
  // stepped clock was, for the guard, an instruction to resume that person's session
  // out from under them — the guard simply stopped holding.
  //
  // `repairGuard` clamps it in the reconciler, but `runnability` is also asked about
  // state nobody repaired (status, and any future caller), so the raw check is the
  // floor: any future expiry holds.
  const guarded = run({
    runId: 'guarded', state: 'RUNNING',
    tickGuard: { sessionId: '00000000-0000-4000-8000-000000000001', expiresAt: EPOCH + 400 * 86_400 },
    lastHeartbeatAt: EPOCH - 99_999, nextExpectedTickAt: null,
  });
  const verdict = runnability(guarded, stateWith(guarded), config, EPOCH, {});
  assert.equal(verdict.runnable, false);
  assert.equal(verdict.code, 'skip:tick-owns-run');

  // ...and the repair is what bounds it, rather than disbelief.
  assert.equal(repairGuard(guarded.tickGuard, config, EPOCH), true);
  assert.equal(guarded.tickGuard.expiresAt, EPOCH + config.heartbeatStaleSeconds);
});

test('an expiry from a stepped clock does not own the run', () => {
  // This was the other half of the round that unified the predicate, and it shipped
  // with no test at all: it could be reverted to a raw `expiresAt > now` and the whole
  // suite stayed green. A claim expiring in the year 2400 is a clock step, not a
  // lease, and must not own the run for ever — the runner behind it is dead.
  const absurd = run({
    runId: 'absurd', state: 'RECOVERING',
    recoveryLease: {
      attemptId: 'a', token: 't', lastRenewedAt: EPOCH - 10,
      expiresAt: EPOCH + 400 * 86_400, pid: 4242, startedAt: 1,
    },
    lastHeartbeatAt: EPOCH - 99_999, nextExpectedTickAt: null,
  });
  // The probe says the runner is gone, and nothing but an unbelievable expiry says
  // otherwise. It is free.
  assert.equal(runnability(absurd, stateWith(absurd), config, EPOCH, {}).runnable, true);
});

test('a claim stamped in the future is held, and the repair bounds the hold', () => {
  // This bound has been wrong in BOTH directions. First it clamped a future stamp
  // down to `now` on every read, so the claim looked freshly renewed for ever and a
  // recycled pid wedged its run permanently. Then it discarded a future stamp as no
  // evidence at all — and a clock corrected backwards (a VM's RTC, an NTP step after
  // a suspend, which is the scenario this supervisor exists for) freed a claim whose
  // runner was ALIVE, and the session was driven twice.
  //
  // It fails CLOSED: a stamp we cannot believe is read as "renewed just now", so the
  // run is held. The bound comes from REPAIRING the claim — writing the believable
  // stamp back — because a clamp that is not persisted resets on every pass and is
  // therefore no bound at all.
  const skewed = () => run({
    runId: 'skewed', state: 'RECOVERING',
    recoveryLease: {
      attemptId: 'a', token: 't', lastRenewedAt: EPOCH + 365 * 86_400,
      expiresAt: EPOCH + 365 * 86_400, pid: 4242, startedAt: 1,
    },
    updatedAt: EPOCH - 99_999, lastHeartbeatAt: EPOCH - 99_999, nextExpectedTickAt: null,
  });
  const inputs = { unknownRuns: new Set(['skewed']) };

  const item = skewed();
  assert.equal(runnability(item, stateWith(item), config, EPOCH, inputs).runnable, false,
    'a claim we cannot date may still have a live runner behind it');

  // The repair dates it now — and dates it EXPIRED, so liveness decides rather than a
  // corrupt clock buying a dead runner a fresh lease.
  const repaired = skewed();
  assert.equal(repairClaim(repaired.recoveryLease, config, EPOCH), true);
  assert.equal(repaired.recoveryLease.lastRenewedAt, EPOCH);
  assert.equal(repaired.recoveryLease.expiresAt, EPOCH);

  // ...and now the hold is bounded: past the longest a runner can live, it is free.
  const later = EPOCH + config.recoveryAttemptTimeoutSeconds + 1;
  assert.equal(runnability(repaired, stateWith(repaired), config, later, inputs).runnable, true,
    'the persisted repair is what makes the bound a bound');
});

test('a hold beyond the retention horizon does not shield a run from the reaper', () => {
  // A status line reporting a reset years away parks the run for years, and the
  // hold then kept the pruner off it for exactly as long. Retention is the outer
  // bound on how long any run may sit in the state file.
  const stale = EPOCH - config.terminalRunRetentionSeconds - 1;
  const absurd = run({
    runId: 'absurd', state: 'RATE_LIMITED', scheduleState: 'pending',
    scheduledResumeAt: EPOCH + 400 * 86_400, scheduledResetAt: EPOCH + 400 * 86_400,
    scheduleConfidence: 'exact',
    updatedAt: stale, lastHeartbeatAt: stale, nextExpectedTickAt: null,
  });
  const state = stateWith(absurd);
  pruneState(state, config, EPOCH, {});
  assert.equal(state.runs.absurd, undefined);
});

test('pruning never deletes a run whose runner is still alive', () => {
  const stale = EPOCH - config.terminalRunRetentionSeconds - 1;
  const item = run({
    runId: 'held', state: 'RECOVERING',
    recoveryLease: { attemptId: 'a', token: 't', expiresAt: EPOCH - 1, pid: 4242, startedAt: 1 },
    updatedAt: stale, lastHeartbeatAt: stale, nextExpectedTickAt: null,
  });
  const state = stateWith(item);
  pruneState(state, config, EPOCH, { aliveRuns: new Set(['held']) });
  assert.ok(state.runs.held);
});

test('a runner we cannot verify wedges its own run, never the whole supervisor', () => {
  // The residual risk of trusting a pid is that the OS recycled it. An
  // unverifiable claim must hold at most its own run: counting it against the
  // global cap would let one stale pid stop the supervisor invoking anything, on
  // any repository, for ever.
  const opaque = run({
    runId: 'a-opaque', state: 'RECOVERING',
    recoveryLease: { attemptId: 'a', token: 't', expiresAt: now - 1, pid: 4242, startedAt: null },
    lastHeartbeatAt: now - 99_999, nextExpectedTickAt: null,
  });
  const due = run({
    runId: 'b-due', sessionId: '00000000-0000-4000-8000-000000000002', state: 'RATE_LIMITED',
    rateLimitedUntil: now - 1_000, resetConfidence: 'exact',
    lastHeartbeatAt: now - 99_999, nextExpectedTickAt: null,
  });
  const state = stateWith(opaque);
  state.runs['b-due'] = due;
  const inputs = { unknownRuns: new Set(['a-opaque']) };

  const decision = selectCandidate(state, inputs, config, now);
  assert.equal(decision.kind, 'invoke');
  assert.equal(decision.runId, 'b-due', 'the other repository must keep working');
  assert.equal(runnability(opaque, state, config, now, inputs).runnable, false,
    'and the opaque run itself is still never double-driven');
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
  const leased = stateWith(run({ recoveryLease: { attemptId: 'a', token: 't', expiresAt: now + 10 } }));
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
