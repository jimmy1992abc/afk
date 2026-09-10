# Remote checks: a reading, not an assumed bar

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#52.

## Frozen issue contract

Acceptance criteria:

1. The checks are always read; configuration governs only what an **empty or
   unanswered** reading means.
2. "Green" is well-defined where no check exists, and never claims a result the
   forge did not produce.
3. Every reading has exactly one next step, and every wait terminates.
4. "Not read" never passes a bar by absence.
5. The tradeoff is stated in `skills/afk/SKILL.md` itself and reaches the
   end-of-run report.
6. The per-run exception path is replaced, not layered beside a new mode.

Engineering invariants: no silent skips; fail toward less exposure; level-1
vocabulary for a level-1 mechanism.

Non-goals: no new forge operation in code; no change to the review roles or
their ordering; no detection by running CI.

## Design

One reading and three resolutions. Nothing here names a forge's own status
vocabulary, so a third forge — or a sixth status on an existing one — edits none
of this prose. Classification is by what the answer *names*, never by how the
lookup exited: `gh pr checks` exits non-zero for a failing check and for a
pending one, so an exit code is a status signal, and reading it as "the lookup
failed" misroutes the two commonest answers.

The passing clause requires the answer to name at least one required check.
Phrased as a universal over the required set it is vacuously true when that set
is empty — which is the state this issue exists for, so the reading nobody could
take would have passed the bar by absence.

An empty or unanswered reading is unresolved until `remote-ci` settles it:
`absent` at once, `detect` (the default) once the window closes, `expected`
never. Unsettled, it takes the same exit as a failing check, so no branch is
left without a next step. The window runs from a stamped first attempt, because
a window with no durable start cannot tell a resumed tick that it is spent.

`remote-ci` reaches the ready path, not only the merge bar: under the default
`leave-open` no merge ever follows, so a merge-only closure would be inert.

## What a run gives up

Where no required check constrained a revision, the ordered roles and the local
suite are the whole of what the run applied, and both are evaluation the driver
performs on itself. Per `AGENTS.md` → *What this plugin can and cannot enforce*,
the roles are level 1 — prose and evaluation, not mechanism — and a required
check is one of the few control points outside the agent's authority at all.
Choosing to run without one is legitimate; choosing it silently is not, which is
why every such revision is named in the end-of-run report with the reading that
said so.

## Test plan

`scripts/remote-checks-rules.test.mjs`, house pattern: presence pins on the
sentences the rule turns on, plus `doesNotMatch` guards on the wordings three
refutation rounds refuted — an exit-code classification, a vacuous passing
clause, a forge's status vocabulary, the retired `deterministic CI green` and
`remote CI not run`, and level-2 verbs inside the disclosure paragraph (with the
cited AGENTS.md section title stripped first, since it contains one). The
disclosure slice fails closed if either bounding heading moves. Each guard was
verified by mutation: reintroducing the overclaim, the exit-code test, or the
vacuous clause each turns the suite red.
