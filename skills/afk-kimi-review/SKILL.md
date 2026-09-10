---
name: afk-kimi-review
description: "afk-kimi-review: Part of the afk pipeline. Runs Kimi (Kimi Code CLI or Kimi CLI) as the default final independent, read-only (prompt-requested) external review role after outer findings are resolved. Subject to ordered .afk/config.md gates and fallback priority. Triggers include \"/afk-kimi-review\", \"run kimi review\", \"kimi gate\"."
---

# afk-kimi-review

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

## Review receipts

To retain canonical inputs and explicit outcomes, use the optional
`--review-receipt <request.json>` flag under the
[shared receipt contract](../afk/SKILL.md#canonical-review-receipts). Preserve
unknown identity explicitly; skipped or incomplete attempts and previews never
supply approval.

## Review context

Use the [shared context contract](../afk/SKILL.md#supported-review-context) to
carry frozen acceptance scope and named prior findings with accessible proof.
`--review-phase re-review --review-context <packet.json>` preserves the selected
review target while supplying closure context; `--print-args` reports its digest.
Context and proof remain literal after console normalization. A prompt exceeding
the conservative native argv bound uses the existing UTF-8 brief-file transport;
native invocation keeps its no-shell boundary.

## Run it

The bundled helper `kimi-gate.mjs` sits beside this SKILL.md. Locate its
directory as `${CLAUDE_PLUGIN_ROOT}/skills/afk-kimi-review` if the env var is set,
else `<pluginRoot>/skills/afk-kimi-review` from `.afk/config.md`, else this
skill's own directory (the helper is its sibling). Resolve `.afk/` from the
repository's main working tree — the first non-bare `worktree` record of
`git worktree list --porcelain` — never the current directory, or a run from a
linked worktree reads a different `.afk/` than the one `afk-init` wrote. If
`.afk/` is absent, the `afk-init` bootstrap runs automatically first:

```text
node "<helper-dir>/kimi-gate.mjs"
```

Run it in the **background** with a generous timeout; redirect stdout to a file
and read it when it completes. Pass through any target flag (`--base <branch>` /
`--commit <sha>` / `--uncommitted`). Do not poll in a sleep loop.

Pass `--implementer <family>` when another model wrote the change. In design
mode (`--design`) the flag instead names the design's **author**, never the
eventual code implementer — see `../afk/SKILL.md` ("Design-stage external
gate"): declaring the code implementer there can hand a driver-authored design
to the driver's own model for review. A persistent `implementer:` line in
`.afk/config.md` also names the code implementer, and in design mode it can
wrongly block that family's independent review of a driver-authored design —
declare the design's author explicitly then: the per-run flag outranks the
config line.

**Design mode** (`--design <path>`) reviews a design document's reasoning instead
of a diff — the opt-in design-stage gate (see `../afk/SKILL.md`, "Design-stage
external gate"). Kimi is pointed at the document on disk and reads it with its own
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

## Handle findings (batch — minimise calls)

Identical discipline to `afk-codex-review`: map every hypothesis to the frozen
contract; admit P1 only on demonstrated evidence; batch-fix admitted P1 findings
with confirmed in-scope P2; self-review once; re-run after content
fixes; then record every other disposition without editing the clean revision or
spending another paid round.

Treat every reported finding as `UNTRIAGED`. Admit P1 only after mapping it to
the frozen issue contract or an invariant, demonstrating a reachable trigger
and wrong consequence, explaining why the current artifact cannot safely
advance, and naming the minimal causal fix. Do not edit for an untriaged claim;
fix confirmed in-scope structural P2 or record its deferral for the operator-owned
merge boundary; collect minor items for one final pass and defer out-of-scope work.

Fix confirmed in-scope structural findings, including P2, in one batch.
Defer documentation and cosmetic items to one final pass after structural
closure. A recorded decision may defer a structural P2 to the operator-owned
merge boundary. Unverified or out-of-scope suggestions authorize no edits.

Use the issue-wide allowance and finding record in `../afk/SKILL.md`
("Review-cycle allowance"). Initial review is comprehensive; re-review checks
accepted findings, the intervening diff, and affected regression paths. Broader
investigation requires specific evidence of an affected area. New evidenced
in-scope blockers remain reportable. Supply prior findings and verification
through supported context; missing context is unavailable, never invented.
Reviewer identity alone does not reopen a closed finding. Exhaustion leaves
unresolved work `OUTSTANDING`; finish the current cycle's validation without
starting another repair or requesting another round automatically.

Apply any invariant in `.afk/config.md` as an extra lens.

## Stop rule

Stop when the loop-termination rule in `../afk/SKILL.md` ("External gate")
holds: triage leaves no `UNTRIAGED`, `Contested`, or open admitted P1, and every
lower-severity item has a recorded disposition that does not block the role stamp (a
structural P2 may still bar auto-merge). That same verdict
earns the role stamp only if it requires no content change; a content fix
invalidates it and the role re-reviews the fixed revision.

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
