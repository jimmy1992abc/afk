import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { defaultConfig } from '../../scripts/supervisor/config.mjs';
import { finalizeActivation, finalizeAttempt, runAttempt } from '../../scripts/supervisor/runner.mjs';
import { StateStore } from '../../scripts/supervisor/state-store.mjs';

const now = 20_000;

function run(overrides = {}) {
  return {
    runId: 'run-1', sessionId: '00000000-0000-4000-8000-000000000001', state: 'RECOVERING',
    firstRateLimitedAt: null, rateLimitedUntil: null, resetConfidence: 'unknown',
    scheduledResumeAt: null, scheduledResetAt: null, scheduleState: 'leased', scheduleConfidence: null,
    recoveryLease: { attemptId: 'attempt-1', token: 'token-1', lastRenewedAt: now - 60, expiresAt: now + 120, pid: null, startedAt: null, stuckNotifiedAt: null },
    retry: { attempts: 0, nextAttemptAt: null },
    quotaRejections: { consecutive: 0, backoffLevel: 0, nextProbeAt: null, lastNotifiedAt: null },
    ...overrides,
  };
}

function state(item = run()) {
  return {
    schemaVersion: 1, revision: 0,
    usage: {
      fiveHourResetAt: null, fiveHourUsedPercentage: null, sevenDayResetAt: null,
      sevenDayUsedPercentage: null, observedAt: null, source: 'unknown', confidence: 'unknown',
      windowAnchorAt: null, thresholdResetAt: null, lastImportedObservationAt: null,
      sevenDaySuppressedUntil: null,
    },
    runs: { 'run-1': item },
    activation: { handledResetAt: null, inProgress: false, attemptId: null, lastAttemptAt: null, lastResult: null, activationAttempts: [] },
  };
}

test('second success inside a window does not move anchor or schedule runs', () => {
  const current = state();
  current.usage.windowAnchorAt = now - 600;
  const next = finalizeAttempt(current, 'run-1', 'token-1', { kind: 'success' }, now, defaultConfig());
  assert.equal(next.usage.windowAnchorAt, now - 600);
  assert.equal(next.runs['run-1'].scheduledResumeAt, null);
  assert.equal(next.runs['run-1'].state, 'RUNNING');
});

test('first successful supervisor response establishes anchor and clears quota escalation', () => {
  const current = state(run({ quotaRejections: { consecutive: 3, backoffLevel: 1, nextProbeAt: 50_000, lastNotifiedAt: 10_000 } }));
  const next = finalizeAttempt(current, 'run-1', 'token-1', { kind: 'success' }, now, defaultConfig());
  assert.equal(next.usage.windowAnchorAt, now);
  assert.equal(next.runs['run-1'].quotaRejections.consecutive, 0);
  assert.equal(next.runs['run-1'].quotaRejections.nextProbeAt, null);
});

test('window anchor uses the request start time, not the finalize time', () => {
  const current = state();
  const startedAt = now - 10_800;
  const next = finalizeAttempt(current, 'run-1', 'token-1', { kind: 'success', startedAt }, now, defaultConfig());
  assert.equal(next.usage.windowAnchorAt, startedAt);
  assert.equal(next.usage.fiveHourResetAt, startedAt + 18_000);
});

test('success clears the rate-limit timestamps of the recovered run', () => {
  const current = state(run({ firstRateLimitedAt: now - 18_000, rateLimitedUntil: now, resetConfidence: 'estimated' }));
  const next = finalizeAttempt(current, 'run-1', 'token-1', { kind: 'success', startedAt: now }, now, defaultConfig());
  assert.equal(next.runs['run-1'].firstRateLimitedAt, null);
  assert.equal(next.runs['run-1'].rateLimitedUntil, null);
});

test('success never reschedules another run', () => {
  const current = state();
  current.runs['run-2'] = run({
    runId: 'run-2', sessionId: '00000000-0000-4000-8000-000000000002', state: 'RUNNING',
    scheduleState: null, recoveryLease: { attemptId: null, token: null, lastRenewedAt: null, expiresAt: null },
  });
  const untouched = structuredClone(current.runs['run-2']);
  const next = finalizeAttempt(current, 'run-1', 'token-1', { kind: 'success', startedAt: now }, now, defaultConfig());
  assert.deepEqual(next.runs['run-2'], untouched);
});

