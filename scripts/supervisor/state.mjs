import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Three files, each with exactly one writer, so there is nothing to lock:
//   latest-observation.json — the status-line wrapper
//   latest-stopfailure.json — the StopFailure hook
//   state.json              — the supervisor pass
// The worst concurrent-write outcome anywhere in this design is one duplicate
// minimal request; a lock would defend against less than it costs.
export function paths(root) {
  return {
    state: join(root, 'state.json'),
    observation: join(root, 'latest-observation.json'),
    stopFailure: join(root, 'latest-stopfailure.json'),
  };
}

export function defaultState() {
  return {
    schemaVersion: 1,
    // The newest reset that has been dealt with — activated, or written off as
    // stale. Everything at or before it is settled.
    handledResetAt: null,
    // When the last successful activation's request STARTED. The five-hour
    // window opens at the first request, so this is what tightens a later
    // StopFailure-only estimate.
    windowAnchorAt: null,
    // [{ at, resetAt, result }] — pruned to the most recent few.
    attempts: [],
    nextAttemptAt: null,
    lastResult: null,
    // The reset an attempts-exhausted notification was sent for, so the
    // operator hears about each dead reset once, not once per minute.
    notifiedResetAt: null,
  };
}

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    // A corrupt file must not take the pass down for ever; it is one
    // observation or one state snapshot, and the next write replaces it.
    if (error instanceof SyntaxError) return fallback;
    throw error;
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomUUID()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

export async function readState(root) {
  const value = await readJson(paths(root).state, null);
  return { ...defaultState(), ...(value && typeof value === 'object' ? value : {}) };
}

export async function writeState(root, state) {
  await writeJson(paths(root).state, state);
  return state;
}
