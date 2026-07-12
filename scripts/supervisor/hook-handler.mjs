#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ConfigStore } from './config.mjs';
import { WINDOW_SECONDS } from './constants.mjs';
import { parseSupervisorLedger } from './ledger.mjs';
import { StateStore } from './state-store.mjs';
import { stableJitterSeconds } from './usage-provider.mjs';

function dataRoot() {
  if (process.env.AFK_SUPERVISOR_DATA_DIR) return process.env.AFK_SUPERVISOR_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'afk-supervisor');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'afk-supervisor');
  return join(homedir(), '.local', 'share', 'afk-supervisor');
}

function containedPath(cwd, target) {
  const rel = relative(cwd, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function newRun(metadata, event, ledgerPath) {
  return {
    runId: metadata.runId,
    sessionId: metadata.sessionId,
    cwd: event.cwd,
    ledgerPath,
    state: metadata.state,
    lastHeartbeatAt: metadata.heartbeatAt,
    nextExpectedTickAt: metadata.nextExpectedTickAt,
    firstRateLimitedAt: null,
    rateLimitedUntil: null,
    resetConfidence: 'unknown',
    scheduledResumeAt: null,
    scheduledResetAt: null,
    scheduleState: null,
    scheduleConfidence: null,
    updatedAt: metadata.heartbeatAt,
    lease: { attemptId: null, token: null, lastRenewedAt: null, expiresAt: null },
    retry: { attempts: 0, nextAttemptAt: null },
    quotaRejections: { consecutive: 0, backoffLevel: 0, nextProbeAt: null, lastNotifiedAt: null },
  };
}

async function sessionStart(event, deps) {
  if (typeof event.cwd !== 'string' || !isAbsolute(event.cwd)) return { code: 'skip:cwd-invalid' };
  await deps.store.update((state) => {
    state.sessions[event.cwd] = { sessionId: event.session_id, observedAt: deps.now() };
    return state;
  });
  const ledgerPath = join(event.cwd, '.afk', 'afk-ledger.md');
  if (!containedPath(event.cwd, ledgerPath)) return { code: 'skip:ledger-path-invalid' };
  let text;
  try { text = await deps.readFile(ledgerPath); } catch { return { code: 'skip:ledger-missing' }; }
  const metadata = parseSupervisorLedger(text);
  if (!metadata || metadata.sessionId !== event.session_id) return { code: 'skip:ledger-not-recoverable' };
  if (deps.now() - metadata.heartbeatAt > deps.config.registrationRecoveryMaxAgeSeconds) {
    return { code: 'skip:ledger-stale' };
  }
  let reconstructed = false;
  await deps.store.update((state) => {
    const existing = state.runs[metadata.runId];
    reconstructed = !existing;
    state.runs[metadata.runId] = {
      ...(existing ?? newRun(metadata, event, ledgerPath)),
      sessionId: metadata.sessionId,
      cwd: event.cwd,
      ledgerPath,
      lastHeartbeatAt: metadata.heartbeatAt,
      nextExpectedTickAt: metadata.nextExpectedTickAt,
      updatedAt: deps.now(),
    };
    return state;
  });
  return { code: reconstructed ? 'action:run-reconstructed' : 'action:run-reconciled' };
}

function resetForRateLimit(state, run, now, config) {
  if (state.usage.confidence === 'exact' && state.usage.fiveHourResetAt > now) {
    return { resetAt: state.usage.fiveHourResetAt, confidence: 'exact' };
  }
  const anchorReset = Number.isFinite(state.usage.windowAnchorAt)
    ? state.usage.windowAnchorAt + WINDOW_SECONDS : null;
  if (anchorReset && now <= anchorReset + config.graceSeconds) {
    return { resetAt: anchorReset, confidence: 'estimated' };
  }
  return { resetAt: (run.firstRateLimitedAt ?? now) + WINDOW_SECONDS, confidence: 'estimated' };
}

async function stopFailure(event, deps) {
  let found = false;
  await deps.store.update((state) => {
    const entry = Object.entries(state.runs).find(([, run]) => run.sessionId === event.session_id);
    if (!entry) return state;
    found = true;
    const [id, run] = entry;
    const firstRateLimitedAt = run.firstRateLimitedAt ?? deps.now();
    const reset = resetForRateLimit(state, { ...run, firstRateLimitedAt }, deps.now(), deps.config);
    const scheduledResumeAt = reset.resetAt + stableJitterSeconds({ ...run, runId: id }, reset.resetAt, deps.config);
    state.runs[id] = {
      ...run,
      state: 'RATE_LIMITED',
      firstRateLimitedAt,
      rateLimitedUntil: reset.resetAt,
      resetConfidence: reset.confidence,
      scheduledResetAt: reset.resetAt,
      scheduledResumeAt,
      scheduleConfidence: reset.confidence,
      scheduleState: 'pending',
      updatedAt: deps.now(),
      quotaRejections: {
        ...(run.quotaRejections ?? {}),
        consecutive: (run.quotaRejections?.consecutive ?? 0) + 1,
      },
    };
    return state;
  });
  return { code: found ? 'result:quota-rescheduled' : 'skip:run-not-registered' };
}

export async function handleHook(event, deps) {
  if (event?.hook_event_name === 'SessionStart') return sessionStart(event, deps);
  if (event?.hook_event_name === 'StopFailure' && event.error === 'rate_limit') return stopFailure(event, deps);
  return { code: 'skip:hook-event-ignored' };
}

async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function main() {
  let event;
  try { event = JSON.parse(await readStdin()); } catch {
    process.stderr.write('skip:hook-input-malformed\n');
    return;
  }
  const result = await handleHook(event, {
    store: new StateStore(dataRoot()), config: await new ConfigStore(dataRoot()).read(),
    now: () => Math.floor(Date.now() / 1000), readFile: (path) => readFile(path, 'utf8'),
  });
  process.stderr.write(`${result.code}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
