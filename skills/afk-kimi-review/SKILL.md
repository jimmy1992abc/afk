---
name: afk-kimi-review
description: Part of the afk pipeline. Runs Kimi (Kimi CLI) as an independent, read-only external review gate on the current PR/branch, then triages and fixes the findings. Interchangeable with afk-codex-review and afk-glm-review, subject to .afk/config.md gate priority and min-pass. Internal review first, external gate last. Triggers include "/afk-kimi-review", "run kimi review", "kimi gate".
---

# afk-kimi-review

An independent second-opinion review by Kimi (a *different* model), used as the
**last** check before a PR is handed back for approval. Interchangeable with
`afk-codex-review` and `afk-glm-review`: run the configured external gate set
from `.afk/config.md`, and never use a gate whose model matches the implementer's
model. Run `afk-internal-review` first and resolve it, then run this gate:
internal review first, external gate last. Kimi reviews the diff read-only; you
triage and fix. Same role and output contract as the other gate skills; only the
underlying model differs.

The helper `kimi-gate.mjs` ships with this skill and travels with the plugin.

## Metering

Metered like any external gate — keep invocations to a minimum. Batch findings
into one fix pass, self-review, then re-run once; defer minor items to a single
final pass.

## Run it

The bundled helper `kimi-gate.mjs` sits beside this SKILL.md. Locate its
directory as `${CLAUDE_PLUGIN_ROOT}/skills/afk-kimi-review` if the env var is set,
else `<pluginRoot>/skills/afk-kimi-review` from `.afk/config.md`, else this
skill's own directory (the helper is its sibling). Resolve `.afk/` from the
repository's main working tree — the first `worktree` line of
`git worktree list --porcelain` — never the current directory, or a run from a
linked worktree reads a different `.afk/` than the one `afk-init` wrote. If
`.afk/` is absent, the `afk-init` bootstrap runs automatically first:

```text
node "<helper-dir>/kimi-gate.mjs"
```

Run it in the **background** with a generous timeout; redirect stdout to a file
and read it when it completes. Pass through any target flag (`--base <branch>` /
`--commit <sha>` / `--uncommitted`). Do not poll in a sleep loop.

Read the verdict between the `===== KIMI REVIEW (final message) =====` markers.
`SKIPPED: …` (Kimi absent, logged out, or disabled via `KIMI_REVIEW_GATE=off`)
is not a failure — report it and continue.

## Handle findings (batch — minimise calls)

Identical discipline to `afk-codex-review`: sort structural vs minor; verify each
finding against the cited `file:line` before trusting it; fix confirmed
structural findings in one batch and sweep for the pattern; self-review once;
re-run once; resolve minor items in a single final pass. Apply any invariant in
`.afk/config.md` as an extra lens.

## Stop rule

Stop when a round returns no new blocker findings, or findings narrow to your own
last fix, or it is a design-only doc. Report `CLEAN` or `OUTSTANDING`. A clean
pass is not authority to merge.

## Selection

Same role, same contract as the other external gate skills. The operator's
explicit choice wins; otherwise the `afk` skill's selection rule applies (skip
the implementer's own model). The round-1 gate choice is locked for later rounds
of the same PR; a mid-loop switch resets the finding baseline and is recorded.

## Setup (per machine, once)

Optional and self-skipping. Install the Kimi CLI and log in; needs Node + git on
PATH. Disable with `KIMI_REVIEW_GATE=off`.
