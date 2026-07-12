#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ConfigStore } from './config.mjs';
import { WINDOW_SECONDS } from './constants.mjs';
import { mkdir } from 'node:fs/promises';
import { runActivation as executeActivation, runClaude as executeClaude, startActivationProcess, startClaudeProcess } from './claude-runner.mjs';
import { StateStore, emptyRecoveryLease } from './state-store.mjs';
import { currentRateLimitStart, estimateReset, stableJitterSeconds } from './usage-provider.mjs';
import { createNotifier } from './notifier.mjs';
import { processStartedAt } from './platform.mjs';
import { appendBoundedLog } from './logger.mjs';

// Releasing the claim says "nothing of ours is driving this run any more". That is
// a lie when the Claude child outlived the kill: on a quota rejection and on an
// action timeout the runner kills the child and stops waiting, and a kill that did
// not take hold leaves a live Claude still writing to the session. Released, that
// child becomes invisible — the empty claim is skipped by the liveness pass — and
// the next supervisor pass starts a SECOND claude --resume on top of it. So the
// claim is kept, carrying the child's identity, until the child is really gone.
function releaseLease(current, result) {
  if (result?.childExited === false) return current.recoveryLease;
  return emptyRecoveryLease();
}

function resetQuota() {
  return { consecutive: 0, backoffLevel: 0, nextProbeAt: null, lastNotifiedAt: null };
}

function allowedAnchor(usage, now) {
  if (!Number.isFinite(usage.windowAnchorAt)) return now;
  if (now >= usage.windowAnchorAt + WINDOW_SECONDS) return now;
  if (usage.confidence === 'exact' && Number.isFinite(usage.fiveHourResetAt) && now >= usage.fiveHourResetAt) return now;
  return usage.windowAnchorAt;
}


export function finalizeAttempt(state, runId, token, result, now, config) {
  const run = state.runs[runId];
  if (!run || run.recoveryLease?.token !== token) return state;
  const next = structuredClone(state);
  const current = next.runs[runId];
  if (result.kind === 'success') {
    // The five-hour window opens at the first request, not when the run ends, so
    // the anchor is the moment the runner started rather than the finalize time.
    const anchorAt = Number.isFinite(result.startedAt) ? result.startedAt : now;
    next.usage.windowAnchorAt = allowedAnchor(next.usage, anchorAt);
    if (next.usage.confidence !== 'exact') {
      next.usage.fiveHourResetAt = next.usage.windowAnchorAt + WINDOW_SECONDS;
      next.usage.source = 'window-anchor';
      next.usage.confidence = 'estimated';
      next.usage.observedAt = now;
    }
    next.runs[runId] = {
      ...current,
      state: 'RUNNING', lastHeartbeatAt: now, updatedAt: now,
      firstRateLimitedAt: null, rateLimitedUntil: null, resetConfidence: 'unknown',
      recoveryLease: releaseLease(current, result), retry: { attempts: 0, nextAttemptAt: null },
      quotaRejections: resetQuota(), scheduleState: current.scheduleState === 'leased' ? 'handled' : current.scheduleState,
      lastResult: 'result:success',
    };
    return next;
  }
  if (result.kind === 'quota') {
    const firstRateLimitedAt = currentRateLimitStart(current, now);
    const reset = estimateReset(next.usage, { firstRateLimitedAt }, now, config);
    const consecutive = (current.quotaRejections?.consecutive ?? 0) + 1;
    let backoffLevel = current.quotaRejections?.backoffLevel ?? 0;
    let nextProbeAt = null;
    let lastResult = 'result:quota-rescheduled';
    if (consecutive >= config.maxConsecutiveQuotaRejections) {
      backoffLevel += 1;
      const delay = Math.min(config.quotaEscalationBaseSeconds * (2 ** (backoffLevel - 1)), config.quotaEscalationMaxSeconds);
      nextProbeAt = now + delay;
      lastResult = 'result:quota-backoff-escalated';
    }
    const jitter = stableJitterSeconds({ ...current, runId }, reset.resetAt, config);
    next.runs[runId] = {
      ...current,
      state: 'RATE_LIMITED', firstRateLimitedAt, rateLimitedUntil: reset.resetAt,
      resetConfidence: reset.confidence, scheduledResetAt: reset.resetAt,
      scheduledResumeAt: nextProbeAt ?? reset.resetAt + jitter,
      // Why this run is parked. Inferring it later from scheduleConfidence was
      // wrong in exactly the common case: an escalation records the *usage*
      // confidence, which is 'exact' whenever a status line is present.
      scheduleSource: nextProbeAt ? 'quota-backoff' : 'reset',
      scheduleConfidence: reset.confidence, scheduleState: 'pending', recoveryLease: releaseLease(current, result),
      quotaRejections: { consecutive, backoffLevel, nextProbeAt, lastNotifiedAt: lastResult.endsWith('escalated') ? now : current.quotaRejections?.lastNotifiedAt ?? null },
      lastResult, updatedAt: now,
    };
    return next;
  }
  const attempts = (current.retry?.attempts ?? 0) + 1;
  const delays = [300, 1200, 3600];
  next.runs[runId] = {
    ...current,
    state: 'FAILED', recoveryLease: releaseLease(current, result),
    // `attempts` already counts this failure, so scheduling while `attempts <=
    // max` schedules one more invocation than the configured maximum: three
    // permitted failures produced a fourth `claude --resume`.
    retry: { attempts, nextAttemptAt: attempts < config.maxRecoveryAttempts ? now + delays[Math.min(attempts - 1, delays.length - 1)] : null },
    lastResult: 'error:resume-failed', updatedAt: now,
  };
  return next;
}

