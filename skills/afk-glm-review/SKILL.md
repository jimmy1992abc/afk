---
name: afk-glm-review
description: "afk-glm-review: Part of the afk pipeline. Independent read-only GLM review, a fallback external role. Triggers include \"/afk-glm-review\", \"run glm review\", \"glm gate\", and \"GLM external gate\"."
---

# afk-glm-review

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

An independent second-opinion review by Z.ai `glm-5.3`, used as a fallback role
after `afk-internal-review`. Run the ordered roles required by `.afk/config.md`,
and never use a reviewer whose model matches the implementer or another role.

GLM is reached through the Z.ai REST API, not an agentic CLI. The helper gathers
the diff and full current contents of changed files, then sends that bounded
context to GLM. Verify findings that depend on files outside that context.

The helper `glm-gate.mjs` ships with this skill and travels with the plugin.

## Metering

Metered like any external gate. Batch minimal admitted P1 fixes into one content pass, self-review, then re-run once. Record every other
disposition together at the end without editing a clean revision.

## Review context

Read [review evidence](../afk/references/review-evidence.md) before using
`--review-context`, `--review-phase` or `--review-receipt`.
Use `--print-prompt` to inspect the supplied section before a provider call.
Required history is validated and never silently truncated.

## Run it

The bundled helper `glm-gate.mjs` sits beside this SKILL.md. Locate its directory
as `${CLAUDE_PLUGIN_ROOT}/skills/afk-glm-review` if the env var is set, else
`<pluginRoot>/skills/afk-glm-review` from `.afk/config.md`, else this skill's own
directory. Resolve `.afk/` from the repository's main working tree — the first non-bare
`worktree` record of `git worktree list --porcelain` — never the current directory,
or a run from a linked worktree reads a different `.afk/` than the one `afk-init`
wrote. If `.afk/` is absent, the `afk-init` bootstrap runs automatically first:

```text
node "<helper-dir>/glm-gate.mjs"
```

Run it in the **background** with a generous timeout; redirect stdout to a file
and read it when it completes. Pass through any target flag (`--base <branch>` /
`--commit <sha>` / `--uncommitted`). Do not poll in a sleep loop.

Read [authorship declaration](../afk/references/external-review.md#authorship-declaration)
before choosing `--implementer`; design mode names the design author.

**The review is bounded** by `GLM_REVIEW_TIMEOUT_MS` (default 15 min), with
`AFK_REVIEW_TIMEOUT_MS` as the shared fallback. A timeout is a non-zero `ERROR`,
never a partial verdict; it follows the role's transient retry rule.

**Design mode** (`--design <path>`) reviews a design document's reasoning instead
of a diff — the opt-in design-stage gate (read [external design review](../afk/references/design-review.md#external-design-review)). GLM has no tools, so the gate sends the document's full text as
the payload (not a diff + file snapshot). A missing or unreadable `--design` path
fails loudly (`ERROR`, non-zero), never a skip.

Read the verdict between the `===== GLM REVIEW (final message) =====` markers. Treat only column-0 marker lines as markers; the last END marker wins.
`SKIPPED: ...` (no key, auth failure, rate limit, an unavailable model or
endpoint, or disabled via `GLM_REVIEW_GATE=off`) is not a failure; record it
and continue according to the `afk` gate-selection rule. A timeout, upstream
HTTP error, non-JSON or empty response, unsafe finish reason, or unverified
response model yields a non-zero `ERROR` with no partial verdict. An empty
completion names the input and output budget knobs; one adjusted retry is
eligible under the shared transient-retry rule, while an unchanged blind retry
is not. The shared skip-vs-error table decides the direction, the same as every
lifecycle gate.

The default `openai` protocol uses the Coding Plan endpoint
`https://api.z.ai/api/coding/paas/v4` and explicitly requests enabled reasoning
at `max` effort. Set `GLM_REVIEW_PROTOCOL=anthropic` to use the Anthropic
Messages endpoint at `https://api.z.ai/api/anthropic`. The protocol is never
inferred from `GLM_REVIEW_BASE_URL`; an override must match the selected
protocol, and a wrong pairing surfaces as the 404 model-unavailable skip naming
both suspects. Use `--print-args` for the resolved protocol and metadata or
`--print-prompt` for the redacted prompt without a provider call.

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

Optional and self-skipping. Set `ZAI_API_KEY` or `GLM_API_KEY` in the environment
or a gitignored `.env`. Disable with `GLM_REVIEW_GATE=off`.

Config knobs:

- `GLM_REVIEW_MODEL` (default `glm-5.3`)
- `GLM_REVIEW_PROTOCOL` (`openai` by default; `anthropic` is the other accepted
  value)
- `GLM_REVIEW_BASE_URL` (defaults to `https://api.z.ai/api/coding/paas/v4` for
  `openai` and `https://api.z.ai/api/anthropic` for `anthropic`)
- `GLM_REVIEW_MAX_CTX_BYTES` (default `160000`)
- `GLM_REVIEW_MAX_OUTPUT_TOKENS` (default `65536`)
- `GLM_REVIEW_EXCLUDE_GLOBS` (extra snapshot exclusions, comma/newline list)
- `GLM_REVIEW_TIMEOUT_MS` (default `900000`; shared fallback
  `AFK_REVIEW_TIMEOUT_MS`)
