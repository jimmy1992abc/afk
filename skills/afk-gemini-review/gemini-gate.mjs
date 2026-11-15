#!/usr/bin/env node
// gemini-gate.mjs — external review through the Antigravity CLI (`agy`).
//
// Runs a structural review of a branch/commit/uncommitted diff (or a design
// document) with a Gemini model through the operator's signed-in `agy`, and
// prints ONLY the final review between markers (transcript -> log file).
//
// Transport: the prompt is the one stream-json user turn on stdin, never argv
// (`--print` takes its prompt as a flag value, and a diff-sized argv exceeds
// the Windows command-line limit). stdout is NDJSON: an `init` event naming the
// session model, `step_update` events, and a final `result` event.
//
// Read-only is NOT by construction. `--mode plan` (verified: no workspace
// writes; it may write plan artifacts under ~/.gemini/antigravity-cli/) and
// `--sandbox` restrict the agent, and the prompt forbids changes, plans,
// subagents and swarms. `--disable-slash-commands` is deliberately absent: agy
// reports that it switches plan mode off. No settings key that removes tools
// is known, so the agent still loads its full toolset.
//
// Independence: agy also serves Claude and GPT models, so only a versioned
// `gemini-*` model is accepted, the `init` event must name it, and a stream
// showing delegation (a step type outside the observed allowlist, or an
// agent/swarm tool) is refused — a delegated worker may run on any model.
//
// Usage:
//   node gemini-gate.mjs                      # current branch vs default base
//   node gemini-gate.mjs --base main          # vs an explicit base
//   node gemini-gate.mjs --commit <sha>       # one commit
//   node gemini-gate.mjs --uncommitted        # staged/unstaged/untracked
//   node gemini-gate.mjs --design <path>      # review a design doc
//   node gemini-gate.mjs --implementer claude # declare who wrote the change
//   node gemini-gate.mjs --print-args         # resolve and print argv; no model call
//
// Opt out with GEMINI_REVIEW_GATE=off. Skips cleanly (exit 0) when agy is
// missing or signed out, the model is not offered, the account is rate
// limited, or the implementer is Gemini.

