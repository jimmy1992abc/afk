// The review target: what `--base` / `--commit` / `--uncommitted` select, the
// scope label that names it, and the diff that describes it.
//
// The scope label carries no instruction about HOW to inspect the target. That
// clause is transport-specific — a reviewer with read tools is told to go
// looking, a reviewer given a snapshot must not be — so each gate supplies its
// own. See the spec, "prompt.mjs holds only the transport-invariant part".

import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { detectBase, git, gitTry, hasRef, RAW_DIFF_FLAGS, resolveBase } from './git.mjs';

// One reader for both spellings a caller may use. Scanning for the bare token
// alone missed `--flag=value` entirely, which is how a declaration a guard
// depends on read as absent.
export function readOption(args, name) {
  const list = Array.isArray(args) ? args : [];
  const hits = [];
  for (let i = 0; i < list.length; i++) {
    const arg = typeof list[i] === 'string' ? list[i] : '';
    if (arg === name) {
      const next = i + 1 < list.length ? list[i + 1] : undefined;
      // A following flag is the next option, not this one's operand.
      hits.push(next !== undefined && !String(next).startsWith('--') ? String(next) : '');
    } else if (arg.startsWith(`${name}=`)) {
      hits.push(arg.slice(name.length + 1));
    }
  }
  if (hits.length === 0) return { supplied: false, value: '', duplicate: false };
  // First in argv order wins, and a second occurrence is reported rather than
  // silently resolved: a wrapper appending a declaration must not overrule the
  // one already there, which is how a guard gets talked past.
  return { supplied: true, value: hits[0], duplicate: hits.length > 1 };
}

export function optVal(args, name) {
  const read = readOption(args, name);
  return read.supplied && read.value ? read.value : null;
}

export function literalPath(path) {
  return `:(top,literal)${path}`;
}

