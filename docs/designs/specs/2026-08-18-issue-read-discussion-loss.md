# The issue read drops its discussion without saying so

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#50. Small scope; brief design per the scaling rule.

## Frozen issue contract

Acceptance criteria:

1. When an issue read returns a comment count above zero and no comment bodies,
   `gather.mjs` records how many were not fetched, in the shape of its other
   skip notes.
2. A count of zero adds no note.
3. The note is derived from the response, never from the forge — a read that
   renders its comments inline must not acquire one.
4. Tests cover a payload with comments, one without, and one carrying no count.

Engineering invariants: no silent skips; the note names no CLI; the payload
still reaches the brief either way.

Non-goals: fetching the comments; any change to forge resolution, dispatch, or
the config schema; any change to the GitHub read.

## Design

`gh issue view` renders the body and the comment thread. `az boards work-item
show` returns a REST field bag carrying `System.CommentCount` and no comment
text — verified against a live organization. `gather.mjs` pushes that payload
into the brief as the issue body, so the brief arrives well-formed with the
conversation missing and nothing saying so. The count is in the payload, which
is what makes the loss knowable rather than merely unfortunate.

The note is keyed to the **response**, not to the forge. Keying it to the forge
would be a second place that decides what a forge's read contains, disagreeing
with the adapter the moment either changes — and a read that includes its
comments would acquire a note for a loss that did not happen. A payload that
does not parse, or whose count is not a number, yields no note: the read
succeeded, and guessing at a shape it does not have would invent a loss.

Fetching the comments is deliberately not the fix. The defect is that the loss
is silent; a second call per issue carries its own response shape and failure
modes, and would be a feature rather than a repair.

## Test plan

In `skills/afk-agent-relay/tests/gather.test.mjs`: a payload with a non-zero
count produces exactly one note naming the issue and the number and naming no
CLI, with the payload still reaching the brief; a zero count produces none; a
GitHub-shaped payload with no count field produces none; a non-numeric count
produces none; and an unparseable payload produces none while still reaching
the brief.
