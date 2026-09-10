# Spec planner: a requirement-closure sweep

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#45. Prose-only change to one skill; brief design per the
scaling rule.

## Frozen issue contract

Acceptance criteria:

1. `afk-spec-planner` gains a closure sweep over the issue, positioned so it
   governs the plan's `Spec review` and `Acceptance criteria`. Every dimension
   list in the pipeline compares an artifact against a requirement and so
   presupposes the requirement exists — `afk-internal-review` says it outright
   ("meets the spec and acceptance criteria", :33) and then forbids its reader
   from supplying the missing half ("Do not invent requirements", :130). The
   requirement side was enumerated nowhere: step 1 said only "every ambiguity".
   Silence therefore passed both files cleanly and was settled by an inference
   no later reader could see made.
2. The sweep is selective — only an axis that applies and that the issue leaves
   open is recorded.
3. A gap the repository cannot settle reaches the existing Clarify → assumption
   path, never a settled acceptance criterion.
4. Stack-agnostic: no document path, no tracker shape, no project nouns.
5. Why-only prose, English, no worked examples.

Engineering invariants: the file loads on every plan, so added length is a cost
paid per run; `scripts/debate-rules.test.mjs:143` asserts the file matches none
of `/debate|round cap|external gate/i`; level-1 vocabulary only — no
"enforced", "blocked", or "guaranteed".

Non-goals: no new skill; no gate, gate ordering, or `.afk/config.md` change; no
bundled script; no change to `afk-internal-review`'s diff-level dimensions.

## Design

Four axes, not the ten the seed material carried, and not the six the first
draft carried. Each axis asks what the issue must decide; each answer is a
sentence in the plan rather than a property of a diff. That test is what
survives the duplication audit — `Authority`, `Lifecycle`, `Outcome set`, and
`Consumers` each name a question no sentence in either skill asks, because
every existing dimension grades a produced artifact against a requirement
assumed to exist.

`Magnitude` was cut. Its charge was the only one of five upheld: step 1 already
asks the same reader, at the same moment, for "hard constraints (performance,
compatibility, security)" over the same subject, so a parallel sweep layers a
superseding instruction on a live one. Per "Overwrite, don't layer", line 19 is
sharpened in place instead — a constraint carries the bar that makes it
checkable, and one without a bar is an ambiguity, which routes to machinery the
file already has.

Placement is after `Read the code` and before `Clarify`. After the code read,
because separating "the issue is silent but the repository settles it" from
"nobody has decided" is a claim about the repository, true only where the code
was read. Before `Clarify`, because the sweep is what distinguishes genuine
ambiguity from a re-read, and `Clarify`'s two-or-three-question budget should be
spent on what the sweep surfaces. That ordering also means the residue needs no
new routing prose: `Clarify`'s existing "Record every assumption you make in
lieu of asking" already carries it to `Assumptions`.

The axes carry no second sentence. Every dimension entry in
`afk-internal-review` (:33-52) is a flat `- **Term** — <enumeration>.`; a reason
that will not fit as a clause of the definition lives in this document instead.
`Lifecycle` and `Consumers` name their own precondition rather than assuming
one, so both null out cleanly for a change with no persisted state and no
unnamed consumer. The step emits no finding and no severity: it is a planning
sweep, and adding a disposition ladder would duplicate one the driver owns.

The `Spec review` bullet is deliberately untouched. An earlier draft had it
enumerate every unbound axis while the routing rule sent each to exactly one
other section — writing every such axis twice inside one plan.

## Test plan

`scripts/closure-sweep-rules.test.mjs`, following the house pattern for prose
rules: presence pins on the load-bearing sentences (they fail on silent deletion
or rewording) plus `doesNotMatch` guards on the wordings refuted below, each of
which was rejected for a concrete reason and must not creep back. Pinned: the
four axis terms; the "what the issue must decide, not what the implementation
must do" altitude line; the selectivity sentence; the single-landing rule; the
sharpened step-1 constraint clause. Guarded: `Magnitude` as a fifth axis; the
`Spec review` bullet re-acquiring an axis enumeration; level-2 vocabulary. The
three strings `debate-rules.test.mjs:143` already forbids in this file are not
re-asserted here — one rule, one home. These pin prose an agent chooses to
follow; they are not proof the sweep works.

## Debate record

Round 1 (six axes, each with a trailing gloss sentence): refuted on all three
lenses. Why-only — seven violations, structural: six of six axes carried a gloss
that was an aphorism or a lesson in review altitude, plus an opening sentence
narrating another skill's admission mechanism. Duplication — ten, including a
self-contradiction the edit created between `Spec review` and the routing rule.
Generality — six: the axes were written from a networked multi-user service with
persisted state, and the step's justification ("the first line of code written
against it") is false for the docs-only and manifest-only issues this planner is
also the entry point for.

Adjudication of the five duplication charges against `afk-internal-review`: four
not upheld, one upheld. Not upheld because matching nouns are not a matching
question — each cited bullet is a verification predicate over shipped code,
answerable from the diff alone, while the corresponding axis is answerable only
from the issue. `Correctness` self-refutes the charge most clearly: it opens
"meets the spec and acceptance criteria", so it cannot also be the act of
enumerating one. Upheld for `Magnitude`, which is categorically unlike the
others — the competing text is in the same file, the same phase, and over the
same subject.

Round 2 (four axes, no gloss): clean on all three lenses, no P1. Applied from
the surviving P2s and minors: the register inverted a head-colon-definition
shape over the file's flat one (all four axes reshaped); `Lifecycle`'s
precondition made conjunctive on state so it nulls for stateless work;
`Authority` reordered to lead with the precondition rather than the actor, so
the label does not steer toward a permission model most issues here do not have;
the single-landing rule made explicit; and the step-1 sentence collapsed from a
positive and a negative form of one instruction to one, with "threshold"
replaced by a shape-neutral noun. Two refuters split on `Consumers`' closing
clause — the unaffected-consumer case — one calling it load-bearing, the other
covered by `Frozen issue contract`. Kept and folded into the definition: that
bullet collects invariants already known, whereas a consumer the issue never
named is the gap itself.
