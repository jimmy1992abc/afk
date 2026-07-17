// Resolving who wrote the code under review, so a gate can refuse to review its
// own implementer.
//
// Extracted from claude-gate despite having one consumer today: it is pure
// decision logic guarding an invariant, and a gate script is an executable that
// runs on import, so this is the only place it can be unit-tested.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { git } from './git.mjs';

// Families are compared, not model names: `opus` and `claude-opus-4-8` are the
// same reviewer.
const FAMILIES = {
  claude: ['claude', 'anthropic', 'opus', 'sonnet', 'haiku', 'fable'],
  codex: ['codex', 'openai', 'gpt'],
  kimi: ['kimi', 'moonshot'],
  glm: ['glm', 'zai', 'z.ai'],
  gemini: ['gemini', 'google'],
  copilot: ['copilot'],
};

// Returns a family name, or null when the value belongs to no known family.
export function classifyImplementer(value) {
  const raw = (value || '').trim().toLowerCase();
  if (!raw) return null;
  for (const [family, prefixes] of Object.entries(FAMILIES)) {
    if (prefixes.some((p) => raw === p || raw.startsWith(`${p}-`) || raw.startsWith(`${p}/`))) {
      return family;
    }
  }
  return null;
}

// The main working tree, per `skills/afk/SKILL.md`: the first `worktree` line of
// `git worktree list --porcelain`.
//
// NOT dirname(git-common-dir): under `--separate-git-dir` or in a submodule that
// parent is git metadata, not a working tree. From a linked worktree that mistake
// makes the main tree's `.afk/config.md` invisible — and this config can only
// TIGHTEN the guard, so losing it silently re-opens the self-review it was
// written to close.
function mainWorktree() {
  const out = git(['worktree', 'list', '--porcelain']);
  const first = out.split('\n').find((l) => l.startsWith('worktree '));
  return first ? first.slice('worktree '.length).trim() : '';
}

export function findAfkConfig() {
  const candidates = [
    join(process.cwd(), '.afk', 'config.md'),
    mainWorktree() && join(mainWorktree(), '.afk', 'config.md'),
    git(['rev-parse', '--show-toplevel']).trim() && join(git(['rev-parse', '--show-toplevel']).trim(), '.afk', 'config.md'),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || '';
}

export function readConfigImplementer(configPath) {
  try {
    if (!configPath || !existsSync(configPath)) return '';
    for (const line of readFileSync(configPath, 'utf8').split('\n')) {
      const match = line.match(/^\s*implementer\s*:\s*([^#]+)/i);
      if (match) return match[1].trim();
    }
  } catch {
    // An unreadable config contributes nothing; the other sources still apply.
  }
  return '';
}

/**
 * Decide whether a gate reviewing as `gateFamily` may run.
 *
 * Resolution order and, crucially, what each source is ALLOWED to do:
 *
 *   1. `--implementer` — per-invocation, cannot go stale. May permit or block.
 *   2. `.afk/config.md` — per-repo, gitignored, written once. May only BLOCK.
 *      Letting a stale per-repo file outrank a live per-run signal is exactly
 *      how this guard dies quietly, so it is a tightener only.
 *   3. `CLAUDECODE` — live, per-process, set by Claude Code in every child.
 *
 * Unrecognised input fails closed: a typo must not silently defeat the guard.
 */
export function resolveGuard({
  gateFamily,
  flagValue = '',
  configValue = '',
  env = process.env,
  driverEnvVar = 'CLAUDECODE',
  driverFamily = 'claude',
}) {
  if (flagValue) {
    const family = classifyImplementer(flagValue);
    if (!family) {
      return {
        run: false,
        reason: `unrecognised --implementer "${flagValue}"; cannot prove this gate is independent, so it declines. Pass a known family (${Object.keys(FAMILIES).join(', ')}).`,
      };
    }
    if (family === gateFamily) {
      return { run: false, reason: `the implementer is ${family} — this gate would be reviewing its own work.` };
    }
    return { run: true, reason: `implementer declared as ${family}.` };
  }

  // No explicit declaration: the config and the live driver signal may each
  // block, and neither may unblock.
  if (configValue) {
    const family = classifyImplementer(configValue);
    if (!family) {
      return {
        run: false,
        reason: `unrecognised implementer "${configValue}" in .afk/config.md; cannot prove this gate is independent, so it declines.`,
      };
    }
    if (family === gateFamily) {
      return { run: false, reason: `.afk/config.md declares the implementer as ${family} — this gate would be reviewing its own work.` };
    }
  }

  if (env[driverEnvVar] && driverFamily === gateFamily) {
    return {
      run: false,
      reason: `${driverEnvVar} is set, so the driver is ${driverFamily} and this gate would likely be reviewing its own work. Pass --implementer <family> if another model wrote this change.`,
    };
  }

  return { run: true, reason: `no ${gateFamily} implementer signal.` };
}

/**
 * The whole guard for a gate, resolved from argv + .afk/config.md + the env.
 *
 * Every gate applies this with its own family. A gate that merely ACCEPTED
 * --implementer and ignored it would let `--implementer codex` send codex to
 * review codex's own work — an independence violation that is silent, which is
 * worse than rejecting the flag outright.
 */
export function guardFor(gateFamily, argv, { env = process.env } = {}) {
  const i = argv.indexOf('--implementer');
  const supplied = i >= 0;
  const value = supplied && i + 1 < argv.length ? argv[i + 1] : '';

  // A supplied-but-valueless flag is a caller bug, not a declaration. Treating
  // it as "absent" would drop through to the driver signal and, with no
  // CLAUDECODE, silently permit the self-review the flag exists to prevent.
  if (supplied && (!value || value.startsWith('--'))) {
    return {
      run: false,
      reason: '--implementer was passed with no value; cannot prove this gate is independent, so it declines.',
    };
  }

  return resolveGuard({
    gateFamily,
    flagValue: value,
    configValue: readConfigImplementer(findAfkConfig()),
    env,
  });
}

// Remove --implementer and its value. It is an afk-level flag: a gate that
// forwards argv to its own CLI (codex) must consume it, or the CLI rejects an
// option it has never heard of and the gate cannot run at all.
export function stripImplementer(argv) {
  const i = argv.indexOf('--implementer');
  if (i < 0) return argv;
  return [...argv.slice(0, i), ...argv.slice(i + 2)];
}
