// Unit tests for the shared gate lib.
//
// detectBase/resolveBase/collectDiff run against real temporary repositories,
// never a stub: they exist to interrogate git's actual behaviour, and a stubbed
// git would only assert that the test author and the implementation agree.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'node:test';

import { isGateDisabled } from './env.mjs';
import { detectBase, gitTry, hasRef, resolveBase } from './git.mjs';
import { classifyImplementer, guardFor, resolveGuard, stripImplementer } from './implementer.mjs';
import { buildReviewPrompt } from './prompt.mjs';
import { collectDiff, optVal, parseTarget, validateTarget } from './target.mjs';

// ── fixtures ────────────────────────────────────────────────────────────────

function run(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-lib-test-'));
  try {
    run(dir, 'init', '-q', '-b', 'main');
    run(dir, 'config', 'user.email', 'test@example.com');
    run(dir, 'config', 'user.name', 'Test');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    run(dir, 'add', '.');
    run(dir, 'commit', '-qm', 'init');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── env ─────────────────────────────────────────────────────────────────────

test('isGateDisabled accepts every documented opt-out spelling', () => {
  for (const v of ['off', '0', 'false', 'no', 'disabled', 'OFF', ' Off ']) {
    assert.equal(isGateDisabled('X', { X: v }), true, JSON.stringify(v));
  }
});

test('isGateDisabled fails closed on anything else', () => {
  // A typo must leave the gate ON. The dangerous direction is a review silently
  // not happening, so only an exact opt-out counts.
  for (const v of ['', 'on', 'yes', 'true', 'offf', 'disable', 'nope', '1']) {
    assert.equal(isGateDisabled('X', { X: v }), false, JSON.stringify(v));
  }
  assert.equal(isGateDisabled('X', {}), false);
});

// ── git ─────────────────────────────────────────────────────────────────────

test('detectBase falls back to a local main when origin/HEAD is absent', () => {
  withRepo((dir) => {
    assert.equal(detectBase({ cwd: dir }), 'main');
  });
});

test('detectBase finds master when there is no main', () => {
  withRepo((dir) => {
    run(dir, 'branch', '-m', 'main', 'master');
    assert.equal(detectBase({ cwd: dir }), 'master');
  });
});

test('detectBase prefers origin/HEAD over a local branch name', () => {
  withRepo((dir) => {
    run(dir, 'checkout', '-qb', 'trunk');
    run(dir, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    run(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    assert.equal(detectBase({ cwd: dir }), 'trunk');
  });
});

test('detectBase defaults to main in a repo with neither', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-lib-empty-'));
  try {
    run(dir, 'init', '-q', '-b', 'somethingelse');
    assert.equal(detectBase({ cwd: dir }), 'main');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveBase promotes a bare branch to its remote-tracking ref', () => {
  // The behaviour change of this PR: a stale local `main` must not decide the
  // review range. Previously codex-gate and kimi-gate diffed the local ref.
  withRepo((dir) => {
    run(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.equal(resolveBase('main', { cwd: dir }), 'origin/main');
  });
});

test('resolveBase leaves a bare branch alone when no remote ref exists', () => {
  withRepo((dir) => {
    assert.equal(resolveBase('main', { cwd: dir }), 'main');
  });
});

test('resolveBase promotes a branch whose NAME contains a slash', () => {
  // A slash is not proof of remote qualification: `release/stable` is an
  // ordinary local branch. Inferring from the name instead of probing for the
  // ref left the staleness this function exists to prevent.
  withRepo((dir) => {
    run(dir, 'checkout', '-qb', 'release/stable');
    run(dir, 'update-ref', 'refs/remotes/origin/release/stable', 'HEAD');
    run(dir, 'checkout', '-q', 'main');
    assert.equal(resolveBase('release/stable', { cwd: dir }), 'origin/release/stable');
  });
});

test('resolveBase passes through a base that already names a remote', () => {
  withRepo((dir) => {
    run(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.equal(resolveBase('origin/main', { cwd: dir }), 'origin/main');
    assert.equal(resolveBase('upstream/main', { cwd: dir }), 'upstream/main');
  });
});

test('a stale local base and a fresh remote base select different ranges', () => {
  // The defect this fixes, demonstrated end to end: with the local branch behind
  // the remote, the promoted ref is the one that describes the PR.
  withRepo((dir) => {
    run(dir, 'checkout', '-qb', 'feature');
    writeFileSync(join(dir, 'b.txt'), 'feature work\n');
    run(dir, 'add', '.');
    run(dir, 'commit', '-qm', 'feature commit');
    // origin/main has advanced; the local main has not.
    run(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

    assert.equal(hasRef('origin/main', { cwd: dir }), true);
    assert.equal(resolveBase('main', { cwd: dir }), 'origin/main');

    const stale = parseTarget([], { cwd: dir, base: 'main' });
    assert.equal(stale.base, 'origin/main');
    assert.equal(stale.command, 'git diff origin/main...HEAD');
  });
});

// ── target ──────────────────────────────────────────────────────────────────

test('optVal reads a flag value and tolerates a trailing flag', () => {
  assert.equal(optVal(['--base', 'dev'], '--base'), 'dev');
  assert.equal(optVal(['--base'], '--base'), null, 'no value must not read past the end');
  assert.equal(optVal([], '--base'), null);
});

test('parseTarget precedence: commit beats uncommitted beats branch', () => {
  withRepo((dir) => {
    const both = parseTarget(['--commit', 'abc123', '--uncommitted'], { cwd: dir });
    assert.equal(both.kind, 'commit');
    assert.equal(both.commit, 'abc123');

    const unc = parseTarget(['--uncommitted'], { cwd: dir });
    assert.equal(unc.kind, 'uncommitted');

    const branch = parseTarget([], { cwd: dir });
    assert.equal(branch.kind, 'branch');
  });
});

test('parseTarget treats a valueless --base as absent and detects instead', () => {
  withRepo((dir) => {
    const t = parseTarget(['--base'], { cwd: dir });
    assert.equal(t.kind, 'branch');
    assert.equal(t.base, 'main');
  });
});

test('scope label names the target and carries no inspection instruction', () => {
  withRepo((dir) => {
    const t = parseTarget([], { cwd: dir });
    // The "how to look" clause is transport-specific and must not leak into the
    // shared label: glm's reviewer has no tools to look with.
    assert.doesNotMatch(t.label, /inspect|git |run /i);
    assert.match(t.label, /the changes on the current branch versus main/);
    assert.equal(t.command, 'git diff main...HEAD');
  });
});

test('collectDiff reports a branch range', () => {
  withRepo((dir) => {
    run(dir, 'checkout', '-qb', 'feature');
    writeFileSync(join(dir, 'b.txt'), 'added\n');
    run(dir, 'add', '.');
    run(dir, 'commit', '-qm', 'add b');

    const target = parseTarget([], { cwd: dir, base: 'main' });
    const { diff, stat, changedFiles } = collectDiff(target, { cwd: dir });

    assert.deepEqual(changedFiles, ['b.txt']);
    assert.match(diff, /\+added/);
    assert.match(stat, /b\.txt/);
  });
});

test('collectDiff includes untracked files for an uncommitted target', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    writeFileSync(join(dir, 'new.txt'), 'brand new\n');

    const target = parseTarget(['--uncommitted'], { cwd: dir });
    const { changedFiles } = collectDiff(target, { cwd: dir });

    assert.deepEqual(changedFiles.sort(), ['a.txt', 'new.txt']);
  });
});

test('collectDiff reports a single commit', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'c.txt'), 'third\n');
    run(dir, 'add', '.');
    run(dir, 'commit', '-qm', 'add c');
    const sha = run(dir, 'rev-parse', 'HEAD').trim();

    const target = parseTarget(['--commit', sha], { cwd: dir });
    const { changedFiles, diff } = collectDiff(target, { cwd: dir });

    assert.deepEqual(changedFiles, ['c.txt']);
    assert.match(diff, /\+third/);
  });
});

