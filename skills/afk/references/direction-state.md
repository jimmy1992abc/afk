# Direction state

Read before explicitly initializing, checking or amending direction records.
Read [environment](environment.md) and [continuity](continuity.md) for the existing
main-tree run and its authority. This reference does not enable audits or start
model calls; absent records remain direction-off, including when config changes.

## Canonical records

The [version-1 schema](../../../lib/direction/schema.mjs) validates the exact
shapes. One immutable sequence at
`.afk/runs/<run-id>/issues/<issue-id>/direction/` owns direction baseline versions,
active digests, policy amendments and audit accounting. The narrative ledger
and [handoff view](output.md) reference those fields; they do not maintain copies.
The existing ledger still owns run lifecycle, findings and content-repair cycles.

Retain source snapshots in the ignored run before preparing canonical requests.
Source paths, exact-byte digests and requirement anchors preserve inspectable
claims, not authenticated intent. A faithful extraction from already authorized
scope needs no second approval. Label technical assumptions and unresolved
product decisions; never invent priorities or publication authority.

Implementation adjustments within the contract change the plan, not the baseline.
Evidence-backed clarification may resolve technical assumptions or facts while
preserving semantic clauses and product decisions. Intent changes require an
explicit operator source for the successor. Baseline and policy successors retain
history and invalidate direction results bound to their old digests.

## Explicit operations

Resolve `<plugin-root>` through [environment](environment.md) before invoking:

```text
node "<plugin-root>/scripts/direction-state.mjs" check --run-id <run-id> --issue <issue-id>
node "<plugin-root>/scripts/direction-state.mjs" apply --request <request.json>
```

Use the contract's canonical request, including the exact expected head.
The check can also bind `--expected <expected.json>`. Reads do not write state;
apply appends one exclusive next record and never dispatches a model. Concurrent
worktrees share that sequence. A stale head requires a deliberate reload and
new request, never an automatic retry or overwrite. `already_recorded` reports
an existing operation and supplies no new dispatch opportunity.

Explicitly enable only an active run with source authorization, a recoverable
baseline and conservative prior direction-call accounting. Completed/prior runs
are not migrated or reopened. Unknown consumption stays unknown until retained
evidence reconciles it; neither an increased limit nor a blank ledger proves zero.
Do not reinterpret existing repair or transport-qualification accounting here.

## Bounds and evidence

The optional `direction` config defaults to mode `off` with no attempt cap.
Blank `max-audit-attempts` resolves to null; an explicit nonnegative integer
retains its finite meaning. Historical built-in-four policies keep their original
cap until an authorized amendment; loading new code never changes them.
Values and sources are frozen on initialization. Subsequent changes, including
lowering, disabling or re-enabling, require an explicit sourced operator amendment.
No amendment removes consumption; invalid values publish nothing, and zero or a
limit below consumption permits no further reservation.

Preparation alone consumes nothing. Reserve before an availability attempt or
dispatch: publication irrevocably charges the slot, including timeout, malformed
result, attempted unavailability or an interrupted/missing terminal. A retry
needs a new attempt ID and available capacity under any explicit cap. A known
uncapped policy has null remaining capacity and can reserve; unknown accounting
also has null remaining capacity but cannot reserve. Read knowledge and policy,
not null alone. Reserved-without-terminal
attempts are already included in charged calls, not added twice. Content repairs
still use the separate [shared repair allowance](review-convergence.md).

Read result fields, not just the exit code: valid/off reads and exact replay may
exit zero without permitting a reservation. Invalid, unavailable or stale state
permits none. Preserve orphan staging and corrupt/missing records; restore exact
evidence or leave the dependent work OUTSTANDING, never truncate or infer zeros.
Before dispatch and after results, the consuming audit flow must check current
baseline/policy and actual target. No state result is a semantic approval.

These are level 2 artifact checks when invoked and level 3 driver obligations.
The helper cannot authenticate authority, prevent external bypass or qualify a
provider. Final packet/result/profile compatibility remains separate from the
provisional #110 transport experiment and requires later evidence.

Read [direction audits](direction-audit.md) before preparing, dispatching or using
an enabled audit. That consumer validates packet/result content and deterministic
response derivation; state remains the sole owner of charged attempts.

Only the exact packet reference in a reservation and result reference in a
terminal defer content secret inspection to the audit consumer. This helper still checks their
confinement, excluded paths, byte limits, strict UTF-8/NUL and exact digests,
and never emits or dispatches raw opaque bytes. Before dispatching a packet or
using a result, #111 must validate and sanitize that content. All Source,
change/accounting evidence and Terminal.evidence references retain strict secret
checks; a weaker opaque cache entry cannot satisfy a stronger evidence read.
