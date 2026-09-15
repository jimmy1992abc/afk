---
name: afk-kimi-review
description: "afk-kimi-review: Part of the afk pipeline. Independent Kimi review, the default final role when configured; read-only is prompt-requested. Triggers include \"/afk-kimi-review\", \"run kimi review\", \"kimi gate\"."
---

# afk-kimi-review

Read [AFK environment](../afk/references/environment.md) before resolving
configuration, local state or bundled helper paths.
Before invoking this gate, read [external review](../afk/references/external-review.md)
and [review convergence](../afk/references/review-convergence.md). They own role
selection, authorship declaration, admission, repair allowance and closure.
Before supplying context/receipts or reusing receipts, read
[review evidence](../afk/references/review-evidence.md). Before `--design`, read
[external design review](../afk/references/design-review.md#external-design-review).
Reuse only the same installed revision already read and still in context;
otherwise reread it. Apply these routes for standalone invocations too.

An independent second-opinion review by Kimi (a *different* model), used as the
default **final** role after internal review and all outer findings are resolved.
Run the ordered `gates` profile from `.afk/config.md`, and never use a reviewer
whose model matches the implementer or another role. Kimi reviews the diff
read-only — requested in the prompt, not enforced by construction (Kimi drives
git itself) — you triage and fix.

The helper `kimi-gate.mjs` ships with this skill and travels with the plugin.

## Metering

Metered like any external gate — keep invocations to a minimum. Batch minimal admitted P1 fixes into one content pass, self-review, then
re-run once. Record every other disposition together at the end without editing
a clean revision.

## Review context

Read [review evidence](../afk/references/review-evidence.md) before using
`--review-context`, `--review-phase` or `--review-receipt`.
Context and proof remain literal after console normalization. A prompt exceeding
the conservative native argv bound uses the existing UTF-8 brief-file transport;
native invocation keeps its no-shell boundary.

## Run it

The bundled helper `kimi-gate.mjs` sits beside this SKILL.md. Read [environment](../afk/references/environment.md) to resolve its sibling
helper directory and bootstrap when needed.

```text
node "<helper-dir>/kimi-gate.mjs"
```

Run it in the **background** with a generous timeout; redirect stdout to a file
and read it when it completes. Pass through any target flag (`--base <branch>` /
`--commit <sha>` / `--uncommitted`). Do not poll in a sleep loop.

Read [authorship declaration](../afk/references/external-review.md#authorship-declaration)
before choosing `--implementer`; design mode names the design author.

**Design mode** (`--design <path>`) reviews a design document's reasoning instead
of a diff — the opt-in design-stage gate (read [external design review](../afk/references/design-review.md#external-design-review)). Kimi is pointed at the document on disk and reads it with its own
tools (keeping a large doc off the argv). A missing or unreadable `--design` path
fails loudly (`ERROR`, non-zero), never a skip.

**The review is bounded** by `KIMI_REVIEW_TIMEOUT_MS` (default 45 min), with
`AFK_REVIEW_TIMEOUT_MS` as the shared fallback. Kimi is a general agentic CLI,
so nothing else ends a turn that stops converging. A review that outlives the
bound is reported as a non-zero `ERROR`, never a `SKIPPED`: a hang says nothing
about whether this reviewer is available, so it takes the role's transient retry
rather than an immediate fallback to another family.

Read the verdict between the `===== KIMI REVIEW (final message) =====` markers. Treat only column-0 marker lines as markers; the last END marker wins.
`SKIPPED: …` (Kimi absent, logged out, or disabled via `KIMI_REVIEW_GATE=off`)
is not a failure — report it and continue. `ERROR: …` means the review itself
failed or timed out — read the transcript it names; never report an errored run
as clean.

`KIMI_GATE_FORCE_SHIM=1` forces the Windows brief-on-disk transport on any
platform. It exists so that path is testable off Windows — `EINVAL` cannot be
produced on POSIX — and it makes the review indirect (the brief travels by file
reference). Never set it for a real review.

An `ERROR` whose message begins **`not retryable —`** must not be retried and
must not fall back. It means the helper and the installed CLI disagree about how
this CLI is invoked — a rejected flag, a rejected value, a dialect that could
not be resolved, or an unrecognised `KIMI_GATE_DIALECT`. Every retry is answered
identically and every fallback hides the defect, which is how this gate once
reported "produced no final message" on every review. Stop the round and report
it; the message names the installed version, the exact argv, and the resolved
dialect with its source. Key the rule on that prefix, not on any one sentence.

**On a non-UTF-8 Windows machine** the gate adds an ASCII-punctuation
constraint to the brief and normalises the brief's own prose, because one
character the model writes that the machine's ANSI code page cannot encode
kills the CLI mid-write and loses the whole paid review. Measured: on cp936 the
crashers are the typographic minus and the no-break space — em dashes and curly
quotes encode fine there, and cp932/949/950 reject a different set. The
constraint is asked for, not enforced, so an `ERROR` that names an encoding
crash is the real net: read it as a transport fault, never as a reviewer that
failed to answer, and never as a reason to doubt the reviewer. Such an `ERROR`
**is** worth one retry — unlike a flag disagreement, the crash depends on which
characters the model happened to choose.

**Two different CLIs are named `kimi`** — the npm Kimi Code CLI
(`@moonshot-ai/kimi-code`) and MoonshotAI's Python Kimi CLI, whose headless
flags disagree — so the gate reads the flag list from the installed CLI's own
`--help` before each review rather than carrying a table. It reports the
resolved dialect on stderr. A print-mode CLI documenting no
`--final-message-only` is refused before the call, not warned about: its answer
would be a whole transcript, and a transcript containing a verdict word cannot
be told apart from a verdict, so such a review could read as clean.

## Handle findings

Apply [review convergence](../afk/references/review-convergence.md) before triage,
repairs or re-review. Keep the issue's current finding record and allowance;
apply consuming `.afk/config.md` invariants as extra must-check lenses.

## Stop rule

Use the [canonical closure and stop rules](../afk/references/review-convergence.md)
to decide whether this revision earns the role stamp.

Report `CLEAN`, or `OUTSTANDING` with what remains. A clean pass is not
authority to merge.

## Selection

Kimi is the default final role, not a generic second pass. The operator's
explicit ordered profile wins; otherwise the `afk` skill's role/fallback rule
applies (skip the implementer's and already-used models). The provider is locked
to final for later sequences; a substitution is recorded and resets only its
provider-specific finding baseline.

## Setup (per machine, once)

Optional and self-skipping. Install either Kimi CLI — `npm i -g
@moonshot-ai/kimi-code` (the npm Kimi Code CLI) or MoonshotAI's Python Kimi CLI
— and log in; needs Node + git on PATH. Disable with `KIMI_REVIEW_GATE=off`.

Config knobs:

- `KIMI_REVIEW_MAX_BUFFER_BYTES` (default `67108864`, 64 MiB) — the output
  buffer bound; output past it aborts the run as an `ERROR`, never a truncated
  verdict.
- `KIMI_GATE_DIALECT` (`prompt` · `print` · `print-positional`) — forces the
  headless flag group and **replaces** the `--help` probe. For an install whose
  help layout the parser cannot read; unset, the gate derives the group. An
  unrecognised value stops the round rather than falling back to probing.
- `KIMI_GATE_CONSOLE` (`legacy` · `utf8`) — forces the encoding constraint on or
  off and **replaces** the code-page probe. `legacy` is the remedy when a review
  still dies with an encoding crash on a machine whose ANSI code page reads as
  UTF-8; `utf8` opts out. Unset, the gate probes. An unrecognised value stops the
  round. It also makes the Windows-only branch runnable off Windows, which is
  the only way this repo can test it at all.
