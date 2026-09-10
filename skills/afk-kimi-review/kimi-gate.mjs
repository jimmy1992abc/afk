#!/usr/bin/env node
// kimi-gate.mjs — cross-platform Kimi Code CLI external review wrapper.
//
// Drives the Kimi Code CLI (`kimi`) headlessly via
// `kimi -p "<prompt>" --output-format text`, spawned WITHOUT a shell, and prints
// ONLY Kimi's final review between markers (transcript -> log file). External
// review gate; run ONE gate per round, whose model differs from the
// implementer's.
//
// Kimi is a general agentic CLI with no built-in `review` subcommand, so this
// passes a review PROMPT and lets Kimi drive git itself.
//
// USE ONLY FLAGS `kimi --help` DOCUMENTS — literally: the argv is DERIVED from
// the installed CLI's own help text (lib/gate/cli-dialect.mjs), never
// transcribed here. Two products install a binary named `kimi` and their
// headless surfaces disagree; a pinned table is wrong on one of them, and the
// version strings do not separate them. A transcribed table shipped twice
// before — `--quiet`/`--input-format` from a newer build's help text, then a
// 0.29.1 table that every kimi-cli 1.x install rejects before the model call —
// and both times a helper/CLI disagreement wore the face of a broken reviewer.
// `KIMI_GATE_DIALECT` forces the group when a help layout defeats the parser.
//
// Two Windows-only constraints shape the invocation; both are verified against
// the real CLI, and each one silently killed the gate before:
//
//   1. NEVER put the prompt in argv under a shell. Node concatenates argv
//      unescaped there (DEP0190), so cmd.exe split the multi-word, multi-line
//      prompt and Kimi read its second word as a subcommand — "No such command
//      'are'", exit 2, on every single review.
//   2. There is NO stdin transport. `--input-format` does not exist on this CLI,
//      and an earlier attempt to use one also hit a stdin decoder that dies on
//      non-ASCII ("UnicodeEncodeError: … surrogates not allowed").
//
// Spawning directly (no shell) with the prompt in argv satisfies both. A `.cmd`
// shim is the one install that cannot start without a shell; there, and only
// there, the brief goes to a private file and argv carries its quotable path.
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
//   node kimi-gate.mjs --print-args    # resolve the target AND the CLI dialect; no model call
//
// Opt out with KIMI_REVIEW_GATE=off. Skips cleanly (exit 0) if kimi is missing
// or not logged in. Bounded by KIMI_REVIEW_TIMEOUT_MS (default 45 min); a review
// that outlives it ends as a non-zero ERROR, not a skip.

import { spawnSync } from 'node:child_process';
import {
  closeSync, openSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { resolveDialect } from '../../lib/gate/cli-dialect.mjs';
import {
  ASCII_PUNCTUATION_CONSTRAINT, encodingCrash, resolveConsole, toAsciiPunctuation,
} from '../../lib/gate/console-encoding.mjs';
import {
  isGateDisabled, isSpawnTimeout, positiveIntEnv, preflightTimeoutMs, reviewTimeoutMs,
} from '../../lib/gate/env.mjs';
import { guardFor } from '../../lib/gate/implementer.mjs';
import {
  buildDesignReviewPrompt, buildReviewPrompt,
} from '../../lib/gate/prompt.mjs';
import { createReceiptProtocol } from '../../lib/gate/review-receipt.mjs';
import { loadReviewContext } from '../../lib/gate/review-context.mjs';
import { gateWorkDir } from '../../lib/gate/workdir.mjs';
import {
  resolveCliBin, spawnCli, spawnViaShell, UNSAFE_SHELL_ARG,
} from '../../lib/gate/spawn.mjs';
import { parseTarget, validateTarget } from '../../lib/gate/target.mjs';

const isWin = process.platform === 'win32';
// Two call sites emit this (the preflight, and the review spawn if the binary
// disappears in between); it names WHICH of the two CLIs called `kimi` the
// install command installs.
const NOT_INSTALLED = 'Kimi CLI not installed (run: npm i -g @moonshot-ai/kimi-code && kimi login, which installs the npm Kimi Code CLI).';
const { receipt, protocol, argv: receiptArgs } = createReceiptProtocol({
  label: 'KIMI', slug: 'kimi-gate', family: 'kimi', argv: process.argv.slice(2),
});
const { emitSkip, emitError, emitVerifiedReview, emitPreview } = protocol;

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
});
if (reviewContext.error) emitError(`cannot review — ${reviewContext.error}`, 1);
receipt.capture({ context: reviewContext });

