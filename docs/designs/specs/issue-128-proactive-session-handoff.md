# Proactive session handoff

Issue #128 adds a deliberate handoff to the existing ledger and SessionStart
resume path. A session currently has to let its heartbeat age before its
successor can distinguish a pause from a live owner. Long sessions also lack a
common index of settled work, and drivers assemble child-stage prompts from
scattered instructions.

## Contract and boundaries

The frozen implementation contract resolves the issue's draft criteria as follows:

| Criterion | Delivery |
| --- | --- |
| C1 | Define one `## Handoff` block in [continuity](../../../skills/afk/references/continuity.md#handoff-block), immediately after the header, overwritten at checkpoints. It indexes retained evidence and never carries authority. |
| C2 | Rotate after an issue's completion stage, on context/compaction signals or on operator instruction. Record open findings; rotation never substitutes for resolving them. Use host scheduling where available and bounded in-session continuation otherwise. |
| C3 | Surface a deliberately vacated active run even with a fresh heartbeat, only when a valid `rotation` or `yield` marker is at or after a known heartbeat. Preserve all existing collision and mode rules. |
| C4 | Add [delegation](../../../skills/afk/references/delegation.md) as the driver's read route before spawning a nested child stage. Keep child results subordinate to driver inspection and retained authority. |
| C5 | Release as 1.3.0 through the existing manifest generator. No new triggers, gate profiles, fallback choices, resume modes or completed-run mutations. |

Handoff writing, scheduling, claiming and child behavior are level 3 workflow
doctrine. Choosing settled decisions remains level 1 judgment. Parsing and
selection are level 2, enforced when invoked; they cannot make a driver follow
the workflow. The plugin cannot open a new conversation or make the heartbeat
an atomic ownership lock.

## Marker interpretation

The canonical block definition belongs in continuity, not in a second schema
file. The detector reads only its three machine-facing fields: `reason`,
`written`, and `next-action`. Human lists retain evidence pointers rather than
duplicating run state. Existing ledgers without a block remain valid.

`parseHandoff` returns a marker or null without throwing. It takes the first
Handoff section, accepts CRLF, and stops at the next H2. Required fields must be
present, the reason must be recognized, and the timestamp must pass the existing
`staleMsOf` validator, including impossible-date and future-skew checks.
`next-action` is display-only and uses the existing scope length bound. The
parser does not interpret the human lists as executable instructions.

Selection uses exact timestamp ages, not rounded display minutes. With known
heartbeat age `h` and valid marker age `w`, deliberate yield means a `rotation`
or `yield` reason and `w <= h`. Equality is essential: the block definition's
single-instant write rule produces it. In its first takeover write, a successor
refreshes the heartbeat and removes takeover eligibility by overwriting the
marker's `reason:` with `compaction` or deleting the block. Consumption does not
depend on clock resolution; ownership is advisory and a successor must
revalidate before acting.

`compaction` records a checkpoint whose writer continues; `auto-pause` records
a no-progress stop. Neither bypasses the stale threshold. Missing, malformed,
implausibly future or older markers cannot remove an existing resume candidate.
Unknown heartbeat ownership cannot be upgraded by any marker. Completed runs
remain excluded before marker evaluation.

The scan remains O(runs), with the existing 16 KB read per ledger. A marker past
that prefix is invisible and falls back to the existing stale-heartbeat path.
Header fields precede the block, preserving first-match header selection even
when block prose contains header-looking lines. No index, state file or ledger
migration is introduced.

## Context and ownership

Single-run notify and auto contexts include the yield time and bounded next
action. Auto still requires rereading this ledger and the other run ledgers,
respecting operator redirection and checking active state and ownership. Fresh
heartbeats permit takeover only for that run's valid marker. Other runs with
fresh heartbeats remain live regardless of their markers. The hook offers
context; collision decisions remain driver doctrine.

Multiple candidates, including a mixture of stale and yielded runs, are listed
without directing any one of them. Unknown ownership remains notify-only.
`off` still prevents scanning; independent update and gate notices retain their
existing behavior. The hook's stdin JSON, at-most-one stdout JSON and exit-zero
contract requires no hook entry-point change.

## Delegation and continuity

The new driver route assembles the supplied run identity, bounded task, scope,
read routes and return-only constraint before dispatch. A child cannot claim
another run, write the driver's ledger, expand authority, finish the queue or
publish. It returns evidence and an actionable next step, including unavailable
prerequisites. The driver inspects the result before adoption; restricted
executor validation stays owned by continuity. Stage output retains its evidence
contract. Only redundant child transition wording is replaced with a link.

## Verification

Tests precede the detector change. Unit fixtures cover all reason values,
missing and malformed fields, impossible dates, future skew, CRLF, section
boundaries, first-section precedence and display truncation. Selection tests
cover fresh/stale/unknown heartbeat ownership, exact equality, marker consumption
by a newer heartbeat, completed runs, markers beyond the read bound, header
lookalikes and adversarial blocks that must not hide stale runs.

Context tests cover notify, auto, mixed multi-run listing and the unchanged
other-run collision instruction. Hook fixtures exercise deliberate yield,
malformed fallback, unknown ownership and off mode through real stdin/stdout.
Run the complete native suite, manifest check, skill/link/Markdown linters and
provenance scan. Environment refusals retain their actual output and are not
reported as assertion outcomes.

No host API integration, rotation counter, orchestration runtime, review-gate
change, direction-state change or historical-ledger migration belongs to this
delivery.
