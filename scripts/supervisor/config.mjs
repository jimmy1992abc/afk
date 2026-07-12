const WINDOW_MODES = new Set(['off', 'notify', 'auto']);
const CATCH_UP_MODES = new Set(['activate', 'notify', 'skip']);
const RECOVERY_MODES = new Set(['auto', 'off']);

export function defaultConfig() {
  return {
    enabled: true,
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
    maxRecoveryAttempts: 3,
    maxConsecutiveQuotaRejections: 3,
    quotaEscalationBaseSeconds: 86400,
    quotaEscalationMaxSeconds: 604800,
    recoveryAttemptTimeoutSeconds: 14400,
    leaseRenewalSeconds: 60,
    leaseMissedRenewals: 3,
    maxConcurrentInvocations: 1,
    pollIntervalSeconds: 60,
    terminalRunRetentionSeconds: 604800,
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
  if (!WINDOW_MODES.has(config.windowMode)) throw new TypeError('windowMode is invalid');
  if (!CATCH_UP_MODES.has(config.catchUpMode)) throw new TypeError('catchUpMode is invalid');
  if (!RECOVERY_MODES.has(config.activeRunRecovery)) throw new TypeError('activeRunRecovery is invalid');
  for (const key of [
    'thresholdPercentage', 'thresholdJitterMinSeconds', 'thresholdJitterMaxSeconds',
    'graceSeconds', 'heartbeatStaleSeconds', 'overdueAutoActivationSeconds',
    'maxWindowActivationsPer24Hours', 'maxRecoveryAttempts',
    'maxConsecutiveQuotaRejections', 'quotaEscalationBaseSeconds',
    'quotaEscalationMaxSeconds', 'recoveryAttemptTimeoutSeconds',
    'leaseRenewalSeconds', 'leaseMissedRenewals', 'maxConcurrentInvocations',
    'pollIntervalSeconds', 'terminalRunRetentionSeconds',
    'registrationRecoveryMaxAgeSeconds',
  ]) positiveInteger(config[key], key);
  if (config.thresholdPercentage > 100) throw new TypeError('thresholdPercentage must be at most 100');
  if (config.thresholdJitterMaxSeconds < config.thresholdJitterMinSeconds) {
    throw new TypeError('threshold jitter range is invalid');
  }
  if (config.quotaEscalationMaxSeconds < config.quotaEscalationBaseSeconds) {
    throw new TypeError('quota escalation range is invalid');
  }
  return config;
}
