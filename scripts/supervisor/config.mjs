import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function defaultConfig() {
  return {
    enabled: true,
    // The verified absolute path recorded by setup; null falls back to PATH.
    claudePath: null,
    // A status-line snapshot at or above this usage counts as "the window was
    // exhausted" even when no StopFailure was seen.
    thresholdPercentage: 95,
    // Fire this long after the observed reset, never a minute early.
    graceSeconds: 90,
    // An activation that produces no result frame within this is killed.
    activationTimeoutSeconds: 180,
    // A reset further in the past than this is water under the bridge: the next
    // real session opens its own window, so it is marked handled, not fired.
    staleResetSeconds: 14_400,
    // Backoff between attempts when an activation is quota-rejected (the
    // estimate was early) or fails outright.
    retryBackoffSeconds: [300, 900, 3600],
    maxAttemptsPerReset: 4,
    // Scheduler cadence; informational for status output.
    pollIntervalSeconds: 60,
  };
}

function positiveInteger(value, key) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${key} must be a positive integer`);
}

export function validateConfig(value) {
  const config = { ...defaultConfig(), ...value };
  if (typeof config.enabled !== 'boolean') throw new TypeError('enabled must be boolean');
  if (config.claudePath !== null && typeof config.claudePath !== 'string') throw new TypeError('claudePath must be a string or null');
  if (!Number.isFinite(config.thresholdPercentage) || config.thresholdPercentage < 1 || config.thresholdPercentage > 100) {
    throw new TypeError('thresholdPercentage must be within 1..100');
  }
  for (const key of ['graceSeconds', 'activationTimeoutSeconds', 'staleResetSeconds', 'maxAttemptsPerReset', 'pollIntervalSeconds']) {
    positiveInteger(config[key], key);
  }
  if (!Array.isArray(config.retryBackoffSeconds) || config.retryBackoffSeconds.length === 0
      || config.retryBackoffSeconds.some((v) => !Number.isInteger(v) || v < 1)) {
    throw new TypeError('retryBackoffSeconds must be a non-empty array of positive integers');
  }
  return config;
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomUUID()}`;
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

export class ConfigStore {
  constructor(root) {
    this.path = join(root, 'config.json');
  }

  async read() {
    try {
      return validateConfig(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return defaultConfig();
      throw error;
    }
  }

  async write(config) {
    const validated = validateConfig(config);
    await atomicWrite(this.path, `${JSON.stringify(validated, null, 2)}\n`);
    return validated;
  }
}
