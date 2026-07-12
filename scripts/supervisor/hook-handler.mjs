#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { paths, writeJson } from './state.mjs';
import { readStdin } from './statusline-wrapper.mjs';

export function dataRoot(env = process.env, platform = process.platform) {
  if (env.AFK_SUPERVISOR_DATA_DIR) return env.AFK_SUPERVISOR_DATA_DIR;
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'afk-supervisor');
  if (platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'afk-supervisor');
  return join(homedir(), '.local', 'share', 'afk-supervisor');
}

// The one fact this hook can contribute: a request actually failed on the rate
// limit, at this moment. When it lifts is the status line's job (exact) or the
// pass's estimate. hooks.json already matches `rate_limit`, but the input is
// re-checked — a matcher change must not turn every StopFailure into evidence.
export async function handleHook(event, { root, now = () => Math.floor(Date.now() / 1000) }) {
  if (event?.hook_event_name !== 'StopFailure' || event?.error !== 'rate_limit') {
    return { code: 'skip:not-rate-limit' };
  }
  await writeJson(paths(root).stopFailure, { limitedAt: now(), observedAt: now() });
  return { code: 'action:rate-limit-recorded' };
}

async function main() {
  let event = null;
  try { event = JSON.parse(await readStdin()); } catch { /* malformed input observes nothing */ }
  try {
    await handleHook(event, { root: dataRoot() });
  } catch {
    // A hook must never fail the session's own turn.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