test('validateTarget rejects a ref git cannot resolve', () => {
  // git() returns '' for a failed command, so without this an unresolvable
  // target is indistinguishable from a clean tree and the gate reports a benign
  // "no changes" skip for what is actually a targeting failure.
  withRepo((dir) => {
    const badCommit = parseTarget(['--commit', 'deadbeefdeadbeef'], { cwd: dir });
    const c = validateTarget(badCommit, { cwd: dir });
    assert.equal(c.ok, false);
    assert.match(c.reason, /does not resolve to a commit/);

    const badBase = parseTarget([], { cwd: dir, base: 'no-such-branch-xyz' });
    const b = validateTarget(badBase, { cwd: dir });
    assert.equal(b.ok, false);
    assert.match(b.reason, /does not resolve to a ref/);
  });
});

test('validateTarget accepts real targets and never blocks uncommitted', () => {
  withRepo((dir) => {
    assert.equal(validateTarget(parseTarget(['--commit', 'HEAD'], { cwd: dir }), { cwd: dir }).ok, true);
    assert.equal(validateTarget(parseTarget(['--uncommitted'], { cwd: dir }), { cwd: dir }).ok, true);
    assert.equal(validateTarget(parseTarget([], { cwd: dir }), { cwd: dir }).ok, true);
  });
});