import { closeSync, openSync, writeSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { classifyChildOutcome, describeChildOutcome } from '../../lib/gate/child-outcome.mjs';
import { workingTreeNotes } from '../../lib/gate/diff-context.mjs';
import {
  isGateDisabled, isSpawnTimeout, positiveIntEnv, reviewTimeoutMs,
} from '../../lib/gate/env.mjs';
import { guardFor } from '../../lib/gate/implementer.mjs';
import { buildDesignReviewPrompt, buildReviewPrompt } from '../../lib/gate/prompt.mjs';
import { createReceiptProtocol } from '../../lib/gate/review-receipt.mjs';
import { loadReviewContext } from '../../lib/gate/review-context.mjs';
import { gateWorkDir } from '../../lib/gate/workdir.mjs';
import { resolveCliBin, spawnCli, UNSAFE_SHELL_ARG } from '../../lib/gate/spawn.mjs';
import { collectDiff, parseTarget, readDesign, validateTarget } from '../../lib/gate/target.mjs';

const MODEL_DEFAULT = 'gemini-4-argon-high';
// A versioned Gemini ID and nothing else: agy also offers claude-* and gpt-*
// models, and a shell-unsafe character could never be carried to a shim.
const MODEL_PATTERN = /^gemini-[A-Za-z0-9._-]*\d[A-Za-z0-9._-]*$/;
// The step types a review was observed to produce. Delegation surfaced as
// `subagent`; anything unobserved fails visible rather than passing as Gemini.
const ALLOWED_STEPS = new Set(['user_input', 'agent_response', 'tool']);
const DELEGATING_TOOL = /agent|swarm|team/i;
const SPAWN_BACKSTOP_MS = 60 * 1000;
const NOT_INSTALLED = 'Antigravity CLI (agy) not found — run `~/.gemini/bin/agy install` to put it on PATH, or set GEMINI_GATE_BIN to its path; set GEMINI_REVIEW_GATE=off to disable this gate.';

const { receipt, protocol, argv: receiptArgs } = createReceiptProtocol({
  label: 'GEMINI', slug: 'gemini-gate', family: 'gemini', argv: process.argv.slice(2),
});
const { emitSkip, emitError, emitVerifiedReview, emitPreview } = protocol;

// The effort is part of the model ID (gemini-4-argon-low/medium/high).
const model = (process.env.GEMINI_REVIEW_MODEL || '').trim() || MODEL_DEFAULT;
receipt.capture({ selection: { model, effort: null } });

// A target that could not be parsed, or a design target naming a missing
// document, is a caller error that must surface even when the gate is off.
{
  const early = parseTarget(receiptArgs);
  if (early.kind === 'error' || early.kind === 'design') {
    const valid = validateTarget(early);
    if (!valid.ok) emitError(`cannot review — ${valid.reason}`, 1);
  }
}

const reviewContext = loadReviewContext({ argv: receiptArgs, target: parseTarget(receiptArgs) });
if (reviewContext.error) emitError(`cannot review — ${reviewContext.error}`, 1);
receipt.capture({ context: reviewContext });

if (isGateDisabled('GEMINI_REVIEW_GATE')) {
  emitSkip('Gemini gate disabled via GEMINI_REVIEW_GATE.');
}

const userArgs = receiptArgs;
const printArgsOnly = userArgs.includes('--print-args');
const printPromptOnly = userArgs.includes('--print-prompt');

const target = parseTarget(userArgs);
const isDesign = target.kind === 'design';
if (isDesign || target.kind === 'error') {
  const valid = validateTarget(target);
  if (!valid.ok) emitError(`cannot review — ${valid.reason}`, 1);
}

const guard = guardFor('gemini', userArgs);
if (!guard.run) {
  emitSkip(`independence check — ${guard.reason}`);
}

if (!isDesign) {
  const valid = validateTarget(target);
  if (!valid.ok) emitError(`cannot review — ${valid.reason}`, 1);
}

receipt.capture({ target });

if (!MODEL_PATTERN.test(model)) {
  emitError(
    `cannot review — GEMINI_REVIEW_MODEL "${model}" is not a versioned Gemini model ID. agy also serves other families, so only a gemini-* ID with a version digit (e.g. ${MODEL_DEFAULT}) can keep this role independent. Run \`agy models\` for the IDs this account offers.`,
    1,
  );
}

// What the reviewer may do, stated honestly: headless plan mode auto-denies
// search and listing (they need command permission), so the reviewer reads
// named files and relies on what the gate supplies.
const TOOLS = 'You can read files in the working tree by path; search and directory-listing tools may be unavailable, and you cannot run commands.';
const BOUNDARY = 'Do NOT modify, create, stage, commit or delete any file, do not start subagents or swarms, and do not create plans or artifacts: answer with the review itself as your final message.';

let prompt;
let changedFiles = [];
let hasChanges = true;
let reviewCwd;

if (isDesign) {
  const doc = readDesign(target);
  if (doc.error) emitError(`cannot review — ${doc.error}`, 1);
  prompt = buildDesignReviewPrompt({
    scope: target.label,
    context: [
      `The design document under review is included below. ${TOOLS} Read any file you need to check a claim the design makes about the code. ${BOUNDARY}`,
      '',
      `## Design document (${target.path})`,
      doc.text,
    ].join('\n'),
  });
} else {
  const { diff, stat, changedFiles: cf, untracked = [], worktreeRoot, error: diffError } = collectDiff(target);
  if (diffError) emitError(`cannot review — ${diffError}`, 1);
  reviewCwd = worktreeRoot;
  changedFiles = cf;
  hasChanges = Boolean(diff.trim() || changedFiles.length);

  // Bytes, not String#length: a CJK diff is ~3 bytes per UTF-16 unit. A
  // truncated diff would let part of a change be approved unseen.
  const maxCtx = positiveIntEnv('GEMINI_REVIEW_MAX_CTX_BYTES', 400000);
  const diffBytes = Buffer.byteLength(diff, 'utf8');
  if (diffBytes > maxCtx) {
    emitError(
      `diff is ${diffBytes} bytes, over the ${maxCtx}-byte budget. A truncated diff cannot be reviewed honestly — the old side of a modification and any deletion would simply be missing. Scope the review (--commit <sha>) or raise GEMINI_REVIEW_MAX_CTX_BYTES.`,
      1,
    );
  }
  prompt = buildReviewPrompt({
    scope: target.label,
    context: [
      `The diff is included below (${target.command}). ${TOOLS} The diff and any file list below are authoritative for what changed. ${BOUNDARY}`,
      ...workingTreeNotes({ target, untracked }),
      '',
      `## Diff stat\n${stat}`,
      '',
      `## Full diff\n${diff}`,
    ].filter(Boolean).join('\n'),
  });
}

prompt += `\n${reviewContext.section}`;

const timeoutMs = reviewTimeoutMs('gemini');
// Rounded UP with a 1 s floor: agy reads `0s` as "no bound at all".
const printTimeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
const args = [
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--model', model,
  '--mode', 'plan',
  '--sandbox',
  '--print-timeout', `${printTimeoutSeconds}s`,
];

const selectedBin = resolveCliBin((process.env.GEMINI_GATE_BIN || '').trim() || 'agy');
// Changing the review cwd must not change an explicit caller-selected executable.
const bin = reviewCwd && selectedBin && !isAbsolute(selectedBin) && /[\\/]/.test(selectedBin)
  ? resolve(selectedBin) : selectedBin;

if (printPromptOnly) {
  emitPreview(`${prompt}\n`);
  process.exit(0);
}

if (printArgsOnly) {
  emitPreview(`${JSON.stringify({
    bin,
    reviewCwd,
    model,
    kind: target.kind,
    base: target.base ?? null,
    commit: target.commit ?? null,
    label: target.label,
    command: target.command ?? null,
    hasChanges,
    changedFiles,
    promptBytes: Buffer.byteLength(prompt, 'utf8'),
    promptOnStdin: true,
    reviewPhase: reviewContext.phase,
    reviewContextDigest: reviewContext.digest,
    timeoutMs,
    args,
  }, null, 2)}\n`);
  process.exit(0);
}

if (!hasChanges) emitSkip(`No changes found for ${target.label}.`);
if (bin === null) emitSkip(NOT_INSTALLED);

const workDir = gateWorkDir('gemini-gate-');
if (workDir.error) emitError(workDir.error, 1);
const logFile = join(workDir.path, 'agy.log');

process.stderr.write(`[gemini-gate] ${bin} --model ${model} --mode plan --sandbox (${changedFiles.length} files, ${Buffer.byteLength(prompt, 'utf8')}B prompt via stdin)\n`);
process.stderr.write(`[gemini-gate] transcript -> ${logFile}\n`);

// POSIX resolves relative and empty PATH entries after chdir; keep the caller's
// executable search identity when the review runs from the worktree root.
const reviewEnv = reviewCwd && process.platform !== 'win32' && process.env.PATH !== undefined
  ? { ...process.env, PATH: process.env.PATH.split(':').map((entry) => resolve(entry || '.')).join(':') }
  : process.env;

const res = spawnCli(bin, args, {
  cwd: reviewCwd,
  env: reviewEnv,
  input: `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  timeout: timeoutMs + SPAWN_BACKSTOP_MS,
  killSignal: 'SIGKILL',
});

receipt.capture({ execution: { exitCode: res.status ?? null, signal: res.signal ?? null, completion: null } });

const out = res.stdout || '';
const errOut = res.stderr || '';
try {
  const fd = openSync(logFile, 'w');
  writeSync(fd, `${out}\n----- stderr -----\n${errOut}`);
  closeSync(fd);
} catch {
  // The transcript is a convenience; losing it must not fail the review.
}

const timedOut = () => emitError(
  `Gemini review timed out after ${printTimeoutSeconds}s with no verdict. Raise GEMINI_REVIEW_TIMEOUT_MS or AFK_REVIEW_TIMEOUT_MS, or narrow the target. Transcript: ${logFile}`,
  1,
);

// (0) A missing executable is unavailability; an argument no shell can carry
// is operator input to fix, never a reason to hand the review elsewhere.
if (res.error && res.error.code === UNSAFE_SHELL_ARG) {
  emitError('cannot review this target: an argument cannot be represented safely by the required shell. Rename the ref or path, or install agy as a native binary.', 1);
}
if (res.error && res.error.code === 'ENOENT') emitSkip(NOT_INSTALLED);
if (!out.trim() && /is not recognized as|command not found|no such file/i.test(errOut)) emitSkip(NOT_INSTALLED);

// (a) The process did not end on its own terms. EPIPE is the one exception: agy
// exited before reading a large prompt, and only its own result may say why.
if (isSpawnTimeout(res)) timedOut();
const epipe = res.error?.code === 'EPIPE';
const outcome = classifyChildOutcome(res);
if (outcome && !epipe && outcome.kind !== 'nonzero') {
  emitError(`${describeChildOutcome('agy', outcome)}; no review was accepted. Transcript: ${logFile}`, 1);
}

const events = [];
for (const line of out.split('\n')) {
  if (!line.trim()) continue;
  try {
    const event = JSON.parse(line);
    if (event && typeof event === 'object') events.push(event);
  } catch {
    // A non-JSON line carries no result; the result event alone decides.
  }
}
const init = events.find((event) => event.event === 'init')?.init;
const result = events.filter((event) => event.event === 'result').pop()?.result;

// (b) agy's own report of unavailability, read before the exit code (sign-in
// and unknown-model failures exit 1 with a result).
if (result && typeof result === 'object' && result.status !== 'SUCCESS') {
  const detail = String(result.error || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (/authenticat|not signed in|sign in|log in/i.test(detail)) {
    emitSkip(`agy is not signed in — run \`agy\` once to sign in, or set GEMINI_REVIEW_GATE=off. ${detail}`);
  }
  if (/not recognized as a known model|model .*not (?:available|found|supported)/i.test(detail)) {
    emitSkip(`Configured model "${model}" is not offered to this agy account — run \`agy models\` and set GEMINI_REVIEW_MODEL to a listed gemini-* ID. ${detail}`);
  }
  if (/\b429\b|rate.?limit|quota|resource.?exhausted/i.test(detail)) {
    emitSkip(`Gemini is rate-limited or out of quota — this gate cannot run right now; the next gate in priority should take its place. ${detail}`);
  }
}