if (isGateDisabled('KIMI_REVIEW_GATE')) {
  emitSkip('Kimi gate disabled via KIMI_REVIEW_GATE.');
}

const userArgs = receiptArgs;
const printArgsOnly = userArgs.includes('--print-args');
// Prints the exact review prompt kimi would receive, and calls no model — the
// only way to observe that design mode swapped the diff context clause.
const printPromptOnly = userArgs.includes('--print-prompt');
const target = parseTarget(userArgs);
const isDesign = target.kind === 'design';

// A malformed --design is operator error that must fail loud on EVERY gate, even
// one about to self-skip, so a design target validates BEFORE the independence
// guard. A diff target validates after it.
// A target that could not be parsed is the same class of operator error: it
// must surface, not become an exit-0 skip when the guard happens to decline.
if (isDesign || target.kind === 'error') {
  const valid = validateTarget(target);
  if (!valid.ok) {
    emitError(`cannot review — ${valid.reason}`, 1);
  }
}

const guard = guardFor('kimi', userArgs);
if (!guard.run) {
  emitSkip(`independence check — ${guard.reason}`);
}

if (!isDesign) {
  const valid = validateTarget(target);
  if (!valid.ok) {
    emitError(`cannot review — ${valid.reason}`, 1);
  }
}

receipt.capture({ target });

// This gate's own context clause: kimi HAS tools, so it is told to go looking —
// the opposite of what glm must be told. See lib/gate/prompt.mjs.
//
// Design mode swaps the whole clause: the diff clause's `git show`/`git diff` is
// meaningless for a design, and pointing kimi at the doc ON DISK (rather than
// injecting its text) keeps a large doc out of the prompt entirely.
//
// The brief is composed with a SLOT per operand, not with the operands
// themselves. On a constrained console the fixed prose is normalised to ASCII
// punctuation, and normalising a brief that already carried the target would
// rewrite it: a design doc at `…/规格 — v2.md` becomes a path that does not
// exist, AFTER validateTarget confirmed the real one does — and the reviewer
// then takes the blame for not reading it. Which is this gate's own failure
// mode, rebuilt by the fix for it.
//
// Per OPERAND, not per argument: the builders take this gate's whole context
// clause as one argument, so a slot standing in for all of it would protect
// that clause's prose too — and in diff mode that prose holds the brief's only
// non-ASCII character, so the normalisation would reach nothing at all.
//
// NUL-delimited, because NUL is the one byte no path or ref can contain, so an
// operand can never collide with a slot.
const SLOT = { scope: '\u0000afk-scope\u0000', target: '\u0000afk-target\u0000' };
let reviewPrompt;
let operands;
if (target.kind === 'design') {
  const context = `Review the design document at ${SLOT.target} in this git repository. Read it in full first. Use git and read surrounding files to check any claim the design makes about the code. Do NOT modify, stage, commit, write, or delete ANY file — review only.`;
  reviewPrompt = buildDesignReviewPrompt({ scope: SLOT.scope, context });
  operands = [[SLOT.scope, target.label], [SLOT.target, target.path]];
} else {
  const inspect = target.inspect || `\`${target.command}\``;
  const context = `Inspect the target with ${SLOT.target} in this git repository. Use git and read surrounding files for context. Do NOT modify, stage, commit, write, or delete ANY file — review only.`;
  reviewPrompt = buildReviewPrompt({ scope: SLOT.scope, context });
  operands = [[SLOT.scope, target.label], [SLOT.target, inspect]];
}

