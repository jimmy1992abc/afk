#!/usr/bin/env node
// codex-gate.mjs — cross-platform external review wrapper around Codex.
//
// Runs `codex exec review` headless against a branch/commit/uncommitted diff
// and prints ONLY Codex's final review message on stdout (full transcript
// goes to a log file). Used by the afk-codex-review skill as a read-only,
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
//   (any extra flags are passed through to `codex exec review`)
//
// Review scope: Codex's built-in `review`. No custom focus prompt — codex-cli
// rejects a PROMPT alongside a diff selector (--base/--commit/--uncommitted),
// and the gate always selects one.
//
// Lean context: overrides config per run via `-c` (the operator's interactive
// Codex config is untouched):
//   - model_reasoning_effort=medium
//   - project_doc_max_bytes=0  (skip the project doc chain)
// Override via CODEX_REVIEW_REASONING / CODEX_REVIEW_PROJECT_DOC_MAX_BYTES.
//
// Exit code mirrors codex; 127 if the codex binary cannot be found.

import { spawnSync } from 'node:child_process';
import {
  existsSync, openSync, readFileSync, mkdtempSync,
  writeSync, closeSync, unlinkSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const isWin = process.platform === 'win32';

// ── Machine-wide serialization of `codex exec` runs ──────────────────────────
// Advisory lockfile in the OS temp dir, shared across repos/worktrees (the
// subscription auth is machine/account-wide, not per-repo). A peer holding
// the lock is WAITED for; a stale lock (dead PID, or older than TTL) is
// stolen. Escape hatch: CODEX_GATE_NO_LOCK=1 disables it.
// Lock path is anchored to homedir(), not os.tmpdir() (which can differ per
// process), so it matches the per-user auth boundary. Override with
// CODEX_GATE_LOCK_PATH.
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

function emitSkip(reason) {
  // Not a failure — the gate is optional. Emit the marker block, exit 0.
  process.stderr.write(`[codex-gate] skipped: ${reason}\n`);
  process.stdout.write('===== CODEX REVIEW (final message) =====\n');
  process.stdout.write(`SKIPPED: ${reason}\n`);
  process.stdout.write('===== END CODEX REVIEW =====\n');
  process.exit(0);
}

// Explicit opt-out: CODEX_REVIEW_GATE=off/0/false/no/disabled.
const gateFlag = (process.env.CODEX_REVIEW_GATE || '').trim().toLowerCase();
if (['off', '0', 'false', 'no', 'disabled'].includes(gateFlag)) {
  emitSkip('Codex gate disabled via CODEX_REVIEW_GATE.');
}

// No custom focus PROMPT is injected: codex-cli rejects a PROMPT alongside a
// diff selector, and the gate always selects a target.

function resolveCodex() {
  // Prefer PATH (works on macOS/Linux and Windows-with-PATH). On Windows also
  // fall back to the npm global shim, which isn't always on a child's PATH.
  if (isWin && process.env.APPDATA) {
    const shim = join(process.env.APPDATA, 'npm', 'codex.cmd');
    if (existsSync(shim)) return shim;
  }
  return 'codex';
}

function detectBase() {
  // origin/HEAD -> the repo's default branch (main/master/...); fall back sanely.
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], {
    encoding: 'utf8',
  });
  if (r.status === 0 && r.stdout.trim()) {
    return r.stdout.trim().replace(/^origin\//, '');
  }
  for (const b of ['main', 'master']) {
    const v = spawnSync('git', ['rev-parse', '--verify', b], { encoding: 'utf8' });
    if (v.status === 0) return b;
  }
  return 'main';
}

const userArgs = process.argv.slice(2);