export function parseNameStatusZ(text) {
  const tokens = String(text).split('\0');
  const entries = [];
  let index = 0;
  while (index < tokens.length && tokens[index]) {
    const status = tokens[index++];
    if (/^[RC]/.test(status)) {
      const oldPath = tokens[index++];
      const path = tokens[index++];
      if (oldPath && path) entries.push({ status, oldPath, path });
    } else {
      const path = tokens[index++];
      if (path) entries.push({ status, oldPath: null, path });
    }
  }
  return entries;
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
  // Detect PRESENCE, not just a value: a valueless `--design` (the flag as the
  // final argument) must still select the design kind. Reading the value with
  // optVal alone would return null and fall through to a diff selector — the lib
  // gates would then review the PR diff while the ledger records a clean
  // design-stage gate with no design reviewed. A present-but-valueless `--design`
  // is operator error validateTarget rejects loudly.
  const designFlag = readOption(argv, '--design');
  const commitDup = readOption(argv, '--commit');
  for (const [flag, read] of [['--design', designFlag], ['--commit', commitDup]]) {
    if (read.duplicate) {
      return {
        kind: 'error',
        reason: `${flag} was supplied more than once; refusing to guess which target was meant.`,
        label: `an ambiguous target (${flag} given twice)`,
      };
    }
  }
  // A target-naming flag with no operand is an error wherever it appears, so it
  // is checked before any target is selected — otherwise `--design x --commit`
  // returns the design and the malformed flag is never seen. `--base` is not
  // included: it narrows the branch target rather than naming one, and is
  // deliberately absent-when-valueless so detection supplies it.
  if (commitDup.supplied && !commitDup.value) {
    return {
      kind: 'error',
      reason: '--commit was supplied with no value; refusing to review a target that was not named.',
      label: 'an unnamed target (--commit had no value)',
    };
  }
  if (designFlag.supplied) {
    const design = designFlag.value || null;
    // A design target names a document, not a diff range. It carries no
    // `command`: it must never reach collectDiff, whose branch case would
    // otherwise diff `undefined...HEAD`.
    return {
      kind: 'design',
      path: design,
      label: design ? `the design document at ${design}` : 'a design document (no --design path given)',
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
  // A target that could not be parsed is invalid here, not merely unusual: the
  // caller's next step is a guard or an invocation, and an unhandled kind would
  // reach a gate with no command and let it return a verdict about nothing.
  if (target.kind === 'error') {
    return { ok: false, reason: target.reason || 'the review target could not be parsed.' };
  }
  // The design kind owns its own existence check here — the SINGLE owner, so a
  // missing/unreadable doc yields one reason and one I/O. A typo'd --design path
  // must fail loudly (emitError, nonzero), never skip: skipping a diff gate means
  // declining to review one's own work (safe), but skipping here would mean no
  // independent review happened at all (unsafe).
  if (target.kind === 'design') {
    if (!target.path) {
      return { ok: false, reason: '--design requires a path to a design document.' };
    }
    // Open for reading, not statSync: metadata being visible does not prove the
    // CONTENTS can be read (an ACL-denied or locked file passes a stat check,
    // then readDesign's readFileSync throws uncaught with no marker block). One
    // open verifies existence AND readability; fstat on the handle rejects a
    // directory. readDesign then does the full read of a path proven readable
    // here — validateTarget stays the single owner of the check.
    let fd;
    try {
      fd = openSync(designPath(target, cwd), 'r');
    } catch {
      return { ok: false, reason: `--design "${target.path}" does not exist or cannot be read.` };
    }
    try {
      if (!fstatSync(fd).isFile()) {
        return { ok: false, reason: `--design "${target.path}" is not a file.` };
      }
    } finally {
      closeSync(fd);
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
 * Load a design document's full text. validateTarget fast-fails the common
 * missing/unreadable case first, but a file can change between that check and
 * this separate read (TOCTOU). So the read failure is RETURNED, never thrown:
 * the gate routes `error` through the protocol (ERROR + nonzero marker block)
 * instead of dying with no marker at all. A design target never reaches
 * collectDiff; this is its loader instead.
 */
export function readDesign(target, { cwd } = {}) {
  const path = designPath(target, cwd);
  try {
    return { text: readFileSync(path, 'utf8'), path, error: null };
  } catch (e) {
    return { text: '', path, error: `--design "${target.path}" could not be read (${e.code || e.message}).` };
  }
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
export function collectDiff(target, { cwd, detectCopiesHarder = false } = {}) {
  // NUL-delimited: git quotes paths containing special characters by default,
  // and a filename may legally contain a newline. Splitting on '\n' yields
  // escaped or fragmented non-paths — which for the untracked list means the
  // reviewer is told to read files that do not exist, while the real new files
  // (absent from the diff) go unreviewed.
  const list = (text) => text.split('\0').filter(Boolean);
  const fail = (what, err) => ({
    diff: '', stat: '', changedFiles: [], untracked: [], entries: [],
    error: `git could not read ${what}${err ? `: ${err}` : ''}`,
  });
  const copyDetection = detectCopiesHarder ? ['--find-copies-harder'] : [];

  if (target.kind === 'commit') {
    const parents = gitTry(['rev-list', '--parents', '-n', '1', target.commit], { cwd });
    if (!parents.ok) return fail(`commit ${target.commit}`, parents.err);
    if (parents.out.trim().split(/\s+/).length > 2) {
      return fail(`merge commit ${target.commit}`, 'select a parent-relative branch range instead');
    }
    const show = gitTry(['show', ...RAW_DIFF_FLAGS, '--no-relative', target.commit], { cwd });
    if (!show.ok) return fail(`commit ${target.commit}`, show.err);
    const names = gitTry([
      'diff-tree', ...RAW_DIFF_FLAGS, '--root', '--no-commit-id', '-r', '-z', '-M', '-C',
      ...copyDetection, '--no-relative', '--name-status', target.commit,
    ], { cwd });
    if (!names.ok) return fail(`commit ${target.commit}`, names.err);
    return {
      diff: show.out,
      stat: git(['show', ...RAW_DIFF_FLAGS, '--no-relative', '--stat', '--oneline', target.commit], { cwd }),
      changedFiles: list(git(['show', ...RAW_DIFF_FLAGS, '--no-relative', '--name-only', '-z', '--pretty=format:', target.commit], { cwd })),
      untracked: [],
      entries: parseNameStatusZ(names.out),
      error: null,
    };
  }

  if (target.kind === 'uncommitted') {
    const diff = gitTry(['diff', ...RAW_DIFF_FLAGS, '--no-relative', 'HEAD'], { cwd });
    if (!diff.ok) return fail('the uncommitted changes', diff.err);
    const tracked = list(git(['diff', ...RAW_DIFF_FLAGS, '--no-relative', '--name-only', '-z', 'HEAD'], { cwd }));
    // Untracked files appear in NO diff. Returned separately so a gate whose
    // reviewer cannot run git can inject their contents itself.
    const untracked = list(git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd }));
    const names = gitTry([
      'diff', ...RAW_DIFF_FLAGS, '--no-relative', '--name-status', '-z', '-M', '-C', ...copyDetection, 'HEAD',
    ], { cwd });
    if (!names.ok) return fail('the uncommitted changes', names.err);
    return {
      diff: diff.out,
      stat: git(['diff', ...RAW_DIFF_FLAGS, '--no-relative', '--stat', 'HEAD'], { cwd }),
      changedFiles: [...new Set([...tracked, ...untracked])],
      untracked,
      entries: [
        ...parseNameStatusZ(names.out),
        ...untracked.map((path) => ({ status: '?', oldPath: null, path })),
      ],
      error: null,
    };
  }

  const range = `${target.base}...HEAD`;
  const diff = gitTry(['diff', ...RAW_DIFF_FLAGS, '--no-relative', range], { cwd });
  if (!diff.ok) return fail(`the range ${range}`, diff.err);
  const names = gitTry([
    'diff', ...RAW_DIFF_FLAGS, '--no-relative', '--name-status', '-z', '-M', '-C', ...copyDetection, range,
  ], { cwd });
  if (!names.ok) return fail(`the range ${range}`, names.err);
  return {
    diff: diff.out,
    stat: git(['diff', ...RAW_DIFF_FLAGS, '--no-relative', '--stat', range], { cwd }),
    changedFiles: list(git(['diff', ...RAW_DIFF_FLAGS, '--no-relative', '--name-only', '-z', range], { cwd })),
    untracked: [],
    entries: parseNameStatusZ(names.out),
    error: null,
  };
}
