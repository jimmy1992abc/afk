// Git access shared by every gate. Read-only by construction: nothing here
// mutates a repository.

import { spawnSync } from 'node:child_process';

export const RAW_DIFF_FLAGS = Object.freeze(['--no-ext-diff', '--no-textconv']);
export const GIT_COMMAND_TIMEOUT_MS = 30000;

export function runGit(args, { cwd, maxBuffer = 128 * 1024 * 1024, spawnImpl = spawnSync } = {}) {
  return spawnImpl('git', args, {
    encoding: 'utf8',
    maxBuffer,
    timeout: GIT_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    cwd,
  });
}

// Probe form: a failed call yields '' so a caller can treat "absent" and
// "empty" alike. Correct ONLY for probes whose failure is itself the answer
// (does this ref exist?).
//
// NEVER use this to fetch content a review depends on: it makes "git failed"
// indistinguishable from "git found nothing", which is how an unreviewable
// target becomes a clean "no changes found" skip. Use gitTry there.
export function git(args, options = {}) {
  const result = runGit(args, options);
  return !result.error && !result.signal && result.status === 0 ? (result.stdout || '') : '';
}

// Content form: reports whether git actually succeeded. An empty `out` with
// `ok: true` means git looked and found nothing; `ok: false` means git could
// not look, which a gate must never silently read as "nothing to review".
export function gitTry(args, options = {}) {
  const result = runGit(args, options);
  const ok = !result.error && !result.signal && result.status === 0;
  const reason = result.error?.code === 'ETIMEDOUT'
    ? `git timed out after ${GIT_COMMAND_TIMEOUT_MS}ms`
    : result.error ? `git spawn failed: ${result.error.message}`
      : result.signal ? `git terminated by ${result.signal}`
        : `git exited with status ${result.status}`;
  return {
    ok,
    out: result.stdout || '',
    err: (result.stderr || '').trim() || (ok ? '' : reason),
  };
}

export function lines(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

// Bare entries have no working files, so they cannot own shared run state.
// Returns '' when git cannot answer
// (not a repo, git absent) so a caller can fall back to the current directory.
//
// NOT dirname(git-common-dir): under `--separate-git-dir` or in a submodule that
// parent is git metadata, not a working tree. From a linked worktree that mistake
// resolves the wrong tree, and `.afk/` has one canonical home in the main tree.
export function mainWorktree({ cwd } = {}) {
  const out = git(['worktree', 'list', '--porcelain'], { cwd });
  const record = out.split(/\r?\n\r?\n/).find((block) => (
    /^worktree /m.test(block) && !/^bare\r?$/m.test(block)
  ));
  const first = record?.split('\n').find((l) => l.startsWith('worktree '));
  return first ? first.slice('worktree '.length).trim() : '';
}

export function hasRef(ref, options = {}) {
  const result = runGit(['rev-parse', '--verify', '--quiet', ref], options);
  return !result.error && !result.signal && result.status === 0;
}

// The repo's default branch, as a bare name.
export function detectBase({ cwd } = {}) {
  const remoteHead = git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd }).trim();
  if (remoteHead) return remoteHead.replace(/^origin\//, '');
  for (const branch of ['main', 'master']) {
    if (hasRef(branch, { cwd })) return branch;
  }
  return 'main';
}

// Promote a branch name to its remote-tracking ref when one exists. A stale
// local `main` otherwise makes a gate review the wrong commit range and report
// findings against commits that are not in the PR.
//
// Ask git what the ref IS, twice over, rather than reasoning about its name:
//   - a slash does not mean "already remote-qualified" (`release/stable` is an
//     ordinary local branch), and
//   - "origin/origin/main cannot exist" is an assumption, not a fact. Where it
//     does, prefixing would silently review the wrong range.
// So: if the base already resolves to a remote-tracking ref, leave it alone;
// otherwise promote it when origin has one.
export function resolveBase(rawBase, { cwd } = {}) {
  const full = git(['rev-parse', '--symbolic-full-name', rawBase], { cwd }).trim();
  if (full.startsWith('refs/remotes/')) return rawBase;
  return hasRef(`origin/${rawBase}`, { cwd }) ? `origin/${rawBase}` : rawBase;
}
