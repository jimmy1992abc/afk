#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { parseStatuslineSnapshot } from './usage-provider.mjs';
import { publishObservation } from './observation-inbox.mjs';

export async function readStdin(stream = process.stdin) {
  let raw = '';
  for await (const chunk of stream) raw += chunk;
  return raw;
}

export async function runBridge({ root, raw, now = () => Math.floor(Date.now() / 1000) }) {
  let input;
  try { input = JSON.parse(raw); } catch { return { code: 'skip:statusline-malformed' }; }
  const observation = {
    ...parseStatuslineSnapshot(input, now()),
    sessionId: input.session_id,
  };
  return publishObservation(root, observation, { now });
}

async function main() {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : null;
  if (!root) process.exitCode = 2;
  else await runBridge({ root, raw: await readStdin() });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
