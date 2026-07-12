#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ConfigStore } from './config.mjs';
import { parseSupervisorLedger } from './ledger.mjs';
import { isTerminalState } from './state-machine.mjs';
import { StateStore, emptyRecoveryLease } from './state-store.mjs';
import { currentRateLimitStart, estimateReset, stableJitterSeconds } from './usage-provider.mjs';

function dataRoot() {
  if (process.env.AFK_SUPERVISOR_DATA_DIR) return process.env.AFK_SUPERVISOR_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'afk-supervisor');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'afk-supervisor');
  return join(homedir(), '.local', 'share', 'afk-supervisor');
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
    recoveryLease: emptyRecoveryLease(),
    tickGuard: null,
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

async function stopFailure(event, deps) {
  let found = false;
  await deps.store.update((state) => {
    // A terminal run stays terminal. The operator keeps using the same session
    // interactively after a run completes, and a rate limit there would otherwise
    // park the finished run RATE_LIMITED and have the supervisor fire
    // `claude --resume` at a session a human is sitting in front of.
    const entry = Object.entries(state.runs)
      .find(([, run]) => run.sessionId === event.session_id && !isTerminalState(run.state));
    if (!entry) return state;
    found = true;
    const [id, run] = entry;
    const now = deps.now();
    const firstRateLimitedAt = currentRateLimitStart(run, now);
    const reset = estimateReset(state.usage, { firstRateLimitedAt }, now, deps.config);
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
      updatedAt: now,
      // The runner owns the probe-rejection counter. The supervisor's own
      // --resume runs with hooks enabled, so a single quota rejection reaches
      // both this hook and the runner's stream classifier; counting it here too
      // would escalate to a 24-hour backoff after two rejections, not three.
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
