import { copyFile, mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { SCHEMA_VERSION, STATE_FILE } from './constants.mjs';
import { CONTENDED, LockHeldError, holdsLock, withFileLock } from './lock.mjs';

export class StateConflictError extends Error {
  constructor(message = 'state revision changed') {
    super(message);
    this.name = 'StateConflictError';
  }
}

export function defaultUsage() {
  return {
    fiveHourResetAt: null,
    fiveHourUsedPercentage: null,
    sevenDayResetAt: null,
    sevenDayUsedPercentage: null,
    observedAt: null,
    source: 'unknown',
    confidence: 'unknown',
    windowAnchorAt: null,
    thresholdResetAt: null,
    lastImportedObservationAt: null,
    sevenDaySuppressedUntil: null,
  };
}

export function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    usage: defaultUsage(),
    sessions: {},
    runs: {},
    activation: {
      handledResetAt: null,
      inProgress: false,
      attemptId: null,
      token: null,
      lastRenewedAt: null,
      expiresAt: null,
      // A pid is not an identity; the pair is. The activation runner is verified the
      // same way a recovery runner is, so an expiry alone can never reclaim it.
      pid: null,
      startedAt: null,
      lastAttemptAt: null,
      lastResult: null,
      activationAttempts: [],
    },
  };
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function emptyRecoveryLease() {
  // Two processes can be driving a run: the runner, and the `claude --resume` child
  // it spawned. The child outlives its runner, so the claim tracks both.
  return {
    attemptId: null, token: null, lastRenewedAt: null, expiresAt: null,
    pid: null, startedAt: null, childPid: null, childStartedAt: null, stuckNotifiedAt: null,
  };
}

// The old shape had one `lease` field carrying two different claims. Which one it
// held was encoded in a string prefix on the attempt id — that overload is the
// bug this schema exists to remove, so the migration decodes it once and for all.
function migrateRun(run) {
  if (!plainObject(run)) return run;
  const { lease, ...rest } = run;
  if (!plainObject(lease)) {
    return { recoveryLease: emptyRecoveryLease(), tickGuard: null, ...rest };
  }
  const owner = String(lease.attemptId ?? '');
  if (owner.startsWith('in-session-')) {
    return {
      ...rest,
      recoveryLease: emptyRecoveryLease(),
      tickGuard: { sessionId: owner.slice('in-session-'.length), expiresAt: lease.expiresAt ?? null },
    };
  }
  return {
    ...rest,
    recoveryLease: { ...emptyRecoveryLease(), ...lease },
    tickGuard: null,
  };
}

export function migrateState(value) {
  if (!plainObject(value)) throw new TypeError('state must be an object');
  const base = defaultState();
  const runs = plainObject(value.runs) ? value.runs : {};
  const migrated = {
    ...base,
    ...value,
    schemaVersion: SCHEMA_VERSION,
    revision: Number.isInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    usage: { ...base.usage, ...(plainObject(value.usage) ? value.usage : {}) },
    sessions: plainObject(value.sessions) ? value.sessions : {},
    runs: Object.fromEntries(Object.entries(runs).map(([id, run]) => [id, migrateRun(run)])),
    activation: {
      ...base.activation,
      ...(plainObject(value.activation) ? value.activation : {}),
      activationAttempts: Array.isArray(value.activation?.activationAttempts)
        ? value.activation.activationAttempts : [],
    },
  };
  return validateState(migrated);
}

export function validateState(value) {
  if (!plainObject(value)) throw new TypeError('state must be an object');
  if (value.schemaVersion !== SCHEMA_VERSION) throw new TypeError('unsupported state schema');
  if (!Number.isInteger(value.revision) || value.revision < 0) throw new TypeError('invalid state revision');
  if (!plainObject(value.usage) || !plainObject(value.sessions) || !plainObject(value.runs) || !plainObject(value.activation)) {
    throw new TypeError('invalid state sections');
  }
  return value;
}

// Windows refuses to replace a file that another reader still has open, and
// reports it as EPERM. Readers here are short, so a bounded retry turns a
// transient sharing conflict into a completed write instead of a failed
// transaction.
async function replace(temp, path) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, path);
      return;
    } catch (error) {
      if (!CONTENDED.has(error.code) || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 + attempt * 5));
    }
  }
}

async function atomicWriteJson(path, value) {
  const temp = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await replace(temp, path);
}

const LOCK_WAIT_MS = 5_000;

// Every state transaction fsyncs, so a fixed short retry budget starves a writer
// whenever several passes, lease renewals, or ticks contend at once. A starved
// lease renewal is swallowed by its caller, and three missed renewals expire the
// lease, so waiting is bounded by a deadline with backoff rather than by a
// fixed number of quick attempts.
async function withStateLock(root, callback) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let delay = 5;
  for (;;) {
    try {
      return await withFileLock({ root }, callback);
    } catch (error) {
      if (!(error instanceof LockHeldError) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay + Math.floor(Math.random() * delay)));
      delay = Math.min(delay * 2, 50);
    }
  }
}

export class StateStore {
  constructor(root, options = {}) {
    this.root = root;
    this.path = join(root, STATE_FILE);
    this.now = options.now ?? Date.now;
  }

  // `repair` is only ever true under the global lock. A plain read is public and
  // unlocked, so repairing there would let a reader rewrite state.json while a
  // lock-holding writer is mid-transaction — and both would end up writing a
  // default state over every registered run.
  async read({ repair = false } = {}) {
    await mkdir(this.root, { recursive: true });
    let raw;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return defaultState();
      throw error;
    }
    try {
      return migrateState(JSON.parse(raw));
    } catch {
      if (!repair) return defaultState();
      // Copy the corrupt file aside and only then replace it. Renaming it away
      // first leaves no state.json at all if the process dies before the
      // replacement lands, and the next read would silently start from scratch.
      const quarantine = join(this.root, `state.corrupt-${Math.floor(this.now() / 1000)}.json`);
      await copyFile(this.path, quarantine);
      await atomicWriteJson(this.path, defaultState());
      return defaultState();
    }
  }

  async write(next, expectedRevision) {
    return withStateLock(this.root, async ({ token }) => {
      if (!await holdsLock(this.root, token)) throw new LockHeldError();
      return this.writeUnlocked(next, expectedRevision);
    });
  }

  async writeUnlocked(next, expectedRevision) {
    const current = await this.read({ repair: true });
    if (current.revision !== expectedRevision) throw new StateConflictError();
    const saved = validateState(migrateState({ ...next, revision: expectedRevision + 1 }));
    await atomicWriteJson(this.path, saved);
    return saved;
  }

  async update(mutator) {
    return withStateLock(this.root, async ({ token }) => {
      const current = await this.read({ repair: true });
      const next = await mutator(structuredClone(current));
      // Two holders would both read this revision and both pass the compare, and
      // the loser's write would vanish with no error at all. Confirming the lock
      // still names us turns that silent loss into a retry.
      if (!await holdsLock(this.root, token)) throw new LockHeldError();
      return this.writeUnlocked(next, current.revision);
    });
  }
}
