# Bounded review iteration

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

## Spec review and frozen issue contract

Issue #78 replaces indefinite review-driven iteration with a default allowance of
two content-fix/re-review cycles per issue. Initial implementation and initial
reviews do not consume cycles. The allowance spans design, self-review, internal
and external roles, provider changes, sequence restarts, scheduled ticks and
resumes. Only an explicit kickoff instruction or configuration may enlarge it.

Acceptance criteria are: comprehensive initial review; focused closure, repair
delta and affected regression review thereafter; evidence-based reopening with
stable finding IDs; dispositions before edits; no lower-severity-only cycles;
no speculative implementation for uncertainty; net-progress accounting; and an
outstanding handoff when further repairs exceed the allowance. An already-started
cycle completes its validation and may finish clean. Current-revision reviews,
full tests, remote checks and owner merge authority remain required.

The causal boundary is workflow prose, shared review brief output, configuration
guidance and validation. No runtime, ledger parser, service, database, additional
skill or enforcement claim is introduced. Helpers constrain their own output
(level 2); driver obedience remains level 3 and reviewer judgment level 1.

## Approach and assumptions

The driver owns one budget definition in its existing run ledger: kickoff
allowance/source, consumed cycle number, accepted finding IDs, repair revision,
closure/regression results and net progress. Reserve a cycle before its first
review-driven content edit; a crash cannot turn an unfinished cycle into a fresh
allowance. Missing historical consumption is reconstructed from saved artifacts;
if reconstruction fails, further content cycles remain outstanding rather than
assuming zero. Provider retries without content changes remain visible attempts.

Review skills reference that definition and carry concise focused-review and
minimal-fix guidance. Shared prompts describe initial versus subsequent review
without inventing unavailable history; drivers supply the prior record through
an existing supported review context or inspectable target artifact. Missing
context is reported and retrieved before closure can be claimed. No new CLI or
transport behavior is assumed. Codex native diff review has no custom prompt;
its driver can only select the supported target and triage its findings, and this
limitation must remain explicit.

A closed finding reopens only for new evidence, a distinct demonstrated outcome,
or proof that prior verification no longer applies. Model identity alone leaves
it closed. Unverified concerns receive a focused check or investigation, not a
new switch, fallback or abstraction. P2/minor observations are recorded without
implementation; an inseparable correction requires a causal necessity record.

The no-progress checkpoint may simplify or narrow a demonstrated repair only
inside the remaining allowance. It cannot grant another content cycle. Each
cycle reports closed and newly introduced blockers, acceptance coverage and
causal-boundary expansion; closing one blocker does not erase regression/churn.

## Files and execution surface

| Path | Change | Reason |
|---|---|---|
| `skills/afk/SKILL.md` | Replace conflicting doctrine | One coherent continuation and exhaustion rule |
| Implementation, internal and external review skills | Replace repeated-sweep and batching guidance | Consistent review scope |
| `lib/gate/prompt.mjs` | Revise shared prompt clauses | Reviewers receive the focused-review boundary |
| `README.md`, `templates/afk-config.example.md` | Replace convergence guidance and document optional review allowance | Kickoff customization is explicit |
| Relevant doctrine and prompt tests | Replace obsolete assertions | Reject superseded behavior |
| This design and predecessor status | Record supersession and replay | Preserve rationale without competing current doctrine |
| `.claude-plugin/marketplace.json` and generated manifests | Version 0.8.10 | Install cache invalidation |

Allowed writes are these artifacts. Read surrounding skills, tests, existing
review helpers and config. Run `node scripts/sync-marketplace.mjs` with
`.claude-plugin/marketplace.json` and skill frontmatter as inputs to regenerate all host manifests;
its expected side effects are manifest/version synchronization only. Run targeted
Node tests, static checks and Markdown lint; after independent review run the
native `npm test` on the final commit. Push only the topic branch and open a
stacked PR on the baseline-fix branch; leave owner review and merge pending.

## Validation and risks

Tests first update obsolete counter, full-sweep and batching assertions, then
pin the emitted shared prompt behavior. Run a manual scenario replay against the
written rules for independent evidence-free repetition, P2-only output, local
closure review, newly demonstrated blockers, repair churn, third-cycle refusal
after resume/provider changes, outstanding exhaustion, and a clean final cycle.
Record inputs, decisions, cycle counts and limits. This is a finite agent-run
replay, not proof of compliance by future agents; Markdown tests only detect
text drift and prompt tests only establish emitted helper output.

Principal risk is contradictory old prose; search all active skills and relevant
guidance before review. Historical designs retain their historical reasoning
with an explicit superseding link. No runtime guarantee follows from these rules.

## Recorded scenario replay

An Astra critic independently read the revised driver, pilot and shared prompt,
then applied nine synthetic states. Findings and passing/failing evidence below
are stipulated fixture inputs, not claimed product executions. Both prompt
builders were also invoked with a supplied repetition context and emitted the
shared focus clause. No runtime counter or paid reviewer was exercised.

| Fixture input | Observed decision | Consumed cycles |
|---|---|---|
| Reviewer B repeats pinned-Refuted F1 without new evidence | Preserve ID/proof, suppress repeat; no edit, reopening or extra paid review | 0 → 0 |
| Only P2/minor findings, no open blockers | Defer without content; retain structural-P2 owner merge boundary | 0 → 0 |
| Initial review admits a local zero-input defect | Reserve repair, check named closure plus repair delta and zero/positive regressions; no extra full sweep | 0 → 1 |
| Focused closure demonstrates a new negative-input P1 | Report/admit evidence; complete current checks, reserve next minimal repair | 1 → 2 |
| F1 closes but repair introduces F2 and loses acceptance coverage | Record regression/churn and proposed boundary growth; investigate smaller repair | 1 → 1 until repair |
| Design and self-review used both cycles, then provider/sequence/tick changes | Restore consumed ledger; refuse third content batch, retain outstanding finding | 2 → 2 |
| Second cycle still has a demonstrated P1 | Finish checks, leave not-ready with findings/attempts/next action; continue independent work | 2 → 2 |
| Second cycle closes findings and current-revision reviews/full suite/remote checks pass | Complete validation and declare ready under owner merge policy; no extra review | 2 → 2 |
| Unverified load-bearing concern suggests a compatibility guard | Investigate without edits; inconclusive evidence leaves outstanding | 0 → 0 |

All nine decisions matched the intended outcomes; no concrete contradiction was
observed. This is one finite reader's interpretation, not proof of future agent
compliance, external-model behavior or non-bypassability. The replay assumes
supplied prior context. D78-001 remains a deferred P2: snapshot-only reviewers
cannot retrieve an omitted ledger, so missing required context can leave closure
unavailable. No scope expansion was made for that limitation.