// resolveCliBin, not the bare name: `npm i -g @moonshot-ai/kimi-code` — the
// install this gate's own skip message recommends — creates `kimi.cmd` with no
// `.exe`, and libuv's Windows PATH search appends only `.com`/`.exe`. Without
// this the preflight below ENOENTs and the gate reports a working CLI as "not
// installed". A no-op off Windows and whenever libuv can find the name itself.
const kimi = resolveCliBin((process.env.KIMI_GATE_BIN || 'kimi').trim());

// Kimi is a general agentic CLI: `-p` bounds neither the turn nor the tool
// calls inside it, so a review that stops converging blocks the driver for as
// long as the process lives. The 45-minute default is deliberately larger than
// the other gates: Kimi drives git itself rather than receiving a pre-injected
// diff, so it does real work before answering, and a bound that kills a review
// still making progress wastes the whole paid call and the role's sticky retry.
const timeoutMs = reviewTimeoutMs('kimi');

// KIMI_GATE_FORCE_SHIM exists because the shim branch is otherwise unreachable
// off Windows, and the last two Windows-only paths in this file shipped broken
// for exactly that reason. It forces the TRANSPORT, never the platform.
const forceShim = ['1', 'true', 'yes', 'on'].includes(
  (process.env.KIMI_GATE_FORCE_SHIM || '').trim().toLowerCase());

// Composed HERE, after `timeoutMs` is bound and before the --print-prompt exit:
// the probe is bounded by that timeout, and resolving at the template above
// would read `timeoutMs` in its temporal dead zone — a ReferenceError, a stack
// trace, and no marker block, which is the one output shape this protocol
// exists to guarantee.
const consoleEncoding = resolveConsole({
  override: process.env.KIMI_GATE_CONSOLE || '',
  probe: () => spawnCli('reg', [
    'query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP',
  ], { encoding: 'utf8', timeout: preflightTimeoutMs(timeoutMs), killSignal: 'SIGKILL' }),
});
if (!consoleEncoding.ok) emitError(`not retryable — ${consoleEncoding.reason}`, 1);
if (consoleEncoding.constrain) {
  reviewPrompt = `${toAsciiPunctuation(reviewPrompt)}\n${ASCII_PUNCTUATION_CONSTRAINT}`;
}
// split/join, never String.replace: with a string pattern, `replace` interprets
// `$&`, `` $` ``, `$'` and `$$` IN THE REPLACEMENT, so a ref or path carrying
// one is mangled — `feature/$&-fix` comes back with the slot re-inserted into
// the brief, and `$$` (a routine temp-path idiom) collapses.
for (const [slot, value] of operands) reviewPrompt = reviewPrompt.split(slot).join(value);
// Insert proof after console normalization so its bytes remain evidence.
reviewPrompt += `\n${reviewContext.section}`;

if (printPromptOnly) {
  emitPreview(`${reviewPrompt}\n`);
  process.exit(0);
}

// The shim fallback's instruction (see below). It repeats the read-only
// prohibition rather than leaving it to the brief alone: on this path the
// prohibition is the one line guaranteed to reach the model even if the file is
// never read, and an agentic CLI with write tools must not receive "follow it
// exactly" with no constraint attached.
const briefInstruction = (path) => `Read the review brief at ${path} in full; it is your task. Follow it exactly. Do NOT modify, stage, commit, write, or delete ANY file - review only.`;

// Availability pre-check (local, no model call). spawnCli, not a bare shell:
// KIMI_GATE_BIN is commonly an absolute path, and an account named "First Last"
// puts a space in it.
//
// This owns ENOENT — and must keep owning it, since its skip is the one that
// names the install command. The dialect probe below runs after it.
const ver = spawnCli(kimi, ['--version'], {
  encoding: 'utf8',
  timeout: preflightTimeoutMs(timeoutMs),
  killSignal: 'SIGKILL',
});
// A reviewer that cannot be run is UNAVAILABLE, which is a skip. Held rather
// than emitted so that --print-args can report it instead of exiting: a dry run
// must be able to say "no CLI here", not disappear into a skip.
let unavailable = null;
if (isSpawnTimeout(ver)) {
  unavailable = 'Kimi CLI preflight timed out; this reviewer is unavailable.';
} else if (ver.error && ver.error.code === 'ENOENT') {
  unavailable = NOT_INSTALLED;
}
// Kept for the drift diagnosis below: a helper and a CLI that disagree about a
// flag are only diagnosable if the error names which CLI answered.
const cliVersion = (ver.stdout || '').trim().split('\n')[0] || '';

