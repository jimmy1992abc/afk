import { WINDOW_SECONDS } from './constants.mjs';

// Which reset are we aiming at, and how sure are we?
//
// Evidence of an exhausted window comes from two independent observers:
//  - the status line: exact `resets_at`, plus the usage percentage that says
//    whether the window was actually exhausted (a reset time alone is reported
//    by every healthy session and means nothing);
//  - the StopFailure hook: the moment a request actually failed on the limit.
//    It says nothing about when the limit lifts — the reset is at most five
//    hours later, tightened to `anchor + 5h` when the window's first request
//    (the anchor) is known.
// An exact reading that plausibly describes the same episode beats the
// estimate. Across episodes, the later reset wins: it describes the newer one.
export function resolveReset({ observation, stopFailure, state, config }) {
  const candidates = [];
  const obsReset = Number.isFinite(observation?.fiveHourResetAt) ? observation.fiveHourResetAt : null;
  // The StopFailure file is never deleted — the hook owns it and the pass only
  // reads it — so a failure from a SETTLED episode survives being handled. Left
  // in play it manufactured a ghost reset (limitedAt + 5h) hours into the
  // healthy new window, or worse, paired itself with the new window's exact
  // reset as same-episode evidence. A failure at or before the handled reset is
  // spent: it is precisely the failure that reset settled.
  const spent = Number.isFinite(state?.handledResetAt) && stopFailure?.limitedAt <= state.handledResetAt;
  const limitedAt = Number.isFinite(stopFailure?.limitedAt) && !spent ? stopFailure.limitedAt : null;

  if (obsReset !== null
      && Number.isFinite(observation?.fiveHourUsedPercentage)
      && observation.fiveHourUsedPercentage >= config.thresholdPercentage) {
    candidates.push({ resetAt: obsReset, confidence: 'exact' });
  }
  if (limitedAt !== null) {
    if (obsReset !== null && obsReset >= limitedAt && obsReset <= limitedAt + WINDOW_SECONDS + config.graceSeconds) {
      candidates.push({ resetAt: obsReset, confidence: 'exact' });
    } else {
      const anchor = Number.isFinite(state?.windowAnchorAt) ? state.windowAnchorAt : null;
      const anchored = anchor !== null && limitedAt >= anchor && limitedAt < anchor + WINDOW_SECONDS
        ? anchor + WINDOW_SECONDS
        : null;
      candidates.push({ resetAt: anchored ?? limitedAt + WINDOW_SECONDS, confidence: 'estimated' });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.resetAt - a.resetAt)
    || (a.confidence === 'exact' ? -1 : 0) - (b.confidence === 'exact' ? -1 : 0));
  return candidates[0];
}

// Attempts that belong to this reset: everything fired at or after it. Keying by
// resetAt equality forgot the cap whenever the estimate refined between passes —
// thirty seconds of drift and four spent attempts read as zero. Time separates
// episodes cleanly instead: consecutive resets are at least one full window
// apart, so an earlier episode's attempts always predate the next reset.
function attemptsFor(state, resetAt) {
  return state.attempts.filter((attempt) => attempt.at >= resetAt);
}

// May an activation fire right now? Pure, and the only place that answers.
export function decide({ observation, stopFailure, state, config, now }) {
  if (!config.enabled) return { code: 'skip:disabled' };

  const target = resolveReset({ observation, stopFailure, state, config });
  if (!target) return { code: 'skip:no-limit-observed' };
  const { resetAt, confidence } = target;

  if (Number.isFinite(state.handledResetAt) && resetAt <= state.handledResetAt) {
    return { code: 'skip:reset-already-handled', resetAt, confidence };
  }
  if (now < resetAt + config.graceSeconds) {
    return { code: 'skip:reset-not-due', resetAt, confidence };
  }
  // Too long past: the moment is gone — any real session since then opened its
  // own window. Fired now it would only burn an unwanted window, so it is
  // marked handled instead.
  if (now - resetAt > config.staleResetSeconds) {
    return { code: 'action:mark-stale', resetAt, confidence };
  }
  if (attemptsFor(state, resetAt).length >= config.maxAttemptsPerReset) {
    return { code: 'skip:attempts-exhausted', resetAt, confidence };
  }
  if (Number.isFinite(state.nextAttemptAt) && now < state.nextAttemptAt) {
    return { code: 'skip:retry-backoff', resetAt, confidence };
  }
  return { code: 'action:activate', resetAt, confidence };
}

function recordAttempt(state, resetAt, at, result) {
  const attempts = [...state.attempts, { at, resetAt, result }].slice(-20);
  return { ...state, attempts };
}

function backoffFor(state, resetAt, config) {
  // Called after the current attempt is recorded, so the first retry uses the
  // first rung of the ladder.
  const failures = Math.max(1, attemptsFor(state, resetAt).length);
  const ladder = config.retryBackoffSeconds;
  return ladder[Math.min(failures - 1, ladder.length - 1)];
}

// One scheduled pass: read the three single-writer files, decide, act, record.
export async function runPass(deps) {
  const now = deps.now();
  const config = deps.config;
  const [observation, stopFailure, state] = await Promise.all([
    deps.readObservation(),
    deps.readStopFailure(),
    deps.readState(),
  ]);

  const decision = decide({ observation, stopFailure, state, config, now });

  if (decision.code === 'action:mark-stale') {
    await deps.writeState({ ...state, handledResetAt: decision.resetAt, nextAttemptAt: null, lastResult: 'skip:reset-stale' });
    return { code: 'skip:reset-stale', resetAt: decision.resetAt };
  }
  const notifiedRecently = Number.isFinite(state.notifiedAt) && now - state.notifiedAt < WINDOW_SECONDS;
  if (decision.code === 'skip:attempts-exhausted' && !notifiedRecently) {
    // Once per dead reset, not once per minute. The next real session will open
    // its own window; the operator just deserves to know this one never did.
    await deps.notify?.('AFK window activation gave up',
      `Activation for the reset at ${new Date(decision.resetAt * 1000).toISOString()} failed ${config.maxAttemptsPerReset} times. The next Claude session will open the window itself.`);
    await deps.writeState({ ...state, notifiedAt: now });
    return decision;
  }
  if (decision.code !== 'action:activate') return decision;

  const outcome = await deps.activate();
  let next = recordAttempt(state, decision.resetAt, now, outcome.kind);

  if (outcome.kind === 'success') {
    next = {
      ...next,
      handledResetAt: decision.resetAt,
      // The five-hour window opens at the request's START, not at its finish.
      windowAnchorAt: Number.isFinite(outcome.startedAt) ? outcome.startedAt : now,
      nextAttemptAt: null,
      lastResult: 'result:activation-success',
    };
    await deps.writeState(next);
    return { code: 'result:activation-success', resetAt: decision.resetAt };
  }

  // Quota: the account is still limited — the estimate was early, and the reset
  // stays unhandled so a later pass tries again. Failure: same backoff; the cap
  // stops it from burning attempts for ever.
  next = {
    ...next,
    nextAttemptAt: now + backoffFor(next, decision.resetAt, config),
    lastResult: outcome.kind === 'quota' ? 'result:activation-quota-rejected' : 'error:activation-failed',
  };
  await deps.writeState(next);
  return { code: next.lastResult, resetAt: decision.resetAt };
}
