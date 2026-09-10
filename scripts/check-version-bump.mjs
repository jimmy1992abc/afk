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
// runtime imported by every gate helper, `hooks/` is a plugin component
// (hooks/hooks.json plus its bundled scripts), and `templates/` is consumed at
// runtime by afk-init's bootstrap, so a change under any of them alters
// installed behaviour exactly as a change under skills/ does.
const SHIPPED_DIRS = ['skills/', 'scripts/', 'lib/', 'hooks/', 'templates/'];

// The comparator coerces garbage to 0.0.0, so anything reaching it must first
// pass this shape rule — a corrupted version must fail loudly, never "bump".
const VERSION_RE = /^\d+\.\d+\.\d+$/;

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
    return { ok: true, reason: 'no shipped paths (skills/scripts/lib/hooks/templates/manifests) changed — bump not required' };
  }
  if (typeof headVersion !== 'string' || !VERSION_RE.test(headVersion)) {
    return {
      ok: false,
      reason: `shipped paths changed but the head version is unusable (${JSON.stringify(headVersion)}) — expected X.Y.Z`,
    };
  }
  if (semverGt(headVersion, baseVersion)) {
    return { ok: true, reason: `version bumped ${baseVersion} -> ${headVersion}` };
  }
  return {
    ok: false,
    reason: `version-relevant paths changed but version was not bumped (base ${baseVersion}, head ${headVersion})`,
  };
}

const MANIFEST_PATH = '.claude-plugin/marketplace.json';

// Shell-less on purpose: `^{commit}` is a cmd.exe metacharacter under a shell.
function runGit(repoRoot, args, opts = {}) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', ...opts });
}

// Classified base read. Only "manifest absent at the ref" may skip the check;
// every other failure throws its distinct reason and the CLI fails closed —
// a silently unreadable base would disable the one gate this script is.
export function readBaseVersion(repoRoot, ref) {
  try {
    runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw new Error(`cannot resolve base ref '${ref}'`);
  }
  const listed = runGit(repoRoot, ['ls-tree', '--name-only', ref, '--', MANIFEST_PATH]).trim();
  if (!listed) return { kind: 'absent' };
  const raw = runGit(repoRoot, ['show', `${ref}:${MANIFEST_PATH}`]);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`manifest at '${ref}' is not valid JSON`);
  }
  const version = parsed?.plugins?.[0]?.version;
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error(`manifest at '${ref}' has no plugins[0].version matching X.Y.Z (got ${JSON.stringify(version)})`);
  }
  return { kind: 'version', version };
}

export function readWorkingVersion(repoRoot) {
  const path = join(repoRoot, '.claude-plugin', 'marketplace.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8')).plugins[0].version;
  } catch (err) {
    throw new Error(`cannot read the working manifest at ${path}: ${err.message}`);
  }
}

// --no-renames: a rename out of a shipped directory is a shipped change; with
// rename detection on, only the destination path would be listed and the
// deletion would vanish from the change set.
export function getChangedPaths(repoRoot, base) {
  const raw = runGit(repoRoot, ['diff', '--name-only', '--no-renames', `${base}...HEAD`]);
  return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const baseArgIdx = process.argv.indexOf('--base');
  const base = (baseArgIdx !== -1 && process.argv[baseArgIdx + 1])
    || process.env.GITHUB_BASE_REF
    || 'origin/main';

  // Catch-all: every unhandled throw fails closed with its message — a check
  // that dies silently or "skips" on an unreadable input is no check at all.
  try {
    // Base read first: an unresolvable ref gets its classified reason instead
    // of whatever `git diff` happens to say about it.
    const baseRead = readBaseVersion(repoRoot, base);
    const changedPaths = getChangedPaths(repoRoot, base);
    if (baseRead.kind === 'absent') {
      console.log(`no manifest at base ref '${base}' (first PR) — skipping bump check`);
      process.exit(0);
    }
    const headVersion = existsSync(join(repoRoot, '.claude-plugin', 'marketplace.json'))
      ? readWorkingVersion(repoRoot)
      : null;

    const { ok, reason } = evaluate(baseRead.version, headVersion, changedPaths);
    console.log(reason);
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error(`version check failed: ${err.message}`);
    process.exit(1);
  }
}
