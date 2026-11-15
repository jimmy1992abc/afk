---
name: afk-gemini-review
description: "afk-gemini-review: Part of the afk pipeline. Independent read-only Gemini review, an optional external role. Triggers include \"/afk-gemini-review\", \"run gemini review\", and \"Gemini external gate\"."
---

# afk-gemini-review

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

For standalone review, run only the requested gate and return its verdict.
Follow [external review](../afk/references/external-review.md) for the distinction
between standalone invocation and driver-managed AFK sequencing.

An optional independent review by Gemini 4 Argon (`gemini-4-argon-high`)
through the operator's signed-in Antigravity CLI (`agy`). No API key is used.
Run it only when an explicit `.afk/config.md` `gates:` or `priority:` profile
selects Gemini, or when the operator invokes this skill directly. Never use it
when Gemini wrote the change or already occupies another ordered role.

Gemini receives the diff (or design document) as its one prompt turn on stdin
and may read files in the working tree by path. Read-only is **not enforced by
construction**: `--mode plan` and `--sandbox` restrict the agent (verified: no
workspace writes), and the prompt forbids changes, plans, subagents and swarms,
but `agy` still loads its full toolset. Prefer a by-construction gate (Claude,
Codex) where both qualify. `--disable-slash-commands` is deliberately not
passed: `agy` reports that it switches plan mode off.

## Review context

Read [review evidence](../afk/references/review-evidence.md) before using
`--review-context`, `--review-phase` or `--review-receipt`.
Use `--print-prompt` to inspect the supplied section before a provider call.
Required history is validated and never silently truncated.

## Run it

Read [environment](../afk/references/environment.md) to resolve
`gemini-gate.mjs` beside this skill and bootstrap when needed.

```text
node "<helper-dir>/gemini-gate.mjs"
```

Run it in the background with a generous timeout and save stdout for the run
record. Pass through `--base <branch>`, `--commit <sha>`, `--uncommitted`, or
`--design <path>`. Use `--print-args` for the resolved argv or `--print-prompt`
for the prompt without a model call. Do not poll in a sleep loop.

Read [authorship declaration](../afk/references/external-review.md#authorship-declaration)
before choosing `--implementer`; design mode names the design author.

The gate accepts a verdict only from a complete turn: `agy` exits 0, its
stream-json `result` reports `SUCCESS` with no `finished_reason`, the `init`
event names exactly the requested model, and no step shows delegation (a
`subagent` step, an unobserved step type, or an agent/swarm tool). Anything
else — a timeout (`--print-timeout`, exit 3), a failed or partial turn, a
missing or different identity, delegation, an empty or verdict-less answer —
is a non-zero `ERROR` with no partial verdict. A missing or invalid `--design`
target and an oversized diff are `ERROR`s too, never a skip or a truncation.
`agy` missing, not signed in, a model the account does not offer, and a rate
limit are `SKIPPED` — the reviewer is unavailable and the next family takes its
place, per the shared skip-vs-error table. Headless plan mode auto-denies
search and listing tools; a review that then answers nothing is an `ERROR`.

Read the verdict between the
`===== GEMINI REVIEW (final message) =====` markers. Treat only column-0
marker lines as markers; the last END marker wins. A `SKIPPED` result is not a
verdict; record it and follow [external review](../afk/references/external-review.md) for fallback.

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

Install the Antigravity CLI and sign in once by running `agy`. The installer
puts the binary at `~/.gemini/bin/agy`; run `~/.gemini/bin/agy install` to add
it to `PATH`, or set `GEMINI_GATE_BIN` to its path. `agy models` lists the
model IDs this account offers. The gate never reads `agy`'s credential files.
Disable with `GEMINI_REVIEW_GATE=off`.

Config knobs:

- `GEMINI_GATE_BIN` (default `agy`, resolved through `PATH`)
- `GEMINI_REVIEW_MODEL` (default `gemini-4-argon-high`; the effort is part of
  the ID — `-low`, `-medium`, `-high`. Only a versioned `gemini-*` ID is
  accepted, because `agy` also serves Claude and GPT models.)
- `GEMINI_REVIEW_MAX_CTX_BYTES` (default `400000`; a larger diff is an `ERROR`)
- `GEMINI_REVIEW_TIMEOUT_MS` (default `900000`; shared fallback
  `AFK_REVIEW_TIMEOUT_MS`), passed to `agy` as `--print-timeout`

Data handling: unlike the snapshot-backed API gates, nothing is excluded or
redacted — Gemini receives the raw diff, as Claude and Kimi do. `agy` keeps the
conversation, and may write plan artifacts, under `~/.gemini/antigravity-cli/`.
It may also load the repository's `GEMINI.md` and `.agents/` content and the
user's global `~/.gemini/GEMINI.md`.
