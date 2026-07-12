import { createHash } from 'node:crypto';

const RECOVERABLE = new Set(['RUNNING', 'RATE_LIMITED', 'RECOVERY_DUE', 'FAILED']);

function finiteInRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function unixSeconds(value, observedAt) {
  if (!Number.isInteger(value) || value <= 0) return null;
  const lowerBound = Math.max(1_000_000_000, Math.floor(observedAt - 366 * 24 * 60 * 60));
  const upperBound = Math.floor(observedAt + 8 * 366 * 24 * 60 * 60);
  return value >= lowerBound && value <= upperBound ? value : null;
}

export function parseStatuslineSnapshot(value, observedAt = Math.floor(Date.now() / 1000)) {
  const five = value?.rate_limits?.five_hour;
  const seven = value?.rate_limits?.seven_day;
  return {
    fiveHourResetAt: unixSeconds(five?.resets_at, observedAt),
    fiveHourUsedPercentage: finiteInRange(five?.used_percentage, 0, 100),
    sevenDayResetAt: unixSeconds(seven?.resets_at, observedAt),
    sevenDayUsedPercentage: finiteInRange(seven?.used_percentage, 0, 100),
    observedAt,
    source: 'statusline',
    confidence: 'exact',
  };
}

export function stableJitterSeconds(run, resetAt, config) {
  const digest = createHash('sha256')
    .update(`${run.runId}\0${run.sessionId}\0${resetAt}`)
    .digest();
  const width = config.thresholdJitterMaxSeconds - config.thresholdJitterMinSeconds + 1;
  return config.thresholdJitterMinSeconds + (digest.readUInt32BE(0) % width);
}

function scheduleRun(run, resetAt, confidence, config) {
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
      if (newThreshold || run.scheduleConfidence === 'estimated') {
        next.runs[id] = scheduleRun({ ...run, runId: run.runId ?? id }, resetAt, 'exact', config);
      }
    }
  }
  if (exact && Number.isFinite(resetAt)) {
    for (const run of Object.values(next.runs)) {
      if (!RECOVERABLE.has(run.state)) continue;
      run.quotaRejections = { consecutive: 0, backoffLevel: 0, nextProbeAt: null, lastNotifiedAt: null };
    }
  }
  if (observation.sevenDayUsedPercentage === 100 && Number.isFinite(observation.sevenDayResetAt)) {
    next.usage.sevenDaySuppressedUntil = observation.sevenDayResetAt + config.graceSeconds;
  }
  return next;
}
