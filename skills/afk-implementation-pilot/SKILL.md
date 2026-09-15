---
name: afk-implementation-pilot
description: "afk-implementation-pilot: Part of the afk pipeline. Implement an approved plan, run checks and self-review before internal review. Triggers include \"/afk-implementation-pilot\", \"implement the plan\"."
---

# afk-implementation-pilot

Read [AFK environment](../afk/references/environment.md) before resolving
configuration, local state or bundled helper paths.
Before review or a review-driven edit, read and apply
[review convergence](../afk/references/review-convergence.md). Reuse only the same
installed revision already read and still in context; otherwise reread it.

Act as the developer executing an approved plan: implement it correctly, test it,
and self-review until it is genuinely ready, then hand off to `afk-internal-review`.
An efficient coding model is appropriate here.

**A plan is required.** Without one, redirect to `afk-spec-planner`. Do not
re-derive the plan.

## Stage boundary

Before returning a result, read [stage output](../afk/references/output.md);
before a run handoff or resume, read
[continuity](../afk/references/continuity.md). Standalone work ends at the
requested implementation and checks within its existing authorization. A nested
invocation returns implementation and self-review evidence to the driver for
internal review. The driver owns subsequent commit, publication and completion
under retained authority; a delegated action needs that authority already supplied.

## Workflow

### 1 — Load the plan

Confirm the acceptance criteria, files to change, key notes, test plan,
out-of-scope items, assumptions, and frozen issue contract. If anything conflicts
with what you observe in the code, correct the contract with repository evidence
before coding — never let an implementation preference expand it silently.

### 2 — Read before writing

Read the current implementation and existing tests of every file the plan
touches; confirm the plan's assumptions still hold; check for conflicting recent
commits or open PRs.

### 3 — Implement

Make the smallest change that satisfies the acceptance criteria. Follow existing
conventions exactly. No unrelated refactors, no speculative abstractions. Add or
update tests for every changed behaviour. Map every edit to a contract item or an
admitted, demonstrated defect. Anything else is removed or deferred; do not
create a follow-up issue automatically.

### 4 — Run checks

Run the project's checks from `.afk/config.md` (`test`, `lint`, `build`); for any
that is blank, auto-detect from the project and, if none exists, say so rather
than skip silently. Report results verbatim; never suppress a failure. Read [environment](../afk/references/environment.md) for the shared config location.

For an environment refusal, read and apply
[continuity](../afk/references/continuity.md), section "Restricted executor handoff",
before classifying the command or returning its evidence to the driver.

### 5 — Self-review loop

The initial review applies every lens below to the full diff and records its
result, including no finding. Record findings and dispositions before editing.
Apply [review convergence](../afk/references/review-convergence.md) for admission,
minimal repair batches, focused re-review and the shared allowance. No extra
clean-only full sweep is required; finish the current cycle's validation even
when further repairs remain outstanding.

- **Spec:** every acceptance criterion met; nothing out-of-scope added.
- **Correctness:** edge cases, error paths, off-by-one, concurrency.
- **Tests:** new behaviour, edge cases, and failure paths covered and passing.
- **Quality:** conventions followed; no dead code, debug artifacts, or unplanned
  TODOs.
- **Engineering rules:** no silent skip/exit; no duplicated helper or constant;
  superseded code overwritten in place, not layered; any position-touching path
  fails closed on unreliable input; plus any invariant listed in `.afk/config.md`.
- **Security:** no injection at new inputs; no sensitive data in logs; auth/authz
  correct for new actions.
- **Compatibility:** no unintended breaking changes; migrations safe and
  reversible.

Track decisions as well as findings. If the same decision changes A→B→A, stop
editing, investigate the affected decision, and pin the contract-and-test-backed
choice. Change it again only on new evidence.

Stop when the initial review and any required focused closure leave no open
blocker; otherwise report `OUTSTANDING` within the issue allowance.

### 6 — Handoff

Summarize what was built, the acceptance-criteria status, deviations from the
plan, files changed, tests added, the lens-by-lens results of the initial review and focused closure
results, and final check results. Return to the driver for
`afk-internal-review` when nested; suggest that next stage when standalone.
Do not merge, push, or open a PR without existing explicit authorization.

For a restricted executor, read [continuity](../afk/references/continuity.md),
section "Restricted executor handoff", before returning commit work to the driver.

### 7 — CI watch (only when asked to push / open a PR)

With `remote-ci: off`, skip this stage and report that remote CI was not read
or requested; local checks and review remain required. Follow the driver's local
completion/publication rule ([Remote checks](../afk/references/publication.md#remote-checks)).

Open new PRs as Draft in enabled modes. Do not wait for intentionally deferred CI.
The driver owns the Ready transition after reviews and the final local suite.
For a Draft PR in enabled modes, defer CI waiting to the driver after reviews
and the final local suite. Do not mark Ready here or treat a skipped job as green.
For an already non-Draft PR, the job is not done when `git push` returns. Ask
the forge which checks it required of the pushed revision ([Remote checks](../afk/references/publication.md#remote-checks), read before
CI watch for what counts as required) and stay engaged while any is
failing: read its real output, confirm each finding against the cited code, fix
true bugs with a regression test, update any doc it flagged, and push one
comprehensive fix commit per round. Stop when the answer names nothing failing —
an answer naming no required check at all is that condition, not one that has
yet to report — and say which of those it was rather than reporting green. An
answer that keeps naming an unfinished check belongs to the driver's rule; do
not push again to move it, and never chase an informational note with another
commit.

## Hard rules

- Requires a plan. Initial review and meaningful fix verification are required.
- Never merge, push, or open a PR unless explicitly asked.
- Local green never sets the merge-ready bar; the driver's "Remote checks" rule
  does.
- Never fabricate results; never refactor unrelated code; flag plan conflicts
  instead of resolving them silently.
