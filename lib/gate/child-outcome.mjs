const ERROR_CODES = new Set([
  'E2BIG', 'EACCES', 'EAGAIN', 'EINVAL', 'EMFILE', 'ENFILE', 'ENOENT',
  'ENOEXEC', 'ENOMEM', 'ENOTDIR', 'EPERM', 'ETIMEDOUT',
]);
const SIGNALS = new Set([
  'SIGABRT', 'SIGALRM', 'SIGBREAK', 'SIGHUP', 'SIGINT', 'SIGKILL', 'SIGPIPE',
  'SIGQUIT', 'SIGSEGV', 'SIGTERM', 'SIGUSR1', 'SIGUSR2',
]);

const safeCode = (code) => ERROR_CODES.has(code) ? code : 'UNKNOWN';
const safeSignal = (signal) => SIGNALS.has(signal) ? signal : 'UNKNOWN';

export function classifyChildOutcome(result) {
  if (result?.error) {
    return { kind: 'launch_error', code: safeCode(result.error.code) };
  }
  if (result?.signal) {
    return { kind: 'signal', signal: safeSignal(result.signal) };
  }
  if (!Number.isInteger(result?.status)) return { kind: 'status_unavailable' };
  if (result.status !== 0) return { kind: 'nonzero', status: result.status };
  return null;
}

export function describeChildOutcome(subject, outcome) {
  if (outcome.kind === 'launch_error') {
    return `${subject} failed to start (${outcome.code})`;
  }
  if (outcome.kind === 'signal') {
    return `${subject} was terminated by ${outcome.signal}`;
  }
  if (outcome.kind === 'status_unavailable') {
    return `${subject} ended without an exit status`;
  }
  return `${subject} exited ${outcome.status}`;
}
