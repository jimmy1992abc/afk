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
  return async (run) => adapter.notify(
    'AFK Supervisor needs attention',
    `Run ${run.runId} remains quota-limited; the next probe uses escalated backoff.`,
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
