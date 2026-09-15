---
name: afk-deepseek-review
description: "afk-deepseek-review: Part of the afk pipeline. Independent read-only DeepSeek review, an optional external role. Triggers include \"/afk-deepseek-review\", \"run deepseek review\", and \"DeepSeek external gate\"."
---

# afk-deepseek-review

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

An optional independent review by `deepseek-v4-pro`. Run it only when an
explicit `.afk/config.md` `gates:` or `priority:` profile selects DeepSeek, or
when the operator invokes this skill directly. Never use it when DeepSeek wrote
the change or already occupies another ordered role.

DeepSeek receives a bounded, redacted snapshot through its REST API. It has no
repository tools, so verify findings that require material outside the snapshot.
Kilo Code may use the same provider, but this gate neither reads Kilo Code state
nor depends on that extension.

## Review context

Read [review evidence](../afk/references/review-evidence.md) before using
`--review-context`, `--review-phase` or `--review-receipt`.
Use `--print-prompt` to inspect the supplied section before a provider call.
Required history is validated and never silently truncated.

## Run it

Read [environment](../afk/references/environment.md) to resolve
`deepseek-gate.mjs` beside this skill and bootstrap when needed.

```text
node "<helper-dir>/deepseek-gate.mjs"
```

Run it in the background with a generous timeout and save stdout for the run
record. Pass through `--base <branch>`, `--commit <sha>`, `--uncommitted`, or
`--design <path>`. Use `--print-args` for resolved metadata or `--print-prompt`
for the redacted prompt without a provider call. Do not poll in a sleep loop.

Read [authorship declaration](../afk/references/external-review.md#authorship-declaration)
before choosing `--implementer`; design mode names the design author.

The bounded snapshot excludes secret-bearing paths, redacts secret-shaped
values, and rejects unsafe design inputs before the request. A missing or
invalid `--design` target is `ERROR`, not a skip. A timeout, unsafe finish
reason, empty completion, or unverified response model also yields a non-zero
`ERROR` with no partial verdict. An empty completion names the two budget knobs;
one adjusted retry is eligible under the shared transient-retry rule, while an
unchanged blind retry is not. Auth failures, rate limits, and an unavailable model or
endpoint (HTTP 404) are `SKIPPED` — the reviewer is unavailable and the next
family takes its place, per the shared skip-vs-error table. A successful review that omitted entries carries a bounded
`SNAPSHOT_NOTE` count; redacted excluded paths stay in local stderr only.

Read the verdict between the
`===== DEEPSEEK REVIEW (final message) =====` markers. Treat only column-0
marker lines as markers; the last END marker wins. A `SKIPPED` result is not
a verdict; record it and follow [external review](../afk/references/external-review.md) for fallback.

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

Set `DEEPSEEK_REVIEW_API_KEY` in the environment or a gitignored `.env`.
`DEV_DEEPSEEK_API_KEY` is the fallback name. Never put a key in the repository,
`.afk/config.md`, a command argument, or Kilo Code export. Disable with
`DEEPSEEK_REVIEW_GATE=off`.

Config knobs:

- `DEEPSEEK_REVIEW_MODEL` (default `deepseek-v4-pro`)
- `DEEPSEEK_REVIEW_BASE_URL` (default `https://api.deepseek.com`)
- `DEEPSEEK_REVIEW_THINKING` (`off` disables thinking; enabled by default)
- `DEEPSEEK_REVIEW_MAX_CTX_BYTES` (default `160000`)
- `DEEPSEEK_REVIEW_MAX_OUTPUT_TOKENS` (default `65536`)
- `DEEPSEEK_REVIEW_EXCLUDE_GLOBS` (comma- or newline-separated additions;
  built-in exclusions remain)
- `DEEPSEEK_REVIEW_TIMEOUT_MS` (default `900000`; shared fallback
  `AFK_REVIEW_TIMEOUT_MS`)
