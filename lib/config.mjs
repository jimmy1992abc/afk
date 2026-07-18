// One reader for the flat single-line `key: value` fields of `.afk/config.md`,
// shared so each consumer parses the file the same way instead of copying the
// regex. An unreadable or absent file contributes nothing.

import { existsSync, readFileSync } from 'node:fs';

// Return the trimmed value of the first `key: value` line, comment stripped, or
// '' when the key, file, or path is absent/unreadable.
export function readConfigValue(configPath, key) {
  try {
    if (!configPath || !existsSync(configPath)) return '';
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^\\s*${escaped}\\s*:\\s*([^#]+)`, 'i');
    for (const line of readFileSync(configPath, 'utf8').split('\n')) {
      const match = line.match(re);
      if (match) return match[1].trim();
    }
  } catch {
    // An unreadable config contributes nothing; callers fall back to defaults.
  }
  return '';
}