// Hidden self-test for the lock only (no codex call): --selftest-lock[=holdMs].
// Acquires, optionally holds holdMs, releases, reports wait time.
const selftest = userArgs.find((a) => a.startsWith('--selftest-lock'));
if (selftest) {
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

const hasTarget = userArgs.some((a) =>
  ['--base', '--commit', '--uncommitted'].includes(a),
);

const work = mkdtempSync(join(tmpdir(), 'codex-gate-'));
const finalFile = join(work, 'review.txt');
const logFile = join(work, 'codex.log');

// Lean-context overrides (review THE DIFF, not the project doc corpus):
//   - model_reasoning_effort: default `medium`. Override via
//     CODEX_REVIEW_REASONING (minimal|low|medium|high|xhigh).
//   - project_doc_max_bytes: default 0 (skip the project doc chain).
//     Override via CODEX_REVIEW_PROJECT_DOC_MAX_BYTES. Parsed as TOML by `-c`.
const reasoning = (process.env.CODEX_REVIEW_REASONING || 'medium').trim();
const projectDocMaxBytes = (
  process.env.CODEX_REVIEW_PROJECT_DOC_MAX_BYTES || '0'
).trim();

const reviewArgs = ['exec', 'review'];
// Push lean defaults FIRST so an operator-supplied `-c key=...` in extra args
// still takes precedence (codex applies later -c overrides last).
reviewArgs.push('-c', `model_reasoning_effort=${reasoning}`);
reviewArgs.push('-c', `project_doc_max_bytes=${projectDocMaxBytes}`);

if (!hasTarget) reviewArgs.push('--base', detectBase());
reviewArgs.push(...userArgs);
reviewArgs.push('-o', finalFile);
if (isWin) reviewArgs.push('--dangerously-bypass-approvals-and-sandbox');
// Do NOT append a positional PROMPT — codex-cli rejects combining a diff
// selector with a PROMPT; the gate always selects a target.

const codex = resolveCodex();

// Availability + auth pre-check (local only, no model call / no metered cost).
// Skip cleanly if Codex is missing or not logged in.
const auth = spawnSync(codex, ['login', 'status'], { encoding: 'utf8', shell: isWin });
if (auth.error && auth.error.code === 'ENOENT') {
  emitSkip('Codex CLI not installed (run: npm i -g @openai/codex && codex login).');
}
const authOut = `${auth.stdout || ''}${auth.stderr || ''}`;
if (/not logged in/i.test(authOut) || !/logged in/i.test(authOut)) {
  emitSkip('Codex not authenticated — run `codex login`, or set CODEX_REVIEW_GATE=off to disable this gate.');
}

process.stderr.write(`[codex-gate] ${codex} ${reviewArgs.join(' ')}\n`);
process.stderr.write(`[codex-gate] transcript -> ${logFile}\n`);

// Serialize the metered `codex exec` against concurrent gate runs on this
// machine; released immediately after the run returns.
const codexLock = acquireCodexLock();

// Codex's transcript -> log file; stdout stays clean (final verdict only).
const fd = openSync(logFile, 'w');
const res = spawnSync(codex, reviewArgs, {
  stdio: ['ignore', fd, fd], // no stdin (no custom prompt); stdout/stderr -> log file
  shell: isWin, // needed to launch the .cmd shim on Windows
});
releaseCodexLock(codexLock);

if (res.error) {
  if (res.error.code === 'ENOENT') {
    process.stderr.write(
      '[codex-gate] codex CLI not found. Install with: npm i -g @openai/codex (then `codex login`).\n',
    );
    process.exit(127);
  }
  process.stderr.write(`[codex-gate] failed to launch codex: ${res.error.message}\n`);
  process.exit(1);
}

if (existsSync(finalFile)) {
  const review = readFileSync(finalFile, 'utf8').trim();
  process.stdout.write('===== CODEX REVIEW (final message) =====\n');
  process.stdout.write(review + '\n');
  process.stdout.write('===== END CODEX REVIEW =====\n');
  process.exit(res.status ?? 1);
}

// No verdict file: review failed. Still emit the marker block (parseable
// SKIPPED/ERROR/verdict); never exit 0 without a verdict.
process.stderr.write(
  `[codex-gate] No final message produced (exit ${res.status}). See ${logFile}\n`,
);
process.stdout.write('===== CODEX REVIEW (final message) =====\n');
process.stdout.write(
  `ERROR: codex produced no final message (exit ${res.status}). Transcript: ${logFile}\n`,
);
process.stdout.write('===== END CODEX REVIEW =====\n');
process.exit(res.status || 1);
