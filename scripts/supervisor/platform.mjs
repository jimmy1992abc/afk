import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { createMacAdapter } from './platform-macos.mjs';
import { createWindowsAdapter } from './platform-windows.mjs';

const execFileAsync = promisify(execFile);

// Notifications are fired and forgotten: a supervisor pass must never wait on a
// window that only a present human could dismiss.
export function defaultSpawnDetached(file, args) {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { pid: child.pid };
}

export function platformAdapter(platform, deps) {
  if (platform === 'darwin') return createMacAdapter(deps);
  if (platform === 'win32') return createWindowsAdapter(deps);
  throw new Error(`unsupported platform: ${platform}`);
}

// A pid is not an identity: the operating system reuses it, aggressively on
// Windows. The process start time is what distinguishes "our runner" from "some
// stranger who inherited its number", and it is the only thing that lets a live
// pid be trusted with no time bound — which suspend requires, because suspend
// stops the timers that any time bound would have relied on.
//
// Returns the OS-reported start time in epoch milliseconds, or null when it
// cannot be determined. Null is never treated as proof of anything.
// Three answers, not two:
//   a number  — the process started then.
//   null      — we asked, and it is not running.
//   undefined — we could not ask. Says nothing about the process.
//
// Collapsing the last two is how "the probe failed" came to mean "the runner is
// dead": on a host where PowerShell or ps cannot be executed, every live runner
// read as dead and the supervisor started a second Claude on top of each one.
//
// The probe is bounded: launchd has no ExecutionTimeLimit, so a hung ps would
// stall the whole supervisor under its single-job semantics.
const PROBE_TIMEOUT_MS = 10_000;

// A non-zero exit is the tool answering "no such process". A spawn failure, or a
// probe we killed for hanging, is the tool failing to answer at all.
function probeAnswered(error) {
  return Number.isInteger(error?.code) && !error?.killed;
}

export async function processStartedAt(pid, deps = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const run = deps.execFile ?? execFileAsync;
  const platform = deps.platform ?? process.platform;
  const options = { windowsHide: true, timeout: PROBE_TIMEOUT_MS };
  try {
    if (platform === 'win32') {
      // -ErrorAction SilentlyContinue: an absent process is empty stdout and exit 0,
      // so a throw here is always a failure to ask.
      const { stdout } = await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().Ticks }`,
      ], options);
      // An absent process is empty stdout and exit 0. Anything else that will not
      // parse is a probe answering incoherently, which is not an answer at all —
      // reading it as "gone" would fail open and put a second Claude on a live run.
      const text = stdout.trim();
      if (text.length === 0) return null;
      const ticks = Number(text);
      // .NET ticks are 100ns since year 1; convert to epoch milliseconds.
      return Number.isFinite(ticks) && ticks > 0 ? Math.round(ticks / 10_000 - 62_135_596_800_000) : undefined;
    }
    if (platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      // Field 22 is starttime in clock ticks since boot. The comm field may contain
      // spaces and parentheses, so parse from the last ')'.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(fields[19]);
      if (!Number.isFinite(ticks)) return undefined;
      const uptime = Number((await readFile('/proc/uptime', 'utf8')).split(' ')[0]);
      if (!Number.isFinite(uptime)) return undefined;
      const bootMs = Date.now() - uptime * 1000;
      return Math.round(bootMs + (ticks / 100) * 1000);
    }
    const { stdout } = await run('ps', ['-p', String(pid), '-o', 'lstart='], options);
    const parsed = Date.parse(stdout.trim());
    // ps can exit 0 with no rows; an unparseable row is not an answer either.
    return stdout.trim().length === 0 ? null : (Number.isFinite(parsed) ? parsed : undefined);
  } catch (error) {
    // /proc/<pid> is gone: that IS the answer, and it means dead.
    if (platform === 'linux') return error?.code === 'ENOENT' ? null : undefined;
    if (platform === 'win32') return undefined;
    return probeAnswered(error) ? null : undefined;
  }
}

// 'alive' — the pid exists and the process is the one we started.
// 'dead'  — the pid is gone, or it is a different process wearing its number.
// 'unknown' — we could not tell. Never treated as either.
async function pidLiveness(pid, expectedStartedAt, deps) {
  if (!Number.isInteger(pid)) return 'dead';
  const startedAt = await processStartedAt(pid, deps);
  if (startedAt === undefined) return 'unknown';
  if (startedAt === null) return 'dead';
  if (!Number.isFinite(expectedStartedAt)) return 'unknown';
  // Clocks and rounding differ between the two readings; a second of slack is
  // far tighter than any plausible pid-reuse interval.
  return Math.abs(startedAt - expectedStartedAt) <= 1_000 ? 'alive' : 'dead';
}

// Two processes can be driving this run: the runner, and the `claude --resume` child
// it spawned. The child OUTLIVES its runner — Windows does not kill a child when its
// parent dies, and on POSIX the child has its own process group — so a runner killed
// outright leaves a live Claude still writing to the session. Tracking only the
// runner read that as `dead` and put a second Claude on top of it. The run is
// occupied while EITHER is alive.
export async function runnerLiveness(lease, deps = {}) {
  const runner = await pidLiveness(lease?.pid, lease?.startedAt, deps);
  if (runner === 'alive') return 'alive';
  const child = await pidLiveness(lease?.childPid, lease?.childStartedAt, deps);
  if (child === 'alive') return 'alive';
  return runner === 'unknown' || child === 'unknown' ? 'unknown' : 'dead';
}

export function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