test('collectDiff surfaces untracked files separately from the diff', () => {
  // `git diff HEAD` is EMPTY for a brand-new file. A reviewer given only the
  // diff would review an all-new-files change as if nothing had changed, so the
  // untracked list must be reachable on its own.
  withRepo((dir) => {
    writeFileSync(join(dir, 'brand-new.txt'), 'entirely new\n');

    const target = parseTarget(['--uncommitted'], { cwd: dir });
    const { diff, untracked, changedFiles } = collectDiff(target, { cwd: dir });

    assert.equal(diff.trim(), '', 'precondition: the diff really is blind to it');
    assert.deepEqual(untracked, ['brand-new.txt']);
    assert.ok(changedFiles.includes('brand-new.txt'));
  });
});

test('every target kind returns an untracked array', () => {
  // A consumer destructuring `untracked` must never get undefined.
  withRepo((dir) => {
    for (const argv of [[], ['--uncommitted'], ['--commit', 'HEAD']]) {
      const t = parseTarget(argv, { cwd: dir });
      assert.ok(Array.isArray(collectDiff(t, { cwd: dir }).untracked), JSON.stringify(argv));
    }
  });
});

test('the uncommitted target tells a tool-having reviewer to look past the diff', () => {
  withRepo((dir) => {
    const t = parseTarget(['--uncommitted'], { cwd: dir });
    // Narrowing this to `git diff HEAD` alone hides every new file from kimi.
    assert.match(t.inspect, /git status/);
    assert.match(t.inspect, /ls-files --others/);
  });
});

test('diff targets need no extra inspection instruction', () => {
  withRepo((dir) => {
    assert.equal(parseTarget([], { cwd: dir }).inspect, undefined);
    assert.equal(parseTarget(['--commit', 'HEAD'], { cwd: dir }).inspect, undefined);
  });
});

test('gitTry separates "git failed" from "git found nothing"', () => {
  withRepo((dir) => {
    const empty = gitTry(['diff', 'HEAD'], { cwd: dir });
    assert.equal(empty.ok, true, 'a clean tree: git looked and found nothing');
    assert.equal(empty.out.trim(), '');

    const broken = gitTry(['diff', 'no-such-ref-xyz...HEAD'], { cwd: dir });
    assert.equal(broken.ok, false, 'git could not look');
    assert.ok(broken.err.length > 0);
  });
});

test('collectDiff errors when a VALID base still cannot be diffed', () => {
  // The root pattern, caught by sweeping rather than by the next review round:
  // validateTarget passes because the ref exists, but unrelated histories have
  // no merge base and `main...HEAD` exits 128. Reading that as an empty diff
  // turns an unreviewable target into a clean "no changes found" skip.
  withRepo((dir) => {
    run(dir, 'checkout', '-q', '--orphan', 'unrelated');
    writeFileSync(join(dir, 'b.txt'), 'orphan\n');
    run(dir, 'add', '.');
    run(dir, 'commit', '-qm', 'orphan commit');

    const target = parseTarget([], { cwd: dir, base: 'main' });
    assert.equal(validateTarget(target, { cwd: dir }).ok, true, 'the ref really does exist');

    const result = collectDiff(target, { cwd: dir });
    assert.ok(result.error, 'an undiffable range must report an error, not an empty diff');
    assert.match(result.error, /git could not read the range/);
  });
});

test('collectDiff reports no error on every healthy target', () => {
  withRepo((dir) => {
    for (const argv of [[], ['--uncommitted'], ['--commit', 'HEAD']]) {
      assert.equal(collectDiff(parseTarget(argv, { cwd: dir }), { cwd: dir }).error, null, JSON.stringify(argv));
    }
  });
});

