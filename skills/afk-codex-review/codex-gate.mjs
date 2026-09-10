#!/usr/bin/env node
// codex-gate.mjs — cross-platform external review wrapper around Codex.
//
// Runs `codex exec review` headless against a branch/commit/uncommitted diff
// and prints ONLY Codex's final review message on stdout (full transcript goes
// to a log file). Used by the afk-codex-review skill as a read-only,
// independent-model review gate.
//
// Per-OS behavior:
//   - Windows: passes --dangerously-bypass-approvals-and-sandbox (`review` is
//     read-only; the OS sandbox cannot launch under a normal user token).
//   - macOS (Seatbelt) / Linux (Landlock): native sandbox, no bypass.
//
// Usage:
//   node codex-gate.mjs                 # review current branch vs default base
//   node codex-gate.mjs --base master   # review vs an explicit base branch
//   node codex-gate.mjs --commit <sha>  # review one commit
//   node codex-gate.mjs --uncommitted   # review staged/unstaged/untracked
//   node codex-gate.mjs --design <path> # review a design doc (exec -s read-only, doc on stdin)
//   node codex-gate.mjs --print-args    # resolve and print argv; no model call
//   (any extra flags are passed through to `codex exec review`)
//
// Review scope: Codex's built-in `review`. No custom focus prompt — codex-cli
// rejects a PROMPT alongside a diff selector (--base/--commit/--uncommitted),
// and the gate always selects one. This gate therefore consumes only the shared
// target PARSING; it builds no scope label and no prompt.
//
// Lean context: overrides config per run via `-c` (the operator's interactive
// Codex config is untouched):
//   - model=gpt-5.6-sol         (pinned reviewer, never the session model)
//   - model_reasoning_effort=medium
//   - project_doc_max_bytes=0  (skip the project doc chain)
// Override via CODEX_REVIEW_MODEL / CODEX_REVIEW_REASONING /
// CODEX_REVIEW_PROJECT_DOC_MAX_BYTES.
//
import {
  closeSync, existsSync, openSync,
  readFileSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  isGateDisabled, isSpawnTimeout, preflightTimeoutMs, reviewTimeoutMs,
} from '../../lib/gate/env.mjs';
import { classifyChildOutcome, describeChildOutcome } from '../../lib/gate/child-outcome.mjs';
import { detectBase, resolveBase } from '../../lib/gate/git.mjs';
import { guardFor, stripImplementer } from '../../lib/gate/implementer.mjs';
import { buildDesignReviewPrompt } from '../../lib/gate/prompt.mjs';
import { createReceiptProtocol } from '../../lib/gate/review-receipt.mjs';
import { loadReviewContext, reviewContextOptions } from '../../lib/gate/review-context.mjs';
import { resolveReviewSelection } from '../../lib/gate/model-select.mjs';
import { gateWorkDir } from '../../lib/gate/workdir.mjs';
import { resolveCliBin, spawnCli, UNSAFE_SHELL_ARG } from '../../lib/gate/spawn.mjs';
import {
  optVal, parseTarget, readDesign, readOption, validateTarget,
} from '../../lib/gate/target.mjs';

const isWin = process.platform === 'win32';
const { receipt, protocol, argv: receiptArgs } = createReceiptProtocol({
  label: 'CODEX', slug: 'codex-gate', family: 'codex', argv: process.argv.slice(2),
});
const { emitSkip, emitError, emitVerifiedReview, emitPreview } = protocol;
let selection;
try {
  selection = resolveReviewSelection({ family: 'codex', argv: receiptArgs });
} catch (error) {
  emitError(`cannot review — ${error.message}`, 1);
}
receipt.capture({ selection });

// ── Machine-wide serialization of `codex exec` runs ──────────────────────────
// Advisory lockfile in the OS temp dir, shared across repos/worktrees (the
// subscription auth is machine/account-wide, not per-repo). A peer holding
// the lock is WAITED for; a stale lock (dead PID, or older than TTL) is
// stolen. Escape hatch: CODEX_GATE_NO_LOCK=1 disables it.
// Lock path is anchored to homedir(), not os.tmpdir() (which can differ per
// process), so it matches the per-user auth boundary. Override with
// CODEX_GATE_LOCK_PATH.
//
// Not shared with the other gates: this serializes `codex exec` specifically,
// and hoisting a single-consumer helper trades duplication for premature
// abstraction.
const LOCK_PATH = (process.env.CODEX_GATE_LOCK_PATH || '').trim()
  || join(homedir(), '.codex-gate.lock');
