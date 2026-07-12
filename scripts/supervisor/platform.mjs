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
export async function processStartedAt(pid, deps = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const run = deps.execFile ?? execFileAsync;
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === 'win32') {
      const { stdout } = await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().Ticks }`,
      ], { windowsHide: true });
      const ticks = Number(stdout.trim());
      // .NET ticks are 100ns since year 1; convert to epoch milliseconds.
      return Number.isFinite(ticks) && ticks > 0 ? Math.round(ticks / 10_000 - 62_135_596_800_000) : null;
    }
    if (platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      // Field 22 is starttime in clock ticks since boot. The comm field may contain
      // spaces and parentheses, so parse from the last ')'.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(fields[19]);
      if (!Number.isFinite(ticks)) return null;
      const uptime = Number((await readFile('/proc/uptime', 'utf8')).split(' ')[0]);
      const bootMs = Date.now() - uptime * 1000;
      return Math.round(bootMs + (ticks / 100) * 1000);
    }
    const { stdout } = await run('ps', ['-p', String(pid), '-o', 'lstart=']);
    const parsed = Date.parse(stdout.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// 'alive' — the pid exists and the process is the one we started.
// 'dead'  — the pid is gone, or it is a different process wearing its number.
// 'unknown' — we could not tell. Never treated as either.
export async function runnerLiveness(lease, deps = {}) {
  const pid = lease?.pid;
  if (!Number.isInteger(pid)) return 'dead';
  const startedAt = await processStartedAt(pid, deps);
  if (startedAt === null) return Number.isFinite(lease.startedAt) ? 'dead' : 'unknown';
  if (!Number.isFinite(lease.startedAt)) return 'unknown';
  // Clocks and rounding differ between the two readings; a second of slack is
  // far tighter than any plausible pid-reuse interval.
  return Math.abs(startedAt - lease.startedAt) <= 1_000 ? 'alive' : 'dead';
}

export function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
