import { createHash } from 'node:crypto';

import { WINDOW_SECONDS } from './constants.mjs';

const RECOVERABLE = new Set(['RUNNING', 'RATE_LIMITED', 'RECOVERY_DUE', 'FAILED']);

// A timestamp from an earlier limit episode would place the upper bound in the
// past and make the run immediately re-probable, so only a same-window value is
// carried forward.
export function currentRateLimitStart(run, now) {
  const previous = run?.firstRateLimitedAt;
  return Number.isFinite(previous) && now - previous < WINDOW_SECONDS ? previous : now;
}

// The single place that decides when a rate-limited run may next be tried. The
// runner classifies a quota frame and the StopFailure hook sees the same
// rejection, so both must reach the same answer — a second copy of this rule is
// how one of them silently drifts.
export function estimateReset(usage, run, now, config) {
  if (usage.confidence === 'exact' && usage.fiveHourResetAt > now) {
    return { resetAt: usage.fiveHourResetAt, confidence: 'exact' };
  }
  const anchorReset = Number.isFinite(usage.windowAnchorAt)
    ? usage.windowAnchorAt + WINDOW_SECONDS : null;
  if (anchorReset && now <= anchorReset + config.graceSeconds) {
    return { resetAt: anchorReset, confidence: 'estimated' };
  }
  return { resetAt: currentRateLimitStart(run, now) + WINDOW_SECONDS, confidence: 'estimated' };
}

function finiteInRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function unixSeconds(value, observedAt) {
  if (!Number.isInteger(value) || value <= 0) return null;
  const lowerBound = Math.max(1_000_000_000, Math.floor(observedAt - 366 * 24 * 60 * 60));
  const upperBound = Math.floor(observedAt + 8 * 366 * 24 * 60 * 60);
  return value >= lowerBound && value <= upperBound ? value : null;
}

// Status-line payloads carry no rate limits before the session's first API
// response, and never for API-key or third-party-provider sessions. Such a
// payload observes nothing, so it must not be presented as an exact reading.
export function hasRateLimitData(snapshot) {
  return Number.isFinite(snapshot?.fiveHourResetAt) || Number.isFinite(snapshot?.fiveHourUsedPercentage)
    || Number.isFinite(snapshot?.sevenDayResetAt) || Number.isFinite(snapshot?.sevenDayUsedPercentage);
}

export function parseStatuslineSnapshot(value, observedAt = Math.floor(Date.now() / 1000)) {
  const five = value?.rate_limits?.five_hour;
  const seven = value?.rate_limits?.seven_day;
  const snapshot = {
    fiveHourResetAt: unixSeconds(five?.resets_at, observedAt),
    fiveHourUsedPercentage: finiteInRange(five?.used_percentage, 0, 100),
    sevenDayResetAt: unixSeconds(seven?.resets_at, observedAt),
    sevenDayUsedPercentage: finiteInRange(seven?.used_percentage, 0, 100),
    observedAt,
    source: 'statusline',
    confidence: 'exact',
  };
  if (!hasRateLimitData(snapshot)) snapshot.confidence = 'none';
  return snapshot;
}

export function stableJitterSeconds(run, resetAt, config) {
  const digest = createHash('sha256')
    .update(`${run.runId}\0${run.sessionId}\0${resetAt}`)
    .digest();
  const width = config.thresholdJitterMaxSeconds - config.thresholdJitterMinSeconds + 1;
  return config.thresholdJitterMinSeconds + (digest.readUInt32BE(0) % width);
}

export function scheduleRun(run, resetAt, confidence, config) {
  const jitter = stableJitterSeconds(run, resetAt, config);
  return {
    ...run,
    scheduledResetAt: resetAt,
    scheduledResumeAt: resetAt + jitter,
    scheduleState: 'pending',
    scheduleConfidence: confidence,
  };
}

export function applyUsageObservation(state, observation, config) {
  if (!observation || !Number.isFinite(observation.observedAt)) return state;
  if (!hasRateLimitData(observation)) return state;
  if (Number.isFinite(state.usage.lastImportedObservationAt)
      && observation.observedAt < state.usage.lastImportedObservationAt) return state;

  const next = structuredClone(state);
  const previousConfidence = next.usage.confidence;
  Object.assign(next.usage, {
    fiveHourResetAt: observation.fiveHourResetAt ?? next.usage.fiveHourResetAt,
    fiveHourUsedPercentage: observation.fiveHourUsedPercentage ?? next.usage.fiveHourUsedPercentage,
    sevenDayResetAt: observation.sevenDayResetAt ?? next.usage.sevenDayResetAt,
    sevenDayUsedPercentage: observation.sevenDayUsedPercentage ?? next.usage.sevenDayUsedPercentage,
    observedAt: observation.observedAt,
    lastImportedObservationAt: observation.observedAt,
    source: observation.source,
    confidence: observation.confidence,
  });

  const exact = observation.confidence === 'exact';
  const resetAt = observation.fiveHourResetAt;
  const thresholdReached = exact && Number.isFinite(resetAt)
    && Number.isFinite(observation.fiveHourUsedPercentage)
    && observation.fiveHourUsedPercentage >= config.thresholdPercentage;
  const newThreshold = thresholdReached && next.usage.thresholdResetAt !== resetAt;
  const replacesEstimate = exact && previousConfidence === 'estimated' && Number.isFinite(resetAt);

  if (newThreshold) next.usage.thresholdResetAt = resetAt;
  if (newThreshold || replacesEstimate) {
    for (const [id, run] of Object.entries(next.runs)) {
      if (!RECOVERABLE.has(run.state)) continue;
      if (!newThreshold && run.scheduleConfidence !== 'estimated') continue;
      const scheduled = scheduleRun({ ...run, runId: run.runId ?? id }, resetAt, 'exact', config);
      // A rate-limited run also carries its own reset deadline, which the
      // selector consults whenever its schedule is no longer pending. Leaving it
      // on an estimate while the schedule became exact would let a stale
      // deadline decide when the run is due.
      next.runs[id] = run.state === 'RATE_LIMITED'
        ? { ...scheduled, rateLimitedUntil: resetAt, resetConfidence: 'exact' }
        : scheduled;
    }
  }
  if (exact && Number.isFinite(resetAt)) {
    for (const run of Object.values(next.runs)) {
      if (!RECOVERABLE.has(run.state)) continue;
      run.quotaRejections = { consecutive: 0, backoffLevel: 0, nextProbeAt: null, lastNotifiedAt: null };
    }
  }
  // used_percentage is a float derived from a utilization ratio, so an exhausted
  // weekly window can report just under 100.
  if (Number.isFinite(observation.sevenDayUsedPercentage)
      && observation.sevenDayUsedPercentage >= config.sevenDaySuppressionPercentage
      && Number.isFinite(observation.sevenDayResetAt)) {
    next.usage.sevenDaySuppressedUntil = observation.sevenDayResetAt + config.graceSeconds;
  }
  return next;
}
