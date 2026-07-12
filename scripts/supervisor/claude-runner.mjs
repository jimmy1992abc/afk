import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const RESUME_PROMPT = 'Resume the active AFK run from .afk/afk-ledger.md. Continue from the first unfinished step. Preserve the existing scope, constraints, merge policy, and overlap guard.';

export function buildResumeArgs(run) {
  return ['--resume', run.sessionId, '--print', '--verbose', '--output-format', 'stream-json', RESUME_PROMPT];
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

export async function runClaude(attempt, deps = {}) {
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
    return streamed;
  }
  if (streamed.kind === 'timeout') {
    await processHandle.kill();
    return { kind: 'failure', reason: 'action-timeout' };
  }
  const completed = await processHandle.completion;
  return streamed.sawSuccess && completed.code === 0
    ? { kind: 'success' }
    : { kind: 'failure', code: completed.code, reason: completed.error?.code ?? completed.signal ?? 'process-exit' };
}