// Which flags this CLI accepts, read from the CLI itself. `KIMI_GATE_DIALECT`
// REPLACES the probe rather than seeding it: it exists for an install whose
// help cannot be parsed — or cannot be obtained — so it must not depend on
// having read one.
const dialectOverride = (process.env.KIMI_GATE_DIALECT || '').trim();
let helpText = '';
if (!dialectOverride && !unavailable) {
  const help = spawnCli(kimi, ['--help'], {
    encoding: 'utf8',
    timeout: preflightTimeoutMs(timeoutMs),
    killSignal: 'SIGKILL',
    // SPREAD, never a bare object: `env` REPLACES the environment, so a bare
    // one loses PATH and every probe ENOENTs — which, classified as
    // unavailability above, would silently skip every review on a healthy
    // machine. The three variables pin the layout: Python help formatters wrap
    // to COLUMNS (commander ignores it), and a narrower wrap produces exactly
    // the description lines that begin with a flag.
    env: {
      ...process.env, COLUMNS: '200', NO_COLOR: '1', TERM: 'dumb',
    },
  });
  if (isSpawnTimeout(help)) {
    unavailable = 'Kimi CLI did not answer `--help` within the preflight bound; this reviewer is unavailable.';
  } else if (help.error) {
    unavailable = `Kimi CLI could not be run to read its \`--help\` (${help.error.code || help.error.message}); this reviewer is unavailable.`;
  } else {
    // The TEXT is the answer, not the exit code: a CLI that prints its help and
    // exits non-zero has still told the gate what it accepts. stdout when it
    // said anything, else stderr — some CLIs print help there. Never both
    // concatenated: one dash-leading warning line on the other stream would
    // join the option pool and, being at column 0, redefine the option column
    // and drop every real option.
    helpText = (help.stdout || '').trim() ? help.stdout : (help.stderr || '');
  }
}

const dialect = unavailable
  ? { ok: false, reason: unavailable }
  : resolveDialect({ helpText, override: dialectOverride });

// Primary transport: the payload as one argv element, spawned WITHOUT a shell.
const promptArgs = dialect.ok ? dialect.buildArgs(reviewPrompt) : null;
const shimArgs = (path) => dialect.buildArgs(briefInstruction(path));
// Doubling every UTF-16 operand covers Windows quoting expansion and fixed argv.
const MAX_NATIVE_ARGV_CHARS = 30000;
const nativeArgvBound = (args) => [kimi, ...args].reduce((sum, value) => sum + 2 * value.length + 3, 1);
const nativeBrief = !forceShim && Boolean(promptArgs && nativeArgvBound(promptArgs) > MAX_NATIVE_ARGV_CHARS);
// The prompt is elided wherever argv is shown: it is in the transcript, and a
// review brief on stderr is noise.
const shown = (args) => (args || []).map(
  (arg) => (arg === reviewPrompt ? `<${reviewPrompt.length}B structural review prompt>` : arg));

