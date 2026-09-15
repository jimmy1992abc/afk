---
name: afk-claude-review
description: "afk-claude-review: Part of the afk pipeline. Independent read-only Claude review, a fallback role when Claude did not implement the change. Triggers include \"/afk-claude-review\", \"run claude review\", \"claude gate\"."
---

# afk-claude-review

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

Per-run `--model <alias-or-id>` and `--effort <level>` override
`CLAUDE_REVIEW_MODEL` and `CLAUDE_REVIEW_EFFORT` independently. The shared
`../../lib/gate/model-select.mjs` expands explicit `opus`, `fable`, `sonnet`,
and `haiku` aliases to pinned IDs; environment model values still require full
IDs. Efforts are `low`, `medium`, `high`, `xhigh`, and `max`. Defaults remain
`claude-opus-5` and `medium`; `--print-args` reports the effective selection.
Response identity verification still applies after alias expansion.

An independent second-opinion review by Claude, used as a fallback external role
after `afk-internal-review`; it is the default outer fallback when Codex is the
implementer. Run the ordered roles required by `.afk/config.md`, and never use a
reviewer whose model matches the implementer or another role.

**This gate exists for the case where Claude is not the implementer** — Codex,
Kimi, GLM, DeepSeek, MiMo, Gemini or Copilot wrote the change and Claude reviews
it. It refuses to run otherwise (see Independence below), so under a Claude Code driver it will
normally self-skip and the next gate in `priority` takes its place. That is the
intended behaviour, not a fault.

The helper `claude-gate.mjs` ships with this skill and travels with the plugin.

## Independence — this gate declines to review its own work

The gate resolves who wrote the change and skips if the answer is Claude:

1. `--implementer <family>` — per invocation. The only source that may permit a
   run as well as block one.
2. `implementer:` in `.afk/config.md` — may only **block**. A per-repo file
   written once must not outrank a live per-run signal.
3. `CLAUDECODE` in the environment — set by Claude Code in every process it
   spawns. Present and undeclared means the driver, and so probably the
   implementer, is Claude.

An unrecognised implementer value fails **closed**: the gate skips rather than
guess that it is independent.

Pass `--implementer <family>` whenever the implementer is not the driver — most
often when `afk-agent-relay` relayed the implementation to another model. In
design mode the flag names the design's author, not the code implementer (see
"Run it"). Known families: `claude`, `codex`, `kimi`, `glm`, `deepseek`, `mimo`, `gemini`, `copilot`.

**Known gap:** `CLAUDECODE` identifies the driver, not the model. A Claude
implementer driven from Copilot, Cursor, CI, or a plain terminal leaves it
unset, so the gate would run. Close it with `--implementer claude` or an
`implementer: claude` line in `.afk/config.md`.

## Read-only

The reviewer session loads `Read`, `Grep` and `Glob` and nothing else — no Bash,
no Write, no Edit. It is read-only by construction rather than by an allowlist,
so there is no command list to maintain and none to get wrong.

Because the reviewer has no shell, the gate pre-injects the diff and its stat
into the prompt; the reviewer uses its read tools for anything the diff does not
answer. This is the gate's advantage over `afk-glm-review`, whose reviewer is
limited to the snapshot it was sent.

## Metering

Metered like any external gate. Batch minimal admitted P1 fixes into one content pass, self-review, then re-run once. Record every other
disposition together at the end without editing a clean revision.

## Review context

Read [review evidence](../afk/references/review-evidence.md) before using
`--review-context`, `--review-phase` or `--review-receipt`.
Use `--print-prompt` to inspect the supplied section before a provider call.
Required history is validated and never silently truncated.

## Run it

The bundled helper `claude-gate.mjs` sits beside this SKILL.md. Read [environment](../afk/references/environment.md) to resolve its sibling
helper directory and bootstrap when needed.

```text
node "<helper-dir>/claude-gate.mjs"
```

Run it in the **background** with a generous timeout; redirect stdout to a file
and read it when it completes. Pass through any target flag (`--base <branch>` /
`--commit <sha>` / `--uncommitted`). Do not poll in a sleep loop.