// ── prompt ──────────────────────────────────────────────────────────────────

test('buildReviewPrompt carries the shared contract and the gate context', () => {
  const p = buildReviewPrompt({ scope: 'the diff', context: 'GATE SPECIFIC CLAUSE' });
  assert.match(p, /independent senior software reviewer/);
  assert.match(p, /Review the diff\./);
  assert.match(p, /GATE SPECIFIC CLAUSE/);
  assert.match(p, /\[P1\]=blocker/);
  assert.match(p, /APPROVE WITH COMMENTS/);
  assert.match(p, /Output only the review\./);
});

test('buildReviewPrompt omits an absent context clause without a blank line', () => {
  const p = buildReviewPrompt({ scope: 'the diff', context: '' });
  assert.doesNotMatch(p, /\n\n/);
});

// ── implementer guard ───────────────────────────────────────────────────────

test('classifyImplementer maps aliases and model names to families', () => {
  for (const v of ['claude', 'Claude', 'anthropic', 'opus', 'sonnet', 'claude-opus-4-8']) {
    assert.equal(classifyImplementer(v), 'claude', v);
  }
  assert.equal(classifyImplementer('codex'), 'codex');
  assert.equal(classifyImplementer('gpt-5'), 'codex');
  assert.equal(classifyImplementer('kimi'), 'kimi');
  assert.equal(classifyImplementer('glm-5.2'), 'glm');
  assert.equal(classifyImplementer('gemini'), 'gemini');
});

test('classifyImplementer returns null for anything it does not know', () => {
  for (const v of ['', '   ', 'llama', 'mistral', 'claud', 'typo']) {
    assert.equal(classifyImplementer(v), null, JSON.stringify(v));
  }
});

const guard = (over) => resolveGuard({ gateFamily: 'claude', env: {}, ...over });

test('guard blocks when the flag declares its own family', () => {
  const r = guard({ flagValue: 'claude' });
  assert.equal(r.run, false);
  assert.match(r.reason, /reviewing its own work/);
});

test('guard runs when the flag declares another family', () => {
  assert.equal(guard({ flagValue: 'codex' }).run, true);
});

test('guard fails closed on an unrecognised flag value', () => {
  // A typo must not silently defeat the guard.
  const r = guard({ flagValue: 'claudee' });
  assert.equal(r.run, false);
  assert.match(r.reason, /unrecognised --implementer/);
});

test('guard blocks on the live driver signal by default', () => {
  const r = guard({ env: { CLAUDECODE: '1' } });
  assert.equal(r.run, false);
  assert.match(r.reason, /CLAUDECODE/);
});

test('guard runs with no signal at all', () => {
  assert.equal(guard({}).run, true);
});

test('the explicit flag overrides the live driver signal', () => {
  // The relay case: Claude Code drives, another model implemented. Only a
  // per-invocation declaration may loosen the guard.
  assert.equal(guard({ flagValue: 'codex', env: { CLAUDECODE: '1' } }).run, true);
});

test('config can tighten the guard', () => {
  // Closes the named fail-open: a Claude implementer driven from Copilot/Cursor,
  // where CLAUDECODE is never set.
  const r = guard({ configValue: 'claude', env: {} });
  assert.equal(r.run, false);
  assert.match(r.reason, /config\.md declares the implementer as claude/);
});

test('config can NEVER loosen the guard', () => {
  // The pathology this design rejects twice: .afk/config.md is per-repo,
  // gitignored and written once, so a stale value must not outrank a live
  // per-run signal.
  const r = guard({ configValue: 'codex', env: { CLAUDECODE: '1' } });
  assert.equal(r.run, false, 'stale config must not unblock a live CLAUDECODE');
  assert.match(r.reason, /CLAUDECODE/);
});

test('an unrecognised config value fails closed', () => {
  const r = guard({ configValue: 'whatever', env: {} });
  assert.equal(r.run, false);
  assert.match(r.reason, /unrecognised implementer/);
});

test('the flag still wins over an unrecognised config value', () => {
  assert.equal(guard({ flagValue: 'codex', configValue: 'whatever' }).run, true);
});

