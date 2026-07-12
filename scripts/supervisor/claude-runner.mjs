import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAbsolute, relative } from 'node:path';

export const RESUME_PROMPT = 'Resume the active AFK run from .afk/afk-ledger.md. Continue from the first unfinished step. Preserve the existing scope, constraints, merge policy, and overlap guard.';
export const ACTIVATION_PROMPT = 'Reply exactly: ok';

// The same shape the state store and the observation inbox accept. A looser rule
// here would let a session ID through that no other layer would ever have stored.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateRecoveryRun(run) {
  if (!SESSION_ID.test(run?.sessionId ?? '')) throw new Error('invalid session ID');
  if (!isAbsolute(run?.cwd ?? '')) throw new Error('invalid working directory');
  const ledgerRelative = relative(run.cwd, run?.ledgerPath ?? '');
  if (!isAbsolute(run?.ledgerPath ?? '') || ledgerRelative.startsWith('..') || isAbsolute(ledgerRelative)) {
    throw new Error('ledger path must stay inside working directory');
  }
  return run;
}

export function buildResumeArgs(run) {
  return ['--resume', run.sessionId, '--print', '--verbose', '--output-format', 'stream-json', RESUME_PROMPT];
}

export function buildActivationArgs() {
  return ['--print', '--verbose', '--output-format', 'stream-json', '--no-session-persistence',
    '--max-turns', '1', '--tools', '', ACTIVATION_PROMPT];
}

export function classifyStreamFrame(frame) {
  return frame?.type === 'system'
    && frame?.subtype === 'api_retry'
    && frame?.error === 'rate_limit'
    && Number.isInteger(frame?.error_status)
    && Number.isInteger(frame?.attempt)
    && Number.isInteger(frame?.max_retries)
    ? { kind: 'quota', status: frame.error_status }
    : null;
}

async function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      killer.once('close', resolve);
      killer.once('error', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  }
}

export function startClaudeProcess(attempt, options = {}) {
  validateRecoveryRun(attempt.run);
  const executable = options.executable ?? process.env.AFK_CLAUDE_PATH ?? 'claude';
  const child = spawn(executable, buildResumeArgs(attempt.run), {
    cwd: attempt.run.cwd,
    shell: false,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const completion = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { lines, completion, kill: () => killTree(child) };
}

export function startActivationProcess(attempt, options = {}) {
  const executable = options.executable ?? process.env.AFK_CLAUDE_PATH ?? 'claude';
  const child = spawn(executable, buildActivationArgs(), {
    cwd: options.cwd, shell: false, detached: true, windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const completion = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { lines, completion, kill: () => killTree(child) };
}

export async function runClaude(attempt, deps = {}) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const startedAt = now();
  const processHandle = (deps.startClaude ?? startClaudeProcess)(attempt);
  const consume = async () => {
    let sawSuccess = false;
    for await (const line of processHandle.lines) {
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      const classified = classifyStreamFrame(frame);
      if (classified) return classified;
      if (frame?.type === 'result' && (frame.subtype === 'success' || frame.is_error === false)) {
        sawSuccess = true;
      }
    }
    return { kind: 'stream-ended', sawSuccess };
  };
  let timeoutId;
  const timeout = deps.timeout
    ? deps.timeout()
    : new Promise((resolve) => {
      timeoutId = setTimeout(resolve, (attempt.timeoutSeconds ?? 14_400) * 1000, 'timeout');
    });
  const streamed = await Promise.race([consume(), timeout.then(() => ({ kind: 'timeout' }))]);
  if (timeoutId) clearTimeout(timeoutId);
  if (streamed.kind === 'quota') {
    await processHandle.kill();
    return { ...streamed, startedAt };
  }
  if (streamed.kind === 'timeout') {
    await processHandle.kill();
    return { kind: 'failure', reason: 'action-timeout', startedAt };
  }
  const completed = await processHandle.completion;
  return streamed.sawSuccess && completed.code === 0
    ? { kind: 'success', startedAt }
    : { kind: 'failure', code: completed.code, reason: completed.error?.code ?? completed.signal ?? 'process-exit', startedAt };
}

export async function runActivation(attempt, deps = {}) {
  return runClaude(attempt, {
    ...deps,
    startClaude: deps.startActivation ?? ((value) => startActivationProcess(value, deps)),
  });
}
