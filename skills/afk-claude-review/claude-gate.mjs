#!/usr/bin/env node
// claude-gate.mjs — cross-platform external review wrapper around the Claude Code CLI.
//
// Runs a READ-ONLY structural review of a branch/commit/uncommitted diff via
// `claude -p` and prints ONLY the final review between markers (transcript ->
// log file). External review gate, interchangeable with the other afk gates.
//
// Read-only by construction: the reviewer session loads `Read,Grep,Glob` and
// nothing else. It has no shell, so there is no command allowlist to maintain
// and no flag surface to get wrong. The gate therefore pre-injects the diff the
// reviewer cannot fetch itself, and the reviewer uses its read tools for
// anything the diff does not answer. See the design spec, Decision 6 — an
// allowlisted `Bash(git …)` was tried and broken twice.
//
// Usage:
//   node claude-gate.mjs                      # current branch vs default base
//   node claude-gate.mjs --base master        # vs an explicit base
//   node claude-gate.mjs --commit <sha>       # one commit
//   node claude-gate.mjs --uncommitted        # staged/unstaged/untracked
//   node claude-gate.mjs --implementer codex  # declare who wrote the change
//   node claude-gate.mjs --print-args         # resolve and print argv; no model call
//
// Opt out with CLAUDE_REVIEW_GATE=off. Skips cleanly (exit 0) when the CLI is
// missing, unauthenticated, the model is unavailable, or the implementer is
// Claude.

import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isGateDisabled } from '../../lib/gate/env.mjs';
import { guardFor } from '../../lib/gate/implementer.mjs';
import { buildReviewPrompt } from '../../lib/gate/prompt.mjs';
import { createProtocol } from '../../lib/gate/protocol.mjs';
import { collectDiff, parseTarget, validateTarget } from '../../lib/gate/target.mjs';

const isWin = process.platform === 'win32';
const { emitSkip, emitReview, emitError } = createProtocol({ label: 'CLAUDE', slug: 'claude-gate' });

if (isGateDisabled('CLAUDE_REVIEW_GATE')) {
  emitSkip('Claude gate disabled via CLAUDE_REVIEW_GATE.');
}

const userArgs = process.argv.slice(2);
const printArgsOnly = userArgs.includes('--print-args');
// Prints the exact prompt the reviewer would receive, and calls no model. The
// argv is not the review: asserting flags proved nothing about whether the
// prompt actually carried the change.
const printPromptOnly = userArgs.includes('--print-prompt');

// ── Self-review guard ───────────────────────────────────────────────────────
// A gate whose model wrote the code under review provides no independence. The
// default afk driver IS Claude Code, so this is the failure that would
// otherwise happen silently and constantly.
const guard = guardFor('claude', userArgs);
if (!guard.run) {
  emitSkip(`independence check — ${guard.reason}`);
}

// ── Target ──────────────────────────────────────────────────────────────────
const target = parseTarget(userArgs);
// A bad ref must not read as a clean tree: git() returns '' for a failed
// command, so without this an unresolvable target becomes "no changes found".
const valid = validateTarget(target);
if (!valid.ok) {
  emitError(`cannot review — ${valid.reason}`, 1);
}
const { diff, stat, changedFiles, untracked = [], error: diffError } = collectDiff(target);
if (diffError) {
  // Never a skip: a target git cannot read is unreviewable, not unchanged.
  emitError(`cannot review — ${diffError}`, 1);
}
const hasChanges = Boolean(diff.trim() || changedFiles.length);

// ── Prompt ──────────────────────────────────────────────────────────────────
const maxCtx = Number.parseInt(process.env.CLAUDE_REVIEW_MAX_CTX_BYTES || '400000', 10) || 400000;
// Bytes, not String#length: the prompt goes out as UTF-8 on stdin, while
// .length counts UTF-16 code units. A CJK diff is ~3 bytes per unit, so a
// 300k-"character" diff is ~900kB and would sail past a 400kB budget.
const diffBytes = Buffer.byteLength(diff, 'utf8');
if (diffBytes > maxCtx) {
  // Truncating and reviewing anyway would let a large change be APPROVED with
  // part of it never shown. The reviewer's read tools cannot recover what a
  // truncated diff drops: a deletion, or the old side of a modification, exists
  // nowhere in the current tree. So this fails closed rather than silently
  // narrowing what "reviewed" means.
  emitError(
    `diff is ${diffBytes} bytes, over the ${maxCtx}-byte budget. A truncated diff cannot be reviewed honestly — the old side of a modification and any deletion would simply be missing. Scope the review (--commit <sha>) or raise CLAUDE_REVIEW_MAX_CTX_BYTES.`,
    1,
  );
}
const diffText = diff;

