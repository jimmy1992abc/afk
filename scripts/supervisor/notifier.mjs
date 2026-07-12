import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { posix, win32 } from 'node:path';

import { platformAdapter } from './platform.mjs';

const execFile = promisify(execFileCallback);

export function createNotifier(options = {}) {
  const platform = options.platform ?? process.platform;
  const join = platform === 'win32' ? win32.join : posix.join;
  const adapter = options.adapter ?? platformAdapter(platform, {
    execFile: (file, args) => execFile(file, args, { windowsHide: true }),
  });
  // The message has to match what actually happened. Reusing the quota-escalation
  // wording for a run that simply ran out of retries tells the operator to wait
  // for a probe that will never come.
  const REASONS = {
    'quota-escalated': (run) => `Run ${run.runId} remains quota-limited; the next probe uses escalated backoff.`,
    exhausted: (run) => `Run ${run.runId} exhausted its recovery attempts and will not be retried. Use \`afk-supervisor trigger-now --run-id ${run.runId}\` to start a new attempt series.`,
    stuck: (run) => `Run ${run.runId} is still held by a runner that outlived its timeout. If that process is gone, \`afk-supervisor trigger-now --run-id ${run.runId}\` clears the lease.`,
  };
  return async (run, reason = 'quota-escalated') => adapter.notify(
    'AFK Supervisor needs attention',
    (REASONS[reason] ?? REASONS['quota-escalated'])(run),
    { notifyScript: join(options.root, 'worker', 'notify-windows.ps1') },
  );
}

// A run held by a runner that outlived its timeout. The operator is the escape
// hatch here, so they have to actually be told — and told what to do about it.
export function createStuckNotifier(options = {}) {
  const platform = options.platform ?? process.platform;
  const join = platform === 'win32' ? win32.join : posix.join;
  const adapter = options.adapter ?? platformAdapter(platform, {
    execFile: (file, args) => execFile(file, args, { windowsHide: true }),
  });
  // The two cases need different advice, and telling the operator to --force a
  // runner that is verifiably ALIVE was advice to corrupt the session: the command
  // now refuses that, because clearing a live claim leaves one Claude writing to the
  // session and starts a second on top of it. A live runner is ended by ending it.
  return async (run, liveness = 'alive') => adapter.notify(
    'AFK Supervisor needs attention',
    liveness === 'unknown'
      ? `Run ${run.runId} is held by process ${run.recoveryLease?.pid}, which cannot be checked. Recovery of this run is paused. \`afk-supervisor trigger-now --run-id ${run.runId} --force\` releases it.`
      : `Run ${run.runId} is still held by a runner (pid ${run.recoveryLease?.pid}) that outlived its timeout but is still running. It will stop at its own action timeout. To end it sooner, stop pid ${run.recoveryLease?.pid} yourself, then \`afk-supervisor trigger-now --run-id ${run.runId}\`.`,
    { notifyScript: join(options.root, 'worker', 'notify-windows.ps1') },
  );
}

export function createWindowNotifier(options = {}) {
  const platform = options.platform ?? process.platform;
  const join = platform === 'win32' ? win32.join : posix.join;
  const adapter = options.adapter ?? platformAdapter(platform, {
    execFile: (file, args) => execFile(file, args, { windowsHide: true }),
  });
  return async () => adapter.notify(
    'Claude usage window reset',
    'No AFK run is active. Start one when you are ready.',
    { notifyScript: join(options.root, 'worker', 'notify-windows.ps1') },
  );
}
