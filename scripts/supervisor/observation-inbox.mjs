import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validObservation(value) {
  return value && SESSION_ID.test(value.sessionId)
    && Number.isFinite(value.observedAt)
    && value.source === 'statusline'
    && value.confidence === 'exact';
}

const CONTENDED = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function atomicJson(path, value) {
  const temp = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Windows refuses to replace a file another writer still has open. This runs
  // inside the status-line hook, where an unhandled rejection is visible to the
  // user, so a transient sharing conflict is waited out rather than raised.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, path);
      return;
    } catch (error) {
      if (!CONTENDED.has(error.code) || attempt >= 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 + attempt * 5));
    }
  }
}

function markerValue(observation, writtenAt) {
  return {
    resetAt: observation.fiveHourResetAt,
    bucket: Number.isFinite(observation.fiveHourUsedPercentage)
      ? Math.floor(observation.fiveHourUsedPercentage) : null,
    writtenAt,
  };
}

export async function publishObservation(root, observation, options = {}) {
  if (!validObservation(observation)) return { code: 'skip:observation-invalid' };
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const inbox = join(root, 'observations');
  const markers = join(root, 'observation-markers');
  await Promise.all([mkdir(inbox, { recursive: true }), mkdir(markers, { recursive: true })]);
  const markerPath = join(markers, `${observation.sessionId}.json`);
  let marker = null;
  try { marker = JSON.parse(await readFile(markerPath, 'utf8')); } catch {}
  const current = markerValue(observation, now());
  if (marker && marker.resetAt === current.resetAt && marker.bucket === current.bucket
      && current.writtenAt - marker.writtenAt < 60) return { code: 'throttled' };

  const name = `${String(observation.observedAt).padStart(16, '0')}-${randomUUID()}.json`;
  const eventPath = join(inbox, name);
  await atomicJson(eventPath, observation);
  await atomicJson(markerPath, current);
  return { code: 'published', path: eventPath };
}

export const OBSERVATION_RETENTION_SECONDS = 3_600;

// Everything the supervisor leaves lying around and never looks at again: inbox
// files that fail validation and so are never committed, the per-session markers,
// the temp files an interrupted atomic write orphans, the corrupt-state
// quarantines, and the lock tombstones. None of these were bounded.
export async function sweepObservations(root, options = {}) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const retention = options.retentionSeconds ?? OBSERVATION_RETENTION_SECONDS;
  // A quarantine is the only surviving copy of a state file the supervisor just
  // blanked to defaults. Sweeping it on the inbox's one-hour clock would destroy
  // the evidence of a corruption nobody has looked at yet.
  const quarantineRetention = options.quarantineRetentionSeconds ?? 604_800;
  let removed = 0;
  for (const [dir, match, keepFor] of [
    [join(root, 'observations'), () => true, retention],
    [join(root, 'observation-markers'), () => true, retention],
    [root, (name) => name.includes('.tmp-') || name.includes('.stale-'), retention],
    [root, (name) => name.startsWith('state.corrupt-'), quarantineRetention],
  ]) {
    let names;
    try { names = await readdir(dir); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names.filter(match)) {
      const path = join(dir, name);
      try {
        const info = await stat(path);
        if (now() - Math.floor(info.mtimeMs / 1000) <= keepFor) continue;
        await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
        removed += 1;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return removed;
}

export async function readObservationBatch(root, options = {}) {
  const inbox = join(root, 'observations');
  let names;
  try { names = await readdir(inbox); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const limit = options.maxFiles ?? 512;
  const batch = [];
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    if (batch.length >= limit) break;
    const path = join(inbox, name);
    try {
      const observation = JSON.parse(await readFile(path, 'utf8'));
      if (validObservation(observation)) batch.push({ path, observation });
    } catch {}
  }
  return batch.sort((a, b) => a.observation.observedAt - b.observation.observedAt
    || a.path.localeCompare(b.path));
}

export async function commitObservationBatch(batch) {
  for (const item of batch) {
    try { await unlink(item.path); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