if (printArgsOnly) {
  emitPreview(`${JSON.stringify({
    bin: kimi,
    kind: target.kind,
    base: target.base ?? null,
    commit: target.commit ?? null,
    label: target.label,
    command: target.command ?? null,
    // The invocation SHAPE is part of the contract, not an implementation
    // detail: each Windows failure below is silent, model-call-expensive to
    // discover, and looks like an unavailable reviewer. Keep it observable.
    transport: forceShim || nativeBrief ? 'brief-file' : 'argv',
    shell: forceShim,
    // Null, never a table: the argv is a function of the installed CLI, so a
    // dry run with nothing to probe must say so rather than print a shape no
    // run would send.
    cliVersion: cliVersion || null,
    dialect: dialect.ok ? dialect.dialect : null,
    dialectSource: dialect.ok ? dialect.source : null,
    dialectReason: dialect.ok ? null : dialect.reason,
    args: dialect.ok ? (forceShim || nativeBrief ? shimArgs('<brief>') : promptArgs) : null,
    // The shim path's argv, with the brief's path standing in for the temp file
    // that only exists during the call. This CLI has no stdin transport at all,
    // so a payload that cannot ride argv has nowhere else to go but disk.
    fallback: dialect.ok
      ? { transport: 'brief-file', shell: true, args: shimArgs('<brief>') }
      : null,
    promptBytes: reviewPrompt.length,
    reviewPhase: reviewContext.phase,
    reviewContextDigest: reviewContext.digest,
    timeoutMs,
  }, null, 2)}\n`);
  process.exit(0);
}

if (unavailable) emitSkip(unavailable);
const workDir = gateWorkDir('kimi-gate-');
if (workDir.error) emitError(workDir.error, 1);
const work = workDir.path;
const logFile = join(work, 'kimi.log');

// After the workdir, deliberately. Precedence runs availability -> environment
// -> CLI interface: an absent reviewer is a skip whatever else is broken, and
// an environment that cannot hold a transcript is the more fundamental failure
// — reporting a flag disagreement while the gate has nowhere to write the
// evidence for it would send the operator after the wrong fault.
if (!dialect.ok) {
  // Not a skip: the CLI is present and answering, so this reviewer is not
  // unavailable — it is a helper and a CLI that disagree, and a skip would hand
  // the review to another family and hide that. Not retryable either: the same
  // help text answers the same way every time.
  emitError(
    `not retryable — cannot tell how to invoke this CLI: ${dialect.reason} `
    + `Installed version: ${cliVersion || 'unknown'}.`,
    1,
  );
}

// No context-leaning for Kimi (intentional): thinking effort stays at its
// default (KIMI_MODEL_THINKING_EFFORT applies only when a synthesized provider
// is set), and project-doc injection is session-level, not per-turn.
process.stderr.write(
  `[kimi-gate] ${kimi} ${shown(promptArgs).join(' ')}`
  + `${forceShim ? ' (brief on disk, via shell)' : ' (no shell)'}\n`,
);
process.stderr.write(`[kimi-gate] dialect -> ${dialect.dialect} (${dialect.source})\n`);
process.stderr.write(`[kimi-gate] timeout -> ${timeoutMs}ms\n`);
process.stderr.write(`[kimi-gate] transcript -> ${logFile}\n`);

const maxBufferBytes = positiveIntEnv('KIMI_REVIEW_MAX_BUFFER_BYTES', 64 * 1024 * 1024);
const spawnOpts = {
  encoding: 'utf8',
  maxBuffer: maxBufferBytes, // reviews can be long
  timeout: timeoutMs,
  killSignal: 'SIGKILL',
};