// The context clause is this gate's own: it states what was supplied and what
// the reviewer may do to learn more. A gate whose reviewer has no tools (glm)
// must never be told to go looking — see lib/gate/prompt.mjs.
//
// Untracked files appear in NO diff (`git diff HEAD` is empty for a brand-new
// file) and this reviewer has no git to discover them with. Without the list
// below, an all-new-files change reaches the reviewer as an empty diff and can
// be approved having inspected nothing.
const context = [
  `The diff is included below (${target.command}). You have Read, Grep and Glob over the working tree and no other tools: read any file you need for context, and do not claim to have run any command.`,
  untracked.length
    // JSON-encoded, one per line: a filename may legally contain a newline, and
    // interpolating it raw would split one path across two bullets — the
    // reviewer then reads neither, and the file is absent from the diff too.
    ? `IMPORTANT: ${untracked.length} file(s) in this change are new and are NOT in the diff below. The diff alone therefore does not show the whole change. Read each one before judging it (paths are JSON-encoded):\n${untracked.map((f) => `- ${JSON.stringify(f)}`).join('\n')}`
    : '',
  '',
  `## Diff stat\n${stat}`,
  '',
  `## Full diff\n${diffText}`,
].filter(Boolean).join('\n');

const prompt = buildReviewPrompt({ scope: target.label, context });

// ── Invocation ──────────────────────────────────────────────────────────────
const model = (process.env.CLAUDE_REVIEW_MODEL || 'opus').trim();
const effort = (process.env.CLAUDE_REVIEW_EFFORT || 'medium').trim();

// `--tools "Read,Grep,Glob"` is the entire read-only boundary: no Bash, no
// Write, no Edit are loaded, so nothing can grant them back.
// `--setting-sources ""` keeps an operator's own permissions.allow out of the
// reviewer session. `--safe-mode` drops CLAUDE.md/skills/plugins/hooks so the
// review is of the diff, not of the project's doc corpus (and so this plugin's
// own skills never load into the reviewer).
//
// The prompt is NOT here: it carries the diff and goes in on stdin. A
// diff-sized argv exceeds the Windows command-line limit (8191 chars), which
// fails the run outright with "The command line is too long."
const args = [
  '-p',
  '--model', model,
  '--effort', effort,
  '--output-format', 'json',
  '--tools', 'Read,Grep,Glob',
  '--setting-sources', '',
  '--safe-mode',
  '--no-session-persistence',
];

const bin = (process.env.CLAUDE_GATE_BIN || 'claude').trim();

if (printPromptOnly) {
  process.stdout.write(`${prompt}\n`);
  process.exit(0);
}

if (printArgsOnly) {
  // Dry run: resolve everything, call no model. Reports what the gate resolved
  // so target/base selection can be tested without spending a metered call.
  // Runs BEFORE the no-changes skip — a dry run on a clean tree must still be
  // able to report which base it resolved.
  process.stdout.write(`${JSON.stringify({
    bin,
    kind: target.kind,
    base: target.base ?? null,
    commit: target.commit ?? null,
    label: target.label,
    command: target.command,
    hasChanges,
    changedFiles,
    promptBytes: prompt.length,
    promptOnStdin: true,
    args,
  }, null, 2)}\n`);
  process.exit(0);
}

if (!hasChanges) {
  emitSkip(`No changes found for ${target.label}.`);
}

const work = mkdtempSync(join(tmpdir(), 'claude-gate-'));
const logFile = join(work, 'claude.log');

process.stderr.write(`[claude-gate] ${bin} -p --model ${model} --effort ${effort} (${changedFiles.length} files, ${prompt.length}B prompt via stdin)\n`);
process.stderr.write(`[claude-gate] transcript -> ${logFile}\n`);

