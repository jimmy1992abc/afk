import { createMacAdapter } from './platform-macos.mjs';
import { createWindowsAdapter } from './platform-windows.mjs';

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
