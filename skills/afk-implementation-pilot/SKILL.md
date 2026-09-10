---
name: afk-implementation-pilot
description: "afk-implementation-pilot: Part of the afk pipeline. Executes an approved implementation plan — writes code, runs the project's checks, and reviews the initial diff and verifies accepted fixes, then prepares the branch for internal review. Requires a plan from afk-spec-planner or equivalent. Triggers include \"/afk-implementation-pilot\", \"implement the plan\"."
---

# afk-implementation-pilot

Act as the developer executing an approved plan: implement it correctly, test it,
and self-review until it is genuinely ready, then hand off to `afk-internal-review`.
An efficient coding model is appropriate here.

**A plan is required.** Without one, redirect to `afk-spec-planner`. Do not
re-derive the plan.

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
than skip silently. Report results verbatim; never suppress a failure. Resolve
`.afk/` from the repository's main working tree — the first non-bare `worktree` record of
`git worktree list --porcelain` — never the current directory, or work in a
linked worktree reads a different `.afk/` than the one `afk-init` wrote.

Record `ENVIRONMENT-BLOCKED` only when evidence shows that the environment
denied a prerequisite before the relevant assertion or contract behavior ran.
Do not infer it from a permission-looking string when the product selected the
path or assertions also ran. It is neither RED nor green. Preserve the worktree
unchanged and hand the exact command, output, refused resource, and causal
evidence to a driver that can rerun the unchanged command in an authorized
environment; that rerun supplies the classification.

### 5 — Self-review loop

The initial review applies every lens below to the full diff and records its
result, including no finding. Record findings and dispositions before editing.
Fix confirmed in-scope structural findings, including P2, in one batch.
Defer documentation and cosmetic items to one final pass after structural
closure. A recorded decision may defer a structural P2 to the operator-owned
merge boundary. Unverified or out-of-scope suggestions authorize no edits.

Re-review checks accepted findings, the intervening diff, and affected regression paths.
Verify every fix with affected checks or a recorded verification step. Silence
about a prior finding verifies nothing. Broader investigation requires specific
evidence of another affected area; newly demonstrated in-scope blockers remain
reportable. Apply the issue-wide "Review-cycle allowance" in `../afk/SKILL.md`;
no extra clean-only full sweep is required. Exhaustion leaves remaining repairs
outstanding while the current cycle's validation completes.

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
results, and final check results. Suggest running
`afk-internal-review` next. Do not merge, push, or open a PR unless asked.

If the executor can edit a linked worktree but cannot write its linked-worktree
Git metadata under the main checkout, stop retrying the commit. Record the dirty
tree's diff identity and exact check results. The driver must inspect that diff
and rerun the declared checks outside the restricted executor before it creates
the commit. This hands back commit work only: push, PR, and merge remain separate
authorized actions.

### 7 — CI watch (only when asked to push / open a PR)

Open new PRs as Draft and keep review-driven or CI-failure repair batches Draft. Do not wait for intentionally deferred CI;
record that state and continue the internal-review handoff. The driver owns the Ready transition
after all required reviews and the final local suite pass; that transition
starts the CI readiness check. A Draft-stage skip is not a passing CI run.

If a push or PR is authorised, the job is not done when `git push` returns. Ask
the forge which checks it required of the pushed revision (`../afk/SKILL.md`,
"Remote checks", for what counts as required) and stay engaged while any is
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
