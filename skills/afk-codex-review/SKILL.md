---
name: afk-codex-review
description: Part of the afk pipeline. Runs Codex (OpenAI Codex CLI) as an independent, read-only external review gate on the current PR/branch, then triages and fixes the findings. Interchangeable with afk-kimi-review — run exactly ONE external gate per round, whose model differs from the implementer's. The last check before a PR is handed back: internal review first, external gate last. Triggers include "/afk-codex-review", "run codex review", "codex gate".
---

# afk-codex-review

An independent second-opinion review by Codex (a *different* model), used as the
**last** check before a PR is handed back for approval. It is interchangeable
with `afk-kimi-review`: run exactly **one** external gate per round, whose model
(1) is not the model that implemented the change and (2) is a current-generation
mainstream frontier model. Run `afk-internal-review` first and resolve it, then
run this gate: internal review first, external gate last. Codex reviews the diff
read-only; you triage and fix.

The helper `codex-gate.mjs` ships with this skill and travels with the plugin.

## Metering

Codex calls are metered — keep invocations to a minimum. Batch every finding into
one fix pass, self-review, then re-run once; defer documentation and minor items
to a single final pass. Never spend a round-trip on a small or doc-only edit.

## Run it

The bundled helper `codex-gate.mjs` sits beside this SKILL.md. Locate its
directory as `${CLAUDE_PLUGIN_ROOT}/skills/afk-codex-review` if the env var is
set, else `<pluginRoot>/skills/afk-codex-review` from `.afk/config.md`, else this
skill's own directory (the helper is its sibling). If `.afk/` is absent, the
`afk-init` bootstrap runs automatically first:

```text
node "<helper-dir>/codex-gate.mjs"
```

Run it in the **background** with a generous timeout (the review traces code
paths and may run tests); redirect stdout to a file and read it when it
completes. Pass through any target flag (`--base <branch>` / `--commit <sha>` /
`--uncommitted`; default = current branch vs the default branch). Do not poll in
a sleep loop — wait for completion.

Read the verdict between the `===== CODEX REVIEW (final message) =====` markers.
`SKIPPED: …` (Codex absent, logged out, or disabled via `CODEX_REVIEW_GATE=off`)
is not a failure — report it and continue. `ERROR: …` means the review itself
failed — read the transcript it names; never report an errored run as clean.

## Handle findings (batch — minimise calls)

1. **Sort by kind.** Structural (architecture, correctness, security, missed
   edge cases) — act on these. Minor (naming, cosmetics) — defer to one final
   pass.
2. **Verify before trusting.** Each finding is a hypothesis; read the cited
   `file:line`. Push back with evidence on anything you can disprove.
3. **Fix every confirmed structural finding in one batch**, and sweep for the
   same pattern elsewhere; keep specs in sync in the same change.
4. **Self-review once** over your fixes.
5. **Re-run the gate once.** Repeat until the stop rule holds.
6. **Deferred pass once, at the end** for the minor items — do not re-run the
   gate to confirm doc edits.

Apply any invariant in `.afk/config.md` as an extra must-check lens.

## Stop rule

Stop when a round returns no new blocker findings — only minor or
implementation-detail — or the findings are narrowing to your own last fix's
wording, or it is a design-only doc whose remainder TDD will enforce in code.
Report honestly: `CLEAN`, or `OUTSTANDING` with what remains. A clean pass is not
authority to merge — hand back to the operator.

## Setup (per machine, once)

Optional and self-skipping. `npm i -g @openai/codex && codex login`; needs Node +
git on PATH. Disable with `CODEX_REVIEW_GATE=off`.