// Orphan cutoff: applies only when lock contents can't identify a live owner
// (empty/corrupt). A lock with a live owner is never stolen by age.
const LOCK_TTL_MS = 20 * 60 * 1000;
const LOCK_POLL_MS = 3000;

function lockDisabled() {
  return ['1', 'true', 'yes', 'on'].includes(
    (process.env.CODEX_GATE_NO_LOCK || '').trim().toLowerCase());
}

function lockMaxWaitMs() {
  const v = Number.parseInt(process.env.CODEX_GATE_LOCK_WAIT_MS || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : 20 * 60 * 1000;
}

function sleepSync(ms) {
  // Synchronous sleep, no subprocess (the gate runs synchronously via spawnSync)
  // and cross-platform (unlike `sleep`). Zero busy-wait.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }        // signal 0 = existence probe
  catch (e) { return e.code === 'EPERM'; }           // exists but not ours to signal
}

function acquireCodexLock() {
  if (lockDisabled()) return null;
  const deadline = Date.now() + lockMaxWaitMs();
  let announced = false;
  for (;;) {
    try {
      const fd = openSync(LOCK_PATH, 'wx');           // exclusive create — fails if held
      writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      closeSync(fd);
      return LOCK_PATH;
    } catch (e) {
      if (e.code !== 'EEXIST') return null;           // unexpected fs error → proceed unlocked
      let info = null;
      try { info = JSON.parse(readFileSync(LOCK_PATH, 'utf8')); } catch { /* empty/partial/corrupt */ }
      let stale;
      if (info && info.pid) {
        // A live owner is never stolen by age (a slow review may run past any
        // TTL); only a dead owner is stale. MAX_WAIT is the waiter's escape hatch.
        stale = !pidAlive(info.pid);
      } else {
        // Empty/unparseable contents may be a live lock caught mid-write (the
        // file is created before the JSON payload). Fall back to mtime: steal
        // only if older than TTL, else treat as a live peer and wait.
        let mtimeMs = 0;
        try { mtimeMs = statSync(LOCK_PATH).mtimeMs; } catch { /* vanished */ }
        if (!mtimeMs) continue;                        // lock removed under us → retry acquire
        stale = (Date.now() - mtimeMs) > LOCK_TTL_MS;
      }
      if (stale) {
        let removed = false;
        try { unlinkSync(LOCK_PATH); removed = true; } catch { /* couldn't steal it */ }
        if (removed) continue;                        // stolen → retry acquire at once
        // Stale but unremovable: do not tight-spin, fall through to bounded wait.
      }
      if (Date.now() >= deadline) {
        process.stderr.write(
          '[codex-gate] a peer codex run is still active after the max wait — '
          + 'proceeding WITHOUT the lock (collision possible).\n');
        return null;                                  // never block a review forever
      }
      if (!announced) {
        process.stderr.write(
          `[codex-gate] another codex review is running (pid ${info?.pid || '?'}); `
          + 'waiting for it to finish…\n');
        announced = true;
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
}

function releaseCodexLock(lock) {
  if (!lock) return;
  try {
    // Only remove the lock if it is still OURS — a stale-steal by a peer must not
    // be deleted by us (that would drop the peer's lock).
    const info = JSON.parse(readFileSync(lock, 'utf8'));
    if (info.pid === process.pid) unlinkSync(lock);
  } catch { /* already gone / corrupt — nothing to release */ }
}

// Explicit opt-out: CODEX_REVIEW_GATE=off/0/false/no/disabled.
// A target that could not be parsed is a caller error, and it must surface even
// when the gate is switched off — placed after that exit, this check would be
// unreachable in exactly the configuration that most needs to say why. Reads
// argv directly: it runs before the shared `userArgs` binding exists.
{
  const early = parseTarget(receiptArgs);
  // A design target names its document here, so a missing path is the same
  // class of caller error as an unparseable target and must surface with it.
  if (early.kind === 'error' || early.kind === 'design') {
    const valid = validateTarget(early);
    if (!valid.ok) emitError(`cannot review — ${valid.reason}`, 1);
  }
}

const reviewContext = loadReviewContext({
  argv: receiptArgs, target: parseTarget(receiptArgs),
  supported: parseTarget(receiptArgs).kind === 'design',
});
if (reviewContext.error) emitError(`cannot review — ${reviewContext.error}`, 1);
receipt.capture({ context: reviewContext });

if (isGateDisabled('CODEX_REVIEW_GATE')) {
  emitSkip('Codex gate disabled via CODEX_REVIEW_GATE.');
}

function resolveCodex() {
  if (process.env.CODEX_GATE_BIN) return resolveCliBin(process.env.CODEX_GATE_BIN.trim());
  // Prefer PATH (works on macOS/Linux and Windows-with-PATH). On Windows also
  // fall back to the npm global shim, which isn't always on a child's PATH.
  // This probe keeps its precedence deliberately: reordering it below the PATH
  // resolution would change which codex binary reviews on a machine holding
  // both, and this gate's bug is only about machines where nothing resolves.
  if (isWin && process.env.APPDATA) {
    const shim = join(process.env.APPDATA, 'npm', 'codex.cmd');
    if (existsSync(shim)) return shim;
  }
  // A bare `codex` installed as a `.cmd` shim elsewhere on PATH (nvm-windows,
  // pnpm, yarn) is invisible to libuv, which appends only `.com`/`.exe`.
  return resolveCliBin('codex');
}

const userArgs = reviewContextOptions(selection.argv).argv;

// Hidden self-test for the lock only (no codex call): --selftest-lock[=holdMs].
// Acquires, optionally holds holdMs, releases, reports wait time.
const selftest = userArgs.find((a) => a.startsWith('--selftest-lock'));
if (selftest) {
  if (receipt.enabled) emitError('review receipts are unavailable for the internal lock self-test');
  const holdMs = Number(selftest.split('=')[1] || 0) || 0;
  const t0 = Date.now();
  const lk = acquireCodexLock();
  process.stderr.write(
    `[codex-gate] selftest: acquired=${!!lk} waited=${Date.now() - t0}ms hold=${holdMs}ms\n`);
  if (holdMs > 0) sleepSync(holdMs);
  releaseCodexLock(lk);
  process.stderr.write('[codex-gate] selftest: released\n');
  process.exit(0);
}

// Both spellings count as a target. Seeing only the bare token meant
// `--commit=HEAD` looked target-less, so the default `--base` was injected
// alongside it and codex received two conflicting selectors.
const TARGET_FLAGS = ['--base', '--commit', '--uncommitted'];
const hasTarget = userArgs.some((a) => typeof a === 'string'
  && TARGET_FLAGS.some((flag) => a === flag || a.startsWith(`${flag}=`)));
const printArgsOnly = userArgs.includes('--print-args');

// Promote an operator-supplied `--base` to its remote-tracking ref too, not just
// the auto-detected default: a bare `--base main` against a stale local main is
// the same wrong-commit-range defect, and the other three gates promote it.
function promoteExplicitBase(argv) {
  const equals = argv.findIndex((a) => typeof a === 'string' && a.startsWith('--base='));
  if (equals >= 0) {
    const next = [...argv];
    next[equals] = `--base=${resolveBase(argv[equals].slice('--base='.length))}`;
    return next;
  }
  const i = argv.indexOf('--base');
  if (i < 0 || i + 1 >= argv.length) return argv;
  const next = [...argv];
  next[i + 1] = resolveBase(argv[i + 1]);
  return next;
}

// --implementer is an afk-level flag: strip it, or `codex exec review` rejects
// an option it does not know and the gate cannot run at all in a relay setup.
const passThrough = promoteExplicitBase(
  stripImplementer(userArgs.filter((a) => !['--print-args', '--print-prompt'].includes(a))),
);

// Detect and validate a design target BEFORE the independence guard: a malformed
// --design is operator error that must ERROR even when codex would self-skip as
// the implementer. Detect by PRESENCE (a valueless --design must still select
// the design kind, then fail loud), not by optVal's value alone.
// The shared reader, not a second spelling rule: `--design=spec.md` here once
// entered diff mode and forwarded an argument `codex exec review` rejects.
const designFlag = readOption(userArgs, '--design');
const isDesign = designFlag.supplied;
const parsedTarget = parseTarget(userArgs);
const designPath = designFlag.value || null;
const designTarget = isDesign
  ? { kind: 'design', path: designPath, label: designPath ? `the design document at ${designPath}` : 'a design document (no --design path given)' }
  : null;
if (parsedTarget.kind === 'error' || isDesign) {
  // The parse error wins: with two --design flags isDesign is also true, and
  // validating the synthesized first one would discard the ambiguity.
  const valid = validateTarget(parsedTarget.kind === 'error' ? parsedTarget : designTarget);
  if (!valid.ok) {
    emitError(`cannot review — ${valid.reason}`, 1);
  }
}

const guard = guardFor('codex', userArgs);
if (!guard.run) {
  emitSkip(`independence check — ${guard.reason}`);
}

receipt.capture({ target: parsedTarget });

// Lean-context overrides (review THE DIFF, not the project doc corpus):
//   - model_reasoning_effort: default `medium`. Override via
//     CODEX_REVIEW_REASONING (minimal|low|medium|high|xhigh|max).
//   - project_doc_max_bytes: default 0 (skip the project doc chain).
//     Override via CODEX_REVIEW_PROJECT_DOC_MAX_BYTES. Parsed as TOML by `-c`.
const projectDocMaxBytes = (
  process.env.CODEX_REVIEW_PROJECT_DOC_MAX_BYTES || '0'
).trim();

// The reviewer's model is PINNED, not inherited. `codex exec` otherwise runs
// whatever `~/.codex/config.toml` selects for interactive work, so a session
// tuned for speed or cost silently downgrades the gate — and a downgraded
// review is indistinguishable from a thorough one at the point it is read. The
// external-gate rule requires a current-generation frontier reviewer, and a
// requirement nothing selects for is not met.
//   - CODEX_REVIEW_MODEL=<id>  pins a different model for this call.
//   - CODEX_REVIEW_MODEL=inherit (or default/config, or empty) restores
//     inheritance — the escape hatch for a CLI too old for the pinned id, which
//     the API rejects outright rather than degrading.
const reviewModel = selection.model || '';

// Shared by both argv builders: a pin applied on one path only would leave the
// other inheriting, which is the defect this prevents.
const leanConfig = [];
// Design mode omits passthrough to preserve its sandbox, so apply only the
// validated selection there; diff mode retains native config ordering.
const argvModel = isDesign ? selection.model : selection.configModel;
const argvEffort = isDesign ? selection.effort : selection.configEffort;
if (argvModel) leanConfig.push('-c', `model=${argvModel}`);
leanConfig.push('-c', `model_reasoning_effort=${argvEffort}`);
leanConfig.push('-c', `project_doc_max_bytes=${projectDocMaxBytes}`);

const workDir = gateWorkDir('codex-gate-');
if (workDir.error) emitError(workDir.error, 1);
const work = workDir.path;
const finalFile = join(work, 'review.txt');
const logFile = join(work, 'codex.log');

// Design mode is a different review of a different artifact, and here — unlike
// diff mode — codex shares the gate lib. The design target is a trivial literal
// (a kind, the path, a scope label; no diff to compute), so codex builds it
// inline rather than routing through parseTarget, then uses the SAME
// validateTarget → readDesign → buildDesignReviewPrompt as the three lib gates.
//
// The invocation is `exec -s read-only -o <file> -`, NEVER `review` + bypass:
// `review` has no `-s` selector, so on Windows the bypass would make it
// full-access. The read-only sandbox launches under a normal Windows token (a
// hermetic probe verified this on codex 0.144.1); design mode needs no bypass.
// The brief + doc ride on stdin (positional `-`): a real design doc overflows
// the Windows ~8191-char argv limit as a positional.
// The design target was detected and validated before the guard (above). Load
// it now that the lean-context vars and the output file exist.
let reviewArgs;
let designPayload = null;

if (isDesign) {
  const doc = readDesign(designTarget);
  if (doc.error) {
    // A read that failed after validateTarget passed (TOCTOU) is unreviewable —
    // fail loud with a marker block, never throw uncaught.
    emitError(`cannot review — ${doc.error}`, 1);
  }
  const { text } = doc;
  const context = 'The design document under review is included below. You are running read-only: you may read files in this repository to check a claim the design makes about the code, but you cannot modify anything. Do not claim to have run any command you did not run.';
  const brief = buildDesignReviewPrompt({ scope: designTarget.label, context });
  designPayload = `${brief}\n\n## Design document (${designTarget.path})\n${text}\n${reviewContext.section}`;

  reviewArgs = ['exec', '-s', 'read-only', ...leanConfig];
  reviewArgs.push('-o', finalFile, '-');
} else {
  // Push lean defaults FIRST so an operator-supplied `-c key=...` in extra args
  // still takes precedence (codex applies later -c overrides last).
  reviewArgs = ['exec', 'review', ...leanConfig];

  // Resolve the base to its remote-tracking ref when one exists. A stale local
  // `main` otherwise makes the gate review the wrong commit range and report
  // findings against commits that are not in the PR.
  if (!hasTarget) reviewArgs.push('--base', resolveBase(detectBase()));
  reviewArgs.push(...passThrough);
  reviewArgs.push('-o', finalFile);
  if (isWin) reviewArgs.push('--dangerously-bypass-approvals-and-sandbox');
  // Do NOT append a positional PROMPT — codex-cli rejects combining a diff
  // selector with a PROMPT; the gate always selects a target.
}

const codex = resolveCodex();
const timeoutMs = reviewTimeoutMs('codex');

if (userArgs.includes('--print-prompt')) {
  if (!isDesign) emitError('native Codex diff review has no custom prompt preview; selected mode was not changed', 1);
  emitPreview(`${designPayload}\n`);
  process.exit(0);
}

if (printArgsOnly) {
  // Dry run: resolve the argv, call no model. Makes the target/base resolution
  // observable without spending a metered call. The design payload is reported by
  // size only — it rides on stdin, never in argv, so it can never leak here.
  emitPreview(`${JSON.stringify({
    bin: codex,
    model: reviewModel || 'inherit',
    effort: selection.effort,
    selectionSources: selection.sources,
    hasExplicitTarget: hasTarget,
    promptOnStdin: isDesign,
    reviewPhase: reviewContext.phase,
    reviewContextDigest: reviewContext.digest,
    reviewContextCapability: isDesign ? 'custom context via stdin' : 'native diff: driver-side history triage only; no custom context delivered',
    stdinBytes: designPayload ? Buffer.byteLength(designPayload, 'utf8') : 0,
    timeoutMs,
    args: reviewArgs.map((a) => (a === finalFile ? '<review-file>' : a)),
  }, null, 2)}\n`);
  process.exit(0);
}

// Availability + auth pre-check (local only, no model call / no metered cost).
// Skip cleanly if Codex is missing or not logged in.
const auth = spawnCli(codex, ['login', 'status'], {
  encoding: 'utf8',
  timeout: preflightTimeoutMs(timeoutMs),
  killSignal: 'SIGKILL',
});
if (isSpawnTimeout(auth)) {
  emitSkip('Codex CLI authentication preflight timed out; this reviewer is unavailable.');
}
if (auth.error && auth.error.code === 'ENOENT') {
  emitSkip('Codex CLI not installed (run: npm i -g @openai/codex && codex login).');
}
const authOut = `${auth.stdout || ''}${auth.stderr || ''}`;
const authOutcome = classifyChildOutcome(auth);
if (authOutcome && authOutcome.kind !== 'nonzero') {
  emitError(`${describeChildOutcome('Codex authentication preflight', authOutcome)}.`, 1);
}
if (/not logged in/i.test(authOut)) {
  emitSkip('Codex not authenticated — run `codex login`, or set CODEX_REVIEW_GATE=off to disable this gate.');
}
if (authOutcome?.kind === 'nonzero') {
  emitError(`${describeChildOutcome('Codex authentication preflight', authOutcome)}.`, 1);
}
if (!/logged in/i.test(authOut)) {
  emitSkip('Codex not authenticated — run `codex login`, or set CODEX_REVIEW_GATE=off to disable this gate.');
}

process.stderr.write(`[codex-gate] ${codex} ${reviewArgs.join(' ')}\n`);
process.stderr.write(`[codex-gate] transcript -> ${logFile}\n`);

// Serialize the metered `codex exec` against concurrent gate runs on this
// machine; released immediately after the run returns.
const codexLock = acquireCodexLock();

// Codex's transcript -> log file; stdout stays clean (final verdict only).
// Design mode pipes the brief+doc to stdin (positional `-`): if stdin stayed
// 'ignore', `input` would be discarded and codex would read EOF on `-` and
// review an empty prompt — a silent no-review. Diff mode has no stdin payload.
// argv carries `-o <path>`: under a shell that path is torn apart at its first
// space (a Windows account named "First Last" puts one in every temp path), so
// spawnCli spawns directly and quotes only when a script shim forces a shell.
// Not a convenience like the other gates' transcripts: this fd IS the child's
// stdout and stderr, so a throw here exits with a stack and no marker block —
// the same defect the work-dir guard above closes, two lines apart.
let fd;
try {
  fd = openSync(logFile, 'w');
} catch (err) {
  // The machine-wide lock is already held here, and emitError exits — without
  // this the lockfile survives with a dead pid and the next codex review waits
  // for it. Bounded (a dead owner is stolen) but pointless.
  releaseCodexLock(codexLock);
  emitError(`cannot open this review's transcript at ${logFile}: ${err.message}. `
    + 'Point TMPDIR (POSIX) or TEMP/TMP (Windows) at a directory that exists and is writable.', 1);
}
const res = spawnCli(codex, reviewArgs, isDesign
  ? {
    input: designPayload, stdio: ['pipe', fd, fd],
    timeout: timeoutMs, killSignal: 'SIGKILL',
  }
  : {
    stdio: ['ignore', fd, fd],
    timeout: timeoutMs, killSignal: 'SIGKILL',
  });
closeSync(fd);
releaseCodexLock(codexLock);
receipt.capture({ execution: { exitCode: res.status ?? null, signal: res.signal ?? null, completion: null } });

if (isSpawnTimeout(res)) {
  emitError(
    `codex review timed out after ${Math.round(timeoutMs / 1000)}s with no verdict. `
    + 'Raise CODEX_REVIEW_TIMEOUT_MS or AFK_REVIEW_TIMEOUT_MS, or narrow the target. '
    + 'Local transcript retained.',
    1,
  );
}

if (res.error && res.error.code === UNSAFE_SHELL_ARG) {
  // Operator input this gate cannot carry, not a reviewer that is unavailable:
  // ERROR, so the round is unclean and the target gets fixed, rather than SKIP,
  // which would hand the review to the next family and hide the bad ref.
  emitError(
    'cannot review this target: an argument cannot be represented safely by the required '
    + 'shell. Rename the ref or path, or install the CLI as a native binary.',
    1,
  );
}

const childOutcome = classifyChildOutcome(res);
if (childOutcome) {
  const subject = childOutcome.kind === 'launch_error'
    ? 'codex review process'
    : 'codex';
  emitError(`${describeChildOutcome(subject, childOutcome)}; no review was accepted.`, 1);
}

if (existsSync(finalFile)) {
  // requireVerdict stays false for codex: its prompt has never mandated a
  // verdict line (issue #28 contract correction, ratified on the issue).
  emitVerifiedReview(readFileSync(finalFile, 'utf8'), {
    emptyMessage: `codex wrote an empty verdict file (exit ${res.status}) — an empty result is an error, not an empty approval. Transcript: ${logFile}`,
    exitCode: res.status || 1,
  });
  process.exit(0);
}

// No verdict file: the review failed. Still emit a parseable block; never exit 0
// without a verdict. A pinned model the installed CLI does not know is rejected
// before any review runs and looks identical here, so name it as a suspect.
const modelHint = reviewModel
  ? ` If the CLI rejected model "${reviewModel}", upgrade codex or set CODEX_REVIEW_MODEL=inherit.`
  : '';
emitError(`codex produced no final message (exit ${res.status}). Transcript: ${logFile}${modelHint}`, res.status || 1);
