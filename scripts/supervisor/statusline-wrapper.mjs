#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { WINDOW_SECONDS } from './constants.mjs';
import { paths, readJson, writeJson } from './state.mjs';

export async function readStdin(stream = process.stdin) {
  let raw = '';
  for await (const chunk of stream) raw += chunk;
  return raw;
}

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

// `resets_at` is epoch seconds and can never be more than one window ahead of
// the observation — anything else is garbage or a broken clock, and recording
// it would park the activator on a reset that never comes.
function saneResetAt(value, observedAt, grace) {
  return Number.isFinite(value)
    && value >= observedAt - WINDOW_SECONDS
    && value <= observedAt + WINDOW_SECONDS + grace
    ? value : null;
}

export function parseObservation(input, observedAt) {
  const five = input?.rate_limits?.five_hour;
  const resetAt = saneResetAt(five?.resets_at, observedAt, 300);
  const used = Number.isFinite(five?.used_percentage)
    && five.used_percentage >= 0 && five.used_percentage <= 100
    ? five.used_percentage : null;
  if (resetAt === null) return null;
  return { fiveHourResetAt: resetAt, fiveHourUsedPercentage: used, observedAt };
}

export async function runWrapper({ root, raw, previous = runPrevious, now = () => Math.floor(Date.now() / 1000) }) {
  // The user's status line renders first and owns stdout and the exit code.
  // Observation is best effort and may never take it down or delay it.
  const chain = await readJson(join(root, 'statusline-chain.json'), null);
  const code = await previous(chain?.previousCommand, raw);
  try {
    const input = JSON.parse(raw);
    const observation = parseObservation(input, now());
    // Absent rate-limit fields observe nothing (API-key sessions, the first
    // moments of a session) and never erase a previous valid observation.
    if (observation) await writeJson(paths(root).observation, observation);
  } catch {
    // Malformed input is not this wrapper's problem to report.
  }
  return code;
}

async function main() {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : null;
  const raw = await readStdin();
  process.exitCode = root ? await runWrapper({ root, raw }) : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
