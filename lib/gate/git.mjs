// Git access shared by every gate. Read-only by construction: nothing here
// mutates a repository.

import { spawnSync } from 'node:child_process';

// A failed git call yields '' rather than throwing: every caller treats "no
// output" and "command failed" identically (an absent ref, an empty diff), and
// a gate must never die on a probe.
export function git(args, { cwd } = {}) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    cwd,
  });
  return result.status === 0 ? (result.stdout || '') : '';
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
