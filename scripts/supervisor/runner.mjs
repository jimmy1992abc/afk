#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ConfigStore } from './config.mjs';
import { WINDOW_SECONDS } from './constants.mjs';
import { mkdir } from 'node:fs/promises';
import { runActivation as executeActivation, runClaude as executeClaude, startActivationProcess, startClaudeProcess } from './claude-runner.mjs';
import { StateStore } from './state-store.mjs';
import { currentRateLimitStart, estimateReset, stableJitterSeconds } from './usage-provider.mjs';
import { createNotifier } from './notifier.mjs';
import { appendBoundedLog } from './logger.mjs';

function clearLease() {
  return { attemptId: null, token: null, lastRenewedAt: null, expiresAt: null };
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
  if (!run || run.lease?.token !== token) return state;
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
      lease: clearLease(), retry: { attempts: 0, nextAttemptAt: null },
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
      scheduleConfidence: reset.confidence, scheduleState: 'pending', lease: clearLease(),
      quotaRejections: { consecutive, backoffLevel, nextProbeAt, lastNotifiedAt: lastResult.endsWith('escalated') ? now : current.quotaRejections?.lastNotifiedAt ?? null },
      lastResult, updatedAt: now,
    };
    return next;
  }
  const attempts = (current.retry?.attempts ?? 0) + 1;
  const delays = [300, 1200, 3600];
  next.runs[runId] = {
    ...current,
    state: 'FAILED', lease: clearLease(),
    retry: { attempts, nextAttemptAt: attempts <= config.maxRecoveryAttempts ? now + delays[Math.min(attempts - 1, delays.length - 1)] : null },
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
    next.usage.windowAnchorAt = now;
    next.usage.fiveHourResetAt = now + WINDOW_SECONDS;
    next.usage.source = 'window-anchor';
    next.usage.confidence = 'estimated';
    next.usage.observedAt = now;
  } else {
    next.activation.lastResult = result.kind === 'quota'
      ? 'result:activation-quota-rejected' : 'error:activation-failed';
  }
  return next;
}

async function renewLease(store, runId, token, now, config, pid = process.pid) {
  await store.update((state) => {
    const run = state.runs[runId];
    if (!run || run.lease?.token !== token) return state;
    const renewedAt = now();
    run.lease.lastRenewedAt = renewedAt;
    run.lease.expiresAt = renewedAt + config.leaseRenewalSeconds * config.leaseMissedRenewals;
    // Expiry alone does not mean this runner died — a suspended machine stops
    // the timer while the process lives. The reconciler checks this pid before
    // it re-issues the lease.
    run.lease.pid = pid;
    return state;
  });
}

export async function runAttempt(attemptId, deps) {
  const state = await deps.store.read();
  const entry = Object.entries(state.runs).find(([, run]) => run.lease?.attemptId === attemptId);
  if (!entry && state.activation.inProgress && state.activation.attemptId === attemptId) {
    const interval = deps.setInterval(() => {
      deps.store.update((current) => {
        if (current.activation.token !== state.activation.token) return current;
        const renewedAt = deps.now();
        current.activation.lastRenewedAt = renewedAt;
        current.activation.expiresAt = renewedAt + deps.config.leaseRenewalSeconds * deps.config.leaseMissedRenewals;
        return current;
      }).catch(() => {});
    }, deps.config.leaseRenewalSeconds * 1000);
    let result;
    try { result = await deps.runActivation({ id: attemptId, timeoutSeconds: deps.config.recoveryAttemptTimeoutSeconds }); }
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
  const interval = deps.setInterval(
    () => renewLease(deps.store, runId, run.lease.token, deps.now, deps.config).catch(() => {}),
    deps.config.leaseRenewalSeconds * 1000,
  );
  let result;
  try {
    try {
      result = await deps.runClaude({ id: attemptId, run, timeoutSeconds: deps.config.recoveryAttemptTimeoutSeconds });
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
    applied = current.runs[runId]?.lease?.token === run.lease.token;
    finalized = finalizeAttempt(current, runId, run.lease.token, result, deps.now(), deps.config);
    return finalized;
  });
  if (!applied) return { code: 'skip:stale-attempt' };
  const saved = finalized.runs[runId];
  const exhausted = saved?.state === 'FAILED'
    && (saved.retry?.attempts ?? 0) >= deps.config.maxRecoveryAttempts
    && !Number.isFinite(saved.retry?.nextAttemptAt);
  // The spec says exhaustion notifies the operator. It only ever notified on a
  // quota escalation, so a run that simply ran out of retries died in silence.
  if (saved?.lastResult === 'result:quota-backoff-escalated' || exhausted) await deps.notify(saved);
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
  const result = await runAttempt(attemptId, {
    store: new StateStore(root), config, now,
    runClaude: (attempt) => executeClaude(attempt, {
      now,
      startClaude: (value) => startClaudeProcess(value, { executable: config.claudePath }),
    }),
    runActivation: (attempt) => executeActivation(attempt, {
      now,
      startActivation: (value) => startActivationProcess(value, { executable: config.claudePath, cwd: activationCwd }),
    }),
    setInterval, clearInterval, notify: createNotifier({ root }),
  });
  await appendBoundedLog(join(root, 'logs', 'runner.log'), {
    at: new Date().toISOString(), code: result.code, attemptId,
  });
  process.stdout.write(`${result.code}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
