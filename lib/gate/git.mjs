// Git access shared by every gate. Read-only by construction: nothing here
// mutates a repository.

import { spawnSync } from 'node:child_process';

function run(args, cwd) {
  return spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
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
export function git(args, { cwd } = {}) {
  const result = run(args, cwd);
  return result.status === 0 ? (result.stdout || '') : '';
}

// Content form: reports whether git actually succeeded. An empty `out` with
// `ok: true` means git looked and found nothing; `ok: false` means git could
// not look, which a gate must never silently read as "nothing to review".
export function gitTry(args, { cwd } = {}) {
  const result = run(args, cwd);
  return {
    ok: result.status === 0,
    out: result.stdout || '',
    err: (result.stderr || '').trim(),
  };
}

export function lines(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

export function hasRef(ref, { cwd } = {}) {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd }).status === 0;
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
// Probe for the ref rather than inferring from the name: a slash does NOT mean
// "already remote-qualified" — `release/stable` is an ordinary local branch, and
// treating its slash as proof left exactly the staleness this exists to prevent.
// `origin/origin/main` and `origin/upstream/main` do not exist, so an
// already-qualified base falls through unchanged.
export function resolveBase(rawBase, { cwd } = {}) {
  return hasRef(`origin/${rawBase}`, { cwd }) ? `origin/${rawBase}` : rawBase;
}
