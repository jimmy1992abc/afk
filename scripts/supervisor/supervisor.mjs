#!/usr/bin/env node
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ConfigStore } from './config.mjs';
import { runActivation } from './claude-runner.mjs';
import { createNotifier } from './notifier.mjs';
import { dataRoot } from './hook-handler.mjs';
import { appendBoundedLog } from './logger.mjs';
import { paths, readJson, readState, writeState } from './state.mjs';
import { runPass } from './pass.mjs';

// The scheduler pins the root it installed into. Without it the worker would
// re-derive a root from an environment the scheduler does not share, and setup
// and the running pass could read two different state directories.
function root(argv) {
  const pinned = argv.indexOf('--root');
  if (pinned >= 0 && argv[pinned + 1]) return argv[pinned + 1];
  return dataRoot();
}

export async function runOnce(data) {
  // A pass that dies must still name what happened: letting anything escape —
  // including a corrupt config, which fails BEFORE the pass proper — gives an
  // unhandled rejection with no log line, and the scheduler reports success for
  // ever while the activator does nothing.
  const result = await (async () => {
    const config = await new ConfigStore(data).read();
    const files = paths(data);
    return runPass({
      config,
      now: () => Math.floor(Date.now() / 1000),
      readObservation: () => readJson(files.observation, null),
      readStopFailure: () => readJson(files.stopFailure, null),
      readState: () => readState(data),
      writeState: (state) => writeState(data, state),
      activate: () => runActivation({
        executable: config.claudePath ?? undefined,
        timeoutSeconds: config.activationTimeoutSeconds,
        cwd: data,
      }),
      notify: createNotifier({ root: data }),
    });
  })().catch((error) => (
    { code: 'error:pass-failed', message: String(error?.message ?? error) }
  ));
  await appendBoundedLog(join(data, 'logs', 'supervisor.log'), {
    at: new Date().toISOString(),
    ...result,
  }).catch(() => {});
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const result = await runOnce(root(argv));
  if (result.code.startsWith('error:')) process.exitCode = 1;
  process.stdout.write(`${result.code}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
