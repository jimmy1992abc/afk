#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ConfigStore } from './config.mjs';
import { commitObservationBatch, readObservationBatch } from './observation-inbox.mjs';
import { readLedgerHeartbeatFile } from './ledger.mjs';
import { reconcileOnce } from './reconciler.mjs';
import { StateStore } from './state-store.mjs';
import { createWindowNotifier } from './notifier.mjs';
import { appendBoundedLog } from './logger.mjs';

function root() {
  if (process.env.AFK_SUPERVISOR_DATA_DIR) return process.env.AFK_SUPERVISOR_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'afk-supervisor');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'afk-supervisor');
  return join(homedir(), '.local', 'share', 'afk-supervisor');
}

export async function main(argv = process.argv.slice(2)) {
  const data = root();
  const config = await new ConfigStore(data).read();
  const store = new StateStore(data);
  const runner = new URL('./runner.mjs', import.meta.url);
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
    notifyWindow: createWindowNotifier({ root: data }),
    dryRun: argv.includes('--dry-run'),
    spawnRunner: (attempt) => spawn(process.execPath, [fileURLToPath(runner), '--attempt', attempt.id], {
      detached: true, stdio: 'ignore', env: { ...process.env, AFK_SUPERVISOR_DATA_DIR: data },
    }),
  });
  await appendBoundedLog(join(data, 'logs', 'supervisor.log'), {
    at: new Date().toISOString(), code: result.code, attemptId: result.attemptId ?? null,
  });
  process.stdout.write(`${result.code}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