test('a fresh window anchor is consumed for the quota estimate', () => {
  const current = state();
  current.usage.windowAnchorAt = now - 3_600;
  const next = finalizeAttempt(current, 'run-1', 'token-1', { kind: 'quota' }, now, defaultConfig());
  assert.equal(next.runs['run-1'].rateLimitedUntil, now - 3_600 + 18_000);
  assert.equal(next.runs['run-1'].resetConfidence, 'estimated');
});

test('a stale first-rate-limit timestamp never schedules a resume in the past', () => {
  const current = state(run({ firstRateLimitedAt: now - 6 * 3_600 }));
  const next = finalizeAttempt(current, 'run-1', 'token-1', { kind: 'quota' }, now, defaultConfig());
  const item = next.runs['run-1'];
  assert.ok(item.rateLimitedUntil > now, `rateLimitedUntil ${item.rateLimitedUntil} must not be in the past`);
  assert.ok(item.scheduledResumeAt > now, `scheduledResumeAt ${item.scheduledResumeAt} must not be in the past`);
});

test('quota result reschedules without consuming ordinary recovery attempts', () => {
  const current = state();
  const next = finalizeAttempt(current, 'run-1', 'token-1', { kind: 'quota' }, now, defaultConfig());
  assert.equal(next.runs['run-1'].retry.attempts, 0);
  assert.equal(next.runs['run-1'].quotaRejections.consecutive, 1);
  assert.equal(next.runs['run-1'].rateLimitedUntil, now + 18_000);
});

test('third consecutive quota rejection escalates to daily backoff and notification result', () => {
  const current = state(run({ quotaRejections: { consecutive: 2, backoffLevel: 0, nextProbeAt: null, lastNotifiedAt: null } }));
  const next = finalizeAttempt(current, 'run-1', 'token-1', { kind: 'quota' }, now, defaultConfig());
  assert.equal(next.runs['run-1'].quotaRejections.consecutive, 3);
  assert.equal(next.runs['run-1'].quotaRejections.backoffLevel, 1);
  assert.equal(next.runs['run-1'].quotaRejections.nextProbeAt, now + 86_400);
  assert.equal(next.runs['run-1'].lastResult, 'result:quota-backoff-escalated');
});

test('maxRecoveryAttempts is a count of invocations, not of retries after them', () => {
  // `attempts` already counts this failure, so scheduling while attempts <= max
  // schedules one more invocation than configured: three permitted failures gave
  // a fourth `claude --resume`.
  const config = defaultConfig();
  let current = state();
  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    current.runs['run-1'].recoveryLease = { attemptId: 'a', token: 'token-1', expiresAt: now + 120 };
    current.runs['run-1'].state = 'RECOVERING';
    current = finalizeAttempt(current, 'run-1', 'token-1', { kind: 'failure' }, now, config);
    seen.push(current.runs['run-1'].retry.nextAttemptAt);
  }
  assert.deepEqual(seen.map(Boolean), [true, true, false, false, false],
    `${config.maxRecoveryAttempts} attempts means two retries after the first failure`);
});

test('exhaustion and quota escalation tell the operator different things', async () => {
  const root = await mkdtemp(join(tmpdir(), 'afk-supervisor-runner-'));
  const store = new StateStore(root);
  await store.update(() => state(run({ retry: { attempts: 2, nextAttemptAt: null } })));
  const notified = [];
  const result = await runAttempt('attempt-1', {
    store, config: defaultConfig(), now: () => now,
    runClaude: async () => ({ kind: 'failure', reason: 'process-exit' }),
    setInterval: () => ({}), clearInterval: () => {},
    notify: async (run, reason) => notified.push(reason),
  });
  assert.equal(result.code, 'error:resume-failed');
  assert.deepEqual(notified, ['exhausted'],
    'a run that ran out of retries is not quota-limited and has no next probe');
});

test('stale lease token cannot finalize a newer attempt', () => {
  const current = state();
  assert.equal(finalizeAttempt(current, 'run-1', 'old-token', { kind: 'success' }, now, defaultConfig()), current);
});

test('runAttempt renews then finalizes the matching lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'afk-supervisor-runner-'));
  const store = new StateStore(root);
  await store.update(() => state());
  const result = await runAttempt('attempt-1', {
    store, config: defaultConfig(), now: () => now,
    runClaude: async () => ({ kind: 'success' }),
    setInterval: (fn) => ({ fn }), clearInterval: () => {}, notify: async () => {},
  });
  assert.equal(result.code, 'result:success');
  assert.equal((await store.read()).runs['run-1'].recoveryLease.attemptId, null);
});

