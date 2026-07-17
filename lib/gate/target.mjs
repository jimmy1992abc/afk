// The review target: what `--base` / `--commit` / `--uncommitted` select, the
// scope label that names it, and the diff that describes it.
//
// The scope label carries no instruction about HOW to inspect the target. That
// clause is transport-specific — a reviewer with read tools is told to go
// looking, a reviewer given a snapshot must not be — so each gate supplies its
// own. See the spec, "prompt.mjs holds only the transport-invariant part".

import { detectBase, git, hasRef, resolveBase } from './git.mjs';

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
  if (target.kind === 'commit' && !hasRef(target.commit, { cwd })) {
    return { ok: false, reason: `--commit "${target.commit}" does not resolve to a commit in this repository.` };
  }
  if (target.kind === 'branch' && !hasRef(target.base, { cwd })) {
    return { ok: false, reason: `base "${target.base}" does not resolve to a ref in this repository.` };
  }
  return { ok: true };
}

export function collectDiff(target, { cwd } = {}) {
  const list = (text) => text.split('\n').filter(Boolean);

  if (target.kind === 'commit') {
    return {
      diff: git(['show', target.commit], { cwd }),
      stat: git(['show', '--stat', '--oneline', target.commit], { cwd }),
      changedFiles: list(git(['show', '--name-only', '--pretty=format:', target.commit], { cwd })),
      untracked: [],
    };
  }

  if (target.kind === 'uncommitted') {
    const tracked = list(git(['diff', '--name-only', 'HEAD'], { cwd }));
    // Untracked files appear in NO diff. Returned separately so a gate whose
    // reviewer cannot run git can inject their contents itself.
    const untracked = list(git(['ls-files', '--others', '--exclude-standard'], { cwd }));
    return {
      diff: git(['diff', 'HEAD'], { cwd }),
      stat: git(['diff', '--stat', 'HEAD'], { cwd }),
      changedFiles: [...new Set([...tracked, ...untracked])],
      untracked,
    };
  }

  const range = `${target.base}...HEAD`;
  return {
    diff: git(['diff', range], { cwd }),
    stat: git(['diff', '--stat', range], { cwd }),
    changedFiles: list(git(['diff', '--name-only', range], { cwd })),
    untracked: [],
  };
}
