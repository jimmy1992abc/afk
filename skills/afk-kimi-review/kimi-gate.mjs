#!/usr/bin/env node
// kimi-gate.mjs — cross-platform Kimi Code CLI external review wrapper.
//
// Drives the Kimi Code CLI (`kimi`) headlessly via `kimi -p "<prompt>"` and
// prints ONLY Kimi's final review between markers (transcript -> log file).
// External review gate; run ONE gate per round, whose model differs from the
// implementer's.
//
// Kimi is a general agentic CLI with no built-in `review` subcommand, so this
// passes a review PROMPT and lets Kimi drive git itself. `-p` is headless on its
// own (kimi rejects combining it with -y/--auto).
//
// Read-only is asked for in the prompt, NOT enforced: kimi has no per-command
// permission surface here. That is weaker than afk-claude-review, whose reviewer
// loads no tool that can write. Prefer that gate where both qualify.
//
// Usage:
//   node kimi-gate.mjs                 # current branch vs default base
//   node kimi-gate.mjs --base master   # vs an explicit base
//   node kimi-gate.mjs --commit <sha>  # one commit
//   node kimi-gate.mjs --uncommitted   # staged/unstaged/untracked
//   node kimi-gate.mjs --design <path> # review a design doc (read the doc on disk, no argv payload)
//   node kimi-gate.mjs --print-args    # resolve and print the target; no model call
//
// Opt out with KIMI_REVIEW_GATE=off. Skips cleanly (exit 0) if kimi is missing
// or not logged in.

import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isGateDisabled } from '../../lib/gate/env.mjs';
import { guardFor } from '../../lib/gate/implementer.mjs';
import { buildDesignReviewPrompt, buildReviewPrompt } from '../../lib/gate/prompt.mjs';
import { createProtocol } from '../../lib/gate/protocol.mjs';
import { parseTarget, validateTarget } from '../../lib/gate/target.mjs';

const isWin = process.platform === 'win32';
const { emitSkip, emitReview, emitError } = createProtocol({ label: 'KIMI', slug: 'kimi-gate' });

if (isGateDisabled('KIMI_REVIEW_GATE')) {
  emitSkip('Kimi gate disabled via KIMI_REVIEW_GATE.');
}

const userArgs = process.argv.slice(2);
const printArgsOnly = userArgs.includes('--print-args');
// Prints the exact review prompt kimi would receive, and calls no model — the
// only way to observe that design mode swapped the diff context clause.
const printPromptOnly = userArgs.includes('--print-prompt');
const guard = guardFor('kimi', userArgs);
if (!guard.run) {
  emitSkip(`independence check — ${guard.reason}`);
}

const target = parseTarget(userArgs);
const valid = validateTarget(target);
if (!valid.ok) {
  emitError(`cannot review — ${valid.reason}`, 1);
}

// This gate's own context clause: kimi HAS tools, so it is told to go looking —
// the opposite of what glm must be told. See lib/gate/prompt.mjs.
//
// Design mode swaps the whole clause: the diff clause's `git show`/`git diff` is
// meaningless for a design, and pointing kimi at the doc ON DISK (rather than
// injecting its text) keeps a large doc off the argv — kimi passes its prompt as
// a `-p` argument, which a diff-sized doc would overflow on Windows.
let reviewPrompt;
if (target.kind === 'design') {
  const context = `Review the design document at ${target.path} in this git repository. Read it in full first. Use git and read surrounding files to check any claim the design makes about the code. Do NOT modify, stage, commit, write, or delete ANY file — review only.`;
  reviewPrompt = buildDesignReviewPrompt({ scope: target.label, context });
} else {
  const context = `Inspect the target with ${target.inspect || `\`${target.command}\``} in this git repository. Use git and read surrounding files for context. Do NOT modify, stage, commit, write, or delete ANY file — review only.`;
  reviewPrompt = buildReviewPrompt({ scope: target.label, context });
}

const kimi = (process.env.KIMI_GATE_BIN || 'kimi').trim();

if (printPromptOnly) {
  process.stdout.write(`${reviewPrompt}\n`);
  process.exit(0);
}

if (printArgsOnly) {
  process.stdout.write(`${JSON.stringify({
    bin: kimi,
    kind: target.kind,
    base: target.base ?? null,
    commit: target.commit ?? null,
    label: target.label,
    command: target.command ?? null,
    promptBytes: reviewPrompt.length,
  }, null, 2)}\n`);
  process.exit(0);
}

// Availability pre-check (local, no model call).
const ver = spawnSync(kimi, ['--version'], { encoding: 'utf8', shell: isWin });
if (ver.error && ver.error.code === 'ENOENT') {
  emitSkip('Kimi CLI not installed (run: npm i -g @moonshot-ai/kimi-code && kimi login).');
}

const work = mkdtempSync(join(tmpdir(), 'kimi-gate-'));
const logFile = join(work, 'kimi.log');

// No context-leaning for Kimi (intentional): thinking effort stays at its
// default (KIMI_MODEL_THINKING_EFFORT applies only when a synthesized provider
// is set), and project-doc injection is session-level, not per-turn.
process.stderr.write('[kimi-gate] kimi -p <structural review prompt>\n');
process.stderr.write(`[kimi-gate] transcript -> ${logFile}\n`);

const res = spawnSync(kimi, ['-p', reviewPrompt], {
  encoding: 'utf8',
  shell: isWin,
  maxBuffer: 64 * 1024 * 1024, // reviews can be long
});

const out = res.stdout || '';
const err = res.stderr || '';
try {
  const fd = openSync(logFile, 'w');
  writeSync(fd, `${out}\n----- stderr -----\n${err}`);
  closeSync(fd);
} catch {
  // The transcript is a convenience; losing it must not fail the review.
}

if (res.error && res.error.code === 'ENOENT') {
  emitSkip('Kimi CLI not installed (run: npm i -g @moonshot-ai/kimi-code && kimi login).');
}

const review = out.trim();

// Not authenticated -> clean skip. Requires an EMPTY review as well as the
// keyword, so a real review that merely mentions login/auth cannot be
// misread as an auth failure.
if (!review && /no model configured|use \/login|\bkimi login\b|not (logged in|authenticated)|unauthorized|please (log|sign) in/i.test(err)) {
  emitSkip('Kimi not authenticated — run `kimi login`, or set KIMI_REVIEW_GATE=off to disable this gate.');
}

if (!review) {
  // Previously this wrote to stderr and exited with NO marker block, leaving a
  // caller that parses stdout with silence to interpret. Every outcome is a
  // parseable block.
  emitError(`kimi produced no final message (exit ${res.status}). Transcript: ${logFile}`, res.status || 1);
}

emitReview(review);
// `?? 1`, never `?? 0`: a null status means kimi died on a signal, and a review
// that was killed must not exit clean.
process.exit(res.status ?? 1);
