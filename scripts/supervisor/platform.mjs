import { spawn } from 'node:child_process';

import { createMacAdapter } from './platform-macos.mjs';
import { createWindowsAdapter } from './platform-windows.mjs';

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

export function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
