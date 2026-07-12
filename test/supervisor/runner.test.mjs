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
    lease: { attemptId: 'attempt-1', token: 'token-1', lastRenewedAt: now - 60, expiresAt: now + 120 },
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
  assert.equal((await store.read()).runs['run-1'].lease.attemptId, null);
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

test('successful activation records one attempt and a new estimated anchor', () => {
  const current = state();
  current.activation = { ...current.activation, inProgress: true, attemptId: 'activation-1', token: 'activation-token', resetAt: now - 90 };
  const next = finalizeActivation(current, 'activation-token', { kind: 'success' }, now);
  assert.equal(next.activation.handledResetAt, now - 90);
  assert.deepEqual(next.activation.activationAttempts, [now]);
  assert.equal(next.usage.windowAnchorAt, now);
});
