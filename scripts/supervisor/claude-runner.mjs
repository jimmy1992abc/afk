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

// Node refuses to spawn a .cmd or .bat without a shell (EINVAL since Node 20), and
// npm installs Claude Code on Windows as exactly that. Running it through
// `cmd.exe /c` with an argument array keeps the arguments out of any shell's
// hands — a `shell: true` string would put a prompt and a path there.
// `detached` exists for one reason: POSIX needs a process group so killTree can
// signal the whole tree with process.kill(-pid). Windows kills by pid with
// taskkill /t and needs no group — and worse, a detached child on Windows gets a
// new console and its stdout never reaches our pipe at all. The runner would then
// read zero frames from `--output-format stream-json`: it could not see a success,
// could not see a quota rejection, and recorded every recovery as a failure while
// Claude was in fact doing the work.
export const DETACHED = process.platform !== 'win32';

// Every place that runs the Claude executable goes through here — the runner and
// setup's preflight probe both do. Knowing this rule in only one of them is what
// left preflight calling the shim directly: it threw, setup caught the throw, and
// told the user their login was missing.
export function claudeInvocation(executable, args) {
  return /\.(cmd|bat)$/i.test(executable)
    ? { file: process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', executable, ...args] }
    : { file: executable, args };
}

export function spawnClaude(executable, args, options = {}) {
  const { spawn: launch = spawn, ...rest } = options;
  const invocation = claudeInvocation(executable, args);
  return launch(invocation.file, invocation.args, { ...rest, detached: DETACHED });
}

export function startClaudeProcess(attempt, options = {}) {
  validateRecoveryRun(attempt.run);
  const executable = options.executable ?? process.env.AFK_CLAUDE_PATH ?? 'claude';
  const child = spawnClaude(executable, buildResumeArgs(attempt.run), {
    cwd: attempt.run.cwd,
    shell: false,
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
  const child = spawnClaude(executable, buildActivationArgs(), {
    cwd: options.cwd, shell: false, windowsHide: true,
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
