import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { posix, win32 } from 'node:path';

import { platformAdapter } from './platform.mjs';

const execFile = promisify(execFileCallback);

// Fired and forgotten. The pass has exactly one thing worth interrupting a
// human for: an activation that gave up. Everything else is in the log.
//
// Best-effort all the way down: on a platform with no notification adapter
// (Linux is not an install target, but the pass itself runs fine there) this
// degrades to a no-op instead of throwing — a missing toast must never be the
// reason a pass dies, which is exactly what an eager adapter constructor did.
export function createNotifier(options = {}) {
  const platform = options.platform ?? process.platform;
  const join = platform === 'win32' ? win32.join : posix.join;
  let adapter = options.adapter ?? null;
  if (!adapter) {
    try {
      adapter = platformAdapter(platform, {
        execFile: (file, args) => execFile(file, args, { windowsHide: true }),
      });
    } catch {
      return async () => {};
    }
  }
  return async (title, message) => adapter.notify(title, message, {
    notifyScript: join(options.root, 'worker', 'notify-windows.ps1'),
  });
}
