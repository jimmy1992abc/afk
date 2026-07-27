# Gate Findings — Demonstrated Consequence and Accounted Reach — Design Spec

- **Date:** 2026-07-27
- **Status:** Proposed (revision 2; round 1 gate findings and their resolutions
  are in the Appendix)
- **Scope:** The external gate's triage step only. Raise the bar a gate finding
  must clear before the driver edits code, and require the reach of that edit
  to be accounted for. No change to gate selection, metering, closure
  dispositions, loop termination, or any helper.

---

## Problem

An operator's afk run merged a regression authored by the external gate. Round
3 of the gate raised a finding against a conditional loading-state assignment
in a shared authentication hook; the driver read the cited line, confirmed the
code was as described, and made the assignment unconditional. The hook's effect
has empty dependencies and ten screens call it, so every mount now raised the
gate's loading state, unmounting the subtree that had just mounted it — a
render loop that shipped.

Two gaps in the current prose let it through, and both are in the triage step,
not in closure.

1. **The verification standard settles the wrong claim.** Every structural
   finding asserts two things: that the code is as described, and that this
   shape produces a wrong outcome. `afk-codex-review`'s step 2 — "Each finding
   is a hypothesis; read the cited `file:line`" — settles the first only. The
   other three gate skills restate the same weak standard ("Verify each finding
   against the cited `file:line`"). A driver that confirms the shape and stops
   has done what the prose asks and has verified nothing about the defect. In
   the incident the asserted consequence was never reproduced, because there
   was none.

2. **Nothing in the loop sees the fix's reach.** The gate reviews a diff, and
   the next round reviews that diff again. Consumers of a changed symbol that
   live outside the diff are therefore invisible to every reviewer in the
   loop — the gate is memoryless and diff-scoped, so the "fresh review of the
   full diff" backstop named in the loop-termination rule
   (`skills/afk/SKILL.md`, "Silence closes nothing") does not cover this class
   at all. The ten calling screens were outside the diff and no round could
   have seen them.

The existing unverified-finding rule already says the right thing about
*closure* — "A finding the driver can neither confirm nor refute is
unverified: accept it with its risk stated" — but says nothing about the
*edit*. Nothing currently forbids fixing a finding whose consequence was never
established, which is the branch the incident took.

## Goals

1. A gate finding's asserted consequence must be demonstrated before the driver
   edits code on its authority; an undemonstrated consequence is evidence
   against the finding, never licence to fix anyway.
2. Before a fix that changes the behaviour of a symbol used outside the diff
   lands, its consumers are enumerated and each is accounted for; a consumer
   that cannot be accounted for narrows the fix or defers the finding, and does
   not stop the run.
3. Both rules are stated once, by the driver, with an identical summary in all
   four gate skills pinned against drift — the shape the loop-termination spec
   established for this same set of files.
4. Level-honest wording: both rules are level-3 workflow doctrine (AGENTS.md,
   "What this plugin can and cannot enforce"). The only mechanical element is
   this repository's CI pin on the four copies, which constrains this repo and
   not a driver's run.

## Non-goals

- **No helper change.** Codex's diff mode runs codex-cli's built-in `review`
  subcommand with no custom prompt (`skills/afk-codex-review/codex-gate.mjs`),
  so there is no place to make the *gate* state a triggering condition and an
  observable per finding. Both rules therefore live driver-side, where all four
  gates behave alike; a per-gate prompt change would apply to three gates and
  not the fourth.
- **No blocking escalation.** A tripped reach check does not stop the run. afk
  exists to run unattended, and its Autonomy rule already forbids blocking on
  in-scope work; the rule converts "did not think of it" into "must account for
  each", not into an operator round-trip.
- **No new disposition and no new ledger section.** Refuted, Accepted, and the
  unverified handling already exist. The demonstration and the consumer
  accounting fold into the existing `finding → fix → how verified` record.
- **No change to internal review, the adversarial debate, the design-stage
  gate, gate selection, stickiness, metering, or the `SKIPPED` discipline.**
  The design-stage gate reviews a document, where "consumers of a changed
  symbol" has no referent; internal review is written by the same driver and
  carries no imported-authority problem. Both are out of scope.
- **No runtime smoke step.** A render loop is caught by running the app, and
  `.afk/config.md` records no smoke command. Adding one is a larger change
  against a different gap (verification breadth, not triage rigour) and is left
  as the follow-up if these two prove insufficient.

## Design

### D1 — the two rules, defined once in the driver

`skills/afk/SKILL.md`, "External gate", gains two blocks between the selection
bullets and "The loop, and what closes a finding", so that triage precedes
closure in the reading order and the section's closing level-3 sentence ("All
of this is level 3 — doctrine, not a guarantee") continues to cover them.

**A finding asserts two things; reading settles one.** Normatively:

- A structural finding claims both that the code is as described and that this
  shape produces a wrong outcome. Reading the cited `file:line` settles the
  first only.
- A fix lands once the second is demonstrated, by one of: a check that fails
  now and passes after; an executed trace; or a stated path from the shape to
  the outcome naming the condition that triggers it. Restating the finding is
  not a demonstration.
- Failing to demonstrate the consequence is evidence against the finding, not
  licence to fix it anyway, and the code is left as it is either way. The two
  exits are not interchangeable: an **affirmative disproof** records it Refuted,
  and **anything short of one** carries it into the existing unverified
  handling. Non-demonstration is not disproof, and Refuted is defined by its
  recorded disproof — routing a merely-undemonstrated finding there would close
  it outright, skipping the operator escalation that the unverified path
  carries when the PR depends on it. The new text references that handling
  rather than restating it, for the same reason: a partial restatement drops
  the escalation branch for exactly the load-bearing case that needs it.
- Why the undemonstrated fix is the more dangerous branch, stated in the text:
  the finding's authorship carries the edit past the scrutiny the same edit
  would draw unprompted.

**Account for the fix's reach before it lands.** Normatively:

- The gate reads a diff and the next round reads that diff again, so consumers
  outside it are invisible to every reviewer in the loop. This is why the rule
  is needed and is stated as the rule's reason.
- Before applying a fix that changes the behaviour of a symbol used outside the
  diff, the driver enumerates those consumers and states what the change does
  to each.
- A consumer that cannot be accounted for is not licence to proceed: narrow the
  fix to the caller inside the diff, or record the finding Accepted with a
  follow-up issue. Accepted here inherits the existing merge bar — an Accepted
  structural finding is never auto-merged — which is the intended cost and is
  not restated in the new text.
- The enumeration and the per-consumer statement go in the finding's record
  beside the fix, so a wide edit is auditable as one.

### D2 — an identical summary in the four gate skills

A gate skill is loadable standalone and finding-handling is exactly where these
rules bite, so a bare pointer would leave them invisible at the point of use.
Following the precedent set for the stop sentence, each of the four gate skills
carries this paragraph verbatim, as a plain paragraph after its finding-handling
list, using the repo's backtick cross-reference convention:

> A structural finding claims both that the code is as described and that it goes
> wrong; reading the cited `file:line` settles only the first. Demonstrate the
> consequence before fixing, and account for every consumer of what you change
> that lives outside the diff — `../afk/SKILL.md` ("External gate") holds both
> rules.

It opens on **structural** findings, matching the flagship rule. The paragraph
lands directly under a list whose first step sorts minor items out and whose
last defers them; an unscoped opener would demand a demonstrated consequence
from a naming or cosmetic item, which no such item can supply, and an
unsatisfiable rule is one a driver learns to step over.

Each skill's own verification step is reduced to a reference to that standard,
so no file states a weaker one beside it:

| Skill | Current step | Becomes |
|---|---|---|
| `afk-codex-review` | "Each finding is a hypothesis; read the cited `file:line`." | "Each finding is a hypothesis; the verification standard is below. Push back with evidence on anything you can disprove." |
| `afk-claude-review` | "Verify each finding against the cited `file:line`." | "Verify each finding to the standard below." |
| `afk-kimi-review` | "verify each finding against the cited `file:line` before trusting it" | "verify each finding to the standard below before trusting it" |
| `afk-glm-review` | "Verify each finding against the cited `file:line`; GLM saw the diff and changed files, not the whole repo." | "Verify each finding to the standard below; GLM saw the diff and changed files, not the whole repo." |

The glm clause is kept: it names a narrower review scope, which is an
independent fact about that gate, not a competing verification standard.

### D3 — tests

New `scripts/gate-finding-rules.test.mjs`, in the file style of
`loop-rules.test.mjs`, and honest about its role: presence pins that fail on
silent deletion or rewording of a load-bearing sentence, plus `doesNotMatch`
guards on the shape-only standard this change retires. They are not proof a
driver applies the rules.

1. The driver states each rule exactly once — unique-phrase pins with an
   exactly-once count, so a duplicate copy creeping back fails.
2. The undemonstrated-consequence branch is pinned specifically: the finding is
   recorded, not fixed, and the Refuted exit is pinned to affirmative disproof
   so a merely-undemonstrated finding cannot take it.
3. The four gate skills each carry the D2 paragraph, extracted and asserted
   byte-identical across the four.
4. The retired shape-only wording does not return: `doesNotMatch` on
   "against the cited `file:line`" and on codex's "read the cited" in all four
   gate skills, plus on the unscoped "A finding claims both" opener. The
   guards are worded so the pinned paragraph's own "reading the cited" does not
   trip them.

The D2 paragraph names `../afk/SKILL.md`, which `check-links.mjs` does not
validate (it checks markdown links only). This test file reads
`skills/afk/SKILL.md` for item 1, so a rename of the flagship path fails CI
loudly. Residual, accepted and unchanged from the loop-termination spec: a
renamer who updates only the test's read path leaves item 3 green with a stale
path in the four copies. Blast radius is near zero — the name-equals-directory
rule freezes the flagship path.

## Alternatives considered

- **Escalate to the operator when the reach check trips.** Safest, and
  rejected: afk's value is unattended execution, and a shared hook or module is
  common enough that this would stall queues routinely. The enumeration keeps
  the driver's autonomy while removing the failure mode, which was omission
  rather than misjudgement.
- **Refuse all wide fixes — record Accepted, never fix.** Simplest to state and
  rejected: it also refuses genuine wide defects, and the Accepted merge bar
  would then park real bugs behind an operator for a mechanical reason.
- **Require a fail-then-pass test for every behavioural finding, closing the
  "otherwise by a recorded verification step" escape hatch in the Fixed
  disposition.** Attractive and rejected for this PR: it changes closure rather
  than triage, and it is unenforceable where no check is expressible — the
  escape hatch exists because that case is real. D1's demonstration requirement
  reaches the same incident earlier and without that cost.
- **Have the gate itself state a triggering condition and an observable per
  finding.** Would give the driver something concrete to test against, and is
  unavailable: codex's diff mode uses codex-cli's built-in `review` with no
  custom prompt, so it would apply to three gates and not the fourth. Rejected
  as a source of divergence.
- **Add an app-level smoke step to the gate round.** Would have caught this
  specific regression, and is a different change: it broadens verification for
  every round rather than tightening triage, needs a new `.afk/config.md` key,
  and cannot run in repos with no runnable app. Recorded as the follow-up.

## Files to change

| Path | Change | Reason |
|---|---|---|
| `skills/afk/SKILL.md` | two blocks in "External gate", before the closure block | D1 |
| `skills/afk-codex-review/SKILL.md` | step 2 references the standard; D2 paragraph added | D2 |
| `skills/afk-claude-review/SKILL.md` | step 2 references the standard; D2 paragraph added | D2 |
| `skills/afk-kimi-review/SKILL.md` | prose step references the standard; D2 paragraph added | D2 |
| `skills/afk-glm-review/SKILL.md` | step 2 references the standard; D2 paragraph added | D2 |
| `scripts/gate-finding-rules.test.mjs` | new | D3 |
| `.claude-plugin/marketplace.json` + mirrored manifests | 0.2.9 → 0.2.10, mirrored by `sync-marketplace.mjs` | AGENTS.md version rule |

## Assumptions

- Claims about this repository's files (the four weak verification steps, the
  absence of any reach rule, codex diff mode's lack of a custom prompt) are
  verifiable by grep and by reading `codex-gate.mjs`, and are re-pinned by D3.
- The incident is the operator's, reported in conversation; nothing in this
  design depends on it being re-derivable from repository files. The defect
  class it exposes is verifiable from the prose alone.
- Residual risk, stated: a driver can believe it demonstrated a consequence
  when it only restated the gate's argument, and can enumerate consumers
  without reasoning about them. Both rules raise the default from "read the
  shape" to "name the trigger" and from "did not think of it" to "must account
  for each"; neither is a guarantee, and no control point in this plugin can
  make one. Real non-bypassability needs a check outside the agent's authority.

## Appendix — gate findings and their resolutions

Round 1 (Codex) reviewed revision 1 and returned two findings, both confirmed
against the cited text and both fixed in revision 2. Each row names what now
prevents the defect.

| # | Finding (severity) | Disposition |
|---|---|---|
| 1 | The triage block offered Refuted as an exit for merely failing to demonstrate a consequence, while the disposition list defines Refuted as closed by a recorded disproof. A load-bearing finding could close there, skipping the operator escalation and the Accepted merge bar (P1) | **Fixed.** D1 splits the exits: an affirmative disproof records Refuted, anything short of one enters the unverified handling. Verified by reading the two texts together — the Refuted exit is no longer reachable from non-demonstration. D3 item 2 pins both halves |
| 2 | The paragraph copied into the four gate skills opened on "A finding", not "A structural finding", so it demanded a demonstrated consequence from the naming and cosmetic items the list immediately above sorts out and defers — a requirement no such item can satisfy (P2) | **Fixed.** The copied paragraph opens on "A structural finding" in all four skills, matching the flagship; D3 item 3 pins the four copies byte-identical and item 4 guards the unscoped opener |

The same-class defect caught in the driver's own self-review before this round —
the first draft restated only the Accepted half of the unverified rule, dropping
the escalation branch — is recorded in commit `fd1a2bc`'s body. Finding 1 is that
defect surviving in the other half of the same sentence, which is why the fix
now names both exits rather than removing one.
