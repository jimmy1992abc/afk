import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const ACTIVATION_PROMPT = 'Reply exactly: ok';

// Node refuses to spawn a .cmd or .bat without a shell (EINVAL since Node 20),
// and npm installs Claude Code on Windows as exactly that — there is no
// claude.exe. Shims run through cmd.exe with the arguments still an ARRAY: a
// shell string would put a prompt and a path in a shell's hands. Every place
// that runs the Claude executable goes through here; knowing this rule in only
// one caller is how setup once reported a logged-in CLI as missing.
export function claudeInvocation(executable, args) {
  return /\.(cmd|bat)$/i.test(executable)
    ? { file: process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', executable, ...args] }
    : { file: executable, args };
}

// `detached` exists so POSIX can signal a process group. Windows kills by pid
// with taskkill /t — and a detached child there gets its own console, so its
// stdout never reaches our pipe and the stream below reads zero frames.
export const DETACHED = process.platform !== 'win32';

export function spawnClaude(executable, args, options = {}) {
  const { spawn: launch = spawn, ...rest } = options;
  const invocation = claudeInvocation(executable, args);
  return launch(invocation.file, invocation.args, { ...rest, detached: DETACHED });
}

export function buildActivationArgs() {
  // `--tools <tools...>` is variadic: it consumes every argument after it until
  // an end-of-options marker. With the prompt simply placed last, Claude read a
  // tool list of ["", "<the prompt>"] and got no prompt at all — every
  // activation exited 1 with "Input must be provided". Verified against the
  // real CLI: `--` fences the prompt off from it.
  return ['--print', '--verbose', '--output-format', 'stream-json', '--no-session-persistence',
    '--max-turns', '1', '--tools', '', '--', ACTIVATION_PROMPT];
}

// The only wire-visible signal that the account is still rate-limited: the
// internal api_error object with its reset time never reaches the stream.
export function classifyStreamFrame(frame) {
  return frame?.type === 'system'
    && frame?.subtype === 'api_retry'
    && frame?.error === 'rate_limit'
    && Number.isInteger(frame?.error_status)
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

export function startActivationProcess(options = {}) {
  const executable = options.executable ?? process.env.AFK_CLAUDE_PATH ?? 'claude';
  const child = spawnClaude(executable, buildActivationArgs(), {
    cwd: options.cwd,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const completion = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { lines, completion, pid: child.pid, kill: () => killTree(child) };
}

// One minimal request. Success means the new five-hour window is open; a quota
// frame means the account is still limited (the reset estimate was early) and
// the child is killed rather than left to Claude's own multi-minute retry loop.
export async function runActivation(deps = {}) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const startedAt = now();
  const handle = (deps.startActivation ?? startActivationProcess)(deps);
  const consume = async () => {
    let sawSuccess = false;
    for await (const line of handle.lines) {
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
      timeoutId = setTimeout(resolve, (deps.timeoutSeconds ?? 180) * 1000, 'timeout');
    });
  const streamed = await Promise.race([consume(), timeout.then(() => ({ kind: 'timeout' }))]);
  if (timeoutId) clearTimeout(timeoutId);
  if (streamed.kind === 'quota') {
    await handle.kill();
    return { kind: 'quota', status: streamed.status, startedAt };
  }
  if (streamed.kind === 'timeout') {
    await handle.kill();
    return { kind: 'failure', reason: 'activation-timeout', startedAt };
  }
  const completed = await handle.completion;
  return streamed.sawSuccess && completed.code === 0
    ? { kind: 'success', startedAt }
    : { kind: 'failure', reason: completed.error?.code ?? completed.signal ?? 'process-exit', startedAt };
}
