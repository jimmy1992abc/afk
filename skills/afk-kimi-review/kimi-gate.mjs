#!/usr/bin/env node
// kimi-gate.mjs — cross-platform Kimi Code CLI external review wrapper.
//
// Mirrors codex-gate.mjs, drives the Kimi Code CLI (`kimi`). Runs a READ-ONLY
// structural review of a branch/commit diff headlessly via `kimi -p "<prompt>"`
// and prints ONLY Kimi's final review between markers (transcript -> log file).
//
// External review gate, interchangeable with codex-gate.mjs. Run ONE gate per
// round; the gate model must differ from the implementer's (never self-review)
// and be a current-generation mainstream frontier model.
//
// Kimi is a general agentic CLI (no built-in `review` subcommand): passes a
// structured review PROMPT via `-p` and lets Kimi run git itself to read the
// diff. `-p` is headless on its own (kimi rejects combining it with
// -y/--auto). Prompt enforces READ-ONLY.
//
// Usage (target flags mirror codex-gate for a familiar interface):
//   node kimi-gate.mjs                 # review current branch vs default base
//   node kimi-gate.mjs --base master   # review vs an explicit base branch
//   node kimi-gate.mjs --commit <sha>  # review one commit
//   node kimi-gate.mjs --uncommitted   # review staged/unstaged/untracked
//
// Opt out with KIMI_REVIEW_GATE=off. Exit code mirrors kimi; skips cleanly (exit 0)
// if kimi is missing or not logged in.

import { spawnSync } from 'node:child_process';
import { openSync, writeSync, closeSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const isWin = process.platform === 'win32';

function emitSkip(reason) {
  // Not a failure — the gate is optional. Emit the marker block, exit 0.
  process.stderr.write(`[kimi-gate] skipped: ${reason}\n`);
  process.stdout.write('===== KIMI REVIEW (final message) =====\n');
  process.stdout.write(`SKIPPED: ${reason}\n`);
  process.stdout.write('===== END KIMI REVIEW =====\n');
  process.exit(0);
}

// Explicit opt-out — set KIMI_REVIEW_GATE to off/0/false/no/disabled.
const gateFlag = (process.env.KIMI_REVIEW_GATE || '').trim().toLowerCase();
if (['off', '0', 'false', 'no', 'disabled'].includes(gateFlag)) {
  emitSkip('Kimi gate disabled via KIMI_REVIEW_GATE.');
}

function detectBase() {
  // origin/HEAD -> the repo's default branch (main/master/...); fall back sanely.
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, '');
  for (const b of ['main', 'master']) {
    const v = spawnSync('git', ['rev-parse', '--verify', b], { encoding: 'utf8' });
    if (v.status === 0) return b;
  }
  return 'main';
}

// --- Resolve the review target (mirror codex-gate's selector semantics) ---
const userArgs = process.argv.slice(2);
function optVal(name) {
  const i = userArgs.indexOf(name);
  return i >= 0 && i + 1 < userArgs.length ? userArgs[i + 1] : null;
}
const commitArg = optVal('--commit');
const uncommitted = userArgs.includes('--uncommitted');
const baseArg = optVal('--base');

let scope;
if (commitArg) {
  scope = `the single commit \`${commitArg}\` (inspect with \`git show ${commitArg}\`)`;
} else if (uncommitted) {
  scope = 'all uncommitted changes — staged, unstaged, and untracked (`git diff HEAD`, `git status`, and untracked files)';
} else {
  const base = baseArg || detectBase();
  scope = `the changes on the current branch versus \`${base}\` (inspect with \`git diff ${base}...HEAD\`)`;
}

const reviewPrompt = [
  'You are an independent senior reviewer running the LAST structural gate before a PR merges. This is a READ-ONLY review.',
  `Review ${scope} in this git repository.`,
  'Use git and read surrounding files for context. Do NOT modify, stage, commit, write, or delete ANY file — review only.',
  'Focus on STRUCTURAL issues: architecture/design, correctness bugs, security loopholes, missed edge cases, concurrency/data-integrity, breaking changes. Ignore pure nitpicks (naming, formatting, comments).',
  'For each finding output: a severity tag [P1]=blocker / [P2] / [minor], the file:line, the problem, and a concrete fix.',
  'Finish with a one-line overall verdict (e.g. APPROVE / APPROVE WITH COMMENTS / REQUEST CHANGES). If nothing structural is wrong, say so plainly.',
  'Output ONLY the review — no preamble, no restating the task.',
].join('\n');

const kimi = 'kimi';

// Availability pre-check (local, no model call).
const ver = spawnSync(kimi, ['--version'], { encoding: 'utf8', shell: isWin });
if (ver.error && ver.error.code === 'ENOENT') {
  emitSkip('Kimi CLI not installed (run: npm i -g @moonshot-ai/kimi-code && kimi login).');
}

const work = mkdtempSync(join(tmpdir(), 'kimi-gate-'));
const logFile = join(work, 'kimi.log');

// `-p` runs one prompt non-interactively and prints the response; headless on
// its own (kimi rejects combining `-p` with -y/--auto/--yolo).
const args = ['-p', reviewPrompt];

// No context-leaning for Kimi (intentional):
//   - Thinking effort stays at Kimi's default (KIMI_MODEL_THINKING_EFFORT only
//     applies when KIMI_MODEL_NAME / a synthesized provider is set).
//   - Project-doc injection is left as-is (session-level, not per-turn).
process.stderr.write('[kimi-gate] kimi -p <structural review prompt>\n');
process.stderr.write(`[kimi-gate] transcript -> ${logFile}\n`);

const res = spawnSync(kimi, args, {
  encoding: 'utf8',
  shell: isWin,
  maxBuffer: 64 * 1024 * 1024, // reviews can be long
});

const out = res.stdout || '';
const err = res.stderr || '';
try {
  const fd = openSync(logFile, 'w');
  writeSync(fd, out + '\n----- stderr -----\n' + err);
  closeSync(fd);
} catch {}

if (res.error && res.error.code === 'ENOENT') {
  emitSkip('Kimi CLI not installed (run: npm i -g @moonshot-ai/kimi-code && kimi login).');
}

const review = out.trim();

// Not authenticated → clean skip. Match on `err` + require an empty `review`
// (not just a keyword) to avoid a false-positive SKIP on a real review that
// merely mentions login/auth/unauthorized.
if (!review && /no model configured|use \/login|\bkimi login\b|not (logged in|authenticated)|unauthorized|please (log|sign) in/i.test(err)) {
  emitSkip('Kimi not authenticated — run `kimi login`, or set KIMI_REVIEW_GATE=off to disable this gate.');
}

if (review) {
  process.stdout.write('===== KIMI REVIEW (final message) =====\n');
  process.stdout.write(review + '\n');
  process.stdout.write('===== END KIMI REVIEW =====\n');
} else {
  process.stderr.write(`[kimi-gate] No review produced (exit ${res.status}). See ${logFile}\n`);
}

process.exit(res.status ?? 1);