// (c) Anything short of a complete, successful turn is an error.
if (epipe) {
  emitError(`agy exited before reading the review prompt; no review was accepted. Transcript: ${logFile}`, 1);
}
if (result?.finished_reason === 'print_timeout' || res.status === 3) timedOut();
if (!result || typeof result !== 'object') {
  const why = outcome ? describeChildOutcome('agy', outcome) : 'agy ended';
  emitError(`${why} without a result event; no review was accepted. Transcript: ${logFile}`, 1);
}
if (result.status !== 'SUCCESS') {
  emitError(`Gemini review failed (status ${JSON.stringify(result.status ?? null)}): ${String(result.error || '').slice(0, 300)} Transcript: ${logFile}`, 1);
}
if (result.finished_reason) {
  emitError(`Gemini ended the turn early (finished_reason ${JSON.stringify(String(result.finished_reason))}); the verdict was discarded. Transcript: ${logFile}`, 1);
}
if (outcome) {
  emitError(`${describeChildOutcome('agy', outcome)} after a successful result; no review was accepted. Transcript: ${logFile}`, 1);
}

// argv states what was requested; the init event states what answered.
const observed = typeof init?.model === 'string' && init.model.trim() ? init.model.trim() : null;
const verified = observed !== null && observed.toLowerCase() === model.toLowerCase();
receipt.capture({ model: {
  observed: observed === null ? null : [observed],
  verification: verified ? 'verified' : observed ? 'mismatch' : 'unavailable',
  reason: verified ? null : 'session model is not verified',
} });
if (!verified) {
  const detail = observed
    ? `the init event reports "${observed}" instead`
    : 'the stream carries no init event naming the session model';
  emitError(`reviewer identity unverified — requested "${model}" but ${detail}. This review is discarded rather than attributed to a model that may not have run. Transcript: ${logFile}`, 1);
}

for (const event of events) {
  if (event.event !== 'step_update') continue;
  const step = event.step_update || {};
  if (!ALLOWED_STEPS.has(step.step_type) || (step.step_type === 'tool' && DELEGATING_TOOL.test(String(step.tool_name || '')))) {
    emitError(`the reviewer delegated work (step ${JSON.stringify(step.step_type ?? null)}${step.tool_name ? `, tool ${JSON.stringify(String(step.tool_name))}` : ''}); a delegated worker's model is not verified, so the review is discarded. Transcript: ${logFile}`, 1);
  }
}

emitVerifiedReview(String(result.response || ''), {
  requireVerdict: true,
  mode: isDesign ? 'design' : 'diff',
  emptyMessage: `Gemini returned an empty review (a tool it needed may have been denied in headless mode). Transcript: ${logFile}`,
  missingVerdictMessage: `Gemini answered without the mandated verdict line; the review is discarded rather than presented as a verdict. Transcript: ${logFile}`,
  exitCode: 1,
});
process.exit(0);
