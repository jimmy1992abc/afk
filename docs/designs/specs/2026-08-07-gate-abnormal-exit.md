# Gates: an abnormal child exit is never a verdict

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#24 (from the #19 audit, gate-runtime P2s). Mechanical
scope; brief design per the scaling rule.

## Frozen issue contract

Acceptance criteria:

1. codex-gate: an empty or whitespace-only verdict file is an `ERROR`, never a
   review — today `existsSync(finalFile)` alone gates `emitReview`, so a
   zero-byte `-o` file becomes an empty clean review with exit 0. Mirrors the
   guard both siblings already carry (claude-gate "an empty result is an
   error, not an empty approval", test-pinned; kimi-gate's `!review` path).
   And a `res.signal` (signal-killed child, `res.error` null — verified shape
   in debate) reaching the verdict branch is an `ERROR` before the file is
   read: a kill during the `-o` write would otherwise present a partial file
   as the verdict, the exact class this issue's title names (R1-F2).
2. kimi-gate: any `res.error` or `res.signal` remaining after the specific
   checks (`UNSAFE_SHELL_ARG`, `ENOENT`, timeout) is an `ERROR`, never a
   REVIEW block — today ENOBUFS (output over `maxBuffer`) and an external
   signal kill leave truncated stdout that reaches `emitReview`, the exact
   "half a review presented as a verdict" hazard the file's own comment
   (:318-319) names. The guard sits after the specific checks (their distinct
   reasons win) and before any use of stdout.
3. kimi-gate's `maxBuffer` becomes overridable via
   `KIMI_REVIEW_MAX_BUFFER_BYTES` through the shared `positiveIntEnv`
   (default unchanged, 64 MiB) — an operator knob for long reviews on
   constrained machines, and the seam that lets a test produce a real ENOBUFS
   with a tiny bound instead of a 64 MiB fixture. The knob is documented as a
   Setup bullet in `afk-kimi-review/SKILL.md` (the established home for
   per-gate knobs; no other knob of its class is undocumented — R1-F5), and
   the ENOBUFS error message names it as the remedy (R1-F8).
4. Tests: codex stub writes an empty verdict file and exits 0 → nonzero
   `ERROR`, no REVIEW block; kimi stub prints partial output then SIGKILLs
   itself → nonzero `ERROR` naming the signal, no REVIEW block (asserting
   only status/ERROR/no-REVIEW — POSIX pipe writes are async, so the partial
   text's arrival is not guaranteed and must not be asserted — R1-F4); kimi
   stub floods stdout past a tiny `KIMI_REVIEW_MAX_BUFFER_BYTES` → nonzero
   `ERROR` (ENOBUFS path), no REVIEW block.
5. Version bumped 0.4.7 → 0.4.8 (skills/ ships) with manifests synced.

Engineering invariants: every new failure path emits a marker-parseable
`ERROR:` block with a distinct reason and the transcript path (no silent
skips, no bare stderr exits); exit codes stay nonzero; existing SKIPPED/ERROR
classifications and their tests are untouched.

Non-goals: timeout/kill mechanics (the Windows orphan-grandchild item stays
deferred in #19); the marker protocol itself (issue #28); codex's
`res.error`-before-verdict handling (already present); the codex bare-stderr
ENOENT/launch-failure exits (pre-existing pattern, recorded as an observation
— they exit nonzero, so the fail direction is right; making them
marker-parseable is a separate cleanup).

## Design

- codex-gate verdict branch: first `if (res.signal)` → `emitError` naming
  the signal (a killed child's partial file is not a verdict); then read the
  file, `trim()`; empty → `emitError` ("codex wrote an empty verdict file
  (exit N) — an empty result is an error, not an empty approval"), else
  `emitReview` as today.
- kimi-gate, after the timeout check and before `const review = out.trim()`:

  ```js
  if (res.error || res.signal) {
    emitError(`kimi did not exit normally (…code/signal…); any partial
    output is not a verdict. Transcript: ${logFile}`, 1);
  }
  ```

  ENOBUFS and future spawn-level errors land here with a distinct reason;
  the auth-skip and flag-drift branches below it are unreachable for an
  abnormal exit, which is correct — their diagnostics presume a child that
  ran to completion. The message prints **both** `res.error.code` and
  `res.signal` when present — a timeout-style kill sets both, and ENOBUFS
  arrives with `signal: SIGKILL` also set, so a signal-only message would
  mask the actionable class (R1-F8; shapes verified by execution). Ordering
  is load-bearing and pinned: the guard sits after `isSpawnTimeout` (a
  timeout sets both fields too, and its message is the actionable one) and
  the tail keeps the literal `process.exit(res.status ?? 1)` the source-pin
  test requires (R1-F6).
- kimi-gate `maxBuffer`: `positiveIntEnv('KIMI_REVIEW_MAX_BUFFER_BYTES',
  64 * 1024 * 1024)`.

## Test plan

Per AC 4. Kimi stubs follow that suite's `#!node` + win32-skip convention
(two new win32 skips); the codex stub follows that suite's cross-platform
`.cmd`/`.sh` wrapper convention instead (`withSleepingStub` shape) so the
empty-verdict test runs on both platforms, answers the auth preflight
(`Logged in` for the `status` argv), and sets `CODEX_GATE_NO_LOCK: '1'`
(R1-F7). The SIGKILL stub prints a partial line then `process.kill(
process.pid, 'SIGKILL')`; the ENOBUFS stub prints a few KiB against
`KIMI_REVIEW_MAX_BUFFER_BYTES=1024` (real ENOBUFS shape with partial stdout
verified by execution in debate — R1-F3).

## Debate record

- R1: F1 guard placement verified correct by execution (timeout sets both
  error and signal; order after `isSpawnTimeout` is load-bearing and
  test-pinned). F2 (P2, supported): codex `res.signal` + partially-written
  verdict file window contradicted the issue title and escaped the non-goal
  fence → AC 1 extended with a pre-read signal guard. F3/F4: both test
  recipes verified by execution incl. an end-to-end HEAD reproduction of the
  kimi fail-open; async-pipe caveat recorded in AC 4. F5 (minor): knob must
  be documented in the kimi SKILL.md → AC 3. F6: source-pin constraint on the
  tail recorded in Design. F7 (minor): stub conventions differ per suite →
  test plan corrected. F8 (minor): print code AND signal; ENOBUFS names the
  knob → AC 3/Design.
- R2: F2/F5/F7/F8 resolved by name, no new findings — clean round.
  Implementation starts here.
