// Unit tests for the shared gate lib.
//
// detectBase/resolveBase/collectDiff run against real temporary repositories,
// never a stub: they exist to interrogate git's actual behaviour, and a stubbed
// git would only assert that the test author and the implementation agree.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'node:test';

import { gateWorkDir } from './workdir.mjs';

import {
  DEFAULT_PREFLIGHT_TIMEOUT_MS,
  DEFAULT_KIMI_REVIEW_TIMEOUT_MS,
  DEFAULT_REVIEW_TIMEOUT_MS,
  isGateDisabled,
  isSpawnTimeout,
  positiveIntEnv,
  preflightTimeoutMs,
  reviewTimeoutMs,
} from './env.mjs';
import { detectBase, gitTry, hasRef, resolveBase } from './git.mjs';
import { classifyImplementer, guardFor, resolveGuard, stripImplementer } from './implementer.mjs';
import {
  isPinnedModelId, isVersionedModelId, sameModelLineage,
  sameVersionedModelLineage, verifyReviewerIdentity,
} from './model-identity.mjs';
import { buildDesignReviewPrompt, buildReviewPrompt } from './prompt.mjs';
import { collectDiff, optVal, parseTarget, readDesign, validateTarget } from './target.mjs';

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

test('positiveIntEnv reads a usable override', () => {
  assert.equal(positiveIntEnv('X', 7, { env: { X: '42' } }), 42);
  assert.equal(positiveIntEnv('X', 7, { env: { X: ' 42 ' } }), 42);
});

test('positiveIntEnv falls back to the bound, never to 0 or NaN', () => {
  // The values this rejects are exactly the ones that would disable the bound
  // they were set to enforce: a 0 or negative timeout waits forever, and NaN
  // reaches the same place through a different door.
  for (const v of ['0', '-1', 'abc', '1e3ms', '  ', '1.5']) {
    assert.equal(positiveIntEnv('X', 7, { env: { X: v } }), 7, JSON.stringify(v));
  }
  assert.equal(positiveIntEnv('X', 7, { env: {} }), 7);
});

test('positiveIntEnv announces a rejected value rather than dropping it', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.equal(positiveIntEnv('X', 7, { env: { X: 'abc' }, warn }), 7);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /X/);
  assert.match(warnings[0], /abc/);
  assert.match(warnings[0], /7/);
});

test('positiveIntEnv stays silent when there is nothing to report', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  positiveIntEnv('X', 7, { env: {}, warn });
  positiveIntEnv('X', 7, { env: { X: '42' }, warn });
  assert.deepEqual(warnings, []);
});

test('review timeout precedence is gate override, shared override, default', () => {
  assert.equal(reviewTimeoutMs('codex', { env: {} }), DEFAULT_REVIEW_TIMEOUT_MS);
  assert.equal(reviewTimeoutMs('kimi', { env: {} }), DEFAULT_KIMI_REVIEW_TIMEOUT_MS);
  assert.equal(reviewTimeoutMs('kimi', { env: { AFK_REVIEW_TIMEOUT_MS: '1200' } }), 1200);
  assert.equal(reviewTimeoutMs('kimi', {
    env: { AFK_REVIEW_TIMEOUT_MS: '1200', KIMI_REVIEW_TIMEOUT_MS: '3400' },
  }), 3400);
});

test('preflight timeout is capped and inherits a shorter review timeout', () => {
  assert.equal(preflightTimeoutMs(DEFAULT_REVIEW_TIMEOUT_MS), DEFAULT_PREFLIGHT_TIMEOUT_MS);
  assert.equal(preflightTimeoutMs(25), 25);
});

test('review timeouts reject values above the platform timer limit', () => {
  const warnings = [];
  const timeout = reviewTimeoutMs('glm', {
    env: { GLM_REVIEW_TIMEOUT_MS: '2147483648' },
    warn: (message) => warnings.push(message),
  });
  assert.equal(timeout, DEFAULT_REVIEW_TIMEOUT_MS);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /GLM_REVIEW_TIMEOUT_MS/);
});

test('spawn timeout detection does not confuse other process failures', () => {
  assert.equal(isSpawnTimeout({ error: { code: 'ETIMEDOUT' } }), true);
  assert.equal(isSpawnTimeout({ error: { code: 'ENOENT' }, status: null, signal: 'SIGTERM' }), false);
  assert.equal(isSpawnTimeout({ status: 1 }), false);
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
  assert.match(p, /P1 candidate/);
  assert.match(p, /scope anchor/i);
  assert.match(p, /never invent/i);
  assert.match(p, /contract mapping unavailable/i);
  assert.match(p, /trigger\/evidence/i);
  assert.match(p, /minimal causal fix/i);
  assert.match(p, /APPROVE WITH COMMENTS/);
  assert.match(p, /Output only the review\./);
});