export function finalizeActivation(state, token, result, now) {
  if (!state.activation.inProgress || state.activation.token !== token) return state;
  const next = structuredClone(state);
  next.activation.inProgress = false;
  next.activation.attemptId = null;
  next.activation.token = null;
  next.activation.lastRenewedAt = null;
  next.activation.expiresAt = null;
  // The attempt was already counted when the lease was taken; counting it again
  // here would only count the activations that survived to finalize.
  if (result.kind === 'success') {
    next.activation.handledResetAt = next.activation.resetAt;
    next.activation.lastResult = 'result:activation-success';
    // The window opens at the first request, not when the activation finishes —
    // the same reason recovery anchors at its runner's start. Anchoring at the
    // finalize pushed the estimated reset late by the activation's own duration,
    // and every recovery keyed off that reset then waited past the real one. It
    // also goes through the clamp, so it cannot move an anchor inside a window
    // that has not elapsed.
    const anchorAt = Number.isFinite(result.startedAt) ? result.startedAt : now;
    next.usage.windowAnchorAt = allowedAnchor(next.usage, anchorAt);
    if (next.usage.confidence !== 'exact') {
      next.usage.fiveHourResetAt = next.usage.windowAnchorAt + WINDOW_SECONDS;
      next.usage.source = 'window-anchor';
      next.usage.confidence = 'estimated';
      next.usage.observedAt = now;
    }
  } else {
    next.activation.lastResult = result.kind === 'quota'
      ? 'result:activation-quota-rejected' : 'error:activation-failed';
  }
  return next;
}

// The `claude --resume` child outlives its runner: Windows does not kill a child
// when its parent dies, and on POSIX the child has its own process group. A runner
// killed outright therefore leaves a live Claude still writing to the session — and
// a claim that tracked only the runner read that as dead, and the supervisor put a
// second Claude on top of it. `locate` picks this attempt's claim out of the state,
// or nothing if a later attempt has replaced it.
async function recordChild(deps, pid, locate) {
  if (!Number.isInteger(pid)) return;
  const startedAt = await (deps.processStartedAt ?? processStartedAt)(pid);
  await deps.store.update((current) => {
    const claim = locate(current);
    if (!claim) return current;
    claim.childPid = pid;
    claim.childStartedAt = Number.isFinite(startedAt) ? startedAt : null;
    return current;
  }).catch(() => {});
}

// A pid alone is not an identity — the OS reuses it. Recording the process start
// time alongside it is what lets the reconciler tell "our runner, still working
// through a suspend" from "a stranger who inherited its number".
async function renewLease(store, runId, token, now, config, identity) {
  await store.update((state) => {
    const run = state.runs[runId];
    if (!run || run.recoveryLease?.token !== token) return state;
    const renewedAt = now();
    run.recoveryLease.lastRenewedAt = renewedAt;
    run.recoveryLease.expiresAt = renewedAt + config.leaseRenewalSeconds * config.leaseMissedRenewals;
    // Never write an identity we do not have. `startedAt` is `undefined` when the
    // probe could not ask, JSON drops the key, and a live runner then reads
    // `unknown` instead of `alive` — the reconciler was hardened against exactly
    // this and the runner was left doing it.
    if (Number.isInteger(identity.pid)) run.recoveryLease.pid = identity.pid;
    if (Number.isFinite(identity.startedAt)) run.recoveryLease.startedAt = identity.startedAt;
    return state;
  });
}

