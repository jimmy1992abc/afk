# Evidence-driven convergence

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Review iteration, batching and reopening are superseded by
[Bounded review iteration](2026-09-07-bounded-review-iteration.md).

- **Status:** Implemented
- **Date:** 2026-08-02
- **Supersedes:** the convergence counters and merge-risk ownership rules in
  `2026-07-18-loop-termination-closure.md` and
  `2026-08-01-role-ordered-double-external-gates.md`. Those documents remain
  historical records; this document governs when they conflict.

## Problem

AFK currently treats review-count limits as authority boundaries. The design
debate escalates near three rounds, and the PR gate refuses a fourth full role
sequence without operator authorization. Those limits bound spend, but on a
complex task they interrupt autonomous work even while verified defects are
being removed.

The more damaging failure mode is not high round count. It is non-monotonic
review churn: an ungraded concern becomes P1, a preference becomes a new
requirement, a later reviewer reverses a prior fix, and the diff grows away from
the issue. A fixed round cap does not prevent any of those outcomes; it only
makes the operator arbitrate them after the fact.

## Goals

1. Let an AFK run continue for as many review rounds as produce verified,
   in-scope progress.
2. Admit a P1 only when scope, reachability, consequence, and pre-merge necessity
   are demonstrated.
3. Freeze the issue contract so a reviewer cannot expand the current PR.
4. Make finding closure monotonic across memoryless reviewers and prevent
   evidence-free reopening or A/B/A fixes.
5. Keep operator escalation for real authority boundaries, not counters.
6. Let lower-severity observations be recorded without expanding the PR while
   keeping structural-risk acceptance at the operator-owned merge boundary.

## Non-goals

- Mechanically enforce workflow doctrine from a Markdown plugin.
- Eliminate independent review or make reviewers agree with the implementer.
- Accept or hide a verified P1.
- Automatically create follow-up issues or expand the operator's scope.
- Add a runtime, database, or structured ledger parser.

## Decisions

### D1 — Freeze an issue contract before implementation

The design/plan records a compact contract containing:

- acceptance criteria;
- engineering and product invariants;
- explicit non-goals;
- allowed user-visible behavior changes;
- the smallest causal boundary in which a fix may operate.

Every implementation edit and every admitted finding maps to one contract item
or to a demonstrated defect in an invariant. A proposal that cannot map is
`OUT-OF-SCOPE`; it is recorded for the operator but is not implemented and does
not spawn an issue automatically.

The contract may be corrected when repository evidence contradicts it. A
reviewer's architectural preference is not evidence and cannot amend it.

### D2 — Reviewer severities are proposals

All newly reported findings begin `UNTRIAGED`. A finding becomes P1 only when the
driver records all of:

1. a contract item or invariant it violates;
2. the reachable condition that triggers the defect;
3. a failing check, executed trace, or complete causal path demonstrating the
   consequence;
4. why the current artifact cannot safely enter the next waterfall stage
   without fixing it;
5. the minimal causal fix.

Missing any element prevents P1 admission. The driver classifies the proposal as
P2, minor, out-of-scope, or leaves it untriaged while gathering evidence. An
untriaged finding prevents a clean verdict but never authorizes a code change.

For an unverified load-bearing claim, element 3 is demonstrated when the artifact
explicitly depends on the claim, every available safe verification path has been
exhausted, and the wrong-side consequence is identified. Mere absence of evidence
does not admit P1. A `minor` is a non-structural improvement with no demonstrated
wrong user or system outcome.

A P1 cannot be accepted or deferred. At PR review, the stage-necessity record is
specifically why the PR cannot safely merge. P2/minor/out-of-scope findings may
be `Deferred`; they remain visible and do not block the role stamp. A structural
P2 bars auto-merge until the operator owns the risk at the merge boundary; minor
and out-of-scope notes do not.

### D3 — Findings have stable identity and evidence-backed reopening

The run ledger assigns every finding a stable ID and records its claim, scope
anchor, evidence, classification, disposition, and verification. Rewording the
same consequence is the same finding.

`Fixed` and `Refuted` remain closed unless a later reviewer supplies new evidence
or a different observable consequence. A `Refuted` record names its executable
check or reproducible verification artifact. The driver may suppress two
evidence-free repetitions from the same role/provider only when that proof is pinned. If the proof is not
pinned, or a different role/provider independently repeats the finding, mark it
`Contested`: it authorizes no edit, bars the role stamp and auto-merge, appears in
the end-of-run report, and enters the root-cause checkpoint. An unresolved
contest leaves the PR `OUTSTANDING`; it does not trigger a permission prompt.
Close it only when the checkpoint re-verifies the pinned disproof against the
current revision or admits the finding on new evidence.

If one decision changes A→B→A, stop editing and run a root-cause pass. Pin the
decision selected by the issue contract and tests. It may change again only on
new evidence.

### D4 — Progress governs continuation; round count does not

Remove the design-debate round cap, the design-gate two-invocation cap, the PR
full-sequence refusal, and the finding-bearing verdict cap. Continue while a
round produces material progress:

- an admitted P1 closes;
- a failing check moves to green;
- a shared root cause is identified and reduced; or
- a clean terminal round earns its stage stamp and advances the waterfall.

During implementation, a contract-mapped RED test or implementation slice with
a named next verification also counts. A commit, push, or larger diff without
that contract coverage does not.

Repeated wording, P2/minor observations, speculative architecture, and diff
growth without additional contract coverage are not progress.

