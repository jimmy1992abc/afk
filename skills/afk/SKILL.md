---
name: afk
description: "afk: Part of the afk pipeline. Execute an operator-supplied, pre-reviewed issue/PR scope autonomously through the full pipeline. Requires explicit scope; never pick tracker work. Triggers include \"/afk\", \"AFK mode\", \"go AFK on …\"."
---

# afk

Hand-off mode: the operator designed and reviewed a scope; you execute exactly
that queue autonomously and stop yourself when done or stuck. This file is the
driver contract; read each reference at the stage where it applies.

## Required reading by stage

Before a dependent action, read the listed reference and its applicable routes.
Reuse a reference only if that same installed revision has already been read
and remains available in the current context. Otherwise reread it. A missing
required reference is an unavailable prerequisite for the dependent action,
not permission to act as though its rules were loaded; retain independent work.
These are level 3 workflow instructions, not an automatic loader.

| Stage | Read before proceeding |
| --- | --- |
| Kickoff/config resolution | [Environment](references/environment.md), [kickoff](references/kickoff.md), [external role profile](references/external-review.md), [issue allowance](references/review-convergence.md), and [CI mode](references/publication.md). |
| Run claim, stage/session handoff or resume | [Continuity](references/continuity.md); keep the current run and authority, including restricted executor handoffs. |
| Spawning a nested child stage | [Delegation](references/delegation.md); supply the bounded task and retained run, then validate the returned result. |
| Stage result or execution summary | [Stage output](references/output.md); retain complete source evidence. |
| Explicit direction-state initialization, check or amendment | [Direction state](references/direction-state.md); no automatic audit activation or dispatch. |
| Retained direction policy enables a stage/signal audit or endpoint check | [Direction audits](references/direction-audit.md); preserve off/shadow/required behavior and the selected endpoint. |
| Plan | [Planner](../afk-spec-planner/SKILL.md); obtain its frozen issue contract before implementation. |
| Design debate or optional design gate | [Design review](references/design-review.md) and [common convergence](references/review-convergence.md). |
| Implementation/self-review | [Implementation pilot](../afk-implementation-pilot/SKILL.md) and [common convergence](references/review-convergence.md). |
| Internal review | [Internal review](../afk-internal-review/SKILL.md) and [common convergence](references/review-convergence.md). |
| External role | [External review](references/external-review.md), [common convergence](references/review-convergence.md), and the selected gate below. |
| Context, receipts or receipt reuse | [Review evidence](references/review-evidence.md) before supplying or reusing those artifacts. |
| Publication, local completion or final report | [Publication](references/publication.md) and [continuity](references/continuity.md). |

External gate entry points: [afk-codex-review](../afk-codex-review/SKILL.md),
[afk-claude-review](../afk-claude-review/SKILL.md),
[afk-kimi-review](../afk-kimi-review/SKILL.md),
[afk-glm-review](../afk-glm-review/SKILL.md),
[afk-deepseek-review](../afk-deepseek-review/SKILL.md), and
[afk-mimo-review](../afk-mimo-review/SKILL.md).

## Per issue — the full waterfall (one at a time)

A nested child's completion is not queue completion. Receive its bounded result,
checkpoint the existing run records and continue the next authorized stage below;
an outstanding result preserves independent queued work. Standalone satellite
requests retain their own endpoints and do not start this waterfall.

**Every issue runs the full review waterfall.** With `remote-ci: off`, the
endpoint is local completion ([Remote checks](references/publication.md#remote-checks)); otherwise each in-scope PR passes
internal review AND the external gate(s) AND lands green (merged, or under
`leave-open` declared ready only after internal review + gate + full test
suite + the revision's check reading). A design doc, a pushed branch, or a PR
not yet AFK merge-ready is a mid-waterfall
checkpoint — never a stopping point and never an operator handoff. "Next:
operator runs the review" is a bug, not an end state.

design doc with a frozen issue contract → adversarial debate ([design-review rules](references/design-review.md);
the shared review-cycle allowance governs repairs) →
design-stage external gate (opt-in pilot, default off; one role per evaluation —
[external design review](references/design-review.md#external-design-review)) → tests
first (targeted) → implementation → adversarial sweep →
commit → push early and open a Draft PR (unless `remote-ci: off`) →
**internal review** (`afk-internal-review`) → triage
every finding and
batch-fix confirmed in-scope structural findings, including P2 →
**external gate(s)** ([loop, closure, and termination](references/review-convergence.md)) →
**full test suite once** (the project's test command from `.afk/config.md`) on
the final commit → local completion if `off`, otherwise mark Ready for review
to start CI → resolve remote checks → declare AFK merge-ready → merge per policy. The design doc matters more
than the code.

- Scale design/debate depth to the work: mechanical, well-specified work gets a
  brief design and one debate round; design-heavy work gets the full treatment.
  Never scale down tests or gates.
- **Local completion** requires all configured independent roles and the final local suite,
  with the same finding dispositions as the review waterfall. It is not CI approval.
- **Green** = the full test suite green on the final commit, and that commit's
  check reading resolved ([Remote checks](references/publication.md#remote-checks)). A green status on the PR alone is
  not green. Never declare it ready before the suite is green.

Before implementation, freeze the issue contract defined by the
[planner](../afk-spec-planner/SKILL.md). Map implementation edits and admitted
findings to it. Repository evidence may correct it; reviewer preference cannot
expand it. Record other proposals as `OUT-OF-SCOPE`, without implementation or
automatic follow-up issue creation.

## Quality and proportionality

Complete every accepted requirement with appropriate context, capable models,
relevant failure-path and regression checks, and the configured independent
reviews. Do not invent token, call, cost or whole-task time ceilings merely to
save money. Explicit operator limits still apply; an unset limit is not zero.
Retain isolation, credential, transport and cancellation controls for their actual
technical purpose, with enough capacity for complete evidence.

Every abstraction, dependency or additional workflow needs a concrete accepted
requirement or demonstrated defect. Prefer existing mechanisms and the smallest
complete causal correction; simpler code may still require thorough verification.
Use the existing root-cause checkpoint for repeated non-progress instead of
creating new supervisory infrastructure.

## Autonomy

Decide with best-practice defaults and record each decision; do not block on
in-scope work. In-scope risky changes use a justified safe direction; uncertainty alone never
authorizes a new guard or fallback. Only stop for: out-of-scope work, a destructive or
outward-facing action without authorization, or genuine ambiguity with no safe
default. Never merge a PR that is not green or has an open finding — open
meaning `UNTRIAGED`, `Contested`, or an admitted P1 without a closing
disposition. Deferred minor/out-of-scope notes do not bar merge; a structural P2
uses the operator-owned auto-merge bar in [publication](references/publication.md#merge-bar).
Never touch
another session's branch; never deploy (merge ≠ deploy).

## Supported review context

Before supplying review context, read the
[canonical context guidance](references/review-evidence.md#supported-review-context).

## Canonical review receipts

Before supplying or reusing receipts, read the
[canonical receipt guidance](references/review-evidence.md#canonical-review-receipts).
