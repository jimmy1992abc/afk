import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from '../../scripts/supervisor/config.mjs';
import { defaultState } from '../../scripts/supervisor/state-store.mjs';
import {
  applyUsageObservation,
  estimateReset,
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

test('an exact snapshot also refreshes a rate-limited run own reset deadline', () => {
  const state = withRuns(['1']);
  state.runs['1'] = {
    ...state.runs['1'], state: 'RATE_LIMITED',
    firstRateLimitedAt: 1_000, rateLimitedUntil: 19_000, resetConfidence: 'estimated',
    scheduledResumeAt: 19_100, scheduledResetAt: 19_000, scheduleConfidence: 'estimated',
  };
  const next = applyUsageObservation(state, exact(91, 3_000), config);
  assert.equal(next.runs['1'].rateLimitedUntil, 3_000);
  assert.equal(next.runs['1'].resetConfidence, 'exact');
});

test('an exact snapshot does not give a running run a rate-limit deadline', () => {
  const state = withRuns(['1']);
  const next = applyUsageObservation(state, exact(91, 3_000), config);
  assert.equal(next.runs['1'].state, 'RUNNING');
  assert.equal(next.runs['1'].rateLimitedUntil ?? null, null);
});

test('exact snapshot clears escalated quota backoff', () => {
  const state = withRuns(['1']);
  state.runs['1'].quotaRejections = { consecutive: 3, backoffLevel: 1, nextProbeAt: 50_000, lastNotifiedAt: 10_000 };
  const next = applyUsageObservation(state, exact(50, 3_000), config);
  assert.deepEqual(next.runs['1'].quotaRejections, { consecutive: 0, backoffLevel: 0, nextProbeAt: null, lastNotifiedAt: null });
});

test('a status-line payload without rate limits is not an exact observation', () => {
  assert.notEqual(parseStatuslineSnapshot({ session_id: 'x' }, 1_000).confidence, 'exact');
});

test('an empty status-line payload cannot relabel an estimated window anchor as exact', () => {
  const state = withRuns(['1']);
  state.usage = {
    ...state.usage, fiveHourResetAt: 5_000, observedAt: 900,
    source: 'window-anchor', confidence: 'estimated',
  };
  const next = applyUsageObservation(state, parseStatuslineSnapshot({}, 1_000), config);
  assert.equal(next.usage.confidence, 'estimated');
  assert.equal(next.usage.source, 'window-anchor');
  assert.equal(next.usage.fiveHourResetAt, 5_000);
});

test('a nearly exhausted seven-day window still suppresses recovery', () => {
  const state = withRuns(['1']);
  const next = applyUsageObservation(state, {
    ...exact(50, 3_000), sevenDayUsedPercentage: 99.8, sevenDayResetAt: 400_000,
  }, config);
  assert.equal(next.usage.sevenDaySuppressedUntil, 400_000 + config.graceSeconds);
});

test('a payload with no five-hour reset cannot relabel the stored one as exact', () => {
  // Seven-day data alone passes hasRateLimitData, so without this guard a
  // seven-day-only payload launders a window-anchor estimate into "exact" — and
  // once the stored reset claims to be exact, a genuine exact snapshot is no
  // longer allowed to replace the schedules built on the estimate.
  const state = withRuns(['1']);
  state.usage = {
    ...state.usage, fiveHourResetAt: 5_000, source: 'window-anchor', confidence: 'estimated',
  };
  const next = applyUsageObservation(state, {
    fiveHourResetAt: null, fiveHourUsedPercentage: null,
    sevenDayResetAt: 400_000, sevenDayUsedPercentage: 40,
    observedAt: 1_000, source: 'statusline', confidence: 'exact',
  }, config);
  assert.equal(next.usage.confidence, 'estimated');
  assert.equal(next.usage.source, 'window-anchor');
  assert.equal(next.usage.sevenDayUsedPercentage, 40, 'the seven-day data is still imported');
});

test('a repeated threshold observation does not re-arm a schedule already handled', () => {
  const state = withRuns(['1']);
  const armed = applyUsageObservation(state, exact(91, 2_000), config);
  armed.runs['1'].scheduleState = 'handled';
  const again = applyUsageObservation(armed, exact(95, 2_000, 1_001), config);
  assert.equal(again.runs['1'].scheduleState, 'handled', 'the same reset must never be armed twice');
});

test('an older observation cannot overwrite a newer import', () => {
  const state = withRuns(['1']);
  const newer = applyUsageObservation(state, exact(50, 3_000, 2_000), config);
  const older = applyUsageObservation(newer, exact(95, 9_999, 1_000), config);
  assert.equal(older.usage.fiveHourResetAt, 3_000);
});

test('a back-dated reset never schedules a resume in the past', () => {
  // A status-line reset can arrive already behind local time. Scheduling on it
  // makes the run due immediately, at 90%+ usage, straight back into the limit.
  const state = withRuns(['1']);
  const next = applyUsageObservation(state, exact(95, 500, 10_000), config);
  assert.ok(next.runs['1'].scheduledResumeAt >= 10_000,
    `scheduledResumeAt ${next.runs['1'].scheduledResumeAt} must not precede the observation`);
});

test('a new exact reset starts a fresh attempt series for an exhausted run', () => {
  const state = withRuns(['1']);
  state.runs['1'] = { ...state.runs['1'], state: 'FAILED', retry: { attempts: 3, nextAttemptAt: null } };
  const next = applyUsageObservation(state, exact(50, 3_000), config);
  assert.deepEqual(next.runs['1'].retry, { attempts: 0, nextAttemptAt: null },
    'without this the run is skipped for ever and never pruned, because FAILED is not terminal');
});

test('an exact reset in the future outranks every estimate', () => {
  const usage = { confidence: 'exact', fiveHourResetAt: 50_000, windowAnchorAt: 1_000 };
  assert.deepEqual(estimateReset(usage, { firstRateLimitedAt: 1_000 }, 20_000, config), {
    resetAt: 50_000, confidence: 'exact',
  });
});

test('stable jitter is deterministic and inside the inclusive range', () => {
  const item = run('1');
  const first = stableJitterSeconds(item, 2_000, config);
  assert.equal(stableJitterSeconds(item, 2_000, config), first);
  assert.ok(first >= 60 && first <= 180);
});
