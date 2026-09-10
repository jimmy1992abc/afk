#!/usr/bin/env node
// Every agent surface (Claude/Codex/Copilot) reads skills/<name>/SKILL.md
// directly, so a malformed or misnamed frontmatter breaks discovery
// silently on whichever surface parses it strictest. Catch that in CI
// instead of per-agent at install time.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NAME_RE = /^afk(-[a-z0-9]+)*$/;
const DESC_MIN = 20;
const DESC_MAX = 1024;

const YAML_PLAIN_KEYWORDS = /^(?:null|true|false|yes|no|on|off|y|n)$/i;

function isYamlPrintable(text) {
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    const valid = cp === 0x09
      || cp === 0x0a
      || cp === 0x0d
      || (cp >= 0x20 && cp <= 0x7e)
      || cp === 0x85
      || (cp >= 0xa0 && cp <= 0xd7ff)
      || (cp >= 0xe000 && cp <= 0xfffd)
      || (cp >= 0x10000 && cp <= 0x10ffff);
    if (!valid) return false;
    i += cp > 0xffff ? 2 : 1;
  }
  return true;
}

function isUnicodeScalarString(text) {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function parseQuotedScalar(raw) {
  if (!isYamlPrintable(raw)) return { error: 'invalid Unicode character' };

  if (raw.startsWith('"')) {
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      return { error: 'malformed quoted scalar' };
    }
    if (typeof value !== 'string') return { error: 'malformed quoted scalar' };
    if (!isUnicodeScalarString(value)) return { error: 'invalid Unicode character' };
    return { value };
  }

  if (!raw.endsWith("'") || raw.length < 2) {
    return { error: 'malformed quoted scalar' };
  }
  const inner = raw.slice(1, -1);
  let value = '';
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== "'") {
      value += inner[i];
      continue;
    }
    if (inner[i + 1] !== "'") return { error: 'malformed quoted scalar' };
    value += "'";
    i += 1;
  }
  if (!isUnicodeScalarString(value)) return { error: 'invalid Unicode character' };
  return { value };
}

function parseScalar(raw) {
  if (raw.startsWith('"') || raw.startsWith("'")) return parseQuotedScalar(raw);
  if (!isYamlPrintable(raw)
    || !/^[A-Za-z]/.test(raw)
    || YAML_PLAIN_KEYWORDS.test(raw)
    || raw.includes('\t')
    || /:(?:[ \t]|$)/.test(raw)
    || /[ \t]#/.test(raw)) {
    return { error: 'invalid plain scalar' };
  }
  return { value: raw };
}

// No YAML dependency allowed: accept only a flat scalar subset that is valid
// YAML and reject every line that falls outside it.
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') {
    return {
      error: lines[0]?.includes('---') || lines[0]?.trim() === '---'
        ? 'invalid frontmatter delimiter'
        : 'SKILL.md missing frontmatter',
    };
  }
  const end = lines.indexOf('---', 1);
  if (end === -1) return { error: 'invalid frontmatter delimiter' };
  const data = {};
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    if (line === '') continue;
    const m = /^([A-Za-z0-9_-]+):([ \t]+)(.*)$/.exec(line);
    if (!m) {
      const category = /^[A-Za-z0-9_-]+:/.test(line)
        ? 'missing mapping separation'
        : 'malformed frontmatter line';
      return { error: `${category} at line ${i + 1}` };
    }
    const key = m[1];
    if (Object.hasOwn(data, key)) {
      return { error: `duplicate key "${key}" at line ${i + 1}` };
    }
    const scalar = parseScalar(m[3].trimEnd());
    if (scalar.error) return { error: `${scalar.error} at line ${i + 1}` };
    data[key] = scalar.value;
  }
  return { data };
}

export function lintSkills(skillsDir) {
  const errors = [];
  if (!existsSync(skillsDir)) return errors;

  const entries = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory());

  for (const entry of entries) {
    const dirName = entry.name;
    const skillMdPath = join(skillsDir, dirName, 'SKILL.md');
    if (!existsSync(skillMdPath)) {
      errors.push(`${dirName}: missing SKILL.md`);
      continue;
    }

    const text = readFileSync(skillMdPath, 'utf8');
    const parsed = parseFrontmatter(text);
    if (parsed.error) {
      errors.push(`${dirName}: ${parsed.error}`);
      continue;
    }
    const front = parsed.data;

    if (!front.name) {
      errors.push(`${dirName}: missing name`);
    } else {
      if (front.name !== dirName) {
        errors.push(`${dirName}: name "${front.name}" does not match directory name`);
      }
      if (!NAME_RE.test(front.name)) {
        errors.push(`${dirName}: name "${front.name}" does not match pattern ${NAME_RE}`);
      }
    }

    if (!front.description) {
      errors.push(`${dirName}: missing description`);
    } else if (front.description.length < DESC_MIN || front.description.length > DESC_MAX) {
      errors.push(
        `${dirName}: description length ${front.description.length} outside [${DESC_MIN}, ${DESC_MAX}]`,
      );
    }
    if (front.description && (!front.description.startsWith(`${dirName}: `)
      || !/part of the afk pipeline\b/i.test(front.description))) {
      errors.push(`${dirName}: description must lead with "${dirName}: " and identify "Part of the afk pipeline"`);
    }
  }

  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const errors = lintSkills(join(repoRoot, 'skills'));
  if (errors.length > 0) {
    errors.forEach((e) => console.log(e));
    process.exit(1);
  } else {
    console.log('lint-skills: OK');
    process.exit(0);
  }
}
