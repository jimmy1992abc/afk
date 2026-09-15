---
name: afk-codex-review
description: "afk-codex-review: Part of the afk pipeline. Independent read-only Codex review, the default outer role when eligible. Triggers include \"/afk-codex-review\", \"run codex review\", \"codex gate\"."
---

# afk-codex-review

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

An independent second-opinion review by Codex (a *different* model), used as the
default **outer** role before later configured roles (Kimi is the default final
when a final role is configured; the built-in default is a single Codex gate).
Run the ordered `gates` profile from `.afk/config.md`, never use a reviewer whose
model matches the implementer or another role, and run `afk-internal-review`
before outer. Codex reviews the diff read-only; you triage and fix.

The helper `codex-gate.mjs` ships with this skill and travels with the plugin.

## Metering

Codex calls are metered — keep invocations to a minimum. Batch minimal admitted P1 fixes into one content pass, self-review, then re-run
once. Record every other disposition together at the end without editing a clean
revision. Never spend a round-trip on a small or doc-only observation.

## Review context

Read [review evidence](../afk/references/review-evidence.md) before using
`--review-context`, `--review-phase` or `--review-receipt`.
Native diff review rejects custom context and re-review focus; it reports the
limitation without changing modes. Native diff review still supports `--review-receipt`.
Only `--design` delivers custom context on
stdin and supports `--print-prompt`. Keep native diff history triage in the driver.

## Run it

The bundled helper `codex-gate.mjs` sits beside this SKILL.md. Read [environment](../afk/references/environment.md) to resolve its sibling
helper directory and bootstrap when needed.

```text
node "<helper-dir>/codex-gate.mjs"
```

Run it in the **background** with a generous timeout (the review traces code
paths and may run tests); redirect stdout to a file and read it when it
completes. Pass through any target flag (`--base <branch>` / `--commit <sha>` /
`--uncommitted`; default = current branch vs the default branch). Do not poll in
a sleep loop — wait for completion.

Read [authorship declaration](../afk/references/external-review.md#authorship-declaration)
before choosing `--implementer`; design mode names the design author.

**Design mode** (`--design <path>`) reviews a design document's reasoning instead
of a diff — the opt-in design-stage gate (read [external design review](../afk/references/design-review.md#external-design-review)). Codex runs it with `exec -s read-only` and the brief + doc piped
on stdin — never the `review` subcommand or the sandbox bypass, so it stays
read-only on every OS. A missing or unreadable `--design` path fails loudly
(`ERROR`, non-zero), never a skip.

**The review is bounded** by `CODEX_REVIEW_TIMEOUT_MS` (default 15 min), with
`AFK_REVIEW_TIMEOUT_MS` as the shared fallback. A timeout is a non-zero `ERROR`,
never a partial verdict; it follows the role's transient retry rule.

**The reviewer's model defaults to `gpt-5.6-sol`**, pinned independently of
`~/.codex/config.toml`: an
interactive session tuned for speed or cost would otherwise decide the gate's
model, and a downgraded reviewer reads exactly like a thorough one.
`CODEX_REVIEW_MODEL=<id>` pins an explicitly assigned model for the call,
including `gpt-6-astra` when requested;
`CODEX_REVIEW_MODEL=inherit` restores inheritance — the escape hatch when the
installed CLI is too old for the pinned id and rejects it outright. `--print-args`
reports the resolved model without spending a call.

Per-run `--model <alias-or-id>` and `--effort <level>` override their environment
values independently. Model aliases `sol`, `terra`, and `astra` resolve through
`../../lib/gate/model-select.mjs`; the default remains Sol at medium effort.
Efforts are `low`, `medium`, `high`, `xhigh`, and `max`; legacy `minimal` is
rejected for GPT-5.6 and GPT-6. Explicit Codex `-c model=...` and
`-c model_reasoning_effort=...` retain last-wins precedence, with the effective
values shown by `--print-args`. Invalid selections fail before a paid call.

Read the verdict between the `===== CODEX REVIEW (final message) =====` markers. Treat only column-0 marker lines as markers; the last END marker wins.
`SKIPPED: …` (Codex absent, logged out, or disabled via `CODEX_REVIEW_GATE=off`)
is not a failure — report it and continue. `ERROR: …` means the review itself
failed — read the transcript it names; never report an errored run as clean.

## Handle findings

Apply [review convergence](../afk/references/review-convergence.md) before triage,
repairs or re-review. Keep the issue's current finding record and allowance;
apply consuming `.afk/config.md` invariants as extra must-check lenses.

## Stop rule

Use the [canonical closure and stop rules](../afk/references/review-convergence.md)
to decide whether this revision earns the role stamp.

Report honestly: `CLEAN`, or `OUTSTANDING` with what remains. A clean pass is
not authority to merge — hand back to the operator.

## Setup (per machine, once)

Optional and self-skipping. `npm i -g @openai/codex && codex login`; needs Node +
git on PATH. Disable with `CODEX_REVIEW_GATE=off`.