// Drop a flag whose value is the empty string. A shell concatenates argv, so an
// empty value vanishes and the NEXT flag silently becomes the value — turning
// `--setting-sources "" --safe-mode` into `--setting-sources=--safe-mode`.
function dropEmptyValued(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] === '' ? [...argv.slice(0, i), ...argv.slice(i + 2)] : argv;
}

const spawnOpts = { input: prompt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };

// No shell: it mangles empty args and imposes the command-line limit. A native
// install (winget/installer/homebrew) launches directly.
let res = spawnSync(bin, args, spawnOpts);

// Windows npm installs a `claude.cmd` shim, which cannot be launched without a
// shell (EINVAL). Retry there, minus the flag that cannot survive a shell.
if (isWin && res.error && res.error.code === 'EINVAL') {
  process.stderr.write('[claude-gate] script shim detected; retrying via shell without --setting-sources (the read-only boundary is --tools and is unaffected)\n');
  res = spawnSync(bin, dropEmptyValued(args, '--setting-sources'), { ...spawnOpts, shell: true });
}

const out = res.stdout || '';
const errOut = res.stderr || '';
try {
  const fd = openSync(logFile, 'w');
  writeSync(fd, `${out}\n----- stderr -----\n${errOut}`);
  closeSync(fd);
} catch {
  // The transcript is a convenience; losing it must not fail the review.
}

if (res.error && res.error.code === 'ENOENT') {
  emitSkip('Claude CLI not installed (see https://claude.com/claude-code), or set CLAUDE_REVIEW_GATE=off to disable this gate.');
}

// Windows launches via a shell, where a missing binary is exit 1 + a shell
// message rather than ENOENT. Match on that before trying to parse JSON.
if (!out.trim() && /is not recognized as|command not found|no such file/i.test(errOut)) {
  emitSkip('Claude CLI not installed (see https://claude.com/claude-code), or set CLAUDE_REVIEW_GATE=off to disable this gate.');
}

// The exit code is NOT the signal: `claude -p --output-format json` exits 0 on
// an API error and reports it in the envelope. Reading the exit code alone
// would report a failed review as a clean one.
let envelope;
try {
  envelope = JSON.parse(out);
} catch {
  emitError(`Claude produced no parseable result (exit ${res.status}). Transcript: ${logFile}`, res.status || 1);
}

if (envelope?.is_error) {
  const status = envelope.api_error_status;
  const detail = String(envelope.result || '').slice(0, 300);
  if (status === 401 || status === 403) {
    emitSkip(`Claude not authenticated (HTTP ${status}) — log in with the Claude Code CLI, or set CLAUDE_REVIEW_GATE=off. ${detail}`);
  }
  if (status === 404) {
    emitSkip(`Configured model "${model}" is unavailable (HTTP 404) — set CLAUDE_REVIEW_MODEL to a model this account can use. ${detail}`);
  }
  if (status === 429) {
    // afk's selection rule treats an out-of-credit or rate-limited reviewer as
    // UNAVAILABLE, so the next gate in priority takes its place. Erroring here
    // would instead mark the round unclean and block the PR on a quota blip.
    emitSkip(`Claude is rate-limited or out of quota (HTTP 429) — this gate cannot run right now; the next gate in priority should take its place. ${detail}`);
  }
  emitError(`Claude review failed${status ? ` (HTTP ${status})` : ''}: ${detail} Transcript: ${logFile}`, res.status || 1);
}

const denials = Array.isArray(envelope?.permission_denials) ? envelope.permission_denials : [];
if (denials.length) {
  // Expected and harmless in itself — the reviewer probed for a tool it does not
  // have. Surfaced so a reviewer starved of context leaves a trace.
  process.stderr.write(`[claude-gate] reviewer was denied ${denials.length} tool call(s); see ${logFile}\n`);
}

const review = String(envelope?.result || '').trim();
if (!review) {
  emitError(`Claude returned an empty review (exit ${res.status}). Transcript: ${logFile}`, res.status || 1);
}

emitReview(review);
process.exit(0);
