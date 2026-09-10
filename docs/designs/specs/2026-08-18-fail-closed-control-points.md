# Four fail-closed control points that a detail walks through

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#54. Four defects, one root cause; brief design per the
scaling rule.

## Frozen issue contract

Acceptance criteria:

1. A target with changes none of which can be rendered resolves as
   **unreviewable**, named, and never as a skip that reads as clean. A target
   with no changes at all stays a benign skip.
2. The relay's codex adapter treats a non-zero exit as a failure.
3. `--implementer` is recognised in both `--flag value` and `--flag=value`
   forms wherever it is read and wherever it is stripped.
4. A target flag supplied without its value is a named caller error, never a
   fall-through to a different target — for every flag that names a target.
5. Each test asserts the negative: the run does not resolve as clean.

Engineering invariants: fail toward less exposure; no silent skips; one
definition per rule, not one per call site.

Non-goals: no change to what a gate reviews once a target resolves; no change
to the review prompts; no new config key.

## Design

**The shared shape.** Each of the four is a control point that answers "may
this proceed" and has one input path it never considered — an entry that
renders nothing, an exit code, an equals sign, a missing operand. In every case
the unconsidered path resolves toward *permitting*, which is the wrong
direction for all four.

**H1.** `hasChanges` is `Boolean(renderedDiff.trim() || visibleContentCount)`,
and a large or binary entry increments neither: it is `excluded: false`, so it
reaches `reviewable`, but `content == null` skips the block that would count
it. Untracked entries never appear in `git diff HEAD`, so a change adding only
a large asset produces an empty diff and no blocks. The distinction the
consumer needs is not "are there changes" but "is there anything to review",
and those differ exactly when an entry exists that could not be rendered. The
snapshot therefore reports that state separately, and the consumer errors on it
rather than skipping — a review that could not read its target has not happened,
and `SKIPPED` is reserved for a reviewer that is unavailable.

**H2.** The adapter's contract is "a result or a throw". A non-zero exit with a
well-formed marker block currently returns as a result. The gate helper already
treats status as load-bearing; the relay path is the copy that did not.

**M2 and M3** are the same argv bug in two guards. A single reader that accepts
both spellings, used by both, replaces two hand-rolled scans — the equals form
is not an exotic input, and a control point that a spelling defeats is not one.
`--commit` gains presence detection so a valueless flag is an error rather than
a silent fall-through to branch mode, matching `--design`, which already does
this.

## Test plan

`lib/gate/snapshot.test.mjs`: a scratch repository whose only change is one
untracked file over the size cap, and one containing a NUL byte, each asserting
the snapshot reports the target unreviewable rather than unchanged; a truly
empty target still reports unchanged. `lib/gate/gate.test.mjs` for the
consumer: unreviewable exits non-zero and emits no clean verdict.

`skills/afk-agent-relay/tests/providers.test.mjs`: a codex invocation exiting
non-zero with a complete marker block throws rather than returning.

`lib/gate/implementer.test.mjs`: `--implementer=codex` is read as a declaration
and stripped; `lib/gate/target.test.mjs`: `--commit` with no operand and
`--commit=<sha>` each resolve as named errors or as the commit target, never as
the branch.
