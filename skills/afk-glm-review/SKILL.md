---
name: afk-glm-review
description: Part of the afk pipeline. Runs GLM (Z.ai glm-5.2) as an independent, read-only external review gate on the current PR/branch, then triages and fixes the findings. Interchangeable with afk-codex-review and afk-kimi-review, subject to .afk/config.md gate priority and min-pass. Triggers include "/afk-glm-review", "run glm review", "glm gate", and "GLM external gate".
---

# afk-glm-review

An independent second-opinion review by Z.ai `glm-5.2`, used as an external gate
after `afk-internal-review`. It is interchangeable with `afk-codex-review` and
`afk-kimi-review`: run the number of gates required by `.afk/config.md`, and
never use a gate whose model matches the implementer's model.

GLM is reached through the Z.ai REST API, not an agentic CLI. The helper gathers
the diff and full current contents of changed files, then sends that bounded
context to GLM. Verify findings that depend on files outside that context.

The helper `glm-gate.mjs` ships with this skill and travels with the plugin.

## Metering

Metered like any external gate. Batch confirmed structural findings into one fix
pass, self-review, then re-run once. Defer minor items to a single final pass.

## Run it

The bundled helper `glm-gate.mjs` sits beside this SKILL.md. Locate its directory
as `${CLAUDE_PLUGIN_ROOT}/skills/afk-glm-review` if the env var is set, else
`<pluginRoot>/skills/afk-glm-review` from `.afk/config.md`, else this skill's own
directory. Resolve `.afk/` from the repository's main working tree — the first
`worktree` line of `git worktree list --porcelain` — never the current directory,
or a run from a linked worktree reads a different `.afk/` than the one `afk-init`
wrote. If `.afk/` is absent, the `afk-init` bootstrap runs automatically first:

```text
node "<helper-dir>/glm-gate.mjs"
```

Run it in the **background** with a generous timeout; redirect stdout to a file
and read it when it completes. Pass through any target flag (`--base <branch>` /
`--commit <sha>` / `--uncommitted`). Do not poll in a sleep loop.

Read the verdict between the `===== GLM REVIEW (final message) =====` markers.
`SKIPPED: ...` (no key, auth failure, HTTP error, or disabled via
`GLM_REVIEW_GATE=off`) is not a failure; record it and continue according to the
`afk` gate-selection rule.

## Handle findings

Use the same discipline as `afk-codex-review` and `afk-kimi-review`:

1. Sort structural findings from minor items.
2. Verify each finding against the cited `file:line`; GLM saw the diff and
   changed files, not the whole repo.
3. Fix confirmed structural findings in one batch and sweep for the same pattern.
4. Self-review once.
5. Re-run the gate once if structural findings were fixed.
6. Resolve minor items in a single final pass without another gate round.

Apply any invariant in `.afk/config.md` as an extra lens.

## Setup

Optional and self-skipping. Set `ZAI_API_KEY` or `GLM_API_KEY` in the environment
or a gitignored `.env`. Disable with `GLM_REVIEW_GATE=off`.

Config knobs:

- `GLM_REVIEW_MODEL` (default `glm-5.2`)
- `GLM_REVIEW_BASE_URL` (default `https://api.z.ai/api/anthropic`)
- `GLM_REVIEW_MAX_CTX_BYTES` (default `400000`)