Measure the no-progress streak on every evaluation round, including a same-model
debate round and each paid role verdict; it crosses role and sequence boundaries.
Only the material progress above resets it. A clean terminal round never counts
as stalled. Count no-progress only when the current stage remains unfinished
with an untriaged finding, open P1, failing check, or an unstamped current role.
Two consecutive unfinished rounds without material progress trigger an automatic
root-cause checkpoint, not an operator prompt. Pause paid gates, cluster finding
IDs, sweep the whole diff against the contract, remove unsupported scope, apply
one minimal batch fix, and run affected checks. Then resume the ordered roles.
Design-stage gates use the same rule and have no separate counter escalation.

If that checkpoint still cannot produce progress, leave the PR draft with
`OUTSTANDING`, continue independent queued work, and report the blocker at the
end. A dependent queue may stop safely, but a counter never asks for permission.

### D5 — Merge bars follow admitted severity

The automatic merge bar consists of:

- an open admitted P1;
- an untriaged finding;
- a contested finding;
- a failing required check;
- an unmet contract item; or
- a structural P2 the operator has not yet chosen to own at the merge boundary.

An agent-deferred structural P2 does not block a role stamp or ready state, but
does bar auto-merge. Deferred minor and out-of-scope notes do not. A final-role
review has no special power to upgrade or expand scope; its findings pass through
the same admission test. A role earns a clean stamp in the same verdict once
triage leaves no `UNTRIAGED`, `Contested`, or open admitted P1 finding and every
lower-severity finding has a non-blocking disposition. It does not need an extra
empty verdict when no content change is required. Any content fix invalidates
that verdict and the role re-reviews the fixed revision.

### D6 — Operator escalation is reserved for authority

Ask the operator only when progress requires one of:

- scope expansion;
- a destructive or outward-facing action not already authorized;
- abandoning or replanning a verified P1 that cannot be fixed inside the frozen
  contract;
- accepting a structural merge risk that is, by definition, not P1;
- choosing between conflicting product requirements with no safe default;
- credentials, hardware, or external state the run cannot obtain safely.

An unverified claim is not automatically an operator question. First narrow the
change, choose a fail-safe default, use a default-off guard, or leave the PR
outstanding. Escalate only when the task depends on the unresolved choice.

The continuity auto-pause rule uses this document's material-progress definition;
it does not maintain a competing list. A contract-mapped RED test or implementation
slice with a named next verification resets the streak during construction;
ordinary commits, pushes, and diff growth do not.

## Artifact changes

| Artifact | Change |
|---|---|
| `skills/afk/SKILL.md` | Replace round caps and accepted-risk merge bar with D1–D6 |
| `skills/afk-spec-planner/SKILL.md` | Require the frozen issue contract |
| `skills/afk-implementation-pilot/SKILL.md` | Map every edit to the contract; detect A/B/A churn |
| `skills/afk-internal-review/SKILL.md` | Apply P1 admission and scope-lock rules before external gates |
| Four external-review skills | Carry one identical admission/closure summary |
| `lib/gate/prompt.mjs` | Ask reviewers for scope anchor, trigger/evidence, consequence, and minimal fix |
| Design-gate and loop tests | Replace their counter pins with progress, clean-stamp, and anti-oscillation pins |

## Validation

- Level-2 prompt formatter tests pin the evidence and scope-anchor fields emitted
  whenever a helper is invoked.
- Level-3 doctrine tests pin that an unlabelled finding is untriaged rather than
  P1; they do not prove a driver follows the rule.
- Level-3 loop tests guard the absence of fixed sequence/verdict caps and
  counter-based authorization text.
- Cross-skill presence tests pin the same triage and convergence summaries in
  every gate; they do not make the workflow enforceable.
- Repository manifest, link, provenance, version, and unit checks pass.

## Risks

- More legitimate findings can spend more reviewer time. The run ledger exposes
  paid attempts, while the no-progress checkpoint stops churn rather than useful
  work.
- A driver can misclassify evidence. A refutation must name inspectable proof,
  and an independent role/provider repeating it creates a merge-blocking
  `Contested` record rather than allowing silent suppression.
- A real structural P2 can remain after the role stamps are clean. It leaves the
  PR ready/open and visible in the final report; only the operator may authorize
  auto-merge across that risk.
- Scope lock can be too narrow when the issue itself is incomplete. Repository
  evidence may correct the contract; genuine product expansion remains an
  operator decision.

## Post-implementation review disposition

- Accepted: refuted-finding suppression needed a reproducible proof and an
  independent-repeat escape; structural P2 needed operator-owned auto-merge;
  implementation progress needed a construction-stage definition; unavailable
  load-bearing claims and `minor` needed explicit semantics.
- Narrowed: the external prompt now asks for an issue anchor only when available
  and otherwise requires `contract mapping unavailable` plus a code invariant.
  The driver still performs contract admission; no new contract transport layer
  is added.
- Deferred: no default or optional paid-call cap. The operator explicitly values
  verified progress over a round budget; adding a counter would recreate the
  interruption this design removes. Paid attempts remain visible and the
  no-progress checkpoint bounds churn.
- Claude outer follow-up accepted: a finding-bearing verdict cannot stamp a
  revision changed after it; the runtime skill now states that the no-progress
  streak crosses role and sequence boundaries and defines unfinished;
  `Contested` now has an explicit closer. The stale design-stage vocabulary was
  corrected.
