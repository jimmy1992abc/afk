import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { normalizePathEntry } from '../lib/gate/spawn.mjs';

/** What libuv appends on Windows, plus the shims cmd.exe resolves. */
const EXECUTABLE_EXTS = ['.com', '.exe', '.cmd', '.bat'];

// Every gate test spawns its gate SYNCHRONOUSLY, so a gate that hangs takes the
// whole `node --test` run down with it — and because spawnSync blocks the event
// loop, the runner's own per-test timeout can never fire. A hung suite reports
// nothing and has to be bisected by hand. Bound every gate spawn instead: these
// tests run against stubs and --print-* paths that finish in well under a
// second, so anything approaching this bound is a hang, not a slow machine.
export const GATE_SPAWN_TIMEOUT_MS = 120000;

const GATE_PREFIXES = [
  'AFK_REVIEW_',
  'CLAUDE_GATE_',
  'CLAUDE_REVIEW_',
  'CODEX_GATE_',
  'CODEX_REVIEW_',
  'DEEPSEEK_REVIEW_',
  'GLM_REVIEW_',
  'KIMI_GATE_',
  'KIMI_REVIEW_',
  'MIMO_REVIEW_',
];
const GATE_EXACT_KEYS = new Set([
  'CLAUDECODE',
  'DEEPSEEK_REVIEW_API_KEY',
  'DEV_DEEPSEEK_API_KEY',
  'DEV_MIMO_API_KEY',
  'GLM_API_KEY',
  'MIMO_REVIEW_API_KEY',
  'ZAI_API_KEY',
]);

export function gateTestEnv(overrides = {}, base = process.env) {
  const clean = { ...base };
  for (const key of Object.keys(clean)) {
    if (GATE_EXACT_KEYS.has(key) || GATE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete clean[key];
    }
  }
  return { ...clean, AFK_GATE_NO_DOTENV: '1', ...overrides };
}

/**
 * Spawn a gate under the bound above, and turn the bound being hit into a named
 * failure. Without this the caller sees an empty stdout and asserts against '',
 * which reads like a gate that printed nothing rather than one that never
 * returned.
 */
export function spawnGate(argv, options = {}) {
  const spawnOpts = { timeout: GATE_SPAWN_TIMEOUT_MS, ...options };
  const res = spawnSync(process.execPath, argv, spawnOpts);
  if (res.error && res.error.code === 'ETIMEDOUT') {
    throw new Error(
      `the gate did not exit within ${spawnOpts.timeout}ms and was killed: ${argv.join(' ')}`,
    );
  }
  return res;
}

/**
 * Windows inherits `Path`, not `PATH`, and `gateTestEnv` merges overrides by
 * EXACT key — so a plain `{ PATH: ... }` override adds a second key beside the
 * inherited one and the child may well read the wrong one. A PATH-dependent
 * test that silently keeps the inherited value passes vacuously on the only
 * platform it runs on, which is worse than failing.
 */
export function pathKey(env = process.env) {
  return envKey('PATH', env);
}

/** The inherited spelling of `name`, or `name` itself when it is not set. */
export function envKey(name, env = process.env) {
  return Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;
}

/**
 * Point every variable `os.tmpdir()` consults at `dir`, using each one's
 * INHERITED spelling: POSIX reads TMPDIR then TMP then TEMP, Windows reads TEMP
 * then TMP — and Windows customarily spells them `Temp`, so an exact-key
 * override would sit beside the inherited value instead of replacing it.
 */
export function tempEnv(dir, env = process.env) {
  return Object.fromEntries(['TMPDIR', 'TMP', 'TEMP'].map((name) => [envKey(name, env), dir]));
}

/**
 * A child `PATH` that puts `dir` first AND cannot resolve `name` any other way.
 *
 * Prepending to the inherited PATH is not enough for a shim-resolution test:
 * `resolveCliBin` is extension-major, so a real `<name>.exe` ANYWHERE later on
 * PATH correctly returns the bare name and the test's stub is never reached.
 * That is precisely the reference machine (issue #12: "that machine had a
 * kimi.exe"), where the test would either fail or — worse — spawn the real,
 * metered CLI. Entries holding the executable are dropped; everything else
 * stays, so the gates still find `git`.
 *
 * Accepted limit: the drop is per DIRECTORY, and no API hides one file inside
 * one. A shared-shims layout (`~\scoop\shims`, `C:\ProgramData\chocolatey\bin`)
 * holds `git` beside the reviewed CLI, so filtering takes git with it and these
 * tests fail loudly on such a host — chosen over a test that silently spawns
 * the metered CLI it exists to avoid.
 */
export function stubPath(dir, name, env = process.env) {
  const key = pathKey(env);
  // Normalize BEFORE the guard, not only inside the probe: `searchableDirs`
  // decides on the normalized value, and a helper that disagreed with the
  // resolver about which entries exist would silently unhermetic the tests.
  const inherited = (env[key] || '').split(delimiter)
    .map(normalizePathEntry)
    .filter((entry) => entry && !EXECUTABLE_EXTS.some(
      (ext) => existsSync(join(entry, `${name}${ext}`)),
    ));
  return { [key]: [dir, ...inherited].join(delimiter) };
}

// Transport assertions must not depend on the checkout's refs or patch size.
export function createReviewFixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'gate-review-fixture-'));
  const cleanup = () => rmSync(cwd, { recursive: true, force: true });
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      throw new Error(`review fixture git failed: ${result.error?.message || result.stderr}`);
    }
    return result.stdout.trim();
  };
  try {
    git('init', '-b', 'main', '--template=');
    mkdirSync(join(cwd, '.git', 'info'), { recursive: true });
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.com');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    git('config', 'core.hooksPath', join(cwd, 'no-hooks'));
    writeFileSync(join(cwd, 'safe.txt'), 'Initial fixture\n');
    git('add', 'safe.txt');
    git('commit', '-m', 'initial fixture');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(join(cwd, 'safe.txt'), 'Review fixture\n');
    git('add', 'safe.txt');
    git('commit', '-m', 'fixture');
    return { cwd, commit: git('rev-parse', 'HEAD'), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