test('buildReviewPrompt omits an absent context clause without a blank line', () => {
  const p = buildReviewPrompt({ scope: 'the diff', context: '' });
  assert.doesNotMatch(p, /\n\n/);
});

test('both prompt modes limit re-review and preserve evidence-based blockers', () => {
  for (const build of [buildReviewPrompt, buildDesignReviewPrompt]) {
    const prompt = build({ scope: 'THE_SCOPE', context: 'THE_CONTEXT' });
    assert.match(prompt, /Initial review is comprehensive/);
    assert.match(prompt, /accepted finding closure, the intervening diff, and affected regression paths/);
    assert.match(prompt, /new evidence.*distinct demonstrated consequence/s);
    assert.match(prompt, /newly demonstrated in-scope blocker/);
    assert.match(prompt, /missing prior review context.*unavailable/s);
    assert.match(prompt, /Do not propose speculative abstractions/);
  }
});

test('buildDesignReviewPrompt hunts omissions and framing, not file:line bugs', () => {
  const p = buildDesignReviewPrompt({ scope: 'the design document at spec.md', context: 'DESIGN CONTEXT CLAUSE' });

  // Shared with the diff brief: the read-only posture and the output rule.
  assert.match(p, /This is a read-only review\./, 'the read-only posture is shared');
  assert.match(p, /Output only the review\./, 'the OUTPUT clause is shared');
  assert.match(p, /Review the design document at spec\.md\./);
  assert.match(p, /DESIGN CONTEXT CLAUSE/);

  // A design doc has no meaningful line numbers: the locator must be a section
  // or a quoted claim, never file:line.
  assert.doesNotMatch(p, /file:line/, 'a design review must not ask for file:line');
  assert.match(p, /section|quote|quoted claim/i);

  // Design verdicts, not the code ones.
  assert.match(p, /SOUND WITH CONCERNS/);
  assert.match(p, /RETHINK/);
  assert.doesNotMatch(p, /APPROVE WITH COMMENTS|REQUEST CHANGES/);

  // Design ROLE/FOCUS, not the diff ones. The design lenses are present; the
  // code-bug focus and the diff role are absent.
  assert.doesNotMatch(p, /last structural gate before a pull request merges/, 'the diff ROLE must not leak in');
  assert.match(p, /assumption|omission|contradiction|unconsidered|gap/i, 'the design lenses are present');

  // Design severity phrasing, not the code-flavoured `[P1]=blocker`.
  assert.match(p, /\[P1 candidate\]/);
  assert.doesNotMatch(p, /\[P1\]=blocker/, 'severity is per-mode; the design meaning is not "blocker"');
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
  assert.equal(classifyImplementer('deepseek-v4-pro'), 'deepseek');
  assert.equal(classifyImplementer('mimo-v2.5-pro'), 'mimo');
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
  for (const family of ['codex', 'kimi', 'glm', 'claude', 'deepseek', 'mimo']) {
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
  // main working tree from `git worktree list --porcelain`. That resolver is
  // shared in git.mjs (mainWorktree); findAfkConfig consumes it.
  const gitSrc = readFileSync(new URL('./git.mjs', import.meta.url), 'utf8');
  assert.match(gitSrc, /worktree list --porcelain|'worktree', 'list', '--porcelain'/);
  const implSrc = readFileSync(new URL('./implementer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(implSrc, /dirname\(commonDir\)/);
  assert.match(implSrc, /mainWorktree/);
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

test('an already-qualified base survives a colliding nested origin ref', () => {
  // "origin/origin/main cannot exist" was an assumption, not a fact. Where the
  // collision does exist, blind prefixing reviews the wrong range entirely.
  withRepo((dir) => {
    run(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    run(dir, 'update-ref', 'refs/remotes/origin/origin/main', 'HEAD');
    assert.equal(hasRef('origin/origin/main', { cwd: dir }), true, 'precondition: the collision is real');

    assert.equal(resolveBase('origin/main', { cwd: dir }), 'origin/main');
  });
});

test('a bare base is still promoted when the collision exists', () => {
  withRepo((dir) => {
    run(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    run(dir, 'update-ref', 'refs/remotes/origin/origin/main', 'HEAD');
    assert.equal(resolveBase('main', { cwd: dir }), 'origin/main');
  });
});

test('a --commit target must peel to a commit, not a blob', () => {
  // `HEAD:file` is a valid object expression that hasRef accepts. Its `git show`
  // output would then be reviewed as if it were the requested diff.
  withRepo((dir) => {
    const blob = parseTarget(['--commit', 'HEAD:a.txt'], { cwd: dir });
    const v = validateTarget(blob, { cwd: dir });
    assert.equal(v.ok, false, 'a blob expression is not a review target');
    assert.match(v.reason, /does not resolve to a commit/);

    assert.equal(validateTarget(parseTarget(['--commit', 'HEAD'], { cwd: dir }), { cwd: dir }).ok, true);
  });
});

// ── design target ─────────────────────────────────────────────────────────────

function withDesignDoc(text, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-design-'));
  try {
    const path = join(dir, 'spec.md');
    writeFileSync(path, text);
    return fn(path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('parseTarget selects the design kind and never a diff selector', () => {
  withDesignDoc('# Spec\n', (path) => {
    const t = parseTarget(['--design', path]);
    assert.equal(t.kind, 'design');
    assert.equal(t.path, path);
    // The scope label names the doc and carries no inspection instruction.
    assert.match(t.label, /the design document at /);
    assert.doesNotMatch(t.label, /git |inspect|run /i);
    // A design target computes no diff range: it must never reach collectDiff.
    assert.equal(t.command, undefined);
  });
});

test('a valueless --design is a design target with no path, never a diff review', () => {
  // `--design` as the final argument: optVal returns null. It must NOT fall
  // through to a branch/diff target — that would let the lib gates review the PR
  // diff while the ledger records a clean design-stage gate with no design review.
  const trailing = parseTarget(['--base', 'main', '--design']);
  assert.equal(trailing.kind, 'design', 'presence of --design selects the design kind, value or not');
  const v = validateTarget(trailing, {});
  assert.equal(v.ok, false, 'a design target with no path must be rejected, loudly');
  assert.match(v.reason, /--design/);
});

test('--design takes precedence over every diff selector', () => {
  // A design review names a KIND, not a range; a stray --base/--commit beside it
  // must not silently turn it back into a diff review.
  withDesignDoc('# Spec\n', (path) => {
    const t = parseTarget(['--design', path, '--base', 'main', '--commit', 'abc123', '--uncommitted']);
    assert.equal(t.kind, 'design');
    assert.equal(t.path, path);
  });
});

test('validateTarget accepts a readable design doc', () => {
  withDesignDoc('# Spec\n', (path) => {
    assert.equal(validateTarget(parseTarget(['--design', path]), {}).ok, true);
  });
});

test('validateTarget rejects a missing design doc with a distinct reason', () => {
  // A typo'd --design path must fail loudly, not read as "nothing to review":
  // skipping here would mean no independent review happened at all.
  const missing = join(tmpdir(), 'no-such-design-doc-xyz.md');
  const v = validateTarget(parseTarget(['--design', missing]), {});
  assert.equal(v.ok, false);
  assert.match(v.reason, /--design/);
  assert.match(v.reason, /does not exist|cannot be read|not a file/i);
});

test('validateTarget rejects a design path that is a directory', () => {
  withDesignDoc('# Spec\n', (_path, dir) => {
    const v = validateTarget(parseTarget(['--design', dir]), {});
    assert.equal(v.ok, false, 'a directory is not a readable design doc');
    assert.match(v.reason, /--design/);
  });
});

// statSync sees metadata; it does not prove the CONTENTS can be read. A file
// whose bytes are denied (ACL) or locked would pass a stat-only check, then
// readDesign's readFileSync throws uncaught with no marker block. POSIX-only:
// Windows does not deny the owner read via chmod, and root ignores it.
const cannotDenyRead = process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);
test('validateTarget rejects a design doc it cannot read, not only a missing one', { skip: cannotDenyRead ? 'needs a non-root POSIX host' : false }, () => {
  withDesignDoc('# Secret\n', (path) => {
    chmodSync(path, 0o000);
    try {
      const v = validateTarget(parseTarget(['--design', path]), {});
      assert.equal(v.ok, false, 'an unreadable file must fail validation, not pass it');
      assert.match(v.reason, /--design/);
    } finally {
      chmodSync(path, 0o644);
    }
  });
});

test('readDesign returns an error instead of throwing when the read fails', () => {
  // validateTarget fast-fails the common missing/unreadable case, but a file can
  // change between that check and readDesign's separate read (TOCTOU). readDesign
  // must NOT throw — the failure has to route through the gate protocol
  // (ERROR + nonzero marker block), never crash the gate with no marker at all.
  // A directory is a stand-in for any path readFileSync cannot read.
  withDesignDoc('# Spec\n', (_path, dir) => {
    const doc = readDesign({ kind: 'design', path: dir });
    assert.ok(doc.error, 'a failed read must surface as an error field, not a throw');
    assert.match(doc.error, /--design/);
    assert.equal(doc.text, '');
  });
});

test('readDesign loads the full document text after validation', () => {
  const body = '# Title\n\nA load-bearing claim that must reach the reviewer verbatim.\n';
  withDesignDoc(body, (path) => {
    const { text, path: p } = readDesign(parseTarget(['--design', path]));
    assert.equal(text, body);
    assert.equal(p, path);
  });
});

test('collectDiff has no design branch — the design kind must be routed around it', () => {
  // The safety property Decision 2 rests on: a design target that leaked into
  // collectDiff would fall through to the branch case and diff `undefined...HEAD`.
  withDesignDoc('# Spec\n', (path) => {
    const t = parseTarget(['--design', path]);
    assert.equal(t.kind, 'design');
    // No `command` means no range; every gate takes its design branch before
    // ever calling collectDiff, which is asserted per-gate.
    assert.equal(t.command, undefined);
  });
});

// ── reviewer identity ───────────────────────────────────────────────────────
// A gate that validates only the model it ASKED for cannot notice a host that
// answered with another one.

test('isPinnedModelId accepts a full ID and refuses every alias', () => {
  for (const id of ['claude-opus-5', 'claude-haiku-4-5-20251001', 'claude-3-5-sonnet-20241022']) {
    assert.equal(isPinnedModelId(id), true, `${id} is a full ID`);
  }
  // An alias carries no generation, which is exactly what makes it resolvable
  // to a different one without notice.
  for (const alias of ['opus', 'sonnet', 'haiku', 'claude-opus-latest', 'default', '', undefined]) {
    assert.equal(isPinnedModelId(alias), false, `${alias} is not a pinned ID`);
  }
});

test('HTTP gate identities require a versioned request and only numeric snapshot suffixes', () => {
  assert.equal(isVersionedModelId('deepseek-v4-pro'), true);
  assert.equal(isVersionedModelId('mimo-v2.5-pro'), true);
  assert.equal(isVersionedModelId('deepseek'), false);
  assert.equal(sameVersionedModelLineage('deepseek-v4-pro', 'deepseek-v4-pro'), true);
  assert.equal(sameVersionedModelLineage('deepseek-v4-pro-20260802', 'deepseek-v4-pro'), true);
  assert.equal(sameVersionedModelLineage('deepseek-v4-pro-old', 'deepseek-v4-pro'), false);
  assert.equal(sameVersionedModelLineage('deepseek-v3-chat', 'deepseek'), false);
});

test('lineage matches in both directions but only at a segment boundary', () => {
  assert.equal(sameModelLineage('claude-opus-5', 'claude-opus-5'), true);
  assert.equal(sameModelLineage('claude-opus-5', 'claude-opus-5-20260115'), true);
  assert.equal(sameModelLineage('claude-opus-5-20260115', 'claude-opus-5'), true);
  assert.equal(sameModelLineage('claude-opus-5', 'claude-opus-50'), false);
  assert.equal(sameModelLineage('claude-opus-5', 'claude-opus-4-8'), false);
  assert.equal(sameModelLineage('claude-opus-5', ''), false);
});

test('verifyReviewerIdentity ignores auxiliary models and names the mismatch', () => {
  const ok = verifyReviewerIdentity(
    { 'claude-haiku-4-5-20251001': {}, 'claude-opus-5': {} },
    'claude-opus-5',
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.matched, 'claude-opus-5');

  const wrong = verifyReviewerIdentity({ 'claude-opus-4-8': {} }, 'claude-opus-5');
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'mismatch');
  assert.deepEqual(wrong.observed, ['claude-opus-4-8']);
});

test('verifyReviewerIdentity treats an absent usage map as unverifiable', () => {
  // Fail closed: no evidence of which model ran is not evidence that the right
  // one did.
  for (const usage of [undefined, null, {}, 'not-an-object', []]) {
    const v = verifyReviewerIdentity(usage, 'claude-opus-5');
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'unverifiable', `${JSON.stringify(usage)} cannot verify anything`);
  }
});

test('gateWorkDir returns an error instead of throwing', () => {
  // The failure mode this exists for: a stale TMPDIR made mkdtempSync throw at
  // module top level in three gates, and the process exited with a stack and no
  // marker block. A returned error is what lets each gate route it through its
  // own protocol — and what makes the message assertable without spawning one.
  const missing = join(tmpdir(), 'afk-no-such-temp-root-unit');
  const failed = gateWorkDir('probe-', { tmp: missing });
  assert.equal(failed.path, null);
  assert.match(failed.error, /cannot create this gate's working directory/);
  assert.match(failed.error, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // Both spellings: os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows,
  // so naming one tells half the operators to change a variable never read.
  assert.match(failed.error, /TMPDIR/);
  assert.match(failed.error, /TEMP\/TMP/);

  const ok = gateWorkDir('afk-workdir-probe-');
  assert.equal(ok.error, null);
  assert.ok(existsSync(ok.path));
  rmSync(ok.path, { recursive: true, force: true });
});

// Both guards are fail-closed control points that a spelling defeated: the
// equals form of a flag, and a flag supplied with no operand at all.

test('--implementer is read and stripped in both spellings', () => {
  // indexOf('--implementer') never matches --implementer=codex, so the guard
  // read the flag as absent and fell through to the driver assumption —
  // letting codex review codex's own work.
  for (const argv of [['--implementer', 'codex'], ['--implementer=codex']]) {
    const guard = guardFor('codex', argv, { env: {} });
    assert.equal(guard.run, false, `${argv.join(' ')} must decline a codex self-review`);
    assert.match(guard.reason, /codex/i);
    assert.deepEqual(stripImplementer(argv), [], `${argv.join(' ')} must be consumed`);
  }
});

test('a valueless --implementer still declines in either spelling', () => {
  for (const argv of [['--implementer'], ['--implementer='], ['--implementer', '--uncommitted']]) {
    const guard = guardFor('codex', argv, { env: {} });
    assert.equal(guard.run, false, argv.join(' '));
  }
});

test('--implementer is stripped without eating an unrelated following flag', () => {
  assert.deepEqual(
    stripImplementer(['--implementer=codex', '--uncommitted']),
    ['--uncommitted'],
  );
  assert.deepEqual(
    stripImplementer(['--implementer', 'codex', '--uncommitted']),
    ['--uncommitted'],
  );
});

test('a target flag with no operand is an error, never another target', () => {
  // --commit read through optVal yielded '' and fell through to branch mode:
  // a full review of a target nobody asked for, reported clean.
  const bare = parseTarget(['--commit']);
  assert.equal(bare.kind, 'error', JSON.stringify(bare));
  assert.match(bare.reason, /--commit/);

  const equals = parseTarget(['--commit=abc1234']);
  assert.equal(equals.kind, 'commit');
  assert.equal(equals.commit, 'abc1234');

  const spaced = parseTarget(['--commit', 'abc1234']);
  assert.equal(spaced.kind, 'commit');
  assert.equal(spaced.commit, 'abc1234');
});

test('a valueless --base stays absent, since detection supplies it', () => {
  // Deliberate and pinned elsewhere: --base narrows a target rather than
  // naming one, so its absence has a safe answer. --commit has none.
  const bare = parseTarget(['--base'], { cwd: process.cwd() });
  assert.notEqual(bare.kind, 'error');
});

test('an unparseable target fails validation rather than reaching a gate', () => {
  // parseTarget's error kind was a state validateTarget did not know, so it
  // reported valid and a gate ran with no command at all.
  const target = parseTarget(['--commit']);
  const valid = validateTarget(target, { cwd: process.cwd() });
  assert.equal(valid.ok, false);
  assert.match(valid.reason, /--commit/);
});

test('a duplicate declaration declines rather than picking one', () => {
  // readOption once preferred the equals form regardless of position, so a
  // wrapper appending --implementer=claude overruled a caller's codex.
  const guard = guardFor('claude', ['--implementer', 'codex', '--implementer=claude'], { env: {} });
  assert.equal(guard.run, false);
  assert.match(guard.reason, /more than once/);
});

test('--design is read in both spellings and duplicates are refused', () => {
  assert.equal(parseTarget(['--design=spec.md']).kind, 'design');
  assert.equal(parseTarget(['--design=spec.md']).path, 'spec.md');
  assert.equal(parseTarget(['--design', 'spec.md']).path, 'spec.md');
  // A valueless --design stays a design target with no path, which
  // validateTarget then fails loudly — never a fall-through to a branch.
  assert.equal(parseTarget(['--design=']).kind, 'design');
  const dup = parseTarget(['--design', 'a.md', '--design=b.md']);
  assert.equal(dup.kind, 'error');
  assert.match(dup.reason, /more than once/);
});

test('a parse error outranks an independence skip on every diff gate', () => {
  // The guard ran first, so `--commit --implementer claude` on the claude gate
  // exited 0 with a skip and the named caller error never surfaced.
  for (const gate of ['claude-gate', 'kimi-gate']) {
    const family = gate.split('-')[0];
    const source = readFileSync(
      new URL(`../../skills/afk-${family}-review/${gate}.mjs`, import.meta.url),
      'utf8',
    );
    assert.match(source, /isDesign \|\| target\.kind === 'error'/, gate);
  }
  const codex = readFileSync(
    new URL('../../skills/afk-codex-review/codex-gate.mjs', import.meta.url),
    'utf8',
  );
  assert.match(codex, /parsedTarget\.kind === 'error' \|\| isDesign/);
  // and the wrapper reads --design through the shared reader, not its own rule
  assert.doesNotMatch(codex, /userArgs\.includes\('--design'\)/);
});

test('every gate validates a parse error before it can skip', () => {
  // The CLI gates were routed first; the snapshot gate kept validating after
  // its disabled and independence skips, so `--commit --implementer glm`
  // exited 0 and the named caller error never surfaced.
  const snapshot = readFileSync(
    new URL('./openai-snapshot-gate.mjs', import.meta.url),
    'utf8',
  );
  const errorAt = snapshot.indexOf("target.kind === 'error'");
  const guardAt = snapshot.indexOf('guardFor(');
  const disabledAt = snapshot.indexOf('isGateDisabled(');
  assert.ok(errorAt > 0, 'the snapshot gate must handle the error kind');
  assert.ok(errorAt < guardAt && errorAt < disabledAt, 'it must precede every skip path');
});

test('the codex wrapper treats both spellings as a supplied target', () => {
  // Only bare tokens counted, so --commit=HEAD looked target-less and the
  // default --base was injected beside it: two conflicting selectors.
  const codex = readFileSync(
    new URL('../../skills/afk-codex-review/codex-gate.mjs', import.meta.url),
    'utf8',
  );
  assert.match(codex, /a === flag \|\| a\.startsWith\(`\$\{flag\}=`\)/);
  assert.match(codex, /--base=\$\{resolveBase\(/);
  // and an ambiguity error outranks the synthesized design target
  assert.match(codex, /parsedTarget\.kind === 'error' \? parsedTarget : designTarget/);
});

test('a valueless target flag is caught before any target is selected', () => {
  // --design returned early, so `--design x --commit` handed back the design
  // and the malformed flag was never seen.
  const mixed = parseTarget(['--design', 'spec.md', '--commit']);
  assert.equal(mixed.kind, 'error', JSON.stringify(mixed));
  assert.match(mixed.reason, /--commit/);
});

test('a disabled gate still surfaces an unparseable target', () => {
  // The check added for this was placed after the disabled exit, making it
  // unreachable in exactly the configuration that most needs to say why.
  for (const [family, file] of [
    ['claude', 'claude-gate'], ['kimi', 'kimi-gate'], ['codex', 'codex-gate'],
  ]) {
    const source = readFileSync(
      new URL(`../../skills/afk-${family}-review/${file}.mjs`, import.meta.url),
      'utf8',
    );
    const earlyAt = source.indexOf('const early = parseTarget(receiptArgs)');
    // A valueless --design is the same class of caller error and was masked by
    // the disabled exit while a malformed --commit was surfaced.
    assert.match(source, /early\.kind === 'error' \|\| early\.kind === 'design'/, file);
    const disabledAt = source.indexOf('if (isGateDisabled(');
    assert.ok(earlyAt > 0, `${file} must check the target before it can skip`);
    assert.ok(disabledAt > 0, `${file} must still have a disabled exit`);
    assert.ok(
      earlyAt < disabledAt,
      `${file}: the target check must precede the disabled exit`,
    );
  }
});
