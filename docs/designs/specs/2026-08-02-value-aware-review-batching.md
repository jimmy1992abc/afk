# Value-Aware Review Batching

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Review iteration, batching and reopening are superseded by
[Bounded review iteration](2026-09-07-bounded-review-iteration.md).

## Problem

The evidence-driven convergence rules correctly prevent a reviewer from turning
an unsupported preference into a P1 and expanding a pull request. Their current
summary, however, overcorrects by implying that every P2 and minor must be
deferred even when an admitted P1 already requires editing the same code and
paying for the same re-review. That discards useful, nearly free improvements.

Four wording gaps from the previous review also remain: normal design progress
is absent from continuity accounting, barren ticks are not explicitly limited to
an unfinished stage, structural P2 disposition is conflated with a non-blocking
merge disposition, and suppression appears to close an already-refuted finding.

## Frozen contract

### Acceptance criteria

1. When an admitted P1 already forces a content pass and re-review, the driver
   may batch a verified P2 or minor only if it is in scope and shares the P1's
   root cause or touched surface.
2. Batched lower-severity work adds no dependency, migration, public contract,
   product choice, scope expansion, or gate round beyond the P1 re-review.
3. A lower-severity-only verdict never reopens a clean revision. Its finding is
   recorded with the appropriate disposition.
4. The driver, implementation pilot, internal reviewer, and all four external
   gate skills express the same boundary.
5. Design versions with a frozen contract and named next validation count as
   material progress. A tick is barren only while its current stage is
   unfinished.
6. A structural P2 can permit a role stamp while still barring auto-merge.
7. Suppression closes two same-provider evidence-free repeats for this PR
   without re-closing the underlying Refuted finding.
8. A verified P1 that cannot be repaired inside the frozen contract remains an
   operator-owned abandon-or-replan decision.

### Invariants

- P1 admission still requires all five evidence elements.
- Reviewers propose severity; the driver validates and classifies it.
- Structural P2 remains visible and operator-owned at the merge boundary.
- Any content edit invalidates the current role verdict and is re-reviewed.
- A batched edit must remain inside the frozen issue contract.

### Non-goals

- Automatically fixing every P2 or minor.
- Adding round, call, or spending counters.
- Allowing new dependencies, migrations, contracts, or product decisions as
  incidental review cleanup.
- Making prose mechanically enforce agent judgment.

## Decision

Use a narrow value test rather than severity alone. Lower-severity work is
eligible only when all of these are true:

- an admitted P1 has already opened a content pass;
- the item is verified and within the frozen contract;
- it shares that P1's root cause or touched surface;
- it adds none of the prohibited expansion categories; and
- it consumes no review round beyond the P1's mandatory re-review.

Otherwise the driver records the finding without editing. This preserves the
anti-expansion safety boundary while capturing improvements whose marginal risk
and review cost are genuinely negligible.

## Verification

- Presence pins assert the canonical batching sentence is byte-identical across
  all four gate skills.
- Driver tests pin every eligibility and exclusion clause.
- Continuity tests pin design progress and unfinished-stage barren-tick scope.
- Closure tests distinguish role stamp from auto-merge and Refuted from
  Suppressed.
- A blind scenario forward-test checks that an agent batches same-surface work
  but defers unrelated polish and migration/product changes.

## Risks

Agent judgment can still misclassify “same surface” or “no extra round.” The
conjunctive eligibility rule limits that risk: failure of any clause means record
without editing. Exact shared text tests prevent gate drift, but cannot prove an
agent follows prose; final gate review remains required after every content fix.
