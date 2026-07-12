import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const WINDOW_MODES = new Set(['off', 'notify', 'auto']);
const CATCH_UP_MODES = new Set(['activate', 'notify', 'skip']);
const RECOVERY_MODES = new Set(['auto', 'off']);

export function defaultConfig() {
  return {
    enabled: true,
    claudePath: null,
    thresholdPercentage: 90,
    thresholdJitterMinSeconds: 60,
    thresholdJitterMaxSeconds: 180,
    windowMode: 'notify',
    activeRunRecovery: 'auto',
    catchUpMode: 'notify',
    graceSeconds: 90,
    heartbeatStaleSeconds: 1500,
    overdueAutoActivationSeconds: 7200,
    maxWindowActivationsPer24Hours: 4,
    sevenDaySuppressionPercentage: 99,
    maxRecoveryAttempts: 3,
    maxConsecutiveQuotaRejections: 3,
    quotaEscalationBaseSeconds: 86400,
    quotaEscalationMaxSeconds: 604800,
    recoveryAttemptTimeoutSeconds: 14400,
    leaseRenewalSeconds: 60,
    leaseMissedRenewals: 3,
    maxConcurrentInvocations: 1,
    pollIntervalSeconds: 60,
    // Must exceed the longest legitimate hold. It used to equal
    // quotaEscalationMaxSeconds, so a run parked on the maximum quota probe was
    // deleted the moment that probe became due.
    terminalRunRetentionSeconds: 1209600,
    registrationRecoveryMaxAgeSeconds: 86400,
  };
}

function positiveInteger(value, key, { allowZero = false } = {}) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${key} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
}

export function validateConfig(value) {
  const config = { ...defaultConfig(), ...value };
  if (typeof config.enabled !== 'boolean') throw new TypeError('enabled must be boolean');
  if (config.claudePath !== null && typeof config.claudePath !== 'string') throw new TypeError('claudePath must be a string or null');
  if (!WINDOW_MODES.has(config.windowMode)) throw new TypeError('windowMode is invalid');
  if (!CATCH_UP_MODES.has(config.catchUpMode)) throw new TypeError('catchUpMode is invalid');
  if (!RECOVERY_MODES.has(config.activeRunRecovery)) throw new TypeError('activeRunRecovery is invalid');
  for (const key of [
    'thresholdPercentage', 'thresholdJitterMinSeconds', 'thresholdJitterMaxSeconds',
    'graceSeconds', 'heartbeatStaleSeconds', 'overdueAutoActivationSeconds',
    'maxWindowActivationsPer24Hours', 'sevenDaySuppressionPercentage', 'maxRecoveryAttempts',
    'maxConsecutiveQuotaRejections', 'quotaEscalationBaseSeconds',
    'quotaEscalationMaxSeconds', 'recoveryAttemptTimeoutSeconds',
    'leaseRenewalSeconds', 'leaseMissedRenewals', 'maxConcurrentInvocations',
    'pollIntervalSeconds', 'terminalRunRetentionSeconds',
    'registrationRecoveryMaxAgeSeconds',
  ]) positiveInteger(config[key], key);
  if (config.thresholdPercentage > 100) throw new TypeError('thresholdPercentage must be at most 100');
  if (config.sevenDaySuppressionPercentage > 100) throw new TypeError('sevenDaySuppressionPercentage must be at most 100');
  if (config.thresholdJitterMaxSeconds < config.thresholdJitterMinSeconds) {
    throw new TypeError('threshold jitter range is invalid');
  }
  if (config.quotaEscalationMaxSeconds < config.quotaEscalationBaseSeconds) {
    throw new TypeError('quota escalation range is invalid');
  }
  // Retention is "how long a dead run is kept". It was also being used, by
  // accident, as "the longest a live run may legitimately wait" — and the two
  // constants were equal, so a run parked on the maximum quota probe was deleted
  // at the exact moment it became due. Make that arithmetically impossible.
  const longestHold = Math.max(
    config.quotaEscalationMaxSeconds,
    config.recoveryAttemptTimeoutSeconds,
    config.heartbeatStaleSeconds,
    config.overdueAutoActivationSeconds,
  );
  if (config.terminalRunRetentionSeconds <= longestHold) {
    throw new TypeError('terminalRunRetentionSeconds must exceed the longest hold a run can legitimately wait out');
  }
  return config;
}

export class ConfigStore {
  constructor(root) {
    this.root = root;
    this.path = join(root, 'config.json');
  }

  async read() {
    try { return validateConfig(JSON.parse(await readFile(this.path, 'utf8'))); } catch (error) {
      if (error.code === 'ENOENT') return defaultConfig();
      throw error;
    }
  }

  async write(value) {
    const config = validateConfig(value);
    await mkdir(this.root, { recursive: true });
    const temp = `${this.path}.tmp-${randomUUID()}`;
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.path);
    return config;
  }
}
