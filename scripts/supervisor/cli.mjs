#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ConfigStore } from './config.mjs';
import { createInstallDeps, installSupervisor, preflightClaude, statusSupervisor, uninstallSupervisor } from './install.mjs';
import { dataRoot } from './hook-handler.mjs';
import { runActivation } from './claude-runner.mjs';
import { paths, readJson, readState, writeState } from './state.mjs';
import { resolveReset, runPass } from './pass.mjs';
import { createNotifier } from './notifier.mjs';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (!rest[i].startsWith('--')) continue;
    const key = rest[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return { command, args };
}

function emit(deps, code, exitCode = 0) {
  deps.writeOutput(`${code}\n`);
  return { code: exitCode };
}

export async function runCli(argv, deps) {
  const { command, args } = parseArgs(argv);
  const config = await deps.configStore.read();

  if (command === 'setup') {
    const verified = await deps.preflight().catch((error) => { throw new Error(error.message); });
    await deps.configStore.write({ ...config, claudePath: verified.claudePath });
    const result = await deps.install();
    return emit(deps, result.code);
  }
  if (command === 'uninstall') {
    const result = await deps.uninstall();
    return emit(deps, result.code);
  }
  if (command === 'enable' || command === 'disable') {
    await deps.configStore.write({ ...config, enabled: command === 'enable' });
    return emit(deps, `action:${command}d`);
  }
  if (command === 'status') {
    const value = {
      config,
      state: await deps.readState(),
      scheduler: (await deps.installStatus()).scheduler,
      nextReset: resolveReset({
        observation: await deps.readObservation(),
        stopFailure: await deps.readStopFailure(),
        state: await deps.readState(),
        config,
      }),
    };
    deps.writeOutput(`${JSON.stringify(value, null, args.json ? 2 : 0)}\n`);
    return { code: 0 };
  }
  if (command === 'next-reset') {
    // Consumed by the afk skill: a rate-limited tick aims its next wake-up just
    // past this instead of waiting out the fixed interval. Only a FUTURE,
    // still-unhandled reset is worth aiming at — reporting a past or settled one
    // would point the tick "shortly after" an instant that already happened, and
    // the tick would spin on immediate retries instead of keeping its cadence.
    const state = await deps.readState();
    const target = resolveReset({
      observation: await deps.readObservation(),
      stopFailure: await deps.readStopFailure(),
      state,
      config,
    });
    const now = deps.now();
    const aimable = target
      && target.resetAt > now
      && !(Number.isFinite(state.handledResetAt) && target.resetAt <= state.handledResetAt);
    deps.writeOutput(`${JSON.stringify({
      resetAt: aimable ? target.resetAt : null,
      confidence: aimable ? target.confidence : null,
      handledResetAt: state.handledResetAt,
      now,
    })}\n`);
    return { code: aimable ? 0 : 1 };
  }
  if (command === 'run-once') {
    const result = await deps.runPass();
    return emit(deps, result.code, result.code.startsWith('error:') ? 1 : 0);
  }
  if (command === 'trigger-now') {
    // The operator's override: fire one activation now, regardless of the
    // gates. It touches no session, so the worst a mistimed trigger can cost is
    // one minimal request.
    const outcome = await deps.activate();
    const state = await deps.readState();
    if (outcome.kind === 'success') {
      await deps.writeState({
        ...state,
        windowAnchorAt: outcome.startedAt,
        nextAttemptAt: null,
        lastResult: 'result:activation-success',
      });
    }
    return emit(deps, outcome.kind === 'success' ? 'result:activation-success'
      : outcome.kind === 'quota' ? 'result:activation-quota-rejected' : 'error:activation-failed',
    outcome.kind === 'success' ? 0 : 1);
  }
  return emit(deps, 'error:unknown-command', 2);
}

export function productionDeps() {
  const root = dataRoot();
  const sourceRoot = dirname(fileURLToPath(import.meta.url));
  const installDeps = createInstallDeps({ dataRoot: root, sourceRoot });
  const files = paths(root);
  const configStore = new ConfigStore(root);
  return {
    configStore,
    now: () => Math.floor(Date.now() / 1000),
    preflight: () => preflightClaude(),
    install: () => installSupervisor(installDeps),
    uninstall: () => uninstallSupervisor(installDeps),
    installStatus: () => statusSupervisor(installDeps),
    readObservation: () => readJson(files.observation, null),
    readStopFailure: () => readJson(files.stopFailure, null),
    readState: () => readState(root),
    writeState: (state) => writeState(root, state),
    activate: async () => runActivation({
      executable: (await configStore.read()).claudePath ?? undefined,
      timeoutSeconds: (await configStore.read()).activationTimeoutSeconds,
      cwd: root,
    }),
    runPass: async () => (await import('./supervisor.mjs')).runOnce(root),
    notify: createNotifier({ root }),
    writeOutput: (text) => process.stdout.write(text),
  };
}

async function main() {
  const result = await runCli(process.argv.slice(2), productionDeps()).catch((error) => {
    process.stdout.write(`error:${error.message}\n`);
    return { code: 1 };
  });
  process.exitCode = result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
