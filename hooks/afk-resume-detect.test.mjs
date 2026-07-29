// Integration tests for the SessionStart hook binary. Spawns the real script
// with a stdin payload against real temporary git repositories — this is the
// boundary the hook actually runs at (stdin JSON in, one JSON object or nothing
// out, always exit 0).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { test } from 'node:test';

const HOOK = fileURLToPath(new URL('./afk-resume-detect.mjs', import.meta.url));

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'resume-hook-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'a.txt'), 'x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

const staleIso = () => new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
const freshIso = () => new Date().toISOString();

function writeRun(root, id, { state = 'active', heartbeat = staleIso(), scope = 'ship it' } = {}) {
  const dir = join(root, '.afk', 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ledger.md'),
    `# afk run ledger\n\nrun-id: ${id}\nscope: ${scope}\nstate: ${state}\nheartbeat: ${heartbeat}\n\n## State\n`,
    'utf8');
}

function writeConfig(root, autoResume) {
  writeFileSync(join(root, '.afk', 'config.md'), `## resume\nauto-resume: ${autoResume}\n`, 'utf8');
}

// The update notice is off unless a test is about it: leaving it on would put a
// network fetch inside every resume assertion.
function runHook({ source = 'startup', cwd, env = { AFK_UPDATE_CHECK: 'off' } }) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source, cwd }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return r;
}

// A fresh cache entry, so the notice path resolves without any network call.
function writeUpdateCache(root, latest) {
  mkdirSync(join(root, '.afk'), { recursive: true });
  writeFileSync(
    join(root, '.afk', 'update-check.json'),
    JSON.stringify({ checkedAt: new Date().toISOString(), latest }),
    'utf8',
  );
}

function parseOut(stdout) {
  const t = stdout.trim();
  return t ? JSON.parse(t) : null;
}

function cleanup(...dirs) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

// ── source filter ─────────────────────────────────────────────────────────────

test('hook is a silent no-op on clear and compact sources', () => {
  const root = initRepo();
  try {
    writeRun(root, 'r1');
    for (const source of ['clear', 'compact']) {
      const r = runHook({ source, cwd: root });
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), '', `source=${source} must produce no output`);
    }
  } finally {
    cleanup(root);
  }
});

test('hook acts on startup and resume sources', () => {
  const root = initRepo();
  try {
    writeRun(root, 'r1');
    for (const source of ['startup', 'resume']) {
      const out = parseOut(runHook({ source, cwd: root }).stdout);
      assert.ok(out, `source=${source} must produce output`);
      assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    }
  } finally {
    cleanup(root);
  }
});

// ── no-op cases ───────────────────────────────────────────────────────────────

