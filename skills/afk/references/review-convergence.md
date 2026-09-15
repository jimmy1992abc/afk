# Review convergence

Read before review or any review-driven content edit. Use these common rules
from design, implementation, internal review and external roles; retain each
stage's own output and exit conditions. For role selection read
[external review](external-review.md); for readiness or merge read
[publication](publication.md).

## Review-cycle allowance

There is no numeric repair cap by default. A cycle is a
batch of review-driven content changes followed by closure and regression review.
Initial implementation and initial reviews do not consume cycles. Resolve the
allowance at kickoff: explicit operator instruction, else `## review` →
`max-fix-cycles` in `.afk/config.md`, else no numeric cap. Blank means no numeric cap;
valid explicit values are nonnegative integers. Invalid values are a reported
config error and permit no automatic repair until resolved. The driver cannot
increase its own allowance mid-run.

Only an operator-authorized resource-budget increase scales existing finite
model-call and cost ceilings. Approval of more repair cycles alone leaves those
ceilings unchanged. Use an explicit operator ratio when supplied; otherwise,
when proportional resource scaling is authorized, divide the new cycle allowance
by the allowance recorded with the original budget totals. Apply the factor once
to those original totals, round integer call ceilings down, and retain consumed
and reserved amounts. Never multiply the remaining balance or compound the same
amendment on resume. A zero or unknown original cycle baseline prevents ratio
inference, not an explicit ratio applied to known finite totals. Missing budget
totals for a known finite budget leave its amendment unresolved. An unset cap
creates no ceiling or budget-reconstruction prerequisite. Do not solicit a
micro-budget approval merely to continue authorized work without a cap.
Operator instruction still outranks config and default.

Record the source, original and amended ceilings before dependent calls. A new
default alone does not amend an active run. Preserve immutable execution handoffs
and predecessor accounting; unknown usage stays unknown, with any finite
conservative hold recorded separately under an explicit reservation policy.
Larger ceilings alone do not cure missing accounting. Task scope, deadlines,
per-invocation limits, retry permissions and review requirements remain separate.

Use the existing run ledger, keyed by issue, for allowance/source, consumed
cycles, accepted finding IDs and dispositions, repair revision, validation and
net-progress results. Reserve the next cycle before the first review-driven content edit.
An unfinished reserved cycle resumes its existing validation; a later batch of
review-driven edits consumes the next cycle. The allowance is shared across
design, self-review, internal/external roles, provider changes, sequence restarts, scheduled ticks, and resumes.
Neither provider retries without content edits nor fresh initial reviews consume
a fix cycle, but all attempts remain recorded. Reconstruct missing consumption
from saved revisions and findings; if you cannot reconstruct it, mark further
repairs `OUTSTANDING`, never assume zero. A new tick never replenishes the budget.

Freeze accepted findings and dispositions before editing. Initial review covers
the full acceptance criteria, relevant invariants and concrete risks. Re-review
checks accepted finding closure, the intervening diff, and affected regression
paths; broader investigation needs specific evidence of another affected area.
New evidence of an in-scope blocker remains reportable and cannot be hidden by
this focus. Carry stable IDs and previous verification through every reviewer
and resume. Supply that record through supported review context or an inspectable
target artifact; if unavailable, record the missing context and obtain it before
claiming closure. Do not invent history or reuse a stale approval unchanged.
Codex native diff review accepts no custom focus prompt: its driver applies this
triage boundary and records that reviewer-focus limitation.

Complete the current cycle's checks even when it consumes the final allowance;
it may finish clean without an extra empty review. Do not start another automatic repair after an explicit limit is exhausted. If further repair is needed, leave the PR not ready with
`OUTSTANDING`, unresolved findings, attempts and a suggested next action; continue
independent queued work. Never auto-merge or downgrade a verified blocker to fit
the allowance. There is no automatic approval request loop. Readiness still
requires valid current-revision reviews, the final full suite and, unless `off`,
remote checks. Changing CI mode does not consume or reset the review-cycle allowance.
Any checkpoint repair uses the same allowance; exhaustion cannot grant an extra
cycle. These are level 3 workflow rules, not runtime enforcement.

## Finding admission

**A finding asserts two things; reading settles one.** Every reported finding is
an `UNTRIAGED` hypothesis. An unlabelled finding starts `UNTRIAGED`. Admit P1 only after recording: the frozen issue
contract or an invariant it violates; the reachable trigger; a failing check,
executed trace, or complete causal path to the wrong outcome; why the current
artifact cannot safely advance; and the minimal causal fix. Reading the cited
`file:line` settles only the code shape. Restating the finding is not a
demonstration. Failing to demonstrate the consequence is evidence against the
finding, not licence to fix it anyway. An affirmative disproof records it
Refuted. Until classified, leave the code as it is: an untriaged claim never
authorizes a code change.

For a load-bearing claim that cannot be verified, the demonstrated consequence
is that the artifact explicitly depends on it, cannot verify it by any available
safe means, and identifies the wrong-side outcome if the assumption fails. Mere
absence of evidence is not enough.

**Account for the fix's reach before it lands.** The gate reads a diff and the
next round reads that diff again, so consumers outside it are invisible to every
reviewer in the loop. Before changing a symbol used outside the diff, enumerate
those consumers and state the effect on each. A consumer you cannot account for
is not licence to proceed: narrow the fix to the caller inside the diff, or
record the finding Deferred as P2 or out-of-scope. That record does not create a
follow-up issue automatically.

**The loop, and what closes a finding.** Every reported finding is named at
triage with a stable ID, then classified against the frozen contract. Every later
round is judged against that PR-wide list — same, reopening, or new — and a named
finding holds at most one **current** recorded disposition. The record keeps its
history:

