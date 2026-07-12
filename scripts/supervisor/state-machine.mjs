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

// A heartbeat ahead of local time is a clock artefact, not progress. Trusting it
// would mark the run fresh for ever, so it would never be recovered, and it would
// also count as post-reset progress and silently discard the run's schedule.
export function usableHeartbeat(value, now, config) {
  return Number.isFinite(value) && value <= now + config.graceSeconds ? value : null;
}

function heartbeatFor(run, inputs, now, config) {
  return usableHeartbeat(inputs.heartbeats?.[run.runId] ?? run.lastHeartbeatAt, now, config);
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
  // A lease expiry is written from the same clock as a heartbeat, so it needs the
  // same distrust: a forward clock step during a renewal persists an expiry years
  // out, and an unclamped lease would then occupy its slot for ever with nothing
  // to reap it.
  // The ceiling has to admit the longest lease anyone legitimately takes. The
  // in-session tick's lease runs for heartbeatStaleSeconds, far longer than a
  // supervisor lease, and treating it as bogus would leave the supervisor free to
  // resume a run the tick is actively working on.
  const longestLease = Math.max(
    config.leaseRenewalSeconds * config.leaseMissedRenewals,
    config.heartbeatStaleSeconds,
  );
  const ceiling = now + longestLease + config.graceSeconds;
  const leaseLive = (run) => Number.isFinite(run.lease?.expiresAt)
    && run.lease.expiresAt > now && run.lease.expiresAt <= ceiling;

  // A run is occupied while its lease is live *or* while its runner is alive — a
  // suspended machine expires the lease without killing anything. The caller
  // resolves liveness, because this function may not touch processes.
  const occupied = (run) => leaseLive(run) || Boolean(inputs.aliveRuns?.has(run.runId));

  // ...but only a *supervisor* invocation counts against the invocation cap. The
  // in-session AFK tick takes a lease on its own run too, and counting it would
  // let one interactively-running repo disable recovery for every other repo.
  const invocation = (run) => occupied(run) && !String(run.lease?.attemptId ?? '').startsWith('in-session-');
  const activationLive = state.activation.inProgress
    && Number.isFinite(state.activation.expiresAt) && state.activation.expiresAt > now ? 1 : 0;
  const liveLeases = activationLive + Object.values(state.runs).filter(invocation).length;
  if (liveLeases >= config.maxConcurrentInvocations) {
    return { kind: 'skip', code: 'skip:concurrency-exhausted' };
  }
  // A run whose state the code does not know cannot be reasoned about. Selecting
  // it would reach transitionRun, which throws, and the exception escapes the
  // store update and kills every reconcile pass from then on.
  const recoverable = orderedRuns(state)
    .filter((run) => !TERMINAL.has(run.state) && Boolean(TRANSITIONS[run.state]));
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
  let handled = null;
  for (const run of recoverable) {
    // Already being worked on. This must skip the run, not end the pass: ending
    // it lets one occupied run starve every other due run behind it.
    if (occupied(run)) {
      nearest ??= { kind: 'skip', code: 'skip:runner-alive', runId: run.runId };
      continue;
    }
    if (config.activeRunRecovery === 'off') {
      nearest ??= { kind: 'skip', code: 'skip:recovery-disabled' };
      continue;
    }
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
    const heartbeat = heartbeatFor(run, inputs, now, config);
    if (run.scheduleState === 'pending' && Number.isFinite(run.scheduledResumeAt)) {
      if (run.scheduledResumeAt > now) {
        nearest ??= { kind: 'skip', code: run.scheduleConfidence === 'estimated' ? 'skip:estimate-not-due' : 'skip:reset-not-due', dueAt: run.scheduledResumeAt };
        continue;
      }
      // `heartbeat > null` is `heartbeat > 0`, i.e. always true, so without the
      // finite check any heartbeat at all would satisfy a schedule that has no
      // reset and silently discard the pending resume. The reconciler's copy of
      // this rule guards it; this one did not.
      if (Number.isFinite(run.scheduledResetAt) && Number.isFinite(heartbeat)
          && heartbeat > run.scheduledResetAt) {
        // Recording that the reset is satisfied is real work, but it must not end
        // the pass: a genuinely due run behind this one waits another 60 seconds
        // for nothing.
        handled ??= { kind: 'handle', code: 'skip:heartbeat-satisfied-reset', runId: run.runId };
        continue;
      }
      if (Number.isFinite(heartbeat) && now - heartbeat < config.heartbeatStaleSeconds) {
        // This run is working; the others behind it in the ordering are not.
        // Returning here would let one healthy run starve every other due run.
        nearest ??= { kind: 'skip', code: 'skip:heartbeat-fresh', runId: run.runId };
        continue;
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
  // An invoke wins; a pending handle is real work and beats an idle skip.
  return handled ?? nearest ?? { kind: 'skip', code: 'skip:no-recovery-due' };
}

export function isTerminalState(state) {
  return TERMINAL.has(state);
}

export function pruneState(state, config, now) {
  for (const [runId, run] of Object.entries(state.runs)) {
    // A run that exhausted its retries is skipped for ever but is not TERMINAL,
    // so without this it survives every prune and grows the state without bound
    // on any machine that never sees an exact reset.
    const exhausted = run.state === 'FAILED'
      && (run.retry?.attempts ?? 0) >= config.maxRecoveryAttempts
      && !Number.isFinite(run.retry?.nextAttemptAt);
    // A run nobody has touched for a whole retention period is abandoned,
    // whatever its state says. Without this, a run that can never reach a
    // terminal or exhausted state — because recovery is switched off, or because
    // it is wedged mid-RECOVERING — survives every prune, and every pass then
    // re-reads its ledger for ever.
    const spent = TERMINAL.has(run.state) || exhausted;
    const idleSince = Math.max(run.updatedAt ?? 0, run.lastHeartbeatAt ?? 0);
    const abandoned = Number.isFinite(idleSince) && idleSince > 0
      && now - idleSince > config.terminalRunRetentionSeconds;
    if ((spent || abandoned) && Number.isFinite(run.updatedAt)
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