test('hook swallows malformed stdin and exits 0 with no output', () => {
  const r = spawnSync(process.execPath, [HOOK], { input: 'not json at all', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('hook is silent outside a git repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resume-hook-nogit-'));
  try {
    const r = runHook({ source: 'startup', cwd: dir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    cleanup(dir);
  }
});

test('hook is silent in a git repo with no .afk/runs', () => {
  const root = initRepo();
  try {
    const r = runHook({ source: 'startup', cwd: root });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    cleanup(root);
  }
});

test('hook is silent when the only run has a fresh heartbeat', () => {
  const root = initRepo();
  try {
    writeRun(root, 'live', { heartbeat: freshIso() });
    assert.equal(runHook({ source: 'startup', cwd: root }).stdout.trim(), '');
  } finally {
    cleanup(root);
  }
});

test('hook is silent when auto-resume is off, even with a stale run', () => {
  const root = initRepo();
  try {
    writeRun(root, 'r1');
    writeConfig(root, 'off');
    assert.equal(runHook({ source: 'startup', cwd: root }).stdout.trim(), '');
  } finally {
    cleanup(root);
  }
});

// ── surfacing + modes ─────────────────────────────────────────────────────────

test('default (no config) surfaces a stale run in notify style — no autonomous drive', () => {
  const root = initRepo();
  try {
    writeRun(root, 'paused-run', { scope: 'finish the queue' });
    const out = parseOut(runHook({ source: 'startup', cwd: root }).stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /paused-run/);
    assert.match(ctx, /finish the queue/);
    assert.doesNotMatch(ctx, /autonomously/i);
  } finally {
    cleanup(root);
  }
});

test('auto mode with one stale run directs an autonomous resume', () => {
  const root = initRepo();
  try {
    writeRun(root, 'solo-run');
    writeConfig(root, 'auto');
    const ctx = parseOut(runHook({ source: 'startup', cwd: root }).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /solo-run/);
    assert.match(ctx, /autonomously/i);
  } finally {
    cleanup(root);
  }
});

test('multiple stale runs are listed and none is driven, even in auto mode', () => {
  const root = initRepo();
  try {
    writeRun(root, 'run-a', { scope: 'alpha work' });
    writeRun(root, 'run-b', { scope: 'beta work' });
    writeConfig(root, 'auto');
    const ctx = parseOut(runHook({ source: 'startup', cwd: root }).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /run-a/);
    assert.match(ctx, /run-b/);
    assert.match(ctx, /alpha work/);
    assert.match(ctx, /beta work/);
    assert.match(ctx, /Do NOT auto-drive/i);
    assert.doesNotMatch(ctx, /resume this run autonomously/i);
  } finally {
    cleanup(root);
  }
});

// ── the main-worktree fix ─────────────────────────────────────────────────────

test('a run in the MAIN tree is found when the hook fires from a LINKED worktree', () => {
  const root = initRepo();
  const linked = join(mkdtempSync(join(tmpdir(), 'resume-hook-wt-')), 'wt');
  try {
    // .afk/runs lives in the main tree; the session opens in a linked worktree.
    writeRun(root, 'spanning-run');
    git(root, 'worktree', 'add', '-q', linked, '-b', 'feature');
    const ctx = parseOut(runHook({ source: 'startup', cwd: linked }).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /spanning-run/);
  } finally {
    // remove the worktree registration before deleting dirs
    try { git(root, 'worktree', 'remove', '--force', linked); } catch { /* best effort */ }
    cleanup(root, join(linked, '..'));
  }
});

// ── the stale-install notice ──────────────────────────────────────────────────
// A direct /afk-codex-review never runs the driver's kickoff check, so the
// SessionStart hook is where a stale install becomes visible at all.

const NOTICE_ON = { AFK_UPDATE_CHECK: '' };

test('a stale install is surfaced even when auto-resume is off', () => {
  // The two knobs govern different facts: silencing resume prompts is not a
  // request to be kept on old code.
  const root = initRepo();
  try {
    writeUpdateCache(root, '99.0.0'); // creates .afk/, which writeConfig needs
    writeConfig(root, 'off');
    const ctx = parseOut(runHook({ cwd: root, env: NOTICE_ON }).stdout)
      .hookSpecificOutput.additionalContext;
    assert.match(ctx, /latest v99\.0\.0/);
    assert.match(ctx, /update the afk-skills plugin/i);
  } finally {
    cleanup(root);
  }
});

test('a paused run and a stale install are surfaced together', () => {
  const root = initRepo();
  try {
    writeRun(root, 'paused-run', { scope: 'finish the queue' });
    writeUpdateCache(root, '99.0.0');
    const ctx = parseOut(runHook({ cwd: root, env: NOTICE_ON }).stdout)
      .hookSpecificOutput.additionalContext;
    assert.match(ctx, /paused-run/);
    assert.match(ctx, /latest v99\.0\.0/);
  } finally {
    cleanup(root);
  }
});

test('a current install adds no notice', () => {
  const root = initRepo();
  try {
    writeRun(root, 'paused-run');
    writeUpdateCache(root, '0.0.1'); // behind the installed version
    const ctx = parseOut(runHook({ cwd: root, env: NOTICE_ON }).stdout)
      .hookSpecificOutput.additionalContext;
    assert.match(ctx, /paused-run/);
    assert.doesNotMatch(ctx, /latest v/);
  } finally {
    cleanup(root);
  }
});

test('the opt-out silences the notice and nothing else', () => {
  const root = initRepo();
  try {
    writeRun(root, 'paused-run');
    writeUpdateCache(root, '99.0.0');
    const ctx = parseOut(runHook({ cwd: root, env: { AFK_UPDATE_CHECK: 'off' } }).stdout)
      .hookSpecificOutput.additionalContext;
    assert.match(ctx, /paused-run/);
    assert.doesNotMatch(ctx, /99\.0\.0/);
  } finally {
    cleanup(root);
  }
});

test('a repo with no .afk stays silent even with the notice enabled', () => {
  // The hook's no-op-outside-an-afk-repo contract is not weakened by the notice.
  const root = initRepo();
  try {
    const r = runHook({ cwd: root, env: NOTICE_ON });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    cleanup(root);
  }
});
