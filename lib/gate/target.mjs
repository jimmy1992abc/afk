// The review target: what `--base` / `--commit` / `--uncommitted` select, the
// scope label that names it, and the diff that describes it.
//
// The scope label carries no instruction about HOW to inspect the target. That
// clause is transport-specific — a reviewer with read tools is told to go
// looking, a reviewer given a snapshot must not be — so each gate supplies its
// own. See the spec, "prompt.mjs holds only the transport-invariant part".

import { detectBase, git, gitTry, hasRef, resolveBase } from './git.mjs';

export function optVal(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

// Precedence: --commit, then --uncommitted, then a branch comparison. Matches
// the order every gate already applied.
export function parseTarget(argv, { cwd, base: baseOverride } = {}) {
  const commit = optVal(argv, '--commit');
  if (commit) {
    return {
      kind: 'commit',
      commit,
      label: `the single commit ${commit}`,
      command: `git show ${commit}`,
    };
  }

  if (argv.includes('--uncommitted')) {
    return {
      kind: 'uncommitted',
      label: 'all uncommitted changes (staged, unstaged, and untracked)',
      command: 'git diff HEAD',
      // `git diff HEAD` shows tracked changes ONLY — a brand-new file produces
      // an entirely empty diff. A reviewer told to inspect just that command
      // would review a change consisting of new files as if it were empty, so a
      // reviewer holding tools gets the fuller instruction.
      inspect: 'git diff HEAD, git status, and git ls-files --others --exclude-standard (read each untracked file — they are absent from the diff)',
    };
  }

  const rawBase = baseOverride || optVal(argv, '--base') || detectBase({ cwd });
  const base = resolveBase(rawBase, { cwd });
  return {
    kind: 'branch',
    base,
    label: `the changes on the current branch versus ${base}`,
    command: `git diff ${base}...HEAD`,
  };
}

/**
 * Check that the target names something git can actually resolve.
 *
 * Without this, a bad ref is indistinguishable from a clean tree: `git()`
 * returns '' for a failed command, so `--commit does-not-exist` collapses to an
 * empty diff and the gate reports "no changes" — a targeting FAILURE recorded as
 * a benign skip, which is the wrong direction to fail in.
 */
export function validateTarget(target, { cwd } = {}) {
  // `^{commit}` peels to a commit or fails. Plain hasRef also accepts a blob or
  // tree expression (`HEAD:package.json`), whose `git show` output would then be
  // reviewed as if it were the requested diff.
  if (target.kind === 'commit' && !hasRef(`${target.commit}^{commit}`, { cwd })) {
    return { ok: false, reason: `--commit "${target.commit}" does not resolve to a commit in this repository.` };
  }
  if (target.kind === 'branch' && !hasRef(target.base, { cwd })) {
    return { ok: false, reason: `base "${target.base}" does not resolve to a ref in this repository.` };
  }
  return { ok: true };
}

/**
 * Collect the material a gate reviews.
 *
 * The diff itself is fetched with gitTry, not git: an unreviewable target must
 * surface as `error`, never as an empty diff. Every finding in this area came
 * from the same root confusion — an empty git result taken as proof of absence
 * — so the distinction is made once, here, rather than guarded per call site.
 * `validateTarget` is not sufficient on its own: a ref can exist and the diff
 * still fail (unrelated histories have no merge base, and `a...b` exits 128).
 */
export function collectDiff(target, { cwd } = {}) {
  // NUL-delimited: git quotes paths containing special characters by default,
  // and a filename may legally contain a newline. Splitting on '\n' yields
  // escaped or fragmented non-paths — which for the untracked list means the
  // reviewer is told to read files that do not exist, while the real new files
  // (absent from the diff) go unreviewed.
  const list = (text) => text.split('\0').filter(Boolean);
  const fail = (what, err) => ({
    diff: '', stat: '', changedFiles: [], untracked: [],
    error: `git could not read ${what}${err ? `: ${err}` : ''}`,
  });

  if (target.kind === 'commit') {
    const show = gitTry(['show', target.commit], { cwd });
    if (!show.ok) return fail(`commit ${target.commit}`, show.err);
    return {
      diff: show.out,
      stat: git(['show', '--stat', '--oneline', target.commit], { cwd }),
      changedFiles: list(git(['show', '--name-only', '-z', '--pretty=format:', target.commit], { cwd })),
      untracked: [],
      error: null,
    };
  }

  if (target.kind === 'uncommitted') {
    const diff = gitTry(['diff', 'HEAD'], { cwd });
    if (!diff.ok) return fail('the uncommitted changes', diff.err);
    const tracked = list(git(['diff', '--name-only', '-z', 'HEAD'], { cwd }));
    // Untracked files appear in NO diff. Returned separately so a gate whose
    // reviewer cannot run git can inject their contents itself.
    const untracked = list(git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd }));
    return {
      diff: diff.out,
      stat: git(['diff', '--stat', 'HEAD'], { cwd }),
      changedFiles: [...new Set([...tracked, ...untracked])],
      untracked,
      error: null,
    };
  }

  const range = `${target.base}...HEAD`;
  const diff = gitTry(['diff', range], { cwd });
  if (!diff.ok) return fail(`the range ${range}`, diff.err);
  return {
    diff: diff.out,
    stat: git(['diff', '--stat', range], { cwd }),
    changedFiles: list(git(['diff', '--name-only', '-z', range], { cwd })),
    untracked: [],
    error: null,
  };
}
