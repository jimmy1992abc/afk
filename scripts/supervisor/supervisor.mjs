#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ConfigStore } from './config.mjs';
import { commitObservationBatch, readObservationBatch, sweepObservations } from './observation-inbox.mjs';
import { readLedgerHeartbeatFile } from './ledger.mjs';
import { reconcileOnce } from './reconciler.mjs';
import { StateStore } from './state-store.mjs';
import { createWindowNotifier } from './notifier.mjs';
import { appendBoundedLog } from './logger.mjs';

// The scheduler pins the root it installed into. Without it the worker would
// re-derive a root from an environment the scheduler does not share, and setup
// and the running supervisor could read two different state directories.
function root(argv) {
  const pinned = argv.indexOf('--root');
  if (pinned >= 0 && argv[pinned + 1]) return argv[pinned + 1];
  if (process.env.AFK_SUPERVISOR_DATA_DIR) return process.env.AFK_SUPERVISOR_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'afk-supervisor');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'afk-supervisor');
  return join(homedir(), '.local', 'share', 'afk-supervisor');
}

export async function main(argv = process.argv.slice(2)) {
  const data = root(argv);
  const config = await new ConfigStore(data).read();
  const store = new StateStore(data);
  const runner = new URL('./runner.mjs', import.meta.url);
  // A pass that loses a lock race, or hits a revision conflict, must still name
  // what happened. Letting it escape gives an unhandled rejection with no log
  // line and no result code — the pass simply vanishes.
  const result = await reconcileOnce({
    store, config,
    now: () => Math.floor(Date.now() / 1000),
    readObservationBatch: () => readObservationBatch(data), commitObservationBatch,
    readHeartbeats: async () => {
      const state = await store.read();
      const pairs = await Promise.all(Object.entries(state.runs).map(async ([id, run]) => [
        id, await readLedgerHeartbeatFile(run.ledgerPath, id, run.sessionId),
      ]));
      return Object.fromEntries(pairs.filter(([, heartbeat]) => Number.isFinite(heartbeat)));
    },
    readLedgerHeartbeat: (run) => readLedgerHeartbeatFile(run.ledgerPath, run.runId, run.sessionId),
    // A lease that expired while its runner slept is not an abandoned lease.
    isRunnerAlive: async (pid) => {
      try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
    },
    notifyWindow: createWindowNotifier({ root: data }),
    dryRun: argv.includes('--dry-run'),
    spawnRunner: (attempt) => spawn(process.execPath, [fileURLToPath(runner), '--attempt', attempt.id], {
      detached: true, stdio: 'ignore', env: { ...process.env, AFK_SUPERVISOR_DATA_DIR: data },
    }),
  }).catch((error) => ({ code: `error:${error?.code === 'LOCK_HELD' ? 'state-lock-held' : 'pass-failed'}` }));
  // Outside the lock and after the pass: an inbox file the reconciler will never
  // import is never committed either, so it would be re-read on every pass for
  // ever. Sweeping must never fail a pass that has already done its work.
  await sweepObservations(data).catch(() => {});
  await appendBoundedLog(join(data, 'logs', 'supervisor.log'), {
    at: new Date().toISOString(), code: result.code, attemptId: result.attemptId ?? null,
  }).catch(() => {});
  process.stdout.write(`${result.code}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
