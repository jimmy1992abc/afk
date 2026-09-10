# Drive Kimi Through Its Documented Flags Only

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

- **Issue:** operator-reported (no tracker issue); the kimi gate ERRORs on every
  review against Kimi Code CLI 0.29.1
- **Status:** Revision 2 — after adversarial round 1 (K1–K9); converged on operator instruction
- **Author:** Claude (Opus 5)
- **Date:** 2026-08-04

## Problem

`kimi-gate.mjs` drives the CLI with `--quiet` on both of its transports:

```js
const promptArgs = [QUIET, '-p', reviewPrompt];          // primary, no shell
const stdinArgs  = [QUIET, '--input-format', 'text'];    // shim fallback, shelled
```

Kimi Code CLI **0.29.1 supports neither flag**, so both paths exit 1 with empty
stdout and the gate reports `kimi produced no final message (exit 1)` on every
review. Verified against the installed CLI, not inferred:

```text
$ kimi --version                → 0.29.1
$ kimi --quiet -p "hi"          → error: unknown option '--quiet'
$ kimi --help                   → -p, --prompt <prompt>
                                  --output-format <format>   (text | stream-json)
```

`--input-format`, `--print`, and `--final-message-only` do not appear in
`--help` at all. The documented headless surface is exactly `-p` plus
`--output-format`.

This shipped in #10, whose description asserted "`--quiet` is the CLI's own
alias for `--print --output-format text --final-message-only`" as verified. It
is not true of this build. The review that merged #10 accepted the claim
without running `kimi --help` — the same unverified-external-claim failure this
repo's debate rules exist to prevent, so the fix has to make the class
detectable, not just repair the flags.

**Why no test caught it:** every kimi-gate test drives a stub that ignores its
argv, so an invalid flag list is invisible to a green suite.

## Frozen issue contract

Acceptance criteria:

1. The gate invokes only flags this CLI documents: `-p <prompt>` and
   `--output-format text`. `--quiet` and `--input-format` disappear.
2. A Windows `.cmd` shim install — which #12 just made reachable — has a
   working transport. `--input-format` never existed here, so the prompt cannot
   go on stdin.
3. A future flag rejection is reported as flag drift, naming the CLI version,
   not as the generic "produced no final message".
4. The stubs reject unknown flags, so this class of drift fails a test instead
   of a paid review.
5. Both #10 constraints still hold: no multi-word payload in a shelled argv,
   and no non-ASCII on stdin (satisfied vacuously — stdin is unused).

Engineering invariants:

- **Overwrite, don't layer.** The `--quiet` constant, the stdin transport, and
  the ASCII-fold table exist only to serve flags being removed; they go with
  them rather than staying as dead alternatives.
- **A payload never transits a shelled argv.** Under a shell, argv carries
  flags and one quotable single-line instruction, never the brief (K5).

Non-goals:

- **The `•` prefix (bullet plus space) and 2-space continuation indent** this CLI adds to stdout.
  Pinned by experiment (`• alpha` / `␣␣beta`), pre-dates #10, and de-prefixing
  risks eating indentation a review legitimately owns. Recorded, not changed.
- No version detection or `--help` parsing: the two flags used are the
  documented intersection, and D3 diagnoses a rejection if that ever changes.
- No change to the prompt text, protocol, timeouts, or the independence guard.

## Decisions

### D1 — Primary transport: `-p <prompt> --output-format text`, no shell