export async function runAttempt(attemptId, deps) {
  const state = await deps.store.read();
  const entry = Object.entries(state.runs).find(([, run]) => run.recoveryLease?.attemptId === attemptId);
  if (!entry && state.activation.inProgress && state.activation.attemptId === attemptId) {
    const renewActivation = () => deps.store.update((current) => {
      if (current.activation.token !== state.activation.token) return current;
      const renewedAt = deps.now();
      current.activation.lastRenewedAt = renewedAt;
      current.activation.expiresAt = renewedAt + deps.config.leaseRenewalSeconds * deps.config.leaseMissedRenewals;
      // Stamp the identity too: whichever of us gets there first, the claim is
      // verifiable from the first second and never mistaken for abandoned.
      current.activation.pid = deps.identity.pid;
      current.activation.startedAt = deps.identity.startedAt;
      return current;
    }).catch(() => {});
    await renewActivation();
    const interval = deps.setInterval(renewActivation, deps.config.leaseRenewalSeconds * 1000);
    let result;
    try {
      result = await deps.runActivation({ id: attemptId, timeoutSeconds: deps.config.recoveryAttemptTimeoutSeconds }, {
        onChildStarted: (pid) => recordChild(deps, pid, (current) => (
          current.activation?.token === state.activation.token ? current.activation : null
        )),
      });
    }
    catch (error) { result = { kind: 'failure', reason: error?.code ?? 'runner-exception' }; }
    finally { deps.clearInterval(interval); }
    let finalized;
    let applied = false;
    await deps.store.update((current) => {
      applied = current.activation.token === state.activation.token;
      finalized = finalizeActivation(current, state.activation.token, result, deps.now());
      return finalized;
    });
    // A finalize that never landed leaves `finalized` undefined; reading through
    // it would throw and lose the result entirely.
    if (!applied || !finalized) return { code: 'skip:stale-attempt' };
    return { code: finalized.activation.lastResult };
  }
  if (!entry) return { code: 'skip:attempt-not-found' };
  const [runId, run] = entry;
  // Stamp the identity now rather than one renewal interval from now. The
  // reconciler stamps it too; whichever of us survives, the claim is verifiable
  // from the first second, and a runner that dies early is never mistaken for free.
  await renewLease(deps.store, runId, run.recoveryLease.token, deps.now, deps.config, deps.identity).catch(() => {});
  const interval = deps.setInterval(
    () => renewLease(deps.store, runId, run.recoveryLease.token, deps.now, deps.config, deps.identity).catch(() => {}),
    deps.config.leaseRenewalSeconds * 1000,
  );
  let result;
  try {
    try {
      result = await deps.runClaude({ id: attemptId, run, timeoutSeconds: deps.config.recoveryAttemptTimeoutSeconds }, {
        onChildStarted: (pid) => recordChild(deps, pid, (state) => {
          const lease = state.runs[runId]?.recoveryLease;
          return lease?.token === run.recoveryLease.token ? lease : null;
        }),
      });
    } catch (error) {
      result = { kind: 'failure', reason: error?.code ?? 'runner-exception' };
    }
  } finally {
    deps.clearInterval(interval);
  }
  let finalized;
  let applied = false;
  await deps.store.update((current) => {
    // finalizeAttempt no-ops on a token mismatch and returns the state unchanged,
    // so the saved record still carries the winner's result. Without this flag a
    // superseded attempt would report the winner's success as its own.
    applied = current.runs[runId]?.recoveryLease?.token === run.recoveryLease.token;
    finalized = finalizeAttempt(current, runId, run.recoveryLease.token, result, deps.now(), deps.config);
    return finalized;
  });
  if (!applied) return { code: 'skip:stale-attempt' };
  const saved = finalized.runs[runId];
  const exhausted = saved?.state === 'FAILED'
    && (saved.retry?.attempts ?? 0) >= deps.config.maxRecoveryAttempts
    && !Number.isFinite(saved.retry?.nextAttemptAt);
  // The spec says exhaustion notifies the operator. It only ever notified on a
  // quota escalation, so a run that simply ran out of retries died in silence.
  if (saved?.lastResult === 'result:quota-backoff-escalated') await deps.notify(saved, 'quota-escalated');
  else if (exhausted) await deps.notify(saved, 'exhausted');
  return { code: result.kind === 'success' ? 'result:success' : saved?.lastResult ?? 'error:resume-failed' };
}

function dataRoot() {
  if (process.env.AFK_SUPERVISOR_DATA_DIR) return process.env.AFK_SUPERVISOR_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'afk-supervisor');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'afk-supervisor');
  return join(homedir(), '.local', 'share', 'afk-supervisor');
}

async function main() {
  const index = process.argv.indexOf('--attempt');
  const attemptId = index >= 0 ? process.argv[index + 1] : null;
  if (!attemptId) {
    process.stderr.write('error:attempt-required\n');
    process.exitCode = 2;
    return;
  }
  const root = dataRoot();
  const activationCwd = join(root, 'activation-work');
  await mkdir(activationCwd, { recursive: true });
  const config = await new ConfigStore(root).read();
  const now = () => Math.floor(Date.now() / 1000);
  // Read once, at start: this is the identity the reconciler later matches a
  // surviving pid against, so that a recycled number cannot pose as this runner.
  const identity = { pid: process.pid, startedAt: await processStartedAt(process.pid) };
  const result = await runAttempt(attemptId, {
    store: new StateStore(root), config, now, identity,
    runClaude: (attempt, hooks) => executeClaude(attempt, {
      now,
      startClaude: (value) => startClaudeProcess(value, { executable: config.claudePath }),
      ...hooks,
    }),
    runActivation: (attempt, hooks) => executeActivation(attempt, {
      now,
      startActivation: (value) => startActivationProcess(value, { executable: config.claudePath, cwd: activationCwd }),
      ...hooks,
    }),
    setInterval, clearInterval, notify: createNotifier({ root }),
  });
  await appendBoundedLog(join(root, 'logs', 'runner.log'), {
    at: new Date().toISOString(), code: result.code, attemptId,
  });
  process.stdout.write(`${result.code}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
