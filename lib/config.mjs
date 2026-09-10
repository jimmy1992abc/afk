// One reader for the flat single-line `key: value` fields of `.afk/config.md`,
// shared so each consumer parses the file the same way instead of copying the
// regex. An unreadable or absent file contributes nothing.

import { existsSync, readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';

function readConfigText(configPath) {
  try {
    if (!configPath || !existsSync(configPath)) return '';
    return readFileSync(configPath, 'utf8');
  } catch {
    return '';
  }
}

// One line assembly for every reader: no `\r` may survive it — the key/value
// regexes anchor with `$` and exclude `\r` from `.`, so a remnant would make
// the section readers and the flat reader disagree about one file. `/\r+$/`
// (not a single strip) also absorbs an EOF bare-`\r` and `\r\r\n`
// double-conversion artifacts.
function configLines(text) {
  return text.split('\n').map((line) => line.replace(/\r+$/, ''));
}

function sectionLines(configPath, section) {
  return sectionTextLines(readConfigText(configPath), section);
}

function sectionTextLines(text, section, withPresence = false) {
  const wanted = String(section || '').trim().toLowerCase();
  if (!wanted) return [];
  const lines = configLines(text);
  const result = [];
  let active = false;
  let present = false;
  for (const line of lines) {
    const heading = line.match(/^\s*##\s+(.+?)\s*$/);
    if (heading) {
      active = heading[1].trim().toLowerCase() === wanted;
      present ||= active;
      continue;
    }
    if (active) result.push(line);
  }
  return withPresence ? { lines: result, present } : result;
}

export function readConfigSectionStrict(configPath, section) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(configPath)); }
  catch (error) {
    if (error.code === 'ENOENT') return { present: false, fields: {}, text: [] };
    throw new Error('configuration is unreadable');
  }
  const { lines, present } = sectionTextLines(text, section, true);
  const fields = Object.create(null);
  const other = [];
  for (const line of lines) {
    const content = line.split('#', 1)[0].trim();
    if (!content) continue;
    const colon = content.indexOf(':');
    const key = colon > 0 ? content.slice(0, colon).trim().toLowerCase() : '';
    const match = key ? keyMatch(line, key) : null;
    if (match) {
      if (!Object.hasOwn(fields, key)) fields[key] = match[1].split('#', 1)[0].trim();
    } else other.push(content);
  }
  return { present, fields, text: other };
}

function keyMatch(line, key) {
  const escaped = String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return null;
  return line.match(new RegExp(`^\\s*${escaped}\\s*:(.*)$`, 'i'));
}

// Return the trimmed value of the first `key: value` line, comment stripped, or
// '' when the key, file, or path is absent/unreadable.
export function readConfigValue(configPath, key) {
  try {
    if (!configPath || !existsSync(configPath)) return '';
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^\\s*${escaped}\\s*:\\s*([^#]+)`, 'i');
    for (const line of configLines(readFileSync(configPath, 'utf8'))) {
      const match = line.match(re);
      if (match) return match[1].trim();
    }
  } catch {
    // An unreadable config contributes nothing; callers fall back to defaults.
  }
  return '';
}

// Presence is distinct from value: `gates:` is a present configuration error,
// while an absent `gates` key selects compatibility/default behavior.
export function hasConfigKeyInSection(configPath, section, key) {
  return sectionLines(configPath, section).some((line) => Boolean(keyMatch(line, key)));
}

// Return the first value from one `## <section>`, with inline comments removed.
// Empty and comment-only values intentionally return '' while presence remains
// observable through hasConfigKeyInSection.
export function readConfigSectionValue(configPath, section, key) {
  for (const line of sectionLines(configPath, section)) {
    const match = keyMatch(line, key);
    if (match) return match[1].split('#', 1)[0].trim();
  }
  return '';
}
