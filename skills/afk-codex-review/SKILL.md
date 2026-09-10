---
name: afk-codex-review
description: "afk-codex-review: Part of the afk pipeline. Runs Codex (OpenAI Codex CLI) as the default outer independent, read-only external review role, then triages and fixes findings before later ordered roles. Subject to .afk/config.md gates and fallback priority. Triggers include \"/afk-codex-review\", \"run codex review\", \"codex gate\"."
---

# afk-codex-review

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
Native diff review cannot accept this input or a focus prompt; it reports the
limitation without changing modes. Only `--design` delivers custom context on
stdin and supports `--print-prompt`. Keep native diff history triage in the driver.

## Run it

The bundled helper `codex-gate.mjs` sits beside this SKILL.md. Locate its
directory as `${CLAUDE_PLUGIN_ROOT}/skills/afk-codex-review` if the env var is
set, else `<pluginRoot>/skills/afk-codex-review` from `.afk/config.md`, else this
skill's own directory (the helper is its sibling). Resolve `.afk/` from the
repository's main working tree — the first non-bare `worktree` record of
`git worktree list --porcelain` — never the current directory, or a run from a
linked worktree reads a different `.afk/` than the one `afk-init` wrote. If
`.afk/` is absent, the `afk-init` bootstrap runs automatically first:

```text
node "<helper-dir>/codex-gate.mjs"
```

Run it in the **background** with a generous timeout (the review traces code
paths and may run tests); redirect stdout to a file and read it when it
completes. Pass through any target flag (`--base <branch>` / `--commit <sha>` /
`--uncommitted`; default = current branch vs the default branch). Do not poll in
a sleep loop — wait for completion.

Pass `--implementer <family>` when another model wrote the change. In design
mode (`--design`) the flag instead names the design's **author**, never the
eventual code implementer — see `../afk/SKILL.md` ("Design-stage external
gate"): declaring the code implementer there can hand a driver-authored design
to the driver's own model for review. A persistent `implementer:` line in
`.afk/config.md` also names the code implementer, and in design mode it can
wrongly block that family's independent review of a driver-authored design —
declare the design's author explicitly then: the per-run flag outranks the
config line.

**Design mode** (`--design <path>`) reviews a design document's reasoning instead
of a diff — the opt-in design-stage gate (see `../afk/SKILL.md`, "Design-stage
external gate"). Codex runs it with `exec -s read-only` and the brief + doc piped
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

## Handle findings (batch — minimise calls)

1. **Triage before editing.** Map each hypothesis to the frozen contract, apply
   the P1 admission standard below, and identify duplicates or scope proposals.
2. **Verify before trusting.** Push back with evidence on anything disproved or
   unverified; severity proposed by the reviewer is not authority to edit.
3. **Fix confirmed structural findings in one batch**, including in-scope P2.
4. **Self-review once** over your fixes.
5. **Re-run the gate once.** Continue only within the issue allowance.
6. **Resolve documentation and cosmetic items once, at the end.** Do not
   spend another gate call on a documentation-only or cosmetic pass.

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

Apply any invariant in `.afk/config.md` as an extra must-check lens.

## Stop rule

Stop when the loop-termination rule in `../afk/SKILL.md` ("External gate")
holds: triage leaves no `UNTRIAGED`, `Contested`, or open admitted P1, and every
lower-severity item has a recorded disposition that does not block the role stamp (a
structural P2 may still bar auto-merge). That same verdict
earns the role stamp only if it requires no content change; a content fix
invalidates it and the role re-reviews the fixed revision.

Report honestly: `CLEAN`, or `OUTSTANDING` with what remains. A clean pass is
not authority to merge — hand back to the operator.

## Setup (per machine, once)

Optional and self-skipping. `npm i -g @openai/codex && codex login`; needs Node +
git on PATH. Disable with `CODEX_REVIEW_GATE=off`.