Read [authorship declaration](../afk/references/external-review.md#authorship-declaration)
before choosing `--implementer`; design mode names the design author.

Add the flag only when that other model *actually* produced the artifact under
review — it can permit a run as well as block one (Independence above), so a
value copied in from an example defeats the self-skip this gate exists for.

**The review is bounded** by `CLAUDE_REVIEW_TIMEOUT_MS` (default 15 min), with
`AFK_REVIEW_TIMEOUT_MS` as the shared fallback. A timeout is a non-zero `ERROR`,
never a partial verdict; it follows the role's transient retry rule.

**Design mode** (`--design <path>`) reviews a design document's reasoning instead
of a diff — the opt-in design-stage gate (read [external design review](../afk/references/design-review.md#external-design-review)). The reviewer keeps its read-only `Read,Grep,Glob` tools, so it
can check whether the code says what the design claims. A missing or unreadable
`--design` path fails loudly (`ERROR`, non-zero), never a skip.

Read the verdict between the `===== CLAUDE REVIEW (final message) =====` markers. Treat only column-0 marker lines as markers; the last END marker wins.
A `SKIPPED: …` line is not a failure — record it and continue per the `afk`
gate-selection rule. The reasons are distinct on purpose, so the ledger can tell
"correctly declined" from "could not review":

- `SKIPPED: independence check — …` — the gate refused to review Claude's own
  work. Correct behaviour; use another gate.
- `SKIPPED: Claude gate disabled via CLAUDE_REVIEW_GATE.`
- `SKIPPED: Claude CLI not installed …`
- `SKIPPED: Claude not authenticated (HTTP 401) …`
- `SKIPPED: Configured model "…" is unavailable (HTTP 404) …`
- `SKIPPED: Claude is rate-limited or out of quota (HTTP 429) …` — the
  selection rule treats a rate-limited reviewer as unavailable; the next gate
  in priority takes its place.
- `SKIPPED: No changes found for …`

An `ERROR: …` line with a non-zero exit means the gate ran and could not produce
a verdict; that is not a clean round.

## Handle findings

Apply [review convergence](../afk/references/review-convergence.md) before triage,
repairs or re-review. Keep the issue's current finding record and allowance;
apply consuming `.afk/config.md` invariants as extra must-check lenses.

## Stop rule

Use the [canonical closure and stop rules](../afk/references/review-convergence.md)
to decide whether this revision earns the role stamp.

Report `CLEAN`, or `OUTSTANDING` with what remains. A clean pass is not
authority to merge.

## Setup

Optional and self-skipping. Needs the Claude Code CLI installed and logged in,
plus Node and `git` on PATH. Uses the operator's existing Claude subscription —
no API key. Disable with `CLAUDE_REVIEW_GATE=off`.

Config knobs:

- `CLAUDE_REVIEW_MODEL` (default `claude-opus-5`)
- `CLAUDE_REVIEW_EFFORT` (default `medium`)
- `CLAUDE_REVIEW_MAX_CTX_BYTES` (default `400000`)
- `CLAUDE_GATE_BIN` — override the resolved `claude` binary

No fallback model is passed: a quiet downgrade to a weaker reviewer is a quality
regression with no visible symptom, so an unavailable model surfaces as a skip.

## The reviewer model is pinned, and checked against what answered

`CLAUDE_REVIEW_MODEL` must be a full model ID. An alias (`opus`, `sonnet`) is
resolved by the host and can select an older generation without a symptom —
`--model opus` answered as `claude-opus-4-8` while the pipeline required a
current generation — so an alias is refused before any call is spent.

The gate then reads `modelUsage` in the result envelope and requires the
requested identity to be present; a dated snapshot of the same model satisfies
it, and the auxiliary models a normal run also bills are ignored. A review whose
envelope names another generation, or names nothing, is discarded with an
`ERROR` rather than attributed to a model that may not have run. Neither case is
a clean round:

- `ERROR: cannot review — CLAUDE_REVIEW_MODEL "…" is an alias …`
- `ERROR: reviewer identity unverified — requested "…" but …`