The documented interface, spawned directly so argv reaches the child verbatim
(#10 rule 1). `--output-format text` is passed explicitly rather than relying
on its documented default, so a changed default cannot silently turn the review
into `stream-json`.

Verified end-to-end against the real CLI: exit 0, stdout carries the final
response and nothing else, reasoning goes to stderr.

### D2 — Shim fallback: the brief on disk, the path in argv

A Windows `.cmd`/`.bat` shim cannot start without a shell (EINVAL), and under a
shell a multi-word prompt in argv is torn apart by cmd.exe — #10's finding,
unchanged. #10 moved the payload to stdin; 0.29.1 has no stdin transport, so
that door is closed.

Instead the gate writes the review brief to a private temp file and passes a
short instruction naming it:

```text
kimi -p "Read the review brief at <path> in full; it is your task. Follow it exactly.
         Do NOT modify, stage, commit, write, or delete ANY file — review only."
     --output-format text
```

The read-only prohibition is repeated in argv rather than left to the brief
alone (K4): on this path it is the one line guaranteed to reach the model even
if the file is never read, and an agentic CLI with write tools must not receive
"follow it exactly" with no constraint attached.

argv is then flags plus one quotable path, which `quoteForShell` already
handles. The file is removed after the call. This is not a new idea in this
gate: design mode already points kimi at a document on disk rather than
injecting its text.

Verified against the real CLI: a brief written to a temp file and named this
way was read and followed. The Windows half (cmd.exe quoting of the path)
rests on `quoteForShell`, which #10 pinned.

**An unread brief must not become a verdict (K3).** By reference, a CLI that
never opened the file still exits 0 with fluent text, and nothing downstream
distinguishes that from a review. On this path only, the output must carry the
verdict vocabulary the prompt mandates (`APPROVE` / `APPROVE WITH COMMENTS` /
`REQUEST CHANGES`, or design mode's `SOUND` / `SOUND WITH CONCERNS` /
`RETHINK`); otherwise the gate errors naming the brief path. No extra spawn.

**The branch must be executable off Windows (K9).** `EINVAL` cannot be produced
on POSIX, and the last two Windows-only paths in this gate shipped having never
run anywhere. `KIMI_GATE_FORCE_SHIM` forces the transport — never the platform —
so a POSIX test drives the whole path.

The ASCII-fold table and its error branch are deleted with the stdin transport
they served: the payload no longer transits stdin, and argv carries non-ASCII
fine.

### D3 — A rejected flag is diagnosed as drift

When the review exits non-zero with empty stdout, the gate emits an ERROR that
names the CLI version and the exact argv it sent — **unconditionally**, not only
when a pattern matches (K7). A stderr pattern
(`unknown option|command`, `unrecognized option|argument`, `no such
option|command`, …) upgrades the message to a named flag-drift diagnosis, but it
is an optimization rather than the mechanism: this CLI has already spoken a
dialect that pattern would miss (`No such command 'are'`, recorded in this
gate's own header from a real run), so no regex can be the guarantee. No extra
spawn: the preflight already knows the version.

The drift ERROR is **stop-the-round, never transient-retryable** (K2): the same
flags are rejected on every attempt, and a transient classification would spend
a paid retry and then fall back to another family — hiding the defect exactly as
it was hidden before.

This is the control for the failure that actually happened — a helper and a CLI
drifting apart, reported as a mystery on every run until someone reads a
transcript.

### D4 — Stubs reject unknown flags

The reason a broken flag list rode a green suite. Every kimi stub gains an
allowlist — transcribed from `kimi --help`, 0.29.1 — and exits non-zero with
commander's own wording on anything outside it, so a rejection is matched
against the string the real CLI emits rather than one invented here.

The argv is asserted by **exact composition**, not by the absence of the two
dead strings (K8): an allowlist authored by the same commit encodes the author's
belief, and "contains neither `--quiet` nor `--input-format`" would pass forever
while catching no new flag. Asserting what the argv *is* fails on any future
addition without anyone having predicted it.

## Files to change

| File | Change |
|---|---|
| `skills/afk-kimi-review/kimi-gate.mjs` | D1–D3; delete `QUIET`, `stdinArgs`, `ASCII_FOLD`, `foldToAscii`, and the fold branch — **plus** the header comment carrying #10's false claim, the `${QUIET}` stderr banner (a `ReferenceError` otherwise), and **rewrite** the `--print-args` `fallback` descriptor, which must also tell the truth under the seam (K1). |
| `skills/afk-kimi-review/SKILL.md` | The flag-drift `ERROR` is stop-the-round, never transient-retryable (K2). |
| `scripts/kimi-gate.test.mjs` | Flag-rejecting stubs, argv-shape assertion, drift-diagnosis test, brief-on-disk fallback assertions. |
| `package.json` + manifests | Patch bump via `scripts/sync-marketplace.mjs`. |

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| A newer Kimi build does support `--quiet` and this "downgrades" it | None functional — `-p`/`--output-format` are documented on both | The intersection is the safe choice; D3 reports it loudly if even that drifts. |
| The shim fallback depends on kimi choosing to read the named file | A review of nothing, reported as a verdict | Verified against the real CLI; the instruction is explicit; the gate already depends on kimi following prose (it fetches the diff itself). |
| The brief file lands on disk | Same class of content the transcript already holds | Private temp dir, removed after the call, scoped to the shell path only. |
| The `•`/indent formatting reaches the review block | Cosmetic; a review with indented code shifts by 2 | Pre-existing and out of scope; recorded above with its evidence. |
| A non-ASCII temp path (a user named `José`) under cmd.exe (K6) | Unverified here; failure would be an unread brief, now caught by the verdict-line check | Node passes UTF-16 to `CreateProcess`; the deleted ASCII fold guarded stdin, not argv. |

## Adversarial review outcome

**Round 1** (same-model critic; lenses: contract completeness, the brief-on-disk
decision, deletion safety, the drift detector, test design) reported K1–K9. No
P1; every finding was accepted and fixed in Revision 2 rather than deferred:

- **K7 (P1 if AC3 is read literally, fixed):** the drift pattern recognized only
  commander's wording — and this CLI has already spoken another dialect, which
  this very file records (`No such command 'are'`, observed against real kimi).
  The pattern is widened, but the actual fix is that the CLI version and the
  exact argv now go into **every** no-output error, so a dialect nobody
  predicted is still diagnosable from one transcript line. The regex became an
  optimization rather than the mechanism.
- **K3 (P2, fixed):** nothing distinguished "read the brief and reviewed" from
  "never read it" — an unread brief yields fluent text that would be emitted as
  a verdict. The shim path now requires the verdict vocabulary the prompt
  mandates and errors naming the brief path otherwise.
- **K9 (P2, fixed):** the fallback could not execute on any machine here, which
  is exactly how #10 and #12 both shipped broken Windows paths.
  `KIMI_GATE_FORCE_SHIM` forces the transport (never the platform), and a
  POSIX-runnable test now asserts the exact argv, that the brief exists and is
  complete *at spawn time*, and that it is gone afterwards.
- **K4 (P2, fixed):** the read-only prohibition moved into the file with the
  brief, so on the one path where the file might not be read, an agentic CLI
  with write tools would have received "follow it exactly" and no constraint.
  It is now repeated in the argv instruction.
- **K1 (P2, fixed):** the deletion list missed the header comment carrying the
  false claim, the `${QUIET}` banner, and the `--print-args` descriptor.
- **K2 (P2, fixed):** the drift ERROR is classified stop-the-round in the gate
  skill, so it cannot be spent as a transient retry and then hidden by fallback.
- **K8 (P2, fixed):** an allowlist authored by the same commit encodes the
  author's belief, and the proposed "argv contains neither `--quiet` nor
  `--input-format`" assertion would pass forever while catching no new flag.
  The argv is now asserted by exact composition, so any future addition fails
  without anyone predicting it.
- **K5, K6 (minor, fixed):** the shelled-argv invariant is restated as "flags
  and one quotable single-line instruction, never the brief"; the
  `UNSAFE_SHELL_ARG` message now names the gate's own temp path as a cause; the
  non-ASCII temp-path residual is recorded below.

Debate closed here on the operator's convergence instruction: no P1 survived,
every fix is mechanical and verified against the artifacts, and the internal
review plus the external gate still read this revision.
