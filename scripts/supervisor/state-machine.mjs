import { WINDOW_SECONDS } from './constants.mjs';

const TERMINAL = new Set(['COMPLETED', 'BLOCKED', 'AUTO_PAUSED']);
const TRANSITIONS = {
  RUNNING: new Set(['RATE_LIMITED', 'RECOVERY_DUE', 'COMPLETED', 'BLOCKED', 'AUTO_PAUSED']),
  RATE_LIMITED: new Set(['RECOVERY_DUE', 'RUNNING', 'COMPLETED', 'BLOCKED', 'AUTO_PAUSED']),
  RECOVERY_DUE: new Set(['RECOVERING', 'RUNNING', 'COMPLETED', 'BLOCKED', 'AUTO_PAUSED']),
  RECOVERING: new Set(['RUNNING', 'RATE_LIMITED', 'FAILED', 'COMPLETED', 'BLOCKED', 'AUTO_PAUSED']),
  FAILED: new Set(['RECOVERY_DUE', 'RECOVERING', 'COMPLETED', 'BLOCKED', 'AUTO_PAUSED']),
};

export function transitionRun(run, nextState, updatedAt = run.updatedAt) {
  if (run.state === nextState) return { ...run, updatedAt };
  if (!TRANSITIONS[run.state]?.has(nextState)) {
    throw new Error(`invalid run transition: ${run.state} -> ${nextState}`);
  }
  return { ...run, state: nextState, updatedAt };
}

function heartbeatFor(run, inputs) {
  return inputs.heartbeats?.[run.runId] ?? run.lastHeartbeatAt;
}

function dueForRateLimit(state, run, config, now) {
  if (Number.isFinite(run.rateLimitedUntil)) return run.rateLimitedUntil + config.graceSeconds;
  const anchorReset = Number.isFinite(state.usage.windowAnchorAt)
    ? state.usage.windowAnchorAt + WINDOW_SECONDS : null;
  if (anchorReset && now <= anchorReset + config.graceSeconds) return anchorReset + config.graceSeconds;
  if (Number.isFinite(run.firstRateLimitedAt)) return run.firstRateLimitedAt + WINDOW_SECONDS + config.graceSeconds;
  return null;
}

function orderedRuns(state) {
  return Object.values(state.runs).sort((a, b) => {
    const aDue = a.scheduledResumeAt ?? Number.MAX_SAFE_INTEGER;
    const bDue = b.scheduledResumeAt ?? Number.MAX_SAFE_INTEGER;
    return aDue - bDue || a.runId.localeCompare(b.runId);
  });
}