test('a superseded attempt reports itself stale and changes nothing', async () => {
  // finalizeAttempt no-ops on a token mismatch and hands back the state
  // unchanged, so the saved record still carries the winner's result. Without a
  // flag the loser would report the winner's success as its own — which is
  // exactly what would mask a double invocation in the logs.
  const root = await mkdtemp(join(tmpdir(), 'afk-supervisor-runner-'));
  const store = new StateStore(root);
  await store.update(() => state());
  const result = await runAttempt('attempt-1', {
    store, config: defaultConfig(), now: () => now,
    runClaude: async () => {
      await store.update((current) => {
        current.runs['run-1'].recoveryLease = { attemptId: 'attempt-2', token: 'token-2', expiresAt: now + 180, pid: null, startedAt: null };
        return current;
      });
      return { kind: 'success', startedAt: now };
    },
    setInterval: () => ({}), clearInterval: () => {}, notify: async () => {},
  });
  assert.equal(result.code, 'skip:stale-attempt');
  const saved = await store.read();
  assert.equal(saved.runs['run-1'].recoveryLease.attemptId, 'attempt-2');
  assert.equal(saved.usage.windowAnchorAt, null, 'a superseded attempt must not anchor the window');
});

test('the lease is renewed while the child is alive, and only for its own attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'afk-supervisor-runner-'));
  const store = new StateStore(root);
  const config = defaultConfig();
  await store.update(() => state());
  let renew;
  let renewed;
  await runAttempt('attempt-1', {
    store, config, now: () => now,
    runClaude: async () => {
      await renew();
      renewed = (await store.read()).runs['run-1'].recoveryLease;
      return { kind: 'success', startedAt: now };
    },
    identity: { pid: 4242, startedAt: 111_000 },
    setInterval: (fn) => { renew = fn; return {}; },
    clearInterval: () => {}, notify: async () => {},
  });
  assert.equal(renewed.lastRenewedAt, now);
  assert.equal(renewed.expiresAt, now + config.leaseRenewalSeconds * config.leaseMissedRenewals);
  assert.equal(renewed.pid, 4242);
  assert.equal(renewed.startedAt, 111_000, 'a pid alone is not an identity; the start time is what proves it is ours');
});

test('runAttempt notifies when consecutive quota rejection escalates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'afk-supervisor-runner-'));
  const store = new StateStore(root);
  await store.update(() => state(run({ quotaRejections: { consecutive: 2, backoffLevel: 0, nextProbeAt: null, lastNotifiedAt: null } })));
  const notified = [];
  const result = await runAttempt('attempt-1', {
    store, config: defaultConfig(), now: () => now,
    runClaude: async () => ({ kind: 'quota' }),
    setInterval: (fn) => ({ fn }), clearInterval: () => {}, notify: async (value) => notified.push(value),
  });
  assert.equal(result.code, 'result:quota-backoff-escalated');
  assert.equal(notified.length, 1);
  assert.equal(notified[0].runId, 'run-1');
});

test('an activation anchors the window at the request, not at the finalize', () => {
  // The five-hour window opens at the FIRST request. Recovery already anchors at
  // the runner's start for exactly this reason; activation used the finalize time,
  // so a slow activation pushed the estimated reset late by its own duration — and
  // every recovery keyed off that reset waited past the real one. It also wrote the
  // anchor straight in, bypassing the clamp that stops an anchor moving inside a
  // window that has not elapsed.
  const startedAt = now - 240;
  const current = state();
  current.activation = {
    ...current.activation, inProgress: true, attemptId: 'activation-1',
    token: 'activation-token', resetAt: now - 90, activationAttempts: [now - 5],
  };
  const next = finalizeActivation(current, 'activation-token', { kind: 'success', startedAt }, now);
  assert.equal(next.usage.windowAnchorAt, startedAt);
  assert.equal(next.usage.fiveHourResetAt, startedAt + 18_000);
});

test('successful activation records a new estimated anchor', () => {
  const current = state();
  current.activation = {
    ...current.activation, inProgress: true, attemptId: 'activation-1',
    token: 'activation-token', resetAt: now - 90, activationAttempts: [now - 5],
  };
  const next = finalizeActivation(current, 'activation-token', { kind: 'success' }, now);
  assert.equal(next.activation.handledResetAt, now - 90);
  assert.equal(next.usage.windowAnchorAt, now);
  // The attempt was counted when the lease was taken. Counting it again here
  // would only ever count the activations that survived to finalize, so a cap
  // counted at finalize never trips for the ones that crash.
  assert.deepEqual(next.activation.activationAttempts, [now - 5]);
});
