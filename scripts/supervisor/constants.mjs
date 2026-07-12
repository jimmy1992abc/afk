export const SCHEMA_VERSION = 1;
export const STATE_FILE = 'state.json';
export const LOCK_FILE = 'state.lock';
export const WINDOW_SECONDS = 5 * 60 * 60;
export const DAY_SECONDS = 24 * 60 * 60;

export const RUN_STATES = Object.freeze([
  'RUNNING',
  'RATE_LIMITED',
  'RECOVERY_DUE',
  'RECOVERING',
  'COMPLETED',
  'BLOCKED',
  'AUTO_PAUSED',
  'FAILED',
]);
