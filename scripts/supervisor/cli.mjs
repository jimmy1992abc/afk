#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ATTEMPT_ENV, validateRecoveryRun } from './claude-runner.mjs';
import { ConfigStore, validateConfig } from './config.mjs';
import { createInstallDeps, installSupervisor, preflightClaude, repairSupervisor, statusSupervisor, uninstallSupervisor } from './install.mjs';
import { runnerLiveness } from './platform.mjs';
import { main as reconcileMain } from './supervisor.mjs';
import { claimLiveness, claimOccupied, transitionRun } from './state-machine.mjs';
import { StateStore, emptyRecoveryLease } from './state-store.mjs';
import { scheduleRun } from './usage-provider.mjs';

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
      // A cwd that has seen two sessions cannot say which one owns this ledger, and
      // guessing binds the run to the wrong conversation — recovery would then
      // `claude --resume` a session that has nothing to do with it. The caller knows
      // its own session id; it has to say so.
      if (observed.ambiguous) return emit(deps, 'error:registration-ambiguous', 2);
      sessionId = observed.sessionId;
    }
  }
  if (!RUN_ID.test(args.runId ?? '')) return emit(deps, 'error:registration-invalid', 2);
  try {
    // The one rule recovery itself applies. Accepting a relative cwd, a relative
    // ledger, or a ledger outside the run only deferred the refusal to recovery
    // time, where the throw burns one of the run's finite attempts on every
    // invocation until they are exhausted — a run that can never be resumed, and
    // no word of it while an operator was still there to see it.
    validateRecoveryRun({ sessionId, cwd: args.cwd, ledgerPath: args.ledger });
  } catch {
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
    recoveryLease: emptyRecoveryLease(),
    tickGuard: null,
    forcedUntil: null,
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
        state.runs[args.runId].recoveryLease = emptyRecoveryLease();
        state.runs[args.runId].tickGuard = null;
        state.runs[args.runId].scheduleState = 'cancelled';
      }
      return state;
    });
  } catch (error) { return emit(deps, `error:${error.message}`, 2); }
  return found ? emit(deps, `action:run-${args.state.toLowerCase()}`) : emit(deps, 'skip:run-not-registered', 1);
}

// The in-session tick's overlap guard. It is NOT the supervisor's recovery lease:
// when the supervisor resumes a run, the session it starts runs this command, and
// under the old single-lease shape it found the supervisor's own claim, concluded
// another layer owned recovery, and exited without doing any work — for ever.
//
// The two claims are now separate fields. A session resumed by the supervisor
// takes its own guard and gets on with it. The only thing that blocks it is
// *another session* holding the guard, which is the overlap this guard is for.
async function lease(args, deps) {
  const before = await deps.stateStore.read();
  const target = before.runs[args.runId];
  if (!target) return emit(deps, 'skip:run-not-registered', 1);

  // The caller's own identity, not the run's. `lease` used to write the guard with
  // the RUN's session id and then compare the guard against the RUN's session id —
  // always equal, so the guard could never detect the overlap it exists for.
  const holder = args.sessionId ?? target.sessionId;

  // Is a supervisor runner driving this run right now, and is it a *different*
  // driver from the caller? The session the supervisor resumed carries the attempt
  // id of the recovery that started it; refusing that session is what deadlocked
  // the supervisor. Refusing every *other* session is the whole point of the claim.
  //
  // The liveness probe shells out to PowerShell or ps and is bounded at ten
  // seconds. A supervisor pass fits inside that gap easily, so its answer is only
  // ever advisory: it is taken here, outside the lock, and then re-validated
  // against the claim that is actually there when we commit. Deciding out here and
  // writing in there is how the tick took the guard on a run a runner had claimed
  // while the probe was still running — two Claudes on one session.
  const probed = target.recoveryLease;
  const attempt = deps.callerAttemptId?.() ?? null;
  const foreign = probed?.attemptId && probed.attemptId !== attempt;
  const liveness = foreign ? await claimLiveness(probed, deps.runnerLiveness) : 'dead';

  let result = 'skip:run-not-registered';
  await deps.stateStore.update((state) => {
    const run = state.runs[args.runId];
    if (!run) return state;

    const claim = run.recoveryLease;
    if (claim?.attemptId && claim.attemptId !== attempt) {
      // The probe only speaks for the claim it was taken against. If a runner
      // claimed the run while we were asking, this is a different claim and we know
      // nothing about it — so it is occupied.
      const sameClaim = claim.attemptId === probed?.attemptId && claim.token === probed?.token;
      const known = sameClaim ? liveness : 'unknown';
      if (claimOccupied(claim, deps.currentConfig, deps.now(), known)) {
        result = 'skip:runner-active'; return state;
      }
    }

    const guard = run.tickGuard;
    if (guard && guard.sessionId !== holder && guard.expiresAt > deps.now()) {
      result = 'skip:tick-guard-held'; return state;
    }
    run.tickGuard = {
      sessionId: holder,
      expiresAt: deps.now() + deps.currentConfig.heartbeatStaleSeconds,
    };
    run.lastHeartbeatAt = deps.now();
    result = 'action:tick-guard-acquired';
    return state;
  });
  return emit(deps, result, result.startsWith('action:') ? 0 : 1);
}

