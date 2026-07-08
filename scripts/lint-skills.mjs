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

// No YAML dependency allowed: only the flat `key: value` shape skills use.
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  const data = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    data[m[1]] = value;
  }
  return data;
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
    const front = parseFrontmatter(text);
    if (!front) {
      errors.push(`${dirName}: SKILL.md missing frontmatter`);
      continue;
    }

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
