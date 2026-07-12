#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readStdin, runBridge } from './statusline-bridge.mjs';

async function runPrevious(command, input) {
  if (!command) return;
  await new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'ignore'], windowsHide: true });
    child.stdin.end(input);
    child.once('error', resolve);
    child.once('close', resolve);
  });
}

export async function runWrapper({ root, raw, previousCommand }) {
  await runBridge({ root, raw });
  await runPrevious(previousCommand, raw);
}

async function main() {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.env.AFK_SUPERVISOR_DATA_DIR;
  if (!root) return;
  let chain = {};
  try { chain = JSON.parse(await readFile(join(root, 'statusline-chain.json'), 'utf8')); } catch {}
  await runWrapper({ root, raw: await readStdin(), previousCommand: chain.previousCommand });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
