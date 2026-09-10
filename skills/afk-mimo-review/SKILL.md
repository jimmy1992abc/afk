---
name: afk-mimo-review
description: "afk-mimo-review: Part of the afk pipeline. Runs Xiaomi MiMo V2.5 Pro as an optional independent, read-only external review role for an ordered .afk/config.md gate profile. Triggers include \"/afk-mimo-review\", \"run mimo review\", and \"MiMo external gate\"."
---

# afk-mimo-review

An optional independent review by `mimo-v2.5-pro` through Xiaomi's Token Plan.
Run it only when an explicit `.afk/config.md` `gates:` or `priority:` profile
selects MiMo, or when the operator invokes this skill directly. Never use it
when MiMo wrote the change or already occupies another ordered role.

MiMo receives a bounded, redacted snapshot through its REST API. It has no
repository tools, so verify findings that require material outside the snapshot.
Kilo Code may use the same provider, but this gate neither reads Kilo Code state
nor depends on that extension.

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

Locate `mimo-gate.mjs` beside this file through
`${CLAUDE_PLUGIN_ROOT}/skills/afk-mimo-review`, then the `pluginRoot` in
`.afk/config.md`, then this skill's directory. Resolve `.afk/` from the main
working tree. Run `afk-init` automatically first when `.afk/` is absent.

```text
node "<helper-dir>/mimo-gate.mjs"
```

Run it in the background with a generous timeout and save stdout for the run
record. Pass through `--base <branch>`, `--commit <sha>`, `--uncommitted`, or
`--design <path>`. Use `--print-args` for resolved metadata or `--print-prompt`
for the redacted prompt without a provider call. Do not poll in a sleep loop.

Pass `--implementer <family>` when another model wrote the change. In design
mode (`--design`) the flag instead names the design's **author**, never the
eventual code implementer — see `../afk/SKILL.md` ("Design-stage external
gate"): declaring the code implementer there can hand a driver-authored design
to the driver's own model for review. A persistent `implementer:` line in
`.afk/config.md` also names the code implementer, and in design mode it can
wrongly block that family's independent review of a driver-authored design —
declare the design's author explicitly then: the per-run flag outranks the
config line.

The bounded snapshot excludes secret-bearing paths, redacts secret-shaped
values, and rejects unsafe design inputs before the request. A missing or
invalid `--design` target is `ERROR`, not a skip. A timeout, unsafe finish
reason, or unverified response model also yields a non-zero `ERROR` with no
partial verdict. Auth failures, rate limits, and an unavailable model or
endpoint (HTTP 404) are `SKIPPED` — the reviewer is unavailable and the next
family takes its place, per the shared skip-vs-error table. A successful review that omitted entries carries a bounded
`SNAPSHOT_NOTE` count; redacted excluded paths stay in local stderr only.

Read the verdict between the
`===== MIMO REVIEW (final message) =====` markers. Treat only column-0
marker lines as markers; the last END marker wins. A `SKIPPED` result is not a
verdict; record it and follow the fallback rule in `../afk/SKILL.md`.

## Handle findings

1. Map every hypothesis to the frozen contract and apply the P1 admission rule.
2. Verify its trigger and consequence because the reviewer saw only a snapshot.
3. Batch any admitted P1 fixes, then self-review the affected surface.
4. Re-run this role when a content fix invalidates its prior verdict.
5. Record every remaining disposition without changing a clean revision.

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

Set `MIMO_REVIEW_API_KEY` in the environment or a gitignored `.env`.
`DEV_MIMO_API_KEY` is the fallback name. Never put a key in the repository,
`.afk/config.md`, a command argument, or Kilo Code export. Disable with
`MIMO_REVIEW_GATE=off`.

Config knobs:

- `MIMO_REVIEW_MODEL` (default `mimo-v2.5-pro`)
- `MIMO_REVIEW_BASE_URL` (default
  `https://token-plan-cn.xiaomimimo.com/v1`)
- `MIMO_REVIEW_MAX_CTX_BYTES` (default `400000`)
- `MIMO_REVIEW_MAX_OUTPUT_TOKENS` (default `8192`)
- `MIMO_REVIEW_EXCLUDE_GLOBS` (comma- or newline-separated additions; built-in
  exclusions remain)
- `MIMO_REVIEW_TIMEOUT_MS` (default `900000`; shared fallback
  `AFK_REVIEW_TIMEOUT_MS`)
