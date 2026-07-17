#!/usr/bin/env node
// Every install surface (Claude/Codex/Copilot) keys its cache off
// plugins[0].version; a skill/script change that ships without a bump
// is invisible to already-installed agents until they happen to reinstall.

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MANIFEST_FILES = [
  '.claude-plugin/marketplace.json',
  '.github/plugin/marketplace.json',
  '.agents/plugins/marketplace.json',
  '.codex-plugin/plugin.json',
  'plugin.json',
];

export function semverGt(a, b) {
  const partsOf = (v) => String(v).split('.').slice(0, 3)
    .map((p) => Number.parseInt(p, 10) || 0);
  const [aMajor, aMinor, aPatch] = partsOf(a);
  const [bMajor, bMinor, bPatch] = partsOf(b);
  if (aMajor !== bMajor) return aMajor > bMajor;
  if (aMinor !== bMinor) return aMinor > bMinor;
  return aPatch > bPatch;
}

// Directories whose contents ship to an installed plugin. `lib/` is shared
// runtime imported by every gate helper, so a change there alters installed
// behaviour exactly as a change under skills/ does.
const SHIPPED_DIRS = ['skills/', 'scripts/', 'lib/'];

export function requiresBump(changedPaths) {
  return changedPaths.some(
    (p) => SHIPPED_DIRS.some((d) => p.startsWith(d)) || MANIFEST_FILES.includes(p),
  );
}

export function evaluate(baseVersion, headVersion, changedPaths) {
  if (baseVersion === null) {
    return { ok: true, reason: 'no base version found (first PR) — skipping bump check' };
  }
  if (!requiresBump(changedPaths)) {
    return { ok: true, reason: 'no skills/scripts/manifest paths changed — bump not required' };
  }
  if (semverGt(headVersion, baseVersion)) {
    return { ok: true, reason: `version bumped ${baseVersion} -> ${headVersion}` };
  }
  return {
    ok: false,
    reason: `version-relevant paths changed but version was not bumped (base ${baseVersion}, head ${headVersion})`,
  };
}

function readVersionAtRef(repoRoot, ref) {
  try {
    const raw = execFileSync('git', ['show', `${ref}:.claude-plugin/marketplace.json`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return JSON.parse(raw).plugins[0].version;
  } catch {
    return null;
  }
}

function readWorkingVersion(repoRoot) {
  const path = join(repoRoot, '.claude-plugin', 'marketplace.json');
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw).plugins[0].version;
}

function getChangedPaths(repoRoot, base) {
  const raw = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const baseArgIdx = process.argv.indexOf('--base');
  const base = (baseArgIdx !== -1 && process.argv[baseArgIdx + 1])
    || process.env.GITHUB_BASE_REF
    || 'origin/main';

  const changedPaths = getChangedPaths(repoRoot, base);
  const baseVersion = readVersionAtRef(repoRoot, base);
  const headVersion = existsSync(join(repoRoot, '.claude-plugin', 'marketplace.json'))
    ? readWorkingVersion(repoRoot)
    : null;

  const { ok, reason } = evaluate(baseVersion, headVersion, changedPaths);
  console.log(reason);
  process.exit(ok ? 0 : 1);
}
