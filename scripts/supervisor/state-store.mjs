import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { SCHEMA_VERSION, STATE_FILE } from './constants.mjs';
import { LockHeldError, withFileLock } from './lock.mjs';

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
      lastAttemptAt: null,
      lastResult: null,
      activationAttempts: [],
    },
  };
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function migrateState(value) {
  if (!plainObject(value)) throw new TypeError('state must be an object');
  const base = defaultState();
  const migrated = {
    ...base,
    ...value,
    schemaVersion: SCHEMA_VERSION,
    revision: Number.isInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    usage: { ...base.usage, ...(plainObject(value.usage) ? value.usage : {}) },
    sessions: plainObject(value.sessions) ? value.sessions : {},
    runs: plainObject(value.runs) ? value.runs : {},
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

async function atomicWriteJson(path, value) {
  const temp = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}

async function withStateLock(root, callback) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await withFileLock({ root }, callback);
    } catch (error) {
      if (!(error instanceof LockHeldError) || attempt === 49) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new LockHeldError();
}

export class StateStore {
  constructor(root, options = {}) {
    this.root = root;
    this.path = join(root, STATE_FILE);
    this.now = options.now ?? Date.now;
  }

  async read() {
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
      const quarantine = join(this.root, `state.corrupt-${this.now()}.json`);
      await rename(this.path, quarantine);
      await atomicWriteJson(this.path, defaultState());
      return defaultState();
    }
  }

  async write(next, expectedRevision) {
    return withStateLock(this.root, () => this.writeUnlocked(next, expectedRevision));
  }

  async writeUnlocked(next, expectedRevision) {
    const current = await this.read();
    if (current.revision !== expectedRevision) throw new StateConflictError();
    const saved = validateState(migrateState({ ...next, revision: expectedRevision + 1 }));
    await atomicWriteJson(this.path, saved);
    return saved;
  }

  async update(mutator) {
    return withStateLock(this.root, async () => {
      const current = await this.read();
      const next = await mutator(structuredClone(current));
      return this.writeUnlocked(next, current.revision);
    });
  }
}
