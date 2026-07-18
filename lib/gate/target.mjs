// The review target: what `--base` / `--commit` / `--uncommitted` select, the
// scope label that names it, and the diff that describes it.
//
// The scope label carries no instruction about HOW to inspect the target. That
// clause is transport-specific — a reviewer with read tools is told to go
// looking, a reviewer given a snapshot must not be — so each gate supplies its
// own. See the spec, "prompt.mjs holds only the transport-invariant part".

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { detectBase, git, gitTry, hasRef, resolveBase } from './git.mjs';

export function optVal(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

// Absolute path a design target resolves to. Both validateTarget and readDesign
// go through here so they check and load the SAME file.
function designPath(target, cwd) {
  return cwd ? resolve(cwd, target.path) : target.path;
}

// Precedence: --design (a different KIND of review, not a range) first, then
// --commit, --uncommitted, and finally a branch comparison. Matches the order
// every gate already applied, with design ahead of all diff selectors.
export function parseTarget(argv, { cwd, base: baseOverride } = {}) {
  const design = optVal(argv, '--design');
  if (design) {
    // A design target names a document, not a diff range. It carries no
    // `command`: it must never reach collectDiff, whose branch case would
    // otherwise diff `undefined...HEAD`.
    return {
      kind: 'design',
      path: design,
      label: `the design document at ${design}`,
    };
  }

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
  // The design kind owns its own existence check here — the SINGLE owner, so a
  // missing/unreadable doc yields one reason and one I/O. A typo'd --design path
  // must fail loudly (emitError, nonzero), never skip: skipping a diff gate means
  // declining to review one's own work (safe), but skipping here would mean no
  // independent review happened at all (unsafe).
  if (target.kind === 'design') {
    let stat;
    try {
      stat = statSync(designPath(target, cwd));
    } catch {
      return { ok: false, reason: `--design "${target.path}" does not exist or cannot be read.` };
    }
    if (!stat.isFile()) {
      return { ok: false, reason: `--design "${target.path}" is not a file.` };
    }
    return { ok: true };
  }

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
 * Load a design document's full text. Assumes a path already validated by
 * validateTarget (the sole owner of the existence check), so it only reads.
 * A design target never reaches collectDiff; this is its loader instead.
 */
export function readDesign(target, { cwd } = {}) {
  const path = designPath(target, cwd);
  return { text: readFileSync(path, 'utf8'), path };
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