export function selectCandidate(state, inputs, config, now) {
  if (!config.enabled) return { kind: 'skip', code: 'skip:disabled' };
  // A known-exhausted weekly window suppresses recovery probes and empty-window
  // activation alike; neither can succeed before the weekly reset.
  if (Number.isFinite(state.usage.sevenDaySuppressedUntil) && state.usage.sevenDaySuppressedUntil > now) {
    return { kind: 'skip', code: 'skip:seven-day-limit' };
  }
  const liveLeases = Object.values(state.runs)
    .filter((run) => Number.isFinite(run.lease?.expiresAt) && run.lease.expiresAt > now).length;
  if (liveLeases >= config.maxConcurrentInvocations) {
    return { kind: 'skip', code: 'skip:concurrency-exhausted' };
  }
  const recoverable = orderedRuns(state).filter((run) => !TERMINAL.has(run.state));
  if (recoverable.length === 0) {
    const resetAt = state.usage.confidence === 'exact' ? state.usage.fiveHourResetAt : null;
    if (!Number.isFinite(resetAt) || now < resetAt + config.graceSeconds
        || state.activation.handledResetAt === resetAt) return { kind: 'skip', code: 'skip:no-active-run' };
    if (config.windowMode === 'off') return { kind: 'skip', code: 'skip:window-mode-off' };
    if (config.windowMode === 'notify') return { kind: 'notify', code: 'action:notify-window-reset', resetAt };
    if (state.activation.inProgress && state.activation.expiresAt > now) {
      return { kind: 'skip', code: 'skip:activation-in-progress' };
    }
    if (state.activation.activationAttempts.length >= config.maxWindowActivationsPer24Hours) {
      return { kind: 'skip', code: 'skip:rolling-activation-cap' };
    }
    if (now - resetAt > config.overdueAutoActivationSeconds && config.catchUpMode !== 'activate') {
      return config.catchUpMode === 'notify'
        ? { kind: 'notify', code: 'action:notify-window-reset', resetAt }
        : { kind: 'skip', code: 'skip:overdue-window' };
    }
    return { kind: 'activate', code: 'action:activate-window', resetAt };
  }

  let nearest = null;
  for (const run of recoverable) {
    if (run.state === 'FAILED' && (run.retry?.attempts ?? 0) >= config.maxRecoveryAttempts
        && !Number.isFinite(run.retry?.nextAttemptAt)) {
      nearest ??= { kind: 'skip', code: 'skip:recovery-attempts-exhausted' };
      continue;
    }
    if (Number.isFinite(run.quotaRejections?.nextProbeAt) && run.quotaRejections.nextProbeAt > now) {
      nearest ??= { kind: 'skip', code: 'skip:quota-backoff', dueAt: run.quotaRejections.nextProbeAt };
      continue;
    }
    if (Number.isFinite(run.retry?.nextAttemptAt) && run.retry.nextAttemptAt > now) {
      nearest ??= { kind: 'skip', code: 'skip:retry-backoff', dueAt: run.retry.nextAttemptAt };
      continue;
    }
    const heartbeat = heartbeatFor(run, inputs);
    if (run.scheduleState === 'pending' && Number.isFinite(run.scheduledResumeAt)) {
      if (run.scheduledResumeAt > now) {
        nearest ??= { kind: 'skip', code: run.scheduleConfidence === 'estimated' ? 'skip:estimate-not-due' : 'skip:reset-not-due', dueAt: run.scheduledResumeAt };
        continue;
      }
      if (Number.isFinite(heartbeat) && heartbeat > run.scheduledResetAt) {
        return { kind: 'handle', code: 'skip:heartbeat-satisfied-reset', runId: run.runId };
      }
      if (Number.isFinite(heartbeat) && now - heartbeat < config.heartbeatStaleSeconds) {
        return { kind: 'skip', code: 'skip:heartbeat-fresh', runId: run.runId };
      }
      return { kind: 'invoke', code: 'action:resume-afk', runId: run.runId, dueAt: run.scheduledResumeAt };
    }
    if (run.state === 'RATE_LIMITED') {
      const dueAt = dueForRateLimit(state, run, config, now);
      if (!Number.isFinite(dueAt) || dueAt > now) {
        nearest ??= { kind: 'skip', code: run.resetConfidence === 'exact' ? 'skip:reset-not-due' : 'skip:estimate-not-due', dueAt };
        continue;
      }
      return { kind: 'invoke', code: 'action:resume-afk', runId: run.runId, dueAt };
    }
    const heartbeatFresh = Number.isFinite(heartbeat) && now - heartbeat < config.heartbeatStaleSeconds;
    if (heartbeatFresh) {
      nearest ??= { kind: 'skip', code: 'skip:heartbeat-fresh' };
      continue;
    }
    if (Number.isFinite(run.nextExpectedTickAt) && now <= run.nextExpectedTickAt + config.graceSeconds) {
      nearest ??= { kind: 'skip', code: 'skip:tick-grace', dueAt: run.nextExpectedTickAt + config.graceSeconds };
      continue;
    }
    return { kind: 'invoke', code: 'action:resume-afk', runId: run.runId, dueAt: now };
  }
  return nearest ?? { kind: 'skip', code: 'skip:no-recovery-due' };
}

export function isTerminalState(state) {
  return TERMINAL.has(state);
}

export function pruneState(state, config, now) {
  for (const [runId, run] of Object.entries(state.runs)) {
    if (TERMINAL.has(run.state) && Number.isFinite(run.updatedAt)
        && now - run.updatedAt > config.terminalRunRetentionSeconds) delete state.runs[runId];
  }
  for (const [cwd, session] of Object.entries(state.sessions)) {
    if (!Number.isFinite(session.observedAt)
        || now - session.observedAt > config.registrationRecoveryMaxAgeSeconds) delete state.sessions[cwd];
  }
  state.activation.activationAttempts = state.activation.activationAttempts
    .filter((attemptAt) => Number.isFinite(attemptAt) && now - attemptAt <= 86_400);
  if (state.activation.inProgress && (!Number.isFinite(state.activation.expiresAt) || state.activation.expiresAt <= now)) {
    state.activation.inProgress = false;
    state.activation.attemptId = null;
    state.activation.token = null;
    state.activation.expiresAt = null;
    state.activation.lastResult = 'error:activation-lease-expired';
  }
  return state;
}