// NO SHELL, and that is the whole point: Node concatenates argv UNESCAPED under
// a shell (it warns about this, DEP0190), so cmd.exe split the multi-word,
// multi-line prompt and Kimi parsed its second word as a subcommand
// ("No such command 'are'", exit 2) — every Windows review died there. Spawned
// directly, the prompt survives verbatim, non-ASCII included, and the ~8191-char
// Windows command-line limit is not in reach (this gate sends instructions, and
// lets Kimi fetch the diff itself).
let briefPath = null;
const prepareBrief = () => {
  if (briefPath) return briefPath;
  const path = join(work, 'review-brief.md');
  try {
    writeFileSync(path, reviewPrompt, 'utf8');
  } catch (err) {
    emitError(`cannot hand the review brief to kimi: ${err.message}. Point TMP at a writable directory.`, 1);
  }
  briefPath = path;
  return path;
};
let sentArgs = nativeBrief ? shimArgs(prepareBrief()) : promptArgs;
if (nativeBrief) {
  if (nativeArgvBound(sentArgs) > MAX_NATIVE_ARGV_CHARS) emitError('native brief arguments exceed the command-line budget; shorten the temporary directory path', 1);
  process.stderr.write(`[kimi-gate] native brief delivery (no shell) -> ${briefPath}\n`);
}
// A forced shim must not buy a native review before the shell review.
let res;
try {
  res = forceShim
    ? { error: { code: 'EINVAL' } }
    : spawnSync(kimi, sentArgs, { ...spawnOpts, shell: false });
  if (forceShim || (isWin && res.error && res.error.code === 'EINVAL')) {
    sentArgs = shimArgs(prepareBrief());
    process.stderr.write(`[kimi-gate] ${forceShim ? 'shim transport forced (KIMI_GATE_FORCE_SHIM)' : 'script shim detected'}; brief on disk -> ${briefPath}\n`);
    process.stderr.write(`[kimi-gate] ${kimi} ${shown(sentArgs).join(' ')} (via shell)\n`);
    res = spawnViaShell(kimi, sentArgs, spawnOpts);
  }
} finally {
  if (briefPath) {
    try { unlinkSync(briefPath); } catch { /* already gone */ }
  }
}

const out = res.stdout || '';
const err = res.stderr || '';
try {
  const fd = openSync(logFile, 'w');
  writeSync(fd, `${out}\n----- stderr -----\n${err}`);
  closeSync(fd);
} catch {
  // The transcript is a convenience; losing it must not fail the review.
}

if (res.error && res.error.code === UNSAFE_SHELL_ARG) {
  // Operator input this gate cannot carry, not a reviewer that is unavailable:
  // ERROR, so the round is unclean and the target gets fixed, rather than SKIP,
  // which would hand the review to the next family and hide the bad ref.
  emitError(
    `cannot review this target: ${res.error.message}. This CLI is installed as a Windows `
    + 'script shim, which forces a shell; rename the ref or path — or, if the refused value is '
    + "this gate's own brief path, point TMP at a directory whose name cmd.exe can carry — or "
    + 'install the CLI as a native binary so its arguments never pass through cmd.exe.',
    1,
  );
}

if (res.error && res.error.code === 'ENOENT') {
  emitSkip(NOT_INSTALLED);
}

// A timed-out review is an ERROR, never a SKIPPED: the driver reads a skip as
// "this reviewer is unavailable, fall back to another family", and a hang says
// nothing about availability. As a transient error it gets the role's one sticky
// retry first. This must also precede the emitReview path — stdout may hold a
// partial answer, and half a review presented as a verdict is worse than none.
receipt.capture({ execution: { exitCode: res.status ?? null, signal: res.signal ?? null, completion: null } });

if (isSpawnTimeout(res)) {
  emitError(
    `kimi review timed out after ${Math.round(timeoutMs / 1000)}s with no verdict. `
    + `Raise KIMI_REVIEW_TIMEOUT_MS or AFK_REVIEW_TIMEOUT_MS, or narrow the target. Transcript: ${logFile}`,
    1,
  );
}

// ENOBUFS, an external signal kill, or any other spawn-level failure the
// specific checks above did not claim: whatever stdout holds is a fragment of
// an aborted run, and half a review presented as a verdict is worse than none.
// Both fields are printed — ENOBUFS arrives with SIGKILL also set, and a
// signal-only message would mask the actionable class.
if (res.error || res.signal) {
  const code = res.error ? (res.error.code || res.error.message) : '';
  const shown = [code, res.signal].filter(Boolean).join(', ');
  const remedy = code === 'ENOBUFS'
    ? ` Output exceeded the ${maxBufferBytes}-byte buffer; raise KIMI_REVIEW_MAX_BUFFER_BYTES.`
    : '';
  emitError(
    `kimi did not exit normally (${shown}); any partial output is not a verdict.${remedy} Transcript: ${logFile}`,
    1,
  );
}

