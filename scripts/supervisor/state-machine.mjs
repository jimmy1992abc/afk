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

export function isTerminalState(state) {
  return TERMINAL.has(state);
}

// A heartbeat ahead of local time is a clock artefact, not progress. Trusting it
// would mark the run fresh for ever, so it would never be recovered, and it would
// also count as post-reset progress and silently discard the run's schedule.
export function usableHeartbeat(value, now, config) {
  return Number.isFinite(value) && value <= now + config.graceSeconds ? value : null;
}

// An expiry is written from the same clock as a heartbeat and gets the same
// distrust: a forward clock step during a renewal would otherwise persist an
// expiry years out and hold its claim for ever, with nothing to reap it.
function claimLive(claim, now, config, longest) {
  return Number.isFinite(claim?.expiresAt)
    && claim.expiresAt > now
    && claim.expiresAt <= now + longest + config.graceSeconds;
}

// Two different claims on a run, with two different owners and two different
// lifetimes. Collapsing them into one field is what made the supervisor resume a
// session that then saw the supervisor's own claim, concluded another layer owned
// recovery, and exited without doing anything.
export function tickOwns(run, now, config) {
  return claimLive(run.tickGuard, now, config, config.heartbeatStaleSeconds);
}

export function runnerOwns(run, now, config) {
  return claimLive(run.recoveryLease, now, config, config.leaseRenewalSeconds * config.leaseMissedRenewals);
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

function exhausted(run, config) {
  return run.state === 'FAILED'
    && (run.retry?.attempts ?? 0) >= config.maxRecoveryAttempts
    && !Number.isFinite(run.retry?.nextAttemptAt);
}

const held = (code, notBefore = null, extra = {}) => ({ runnable: false, code, notBefore, ...extra });

/**
 * The single answer to "may this run be driven right now, and by whom?".
 *
 * Every consumer — selection, pruning, status — asks this one function. Nine
 * uncoordinated predicates spread over three files used to answer parts of it,
 * and every round of fixes tightened one and silently changed the meaning of two
 * others.
 *
 * `notBefore` is the earliest moment this run could become runnable. A hold with
 * a future `notBefore` is deliberate, and pruning must never delete such a run:
 * a run parked on a seven-day quota probe is waiting, not abandoned.
 *
 * `inputs.aliveRuns` — runs whose recovery lease expired but whose runner the
 * caller has *verified* is still alive. `inputs.unknownRuns` — the same, but
 * liveness could not be determined. Both mean "do not touch this run"; only a
 * verified one is a real Claude invocation that counts against the global cap.
 */
// How long a claim has gone without a renewal. A claim expires one TTL after its
// last renewal, so an expiry stands in for a missing `lastRenewedAt` — an old-shape
// lease from before an upgrade carries no such stamp. A forward clock step cannot
// make the answer negative, and so cannot buy a claim an indefinite hold.
export function unrenewedFor(claim, config, now) {
  const ttl = config.leaseRenewalSeconds * config.leaseMissedRenewals;
  const renewed = Number.isFinite(claim?.lastRenewedAt)
    ? claim.lastRenewedAt
    : (Number.isFinite(claim?.expiresAt) ? claim.expiresAt - ttl : 0);
  return now - Math.min(renewed, now);
}

export function runnability(run, state, config, now, inputs = {}) {
  if (TERMINAL.has(run.state)) return held('skip:run-terminal');
  if (!TRANSITIONS[run.state]) return held('skip:run-state-unknown');

  if (tickOwns(run, now, config)) return held('skip:tick-owns-run', run.tickGuard.expiresAt);
  if (runnerOwns(run, now, config)) return held('skip:runner-active', run.recoveryLease.expiresAt);
  // A lease that expired while the machine slept still has a live runner behind
  // it. It will be re-evaluated next pass, so it is held, not abandoned.
  if (inputs.aliveRuns?.has(run.runId)) return held('skip:runner-alive', now + config.leaseRenewalSeconds);

  // A claim we could not verify holds its own run — we never double-drive it — but
  // it may not hold it for ever. This branch re-armed its notBefore every pass, so
  // a recycled pid wedged its run permanently: never recovered, never pruned, and
  // burning an OS probe every pass until the end of time.
  //
  // A live runner renews, and a renewed claim is unexpired, so it never reaches
  // here. A claim unrenewed for longer than a runner can even live — its own action
  // timeout bounds that — has no runner behind it.
  if (inputs.unknownRuns?.has(run.runId)
      && unrenewedFor(run.recoveryLease, config, now) <= config.recoveryAttemptTimeoutSeconds) {
    return held('skip:runner-alive', now + config.leaseRenewalSeconds);
  }

  if (Number.isFinite(state.usage.sevenDaySuppressedUntil) && state.usage.sevenDaySuppressedUntil > now) {
    return held('skip:seven-day-limit', state.usage.sevenDaySuppressedUntil);
  }
  if (config.activeRunRecovery === 'off') return held('skip:recovery-disabled');

  // The operator has said: drive this run now. `trigger-now --force` has already
  // released the claims and reset the counters, so what is left are the timers —
  // and "wait for the next tick" is precisely what they were overriding. It is
  // cleared when the run is claimed, so a force resumes once, not for ever.
  if (Number.isFinite(run.forcedUntil) && run.forcedUntil > now) {
    return { runnable: true, code: 'action:resume-afk', dueAt: now, notBefore: null };
  }

  if (exhausted(run, config)) return held('skip:recovery-attempts-exhausted');

  if (Number.isFinite(run.quotaRejections?.nextProbeAt) && run.quotaRejections.nextProbeAt > now) {
    return held('skip:quota-backoff', run.quotaRejections.nextProbeAt);
  }
  if (Number.isFinite(run.retry?.nextAttemptAt) && run.retry.nextAttemptAt > now) {
    return held('skip:retry-backoff', run.retry.nextAttemptAt);
  }

  const heartbeat = heartbeatFor(run, inputs, now, config);
  const fresh = Number.isFinite(heartbeat) && now - heartbeat < config.heartbeatStaleSeconds;
  const freshUntil = Number.isFinite(heartbeat) ? heartbeat + config.heartbeatStaleSeconds : null;

  if (run.scheduleState === 'pending' && Number.isFinite(run.scheduledResumeAt)) {
    if (run.scheduledResumeAt > now) {
      const code = run.scheduleConfidence === 'estimated' ? 'skip:estimate-not-due' : 'skip:reset-not-due';
      return held(code, run.scheduledResumeAt);
    }
    // `heartbeat > null` is `heartbeat > 0` — always true — so the finite check is
    // what stops any heartbeat at all from satisfying a schedule that has no reset.
    if (Number.isFinite(run.scheduledResetAt) && Number.isFinite(heartbeat)
        && heartbeat > run.scheduledResetAt) {
      return held('skip:heartbeat-satisfied-reset', null, { handle: true });
    }
    if (fresh) return held('skip:heartbeat-fresh', freshUntil);
    return { runnable: true, code: 'action:resume-afk', dueAt: run.scheduledResumeAt, notBefore: null };
  }

  if (run.state === 'RATE_LIMITED') {
    const dueAt = dueForRateLimit(state, run, config, now);
    if (!Number.isFinite(dueAt) || dueAt > now) {
      const code = run.resetConfidence === 'exact' ? 'skip:reset-not-due' : 'skip:estimate-not-due';
      return held(code, Number.isFinite(dueAt) ? dueAt : null);
    }
    return { runnable: true, code: 'action:resume-afk', dueAt, notBefore: null };
  }

  if (fresh) return held('skip:heartbeat-fresh', freshUntil);
  if (Number.isFinite(run.nextExpectedTickAt) && now <= run.nextExpectedTickAt + config.graceSeconds) {
    return held('skip:tick-grace', run.nextExpectedTickAt + config.graceSeconds);
  }
  return { runnable: true, code: 'action:resume-afk', dueAt: now, notBefore: null };
}

// Only a supervisor invocation consumes the global cap. The in-session tick's
// guard is not one, and counting it would let a single interactively-running repo
// disable recovery for every other repository.
//
// A runner whose liveness could not be *verified* does not consume it either: a
// recycled pid must be able to wedge at most its own run, never the whole
// supervisor.
function invocations(state, config, now, inputs) {
  return Object.values(state.runs)
    .filter((run) => runnerOwns(run, now, config) || inputs.aliveRuns?.has(run.runId))
    .length;
}

function orderedRuns(state) {
  return Object.values(state.runs).sort((a, b) => {
    const aDue = a.scheduledResumeAt ?? Number.MAX_SAFE_INTEGER;
    const bDue = b.scheduledResumeAt ?? Number.MAX_SAFE_INTEGER;
    return aDue - bDue || a.runId.localeCompare(b.runId);
  });
}

function emptyWindow(state, config, now) {
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

export function selectCandidate(state, inputs, config, now) {
  if (!config.enabled) return { kind: 'skip', code: 'skip:disabled' };

  // A known-exhausted weekly window suppresses recovery probes and empty-window
  // activation alike — neither can succeed before the weekly reset. This is a
  // global gate: runnability also refuses each run individually, but with no runs
  // at all the empty-window branch would otherwise never see it.
  if (Number.isFinite(state.usage.sevenDaySuppressedUntil) && state.usage.sevenDaySuppressedUntil > now) {
    return { kind: 'skip', code: 'skip:seven-day-limit' };
  }

  // An activation is a Claude invocation too, and its child lives as long as any
  // recovery.
  const activationLive = state.activation.inProgress
    && Number.isFinite(state.activation.expiresAt) && state.activation.expiresAt > now ? 1 : 0;
  if (activationLive + invocations(state, config, now, inputs) >= config.maxConcurrentInvocations) {
    return { kind: 'skip', code: 'skip:concurrency-exhausted' };
  }

  const drivable = orderedRuns(state).filter((run) => !TERMINAL.has(run.state) && TRANSITIONS[run.state]);
  if (drivable.length === 0) return emptyWindow(state, config, now);

  let nearest = null;
  let handled = null;
  for (const run of drivable) {
    const verdict = runnability(run, state, config, now, inputs);
    if (verdict.runnable) {
      return { kind: 'invoke', code: verdict.code, runId: run.runId, dueAt: verdict.dueAt };
    }
    // Recording a satisfied reset is real work, but it must never end the pass: a
    // genuinely due run behind this one would wait another 60 seconds for nothing.
    if (verdict.handle) {
      handled ??= { kind: 'handle', code: verdict.code, runId: run.runId };
      continue;
    }
    nearest ??= { kind: 'skip', code: verdict.code, runId: run.runId, dueAt: verdict.notBefore ?? undefined };
  }
  // An invoke wins outright; a pending handle beats an idle skip.
  return handled ?? nearest ?? { kind: 'skip', code: 'skip:no-recovery-due' };
}

export function pruneState(state, config, now, inputs = {}) {
  for (const [runId, run] of Object.entries(state.runs)) {
    // Deliberate holds are not abandonment. A run parked on a seven-day quota
    // probe, or held while its runner is alive, is waiting — deleting it is how
    // the mechanism meant to resume it destroyed it instead.
    // ...but retention is the outer bound on how long any run may sit here. A status
    // line reporting a reset years out parks the run for years, and the hold then
    // kept the reaper off it for exactly as long. A hold past the horizon protects
    // nothing; the run still has to be idle beyond retention to actually go.
    const verdict = runnability(run, state, config, now, inputs);
    const horizon = now + config.terminalRunRetentionSeconds;
    if (Number.isFinite(verdict.notBefore) && verdict.notBefore > now && verdict.notBefore <= horizon) continue;

    const spent = TERMINAL.has(run.state) || exhausted(run, config);
    const idleSince = Math.max(run.updatedAt ?? 0, run.lastHeartbeatAt ?? 0);
    const abandoned = idleSince > 0 && now - idleSince > config.terminalRunRetentionSeconds;
    if ((spent || abandoned) && Number.isFinite(run.updatedAt)
        && now - run.updatedAt > config.terminalRunRetentionSeconds) delete state.runs[runId];
  }
  for (const [cwd, session] of Object.entries(state.sessions)) {
    if (!Number.isFinite(session.observedAt)
        || now - session.observedAt > config.registrationRecoveryMaxAgeSeconds) delete state.sessions[cwd];
  }
  state.activation.activationAttempts = state.activation.activationAttempts
    .filter((attemptAt) => Number.isFinite(attemptAt) && now - attemptAt <= 86_400);
  // An expiry is not a death certificate. The activation lease was reclaimed on
  // expiry alone — no liveness check at all — so a machine that slept longer than
  // the lease expired it while the detached activation runner was still running,
  // and the next pass started a second activation on top of it.
  if (state.activation.inProgress && !inputs.activationOccupied
      && (!Number.isFinite(state.activation.expiresAt) || state.activation.expiresAt <= now)) {
    state.activation.inProgress = false;
    state.activation.attemptId = null;
    state.activation.token = null;
    state.activation.expiresAt = null;
    state.activation.lastResult = 'error:activation-lease-expired';
  }
  return state;
}
