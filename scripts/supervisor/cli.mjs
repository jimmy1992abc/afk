#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ConfigStore, validateConfig } from './config.mjs';
import { createInstallDeps, installSupervisor, preflightClaude, repairSupervisor, statusSupervisor, uninstallSupervisor } from './install.mjs';
import { main as reconcileMain } from './supervisor.mjs';
import { transitionRun } from './state-machine.mjs';
import { StateStore } from './state-store.mjs';
import { scheduleRun } from './usage-provider.mjs';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function dataRoot() {
  if (process.env.AFK_SUPERVISOR_DATA_DIR) return process.env.AFK_SUPERVISOR_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'afk-supervisor');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'afk-supervisor');
  return join(homedir(), '.local', 'share', 'afk-supervisor');
}

function parseArgs(argv) {
  const values = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) values._.push(value);
    else {
      const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) values[key] = true;
      else { values[key] = next; index += 1; }
    }
  }
  return values;
}

function emit(deps, value, code = 0) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  deps.writeOutput(`${text}\n`);
  return { code, value };
}

function numberValue(value, key) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${key} must be numeric`);
  return parsed;
}

async function configure(args, deps) {
  const config = await deps.configStore.read();
  const mapping = {
    windowMode: 'windowMode', activeRunRecovery: 'activeRunRecovery', catchUpMode: 'catchUpMode',
    thresholdPercentage: 'thresholdPercentage', maxConcurrentInvocations: 'maxConcurrentInvocations',
    heartbeatStaleSeconds: 'heartbeatStaleSeconds', graceSeconds: 'graceSeconds',
  };
  for (const [arg, key] of Object.entries(mapping)) {
    if (args[arg] === undefined) continue;
    config[key] = ['thresholdPercentage', 'maxConcurrentInvocations', 'heartbeatStaleSeconds', 'graceSeconds'].includes(key)
      ? numberValue(args[arg], arg) : args[arg];
  }
  await deps.configStore.write(validateConfig(config));
  return emit(deps, 'action:config-updated');
}

async function register(args, deps) {
  let sessionId = args.sessionId;
  if (!sessionId && args.cwd) {
    const state = await deps.stateStore.read();
    const observed = state.sessions?.[args.cwd];
    if (observed && deps.now() - observed.observedAt <= deps.currentConfig.registrationRecoveryMaxAgeSeconds) {
      sessionId = observed.sessionId;
    }
  }
  if (!RUN_ID.test(args.runId ?? '') || !SESSION_ID.test(sessionId ?? '') || !args.cwd || !args.ledger) {
    return emit(deps, 'error:registration-invalid', 2);
  }
  await deps.stateStore.update((state) => {
    const existing = state.runs[args.runId];
    // Registration is repeated by the AFK lifecycle, so it may only refresh
    // identity and liveness. Recovery state — schedules, quota backoff, retry
    // counters — belongs to the supervisor and must survive re-registration.
    const merged = {
      ...(existing ?? newRunRecovery()),
      runId: args.runId, sessionId, cwd: args.cwd, ledgerPath: args.ledger,
      state: existing?.state ?? 'RUNNING',
      lastHeartbeatAt: deps.now(), nextExpectedTickAt: deps.now() + 900,
      updatedAt: deps.now(),
    };
    state.runs[args.runId] = existing
      ? merged
      : inheritThresholdSchedule(merged, state.usage, deps.currentConfig, deps.now());
    return state;
  });
  return emit(deps, 'action:run-registered');
}

function newRunRecovery() {
  return {
    firstRateLimitedAt: null, rateLimitedUntil: null, resetConfidence: 'unknown',
    scheduledResumeAt: null, scheduledResetAt: null, scheduleState: null, scheduleConfidence: null,
    lease: { attemptId: null, token: null, lastRenewedAt: null, expiresAt: null },
    retry: { attempts: 0, nextAttemptAt: null },
    quotaRejections: { consecutive: 0, backoffLevel: 0, nextProbeAt: null, lastNotifiedAt: null },
  };
}

// A run registered after the 90% crossing but before the reset joins the queue
// for the reset that is already armed.
function inheritThresholdSchedule(run, usage, config, now) {
  const resetAt = usage.thresholdResetAt;
  if (usage.confidence !== 'exact' || !Number.isFinite(resetAt) || resetAt <= now) return run;
  return scheduleRun(run, resetAt, 'exact', config, now);
}

async function transition(args, deps) {
  let found = false;
  try {
    await deps.stateStore.update((state) => {
      const run = state.runs[args.runId];
      if (!run) return state;
      found = true;
      state.runs[args.runId] = transitionRun(run, args.state, deps.now());
      if (['COMPLETED', 'BLOCKED', 'AUTO_PAUSED'].includes(args.state)) {
        state.runs[args.runId].lease = { attemptId: null, token: null, lastRenewedAt: null, expiresAt: null };
        state.runs[args.runId].scheduleState = 'cancelled';
      }
      return state;
    });
  } catch (error) { return emit(deps, `error:${error.message}`, 2); }
  return found ? emit(deps, `action:run-${args.state.toLowerCase()}`) : emit(deps, 'skip:run-not-registered', 1);
}

async function lease(args, deps) {
  let result = 'skip:run-not-registered';
  await deps.stateStore.update((state) => {
    const run = state.runs[args.runId];
    if (!run) return state;
    const owner = `in-session-${run.sessionId}`;
    if (run.lease?.expiresAt > deps.now() && run.lease.attemptId !== owner) {
      result = 'skip:recovery-lease-held'; return state;
    }
    const config = deps.currentConfig;
    run.lease = {
      attemptId: owner, token: run.lease?.attemptId === owner ? run.lease.token : randomUUID(), lastRenewedAt: deps.now(),
      expiresAt: deps.now() + config.heartbeatStaleSeconds,
    };
    run.lastHeartbeatAt = deps.now();
    result = 'action:in-session-lease-acquired';
    return state;
  });
  return emit(deps, result, result.startsWith('action:') ? 0 : 1);
}

async function triggerNow(args, deps) {
  let found = false;
  await deps.stateStore.update((state) => {
    const run = state.runs[args.runId];
    if (!run) return state;
    found = true;
    run.quotaRejections = { consecutive: 0, backoffLevel: 0, nextProbeAt: null, lastNotifiedAt: null };
    run.scheduledResumeAt = deps.now();
    run.scheduledResetAt ??= deps.now();
    run.scheduleState = 'pending';
    return state;
  });
  if (!found) return emit(deps, 'skip:run-not-registered', 1);
  const result = await deps.reconcile();
  return emit(deps, result.code);
}

export async function runCli(argv, deps) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  deps.currentConfig = await deps.configStore.read();
  try {
    if (command === 'setup') {
      const verified = await deps.preflight();
      deps.currentConfig = await deps.configStore.write({ ...deps.currentConfig, claudePath: verified.claudePath });
      return emit(deps, (await deps.install()).code);
    }
    if (command === 'repair') return emit(deps, (await deps.repair()).code);
    if (command === 'uninstall') return emit(deps, (await deps.uninstall()).code);
    if (command === 'status') {
      const value = { ...(await deps.installStatus()), config: deps.currentConfig, state: await deps.stateStore.read() };
      return emit(deps, args.json ? value : `status:${value.installed ? 'installed' : 'not-installed'}`);
    }
    if (command === 'enable' || command === 'disable') {
      await deps.configStore.write({ ...deps.currentConfig, enabled: command === 'enable' });
      return emit(deps, `action:supervisor-${command}d`);
    }
    if (command === 'configure') return configure(args, deps);
    if (command === 'register') return register(args, deps);
    if (command === 'transition') return transition(args, deps);
    if (command === 'lease') return lease(args, deps);
    if (command === 'trigger-now') return triggerNow(args, deps);
    return emit(deps, `error:unknown-command:${command ?? ''}`, 2);
  } catch (error) {
    return emit(deps, `error:${error.message}`, 2);
  }
}

export function productionDeps() {
  const root = dataRoot();
  const sourceRoot = dirname(fileURLToPath(import.meta.url));
  const installDeps = createInstallDeps({ dataRoot: root, sourceRoot });
  return {
    configStore: new ConfigStore(root), stateStore: new StateStore(root), now: () => Math.floor(Date.now() / 1000),
    preflight: () => preflightClaude(),
    install: () => installSupervisor(installDeps), repair: () => repairSupervisor(installDeps),
    uninstall: () => uninstallSupervisor(installDeps), installStatus: () => statusSupervisor(installDeps),
    reconcile: () => reconcileMain(['--once']), writeOutput: (text) => process.stdout.write(text),
  };
}

async function main() {
  const result = await runCli(process.argv.slice(2), productionDeps());
  process.exitCode = result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