- **Fixed** — the record maps finding → minimal fix → verification. Use a test
  that failed before and passes after when expressible, otherwise a recorded
  verification step.
- **Refuted** — an affirmative disproof closes it. Record the executable check or
  reproducible verification artifact supporting that disproof. New evidence or a different observable
  consequence may reopen it.
- **Deferred** — a classified P2, minor, or out-of-scope observation remains
  visible. None blocks the role stamp. A structural P2 bars auto-merge until the
  operator owns it at the merge boundary; deferred minor and out-of-scope
  findings do not bar auto-merge. A P1 cannot be deferred.
- **Suppressed** — an evidence-free repeat of a pinned-Refuted finding may be
  recorded `Suppressed` without reopening it. A different role/provider or new
  wording alone causes no edit, reopening, or extra paid review. Preserve the
  prior executable check or reproducible verification artifact.
- **Contested** — new evidence, a distinct demonstrated consequence, or proof
  that previous verification no longer applies challenges a closed finding.
  Identity alone is insufficient. Re-verify the affected proof or admit the
  finding on the new evidence; otherwise leave it `OUTSTANDING`. A contest
  authorizes no edit and bars the role stamp and auto-merge until classified.

Rewording the same consequence is the same finding. Silence closes nothing: a
later round omitting an open finding has not resolved it. The open-findings
record is run-scoped and survives provider switches and sequence restarts. When
the reviewed artifact is a design doc, a required future test closes only once
recorded in that design; the record is the closure, not the future test.

A finding the driver can neither confirm nor refute remains untriaged. Use a
focused test, trace, or code investigation to verify it. Do not add abstractions, switches, compatibility branches, or fallbacks
solely to make an unverified concern disappear. An unresolved load-bearing
concern prevents safe completion: retain `OUTSTANDING`, without manufacturing
certainty or accepting the risk.

**Keep the minimal causal fix.** Fix confirmed in-scope structural findings, including P2, in one batch.
Defer documentation and cosmetic items to one final pass after structural
closure. A recorded decision may defer a structural P2 to the operator-owned
merge boundary. Unverified or out-of-scope suggestions authorize no edits.
An unfixed structural P2 remains operator-owned at the merge boundary.

After a repair batch, self-review the affected surface before rerunning an
external role. Record that verification with the batch; this is part of the
current repair cycle and grants no additional cycle or empty paid review.

**The loop ends** as soon as triage leaves no `UNTRIAGED`, `Contested`, or open
admitted P1 finding, and every lower-severity item has a recorded disposition
that does not block the role stamp (a structural P2 may still bar auto-merge).
That same verdict earns the role's clean stamp only if that verdict requires no
content change. A content fix invalidates that verdict; the role must re-review
the fixed revision. No extra empty review is needed after a verdict whose only
findings receive non-content dispositions. A final reviewer has no special power
to expand the issue or upgrade a finding without the same evidence.

## Ordered-role revision and convergence rules

Before/after every PR role, record a clean worktree, `HEAD`, merge-base, base-tip
context, and the effective role-profile hash: when handoff flags are present,
the flag-derived role list plus the normalized `## external gate` section
minus its `gates` key — flags replace only what they override, so mid-run
edits to `priority` or the `implementer` declaration still stale stamps —
otherwise the normalized section (or its absent sentinel). Claude/Kimi/GLM/DeepSeek/MiMo
receive the immutable merge-base SHA; Codex receives its supported base ref and its
verdict is invalid if the before/after merge-base changed. All configured role
verdicts must name the same `HEAD`, merge-base, and role-profile hash.

Outer closes its finding loop on the current sequence. Only then run each later
role. A later-role content change invalidates every earlier stamp and starts the
ordered sequence again at outer. Finding identity is PR-scoped. A role keeps the
same provider across sequences unless availability/independence forces a
recorded substitution.

Convergence requires net material progress inside the shared allowance. At each
cycle record closed blockers, newly introduced blockers, acceptance-criterion coverage,
and expansion of the causal boundary. Closing one blocker alone is insufficient:
new defects or growing complexity are regression/churn, not an automatic reset.
Simplify or narrow the demonstrated fix within the allowance, else hand off
outstanding. Line count alone is not a correctness metric.

Material progress means demonstrated defect reduction without offsetting
regressions or unsupported boundary expansion, a check turning green, or a clean
stage stamp advancing the waterfall. A design version lands with its frozen
contract and a named next validation also counts. During initial implementation,
a contract-mapped RED test or implementation slice with a named next verification
counts; commits, pushes and diff growth alone do not. A clean terminal round never
counts as stalled. Each role still gets one transient retry per sequence;
retries, skips, finding verdicts, and paid attempts remain visible in the ledger.

The no-progress streak crosses debate rounds, paid role verdicts, role
substitutions, and sequence restarts. A stage is unfinished only while it has an
untriaged or contested finding, an open admitted P1, an unresolved check
reading, or
an unstamped current role. The streak resets only on net material progress; a role
change or sequence restart never resets it by itself.

## Root-cause checkpoint

Two consecutive unfinished rounds without material progress trigger an
automatic root-cause checkpoint, never an operator permission prompt. Pause paid
gates, cluster stable IDs, remove duplicates and unsupported scope, sweep the
affected repair against the contract, apply a minimal fix only within the
remaining allowance, and run affected checks. Broader investigation requires
specific evidence of another affected area. If the checkpoint still cannot progress, leave the PR not ready with
`OUTSTANDING`, continue independent queued work, and report the blocker. If one
decision changed A→B→A, pin the contract-and-test-backed choice; it changes again
only on new evidence. The disposition record lives in the run ledger, PR thread,
commit record, or a collision-safe standalone run directory; untracked is not an
option. All of this is level 3 doctrine, not a guarantee.