test('a non-claude gate is not blocked by a claude driver', () => {
  const r = resolveGuard({ gateFamily: 'kimi', env: { CLAUDECODE: '1' } });
  assert.equal(r.run, true);
});

test('stripImplementer removes the flag AND its value', () => {
  // codex forwards argv to `codex exec review`, which has never heard of
  // --implementer. Leaving either token behind makes the gate unable to run at
  // all in exactly the relay setup the flag exists for.
  assert.deepEqual(stripImplementer(['--base', 'main', '--implementer', 'codex']), ['--base', 'main']);
  assert.deepEqual(stripImplementer(['--implementer', 'codex', '--base', 'main']), ['--base', 'main']);
  assert.deepEqual(stripImplementer(['--base', 'main']), ['--base', 'main']);
});

test('every gate family is guarded, not just claude', () => {
  // A gate that accepted --implementer and ignored it would send codex to review
  // codex's own work, silently. Each gate applies the guard with its own family.
  for (const family of ['codex', 'kimi', 'glm', 'claude']) {
    const own = resolveGuard({ gateFamily: family, flagValue: family, env: {} });
    assert.equal(own.run, false, `${family} must decline its own work`);
    const other = resolveGuard({ gateFamily: family, flagValue: family === 'codex' ? 'kimi' : 'codex', env: {} });
    assert.equal(other.run, true, `${family} must run for another implementer`);
  }
});

test('a valueless --implementer declines instead of permitting', () => {
  // `--implementer` as the last argument yielded '' and was read as "absent",
  // dropping through to the driver signal — so with no CLAUDECODE a caller
  // omission silently permitted the self-review the flag exists to prevent.
  const trailing = guardFor('claude', ['--base', 'main', '--implementer'], { env: {} });
  assert.equal(trailing.run, false);
  assert.match(trailing.reason, /no value/);

  const swallowed = guardFor('claude', ['--implementer', '--base', 'main'], { env: {} });
  assert.equal(swallowed.run, false, 'the next flag is not a value');
  assert.match(swallowed.reason, /no value/);
});

test('a properly valued --implementer still works', () => {
  assert.equal(guardFor('claude', ['--implementer', 'codex'], { env: {} }).run, true);
  assert.equal(guardFor('claude', ['--implementer', 'claude'], { env: {} }).run, false);
});

test('a filename git would quote survives the changed-file list', () => {
  // git quotes paths with special characters by default, so a '\n'-split yields
  // escaped non-paths. The reviewer is then pointed at files that do not exist
  // while the real new file — absent from the diff — goes unreviewed.
  withRepo((dir) => {
    // Non-ASCII is enough: core.quotepath defaults on, so git renders this as
    // "\303\274n\303\257code.txt" unless -z is used. (Quotes and newlines in a
    // name are the nastier case but are not legal on Windows.)
    const awkward = 'ünïcode file.txt';
    writeFileSync(join(dir, awkward), 'new\n');

    const target = parseTarget(['--uncommitted'], { cwd: dir });
    const { untracked } = collectDiff(target, { cwd: dir });

    assert.deepEqual(untracked, [awkward], 'the path must come back verbatim, unquoted and unfragmented');
  });
});

test('findAfkConfig does not use the parent of the git common dir', () => {
  // Under --separate-git-dir or in a submodule that parent is git metadata, not
  // a working tree, so a linked worktree would miss the main tree's config —
  // and that config can only TIGHTEN the guard, so losing it re-opens the
  // self-review it exists to close. skills/afk/SKILL.md mandates resolving the
  // main working tree from `git worktree list --porcelain`.
  const src = readFileSync(new URL('./implementer.mjs', import.meta.url), 'utf8');
  assert.match(src, /worktree list --porcelain|'worktree', 'list', '--porcelain'/);
  assert.doesNotMatch(src, /dirname\(commonDir\)/);
});

test('the main worktree config outranks a linked worktree copy', () => {
  // .afk/ has ONE canonical location. A stray per-run `implementer` left in some
  // linked worktree must not decide which gate runs.
  const src = readFileSync(new URL('./implementer.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function findAfkConfig'));
  const mainIdx = body.indexOf('main &&');
  const cwdIdx = body.indexOf('process.cwd()');
  assert.ok(mainIdx > -1 && cwdIdx > -1);
  assert.ok(mainIdx < cwdIdx, 'the main worktree must be probed before the cwd');
});
