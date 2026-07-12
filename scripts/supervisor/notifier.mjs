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