const review = out.trim();

// stderr first, then stdout: a CLI that folds its traceback into its transcript
// stream must not escape the diagnosis. The cost is that a review ABOUT
// encodings could match its own text, on a path that is an ERROR either way.
//
// LAZY and BOUNDED, because this runs on every review: eager, it would scan and
// line-split up to `maxBufferBytes` of a perfectly good answer for a fault that
// is not there. A traceback lands at the END of the stream it aborts, so a
// tail of stdout is the part worth reading.
const CRASH_SCAN_TAIL = 64 * 1024;
let crashCache;
const crashInfo = () => {
  if (crashCache === undefined) {
    crashCache = encodingCrash(`${err}\n${out.length > CRASH_SCAN_TAIL ? out.slice(-CRASH_SCAN_TAIL) : out}`);
  }
  return crashCache;
};
const codePageNote = consoleEncoding.codePage ? ` (ANSI code page ${consoleEncoding.codePage})` : '';

// Keyed on WHICH signature matched, because the two are different events with
// different remedies. An output-punctuation constraint does nothing for a brief
// the CLI could not read, and a decode failure on the shim path IS a brief that
// never arrived — so that conclusion is kept, not displaced by this one.
const encodingFailure = () => (crashInfo().kind === 'decode'
  ? `kimi could not decode text this gate handed it: ${crashInfo().detail}.${briefPath
    ? ` The brief was written to ${work} as UTF-8 and read back under this machine's own encoding${codePageNote}, so it most likely never arrived — which is what a missing verdict on this transport means. Point KIMI_GATE_BIN at a native executable so the brief travels in argv instead of through a file.`
    : ` The payload this gate sent could not be decoded by the CLI${codePageNote}.`}`
  : `kimi crashed while writing its answer: ${crashInfo().detail}. A character the model wrote cannot be encoded by this machine's ANSI code page${codePageNote}, so the CLI died mid-write: the review was lost to the transport, NOT to a reviewer that failed to answer.${consoleEncoding.constrain
    ? ' The ASCII-punctuation constraint was applied on this run, so the model wrote a character it was asked not to.'
    : ` The constraint was NOT applied on this run (${consoleEncoding.source === 'override' ? 'KIMI_GATE_CONSOLE forced it off' : 'the probe read the code page as UTF-8'}); force it with KIMI_GATE_CONSOLE=legacy.`}`);

// Not authenticated -> clean skip. Requires an EMPTY review as well as the
// keyword, so a real review that merely mentions login/auth cannot be
// misread as an auth failure.
if (!review && /no model configured|use \/login|\bkimi login\b|not (logged in|authenticated)|unauthorized|please (log|sign) in/i.test(err)) {
  emitSkip('Kimi not authenticated — run `kimi login`, or set KIMI_REVIEW_GATE=off to disable this gate.');
}

if (!review && crashInfo()) {
  // The reported symptom: forty minutes of paid review, discarded, and the
  // gate blaming the reviewer for a fault in the transport.
  emitError(`${encodingFailure()} Transcript: ${logFile}`, res.status || 1);
}

if (!review) {
  // A rejected flag is the failure this gate actually shipped: `--quiet` and
  // `--input-format`, asserted from a newer build's help text, do not exist in
  // 0.29.1, so every review exited 1 with empty stdout and reported "no final
  // message" — a broken-reviewer story for a helper/CLI disagreement. The
  // pattern below recognizes the dialects these CLIs use, but it is an
  // optimization, NOT the mechanism: the version and the exact argv go into
  // every no-output error, so a dialect nobody predicted is still diagnosable
  // from one transcript line.
  const argvShown = JSON.stringify(shown(sentArgs));
  // A rejected VALUE is drift too: kimi-cli 1.x answers `Invalid value for
  // --output-format: Output format is only supported for print UI`, which none
  // of the unknown-option dialects match, so the failure that this whole file
  // exists for would otherwise arrive as a generic empty review.
  const drifted = /unknown (option|command)|unrecognized (option|argument)|no such (option|command)|is not a recognized|invalid option|invalid value for|is only supported|unsupported option/i.exec(err);
  // The whole rejection LINE, not just the matched token: `Invalid value for`
  // alone tells an operator nothing, while the CLI's own sentence usually names
  // both the flag and what it wanted instead. Capped — some CLIs print a usage
  // block after it.
  const rejection = drifted
    ? (err.split(/\r?\n/).find((line) => line.includes(drifted[0])) || drifted[0]).trim().slice(0, 300)
    : '';
  if (drifted) {
    // Never transient: the same flags are rejected on every retry, so a retry
    // spends a paid call to relearn this. The round stops here.
    emitError(
      `not retryable — kimi rejected an argument this gate sent (${rejection}) — the helper and the installed `
      + `CLI disagree about the flag list. Installed version: ${cliVersion || 'unknown'}. `
      + `Dialect: ${dialect.dialect} (${dialect.source}). Sent: ${argvShown}. `
      + `${dialect.source === 'override'
        ? 'That dialect was forced by KIMI_GATE_DIALECT; unset it to read the flag list from the CLI instead.'
        : `Check what \`${kimi} --help\` documents, or force a group with KIMI_GATE_DIALECT.`} `
      + `Transcript: ${logFile}`,
      res.status || 1,
    );
  }
  emitError(
    `kimi produced no final message (exit ${res.status}) with version ${cliVersion || 'unknown'}, `
    + `dialect ${dialect.dialect} (${dialect.source}), and argv ${argvShown}. Transcript: ${logFile}`,
    res.status || 1,
  );
}

// A CLI that died mid-write leaves a FRAGMENT on stdout, and a fragment that
// happens to carry a verdict word is accepted by the protocol as a verdict.
// That is the fail-open half of the encoding bug, and it is worse than the
// reported symptom. Scoped to non-empty stdout deliberately: the empty-stdout
// paths above own the auth SKIP (a logged-out reviewer must still fall back to
// another family) and the `not retryable —` flag-drift diagnosis, and neither
// may be swallowed by this rule.
//
// It rests on an assumption nothing here can verify — that a successful review
// exits 0. `kimi -p …` is a paid call. If it is wrong, every review on that
// install errors, retries once, and falls back; the ERROR says exactly that
// shape so one round of transcripts identifies it.
if (res.status !== 0) {
  emitError(
    `kimi exited ${res.status} while stdout held a review-shaped answer, so that answer is a `
    + `fragment of an aborted run, not a verdict.${crashInfo() ? ` ${encodingFailure()}` : ''} `
    + `Transcript: ${logFile}`,
    res.status,
  );
}

// The prompt mandates a verdict line on every transport; its absence means
// the review did not follow the brief. On the shim path — where the brief
// travels by file reference — it more specifically means the brief was most
// likely never read, so that path keeps its own diagnosis. An encoding fault
// outranks both, EXCEPT a decode failure on the shim path, where the two are
// the same event and `encodingFailure` already says so.
emitVerifiedReview(review, {
  requireVerdict: true,
  mode: target.kind === 'design' ? 'design' : 'diff',
  missingVerdictMessage: (() => {
    if (crashInfo()) return `${encodingFailure()} Transcript: ${logFile}`;
    if (briefPath) {
      return 'kimi answered without the verdict line its brief requires, so the brief handed to it '
        + `(written to ${work} for the duration of the call, then removed) was most likely never read. `
        + 'This install is a Windows script shim, whose only '
        + 'transport is a file reference. Point KIMI_GATE_BIN at a native executable. '
        + `Transcript: ${logFile}`;
    }
    // Today's default names no transcript, leaving the operator un-pointed at
    // the log that holds the answer.
    return 'kimi answered without the mandated verdict line; the review is discarded rather than '
      + `presented as a verdict. Transcript: ${logFile}`;
  })(),
});
// `?? 1`, never `?? 0`: a null status means kimi died on a signal, and a review
// that was killed must not exit clean.
process.exit(res.status ?? 1);
