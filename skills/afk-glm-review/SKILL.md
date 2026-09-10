---
name: afk-glm-review
description: "afk-glm-review: Part of the afk pipeline. Runs GLM (Z.ai glm-5.3) as an independent, read-only fallback external review role for an ordered .afk/config.md gate profile. Triggers include \"/afk-glm-review\", \"run glm review\", \"glm gate\", and \"GLM external gate\"."
---

# afk-glm-review

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

Pass `--implementer <family>` when another model wrote the change. In design
mode (`--design`) the flag instead names the design's **author**, never the
eventual code implementer — see `../afk/SKILL.md` ("Design-stage external
gate"): declaring the code implementer there can hand a driver-authored design
to the driver's own model for review. A persistent `implementer:` line in
`.afk/config.md` also names the code implementer, and in design mode it can
wrongly block that family's independent review of a driver-authored design —
declare the design's author explicitly then: the per-run flag outranks the
config line.

**The review is bounded** by `GLM_REVIEW_TIMEOUT_MS` (default 15 min), with
`AFK_REVIEW_TIMEOUT_MS` as the shared fallback. A timeout is a non-zero `ERROR`,
never a partial verdict; it follows the role's transient retry rule.

**Design mode** (`--design <path>`) reviews a design document's reasoning instead
of a diff — the opt-in design-stage gate (see `../afk/SKILL.md`, "Design-stage
external gate"). GLM has no tools, so the gate sends the document's full text as
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

Use the same discipline as `afk-codex-review` and `afk-kimi-review`:

1. Map every hypothesis to the frozen contract and apply the P1 admission rule.
2. Verify its trigger and consequence; GLM saw the diff and changed
   files, not the whole repo.
3. Fix confirmed structural findings in one batch, including in-scope P2.
4. Self-review once.
5. Re-run the gate once if structural findings were fixed.
6. Resolve documentation and cosmetic items in one final pass without another
   gate call for that pass alone.

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
