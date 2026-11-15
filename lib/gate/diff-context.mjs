// Working-tree notes for a CLI reviewer that receives a pre-injected diff and
// can read files itself. Shared by the gates whose reviewer holds read tools
// (claude, gemini); a snapshot-only gate has nothing to read and never uses it.

import { git } from './git.mjs';

// The read tools see the working tree as it is NOW, which is not necessarily the
// revision the diff describes: `--commit <old-sha>` reviews history, and a
// branch review may run over a dirty tree. Saying so is the honest fix — a
// reviewer told its context is authoritative will reason about the wrong
// revision and never know.
const DRIFT_CAUTION = 'CAUTION: the files you can Read are the CURRENT working tree, which is not the revision this diff describes — a file may have changed since, or carry uncommitted edits. The diff is authoritative for what changed; treat file contents as background only, and say so if a judgement depends on the difference.';

export function workingTreeMayDrift(target, run = git) {
  return target.kind === 'commit'
    ? run(['rev-parse', target.commit]).trim() !== run(['rev-parse', 'HEAD']).trim()
    : Boolean(run(['status', '--porcelain']).trim());
}

// Untracked files appear in NO diff (`git diff HEAD` is empty for a brand-new
// file) and a reviewer without git cannot discover them. Without this list an
// all-new-files change reaches the reviewer as an empty diff and can be
// approved having inspected nothing. JSON-encoded, one per line: a filename may
// legally contain a newline, and interpolating it raw would split one path
// across two bullets.
export function untrackedNotice(untracked) {
  return untracked.length
    ? `IMPORTANT: ${untracked.length} file(s) in this change are new and are NOT in the diff below. The diff alone therefore does not show the whole change. Read each one before judging it (paths are JSON-encoded):\n${untracked.map((f) => `- ${JSON.stringify(f)}`).join('\n')}`
    : '';
}

export function workingTreeNotes({ target, untracked = [], run = git }) {
  return [workingTreeMayDrift(target, run) ? DRIFT_CAUTION : '', untrackedNotice(untracked)];
}
