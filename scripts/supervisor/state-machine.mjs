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
//
// The guard fails CLOSED, and it is the one claim that must. On the other side of it
// is an interactive Claude that a human may be sitting in front of. The clamp that
// (correctly) refuses to believe a RUNNER's lease from a stepped clock was, for the
// guard, an instruction to resume that person's session out from under them: an
// expiry we cannot believe made the guard not hold at all. So any future expiry
// holds, and `repairGuard` is what bounds it — by clamping the guard and writing the
// clamp down, rather than by disbelieving it.
export function tickOwns(run, now, config) {
  void config;
  return Number.isFinite(run.tickGuard?.expiresAt) && run.tickGuard.expiresAt > now;
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
// How long this claim has gone unrenewed. The bound has now been wrong in BOTH
// directions — held for ever (a recycled pid wedged its run), then freed instantly
// (a clock-stepped claim let a live runner be driven twice) — because each version
// tried to answer the question from a stamp it could not trust.
//
// So it fails CLOSED: a stamp we cannot believe — in the future, or absent — reads
// as "renewed just now", and the claim is held. On its own that holds for ever
// again, which is why `repairClaim` writes the believable stamp back UNDER THE LOCK.
// A clamp has to be persisted to be a bound; an un-persisted one resets on every
// pass, and that is precisely how the first version came to hold for ever.
export function unrenewedFor(claim, config, now) {
  const ttl = config.leaseRenewalSeconds * config.leaseMissedRenewals;
  const derived = Number.isFinite(claim?.expiresAt) ? claim.expiresAt - ttl : NaN;
  const stamp = Number.isFinite(claim?.lastRenewedAt) ? claim.lastRenewedAt : derived;
  if (!Number.isFinite(stamp)) return 0;
  return Math.max(0, now - stamp);
}

// The tick guard is a claim too, and it was the one claim nothing repaired — so the
// only bound on it was a clamp that made it fail open. Repaired, it holds for its
// normal window and no longer: if the session behind it is really gone, it expires;
// if it is alive, its next tick renews it.
export function repairGuard(guard, config, now) {
  if (!guard) return false;
  const ceiling = now + config.heartbeatStaleSeconds + config.graceSeconds;
  if (Number.isFinite(guard.expiresAt) && guard.expiresAt <= ceiling) return false;
  guard.expiresAt = now + config.heartbeatStaleSeconds;
  return true;
}

// A claim stamped in the future is corrupt: a clock that ran ahead and was corrected
// back, a VM's drifted RTC, an NTP step after a suspend — and suspend is the very
// scenario this supervisor exists for. Such a claim is neither trustworthy (it would
// hold the run for ever) nor discardable (a live runner may be behind it, and
// discarding it drives the session twice). It is REPAIRED: dated now, so it is held
// from here and expires on schedule. Returns true when it changed something.
export function repairClaim(claim, config, now) {
  if (!claim?.attemptId) return false;
  const ttl = config.leaseRenewalSeconds * config.leaseMissedRenewals;
  let repaired = false;
  if (!Number.isFinite(claim.lastRenewedAt) || claim.lastRenewedAt > now) {
    claim.lastRenewedAt = now;
    repaired = true;
  }
  // An expiry beyond any plausible lease is a stepped clock, and it says nothing
  // about how long this claim has really held the run. Dating it `now` does not
  // grant it a fresh lease — it makes it expired, so that LIVENESS decides, which is
  // the only evidence left worth having. Handing it a new TTL instead would let a
  // corrupt clock buy a dead runner three more minutes of ownership.
  if (Number.isFinite(claim.expiresAt) && claim.expiresAt > now + ttl + config.graceSeconds) {
    claim.expiresAt = now;
    repaired = true;
  }
  return repaired;
}

// May this claim be taken from its holder? Both the supervisor and the in-session
// tick have to answer it the same way — they used to disagree about a claim with no
// pid, so the supervisor refused to touch a run that the tick then drove anyway.
export function claimOccupied(claim, config, now, liveness) {
  if (!claim?.attemptId) return false;
  // The clamped expiry, not the raw one: a claim expiring in the year 2400 is a
  // clock step, not a lease, and must not own the run for ever.
  if (claimLive(claim, now, config, config.leaseRenewalSeconds * config.leaseMissedRenewals)) return true;
  if (liveness === 'alive') return true;
  if (liveness === 'dead') return false;
  return unrenewedFor(claim, config, now) <= config.recoveryAttemptTimeoutSeconds;
}

// The one answer to "how long may this claim hold the run before we stop believing
// in it". `claimOccupied` above is the ONLY caller that matters, and every consumer
// — the tick's `lease`, the reconciler, the pruner, activation — goes through it.
export function claimNotBefore(config, now) {
  return now + config.leaseRenewalSeconds;
}

// The liveness the reconciler resolved for this run, in the vocabulary claimOccupied
// speaks. A run in neither set was either not probed (its claim is unexpired, so the
// lease itself says it is occupied) or probed and found dead.
function runLiveness(runId, inputs) {
  if (inputs.aliveRuns?.has(runId)) return 'alive';
  if (inputs.unknownRuns?.has(runId)) return 'unknown';
  return 'dead';
}

// A pid we never recorded cannot be probed, and an unprobed claim is `unknown` —
// never `dead`. `runnerLiveness` alone answers `dead` for a missing pid, which is
// the right answer to "is this process alive" and the wrong answer to "is this run
// occupied".
export async function claimLiveness(claim, probe) {
  return Number.isInteger(claim?.pid) ? probe(claim) : 'unknown';
}

export function runnability(run, state, config, now, inputs = {}) {
  if (TERMINAL.has(run.state)) return held('skip:run-terminal');
  if (!TRANSITIONS[run.state]) return held('skip:run-state-unknown');

  if (tickOwns(run, now, config)) return held('skip:tick-owns-run', run.tickGuard.expiresAt);

  // ONE predicate answers "is a runner driving this run?", and every caller is forced
  // through it — the tick's `lease`, this selector, the pruner, and activation. There
  // used to be two: this function hand-rolled its own, and the two then disagreed on
  // the same state, so the tick refused a run the supervisor went on to drive. That
  // is the exact bug the single predicate was introduced to make impossible, still
  // possible because this caller had not been routed through it.
  //
  // A lease that expired while the machine slept may still have a live runner behind
  // it. It is re-evaluated next pass, so it is held, not abandoned.
  const liveness = runLiveness(run.runId, inputs);
  if (claimOccupied(run.recoveryLease, config, now, liveness)) {
    const notBefore = runnerOwns(run, now, config)
      ? run.recoveryLease.expiresAt
      : claimNotBefore(config, now);
    return held(liveness === 'dead' ? 'skip:runner-active' : 'skip:runner-alive', notBefore);
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

function emptyWindow(state, inputs, config, now) {
  const resetAt = state.usage.confidence === 'exact' ? state.usage.fiveHourResetAt : null;
  if (!Number.isFinite(resetAt) || now < resetAt + config.graceSeconds
      || state.activation.handledResetAt === resetAt) return { kind: 'skip', code: 'skip:no-active-run' };
  if (config.windowMode === 'off') return { kind: 'skip', code: 'skip:window-mode-off' };
  if (config.windowMode === 'notify') return { kind: 'notify', code: 'action:notify-window-reset', resetAt };
  // The one predicate, again — this was the last caller still answering the question
  // by itself, with a raw expiry and no liveness. The reconciler resolved the answer
  // properly and then handed it only to the pruner, so the path that actually SELECTS
  // never asked: a suspend past the lease TTL, with the activation runner still
  // running, started a second one on top of it. A caller that has not resolved
  // liveness gets the safe answer, not a guess of its own.
  if (state.activation.inProgress && (inputs.activationOccupied ?? true)) {
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
  if (drivable.length === 0) return emptyWindow(state, inputs, config, now);

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
