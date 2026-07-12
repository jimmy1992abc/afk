#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ConfigStore } from './config.mjs';
import { commitObservationBatch, readObservationBatch } from './observation-inbox.mjs';
import { reconcileOnce } from './reconciler.mjs';
import { StateStore } from './state-store.mjs';

function root() {
  if (process.env.AFK_SUPERVISOR_DATA_DIR) return process.env.AFK_SUPERVISOR_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'afk-supervisor');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'afk-supervisor');
  return join(homedir(), '.local', 'share', 'afk-supervisor');
}

export async function main(argv = process.argv.slice(2)) {
  const data = root();
  const config = await new ConfigStore(data).read();
  const runner = new URL('./runner.mjs', import.meta.url);
  const result = await reconcileOnce({
    store: new StateStore(data), config,
    now: () => Math.floor(Date.now() / 1000),
    readObservationBatch: () => readObservationBatch(data), commitObservationBatch,
    readHeartbeats: async () => ({}), readLedgerHeartbeat: async () => null,
    dryRun: argv.includes('--dry-run'),
    spawnRunner: (attempt) => spawn(process.execPath, [fileURLToPath(runner), '--attempt', attempt.id], {
      detached: true, stdio: 'ignore', env: { ...process.env, AFK_SUPERVISOR_DATA_DIR: data },
    }),
  });
  process.stdout.write(`${result.code}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
