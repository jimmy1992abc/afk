import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { posix, win32 } from 'node:path';

import { platformAdapter } from './platform.mjs';

const execFile = promisify(execFileCallback);

// Fired and forgotten. The pass has exactly one thing worth interrupting a
// human for: an activation that gave up. Everything else is in the log.
export function createNotifier(options = {}) {
  const platform = options.platform ?? process.platform;
  const join = platform === 'win32' ? win32.join : posix.join;
  const adapter = options.adapter ?? platformAdapter(platform, {
    execFile: (file, args) => execFile(file, args, { windowsHide: true }),
  });
  return async (title, message) => adapter.notify(title, message, {
    notifyScript: join(options.root, 'worker', 'notify-windows.ps1'),
  });
}
