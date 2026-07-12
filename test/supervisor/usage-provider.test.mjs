import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from '../../scripts/supervisor/config.mjs';
import { defaultState } from '../../scripts/supervisor/state-store.mjs';
import {
  applyUsageObservation,
  parseStatuslineSnapshot,
  stableJitterSeconds,
} from '../../scripts/supervisor/usage-provider.mjs';

const config = defaultConfig();

function run(id, state = 'RUNNING') {
  return {
    runId: id,
    sessionId: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    state,
    scheduledResumeAt: null,
    scheduledResetAt: null,
    scheduleState: null,
  };
}

function withRuns(ids) {
  const state = defaultState();
  state.runs = Object.fromEntries(ids.map((id) => [id, run(id)]));
  return state;
}

function exact(used, resetAt, observedAt = 1_000) {
  return {
    fiveHourResetAt: resetAt,
    fiveHourUsedPercentage: used,
    sevenDayResetAt: 9_000,
    sevenDayUsedPercentage: 25,
    observedAt,
    source: 'statusline',
    confidence: 'exact',
  };
}

test('parses documented status-line epoch seconds and percentages', () => {
  const snapshot = parseStatuslineSnapshot({
    rate_limits: {
      five_hour: { used_percentage: 90.5, resets_at: 2_000_000_000 },
      seven_day: { used_percentage: 40, resets_at: 2_000_100_000 },
    },
  }, 1_999_999_000);
  assert.equal(snapshot.fiveHourResetAt, 2_000_000_000);
  assert.equal(snapshot.fiveHourUsedPercentage, 90.5);
  assert.equal(snapshot.confidence, 'exact');
});

test('rejects ISO reset values and malformed percentages without erasing fields', () => {
  const snapshot = parseStatuslineSnapshot({
    rate_limits: { five_hour: { used_percentage: 101, resets_at: '2030-01-01T00:00:00Z' } },
  }, 100);
  assert.equal(snapshot.fiveHourResetAt, null);
  assert.equal(snapshot.fiveHourUsedPercentage, null);
});

test('exact 90 percent observation schedules every recoverable run once', () => {
  const state = withRuns(['1', '2']);
  const next = applyUsageObservation(state, exact(90, 2_000), config);
  for (const item of Object.values(next.runs)) {
    assert.ok(item.scheduledResumeAt >= 2_060 && item.scheduledResumeAt <= 2_180);
    assert.equal(item.scheduledResetAt, 2_000);
  }
  const repeated = applyUsageObservation(next, exact(91, 2_000, 1_001), config);
  assert.deepEqual(
    Object.values(repeated.runs).map((item) => item.scheduledResumeAt),
    Object.values(next.runs).map((item) => item.scheduledResumeAt),
  );
});

test('terminal runs are not scheduled at threshold crossing', () => {
  const state = withRuns(['1']);
  state.runs.done = run('3', 'COMPLETED');
  const next = applyUsageObservation(state, exact(95, 2_000), config);
  assert.equal(next.runs.done.scheduledResumeAt, null);
});

test('estimated reset updates usage but never arms threshold schedules', () => {
  const state = withRuns(['1']);
  const next = applyUsageObservation(state, {
    ...exact(95, 2_000), source: 'window-anchor', confidence: 'estimated',
  }, config);
  assert.equal(next.runs['1'].scheduledResumeAt, null);
  assert.equal(next.usage.confidence, 'estimated');
});

test('newer exact snapshot replaces pending estimated schedules', () => {
  const state = withRuns(['1']);
  state.runs['1'].scheduledResumeAt = 9_999;
  state.runs['1'].scheduledResetAt = 9_000;
  state.runs['1'].scheduleConfidence = 'estimated';
  const next = applyUsageObservation(state, exact(91, 3_000), config);
  assert.equal(next.runs['1'].scheduledResetAt, 3_000);
  assert.equal(next.runs['1'].scheduleConfidence, 'exact');
});

test('exact snapshot clears escalated quota backoff', () => {
  const state = withRuns(['1']);
  state.runs['1'].quotaRejections = { consecutive: 3, backoffLevel: 1, nextProbeAt: 50_000, lastNotifiedAt: 10_000 };
  const next = applyUsageObservation(state, exact(50, 3_000), config);
  assert.deepEqual(next.runs['1'].quotaRejections, { consecutive: 0, backoffLevel: 0, nextProbeAt: null, lastNotifiedAt: null });
});

test('stable jitter is deterministic and inside the inclusive range', () => {
  const item = run('1');
  const first = stableJitterSeconds(item, 2_000, config);
  assert.equal(stableJitterSeconds(item, 2_000, config), first);
  assert.ok(first >= 60 && first <= 180);
});