// The operator's only manual escape hatch, and the runs they reach for it with are
// exactly the ones the selector refuses: a run in retry backoff, a run that
// exhausted its attempts, a run wedged behind a lease whose runner is gone.
// Arming a schedule alone changes none of those, so it clears every hold it may
// safely clear.
//
// What it must NOT clear is a lease whose runner is genuinely still working:
// wiping that would start a second `claude --resume` on the same session, which
// is the corruption the whole liveness check exists to prevent.
async function triggerNow(args, deps) {
  const before = await deps.stateStore.read();
  const target = before.runs[args.runId];
  if (!target) return emit(deps, 'skip:run-not-registered', 1);

  // --force overrides the timers, the tick guard, and a claim we cannot verify — the
  // states an operator actually reaches for it in. It does not override a runner we
  // can SEE is alive: clearing that claim would leave a live Claude writing to the
  // session and start a second one on top of it. The runner's own action timeout
  // bounds how long it can hold the run.
  const probed = target.recoveryLease;
  if (await claimLiveness(probed, deps.runnerLiveness) === 'alive') {
    return emit(deps, 'skip:runner-alive', 1);
  }

  let outcome = null;
  await deps.stateStore.update((state) => {
    const run = state.runs[args.runId];
    if (!run) { outcome = 'skip:run-not-registered'; return state; }

    // The probe was taken before the lock, and it only speaks for the claim it was
    // taken against. A supervisor pass that claimed the run in that gap knows things
    // we do not — clearing its claim orphaned a live runner, and the reconcile this
    // command then kicks off started a second Claude on the same session.
    const claim = run.recoveryLease;
    const sameClaim = claim?.attemptId === probed?.attemptId && claim?.token === probed?.token;
    if (!sameClaim && claim?.attemptId) { outcome = 'skip:runner-active'; return state; }

    run.quotaRejections = { consecutive: 0, backoffLevel: 0, nextProbeAt: null, lastNotifiedAt: null };
    run.retry = { attempts: 0, nextAttemptAt: null };
    run.recoveryLease = emptyRecoveryLease();
    run.scheduledResumeAt = deps.now();
    run.scheduledResetAt ??= deps.now();
    run.scheduleState = 'pending';
    if (args.force) {
      // The stuck notification promises the operator that --force releases the run.
      // It released the recovery lease and nothing else: a live tick guard still
      // held it, and a heartbeat that merely *looked* fresh still held it. Both are
      // exactly what the operator is overriding by saying --force.
      run.tickGuard = null;
      run.forcedUntil = deps.now() + deps.currentConfig.heartbeatStaleSeconds;
    }
    return state;
  });
  if (outcome) return emit(deps, outcome, 1);
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
    runnerLiveness: (lease) => runnerLiveness(lease),
    // Set by the runner on the session it resumes; absent in every other session.
    callerAttemptId: () => process.env[ATTEMPT_ENV] ?? null,
  };
}

async function main() {
  const result = await runCli(process.argv.slice(2), productionDeps());
  process.exitCode = result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
