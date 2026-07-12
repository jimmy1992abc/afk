#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readStdin, runBridge } from './statusline-bridge.mjs';

export async function runPrevious(command, input) {
  if (typeof command !== 'string' || command.length === 0) return 0;
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'ignore'], windowsHide: true });
    // A status-line command that exits without draining stdin makes the write
    // fail with EPIPE; that is normal and must not raise.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.once('error', () => resolve(0));
    child.once('close', (code) => resolve(code ?? 0));
  });
}

export async function runWrapper({ root, raw, previousCommand, previous = runPrevious, bridge = runBridge }) {
  // The user's status line renders first and owns stdout and the exit code. AFK
  // observation is best effort and may never take it down or delay it.
  const code = await previous(previousCommand, raw);
  try {
    await bridge({ root, raw });
  } catch {
    // An unwritable data directory must not blank the status line.
  }
  return code;
}

async function main() {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.env.AFK_SUPERVISOR_DATA_DIR;
  if (!root) return;
  let chain = {};
  try { chain = JSON.parse(await readFile(join(root, 'statusline-chain.json'), 'utf8')); } catch {}
  process.exitCode = await runWrapper({ root, raw: await readStdin(), previousCommand: chain.previousCommand });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
