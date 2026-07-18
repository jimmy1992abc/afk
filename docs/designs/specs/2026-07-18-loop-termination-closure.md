# Loop-Termination Closure — Design Spec

- **Date:** 2026-07-18
- **Status:** Proposed (revision 4; rounds 1–3 findings and their resolutions
  are in the Appendix)
- **Scope:** Issue #11 — define once how the external-gate loop and the
  implementation pilot's self-review loop end, and what closes a finding in
  each; remove the drifted per-gate stop-rule copies.

---

## Problem

Two loops in the pipeline end on an empty review round without defining what
makes that round count, and one of them states its stop rule in several places
at once.

1. **External gate loop.** The driver (`skills/afk/SKILL.md`) sends a PR
   through gate rounds and references "later rounds of the same PR", but never
   defines when the loop ends. The termination that does exist lives in the
   gate skills, inconsistently: `afk-codex-review` and `afk-kimi-review` carry
   two differently-worded "Stop rule" sections (already drifted — one spells
   out the narrowing and design-only clauses, the other compresses them), and
   `afk-claude-review` and `afk-glm-review` have none. Worse, "stop when a
   round returns no new blocker findings" closes a **prior** finding by the
   next round's silence: review rounds are stochastic, and a reviewer that
   omits a previously confirmed finding has not resolved it. The debate had
   the same defect in prose form; PR #10 (commit 7abfbe1, whose body records
   it) closed it there. This spec closes the same class here.

2. **Pilot self-review loop.** `skills/afk-implementation-pilot` stops on "two
   consecutive rounds produce no new findings". Nothing defines what a round
   must contain to count: a round where lenses were skipped, or where a prior
   finding's fix was never re-verified, reads as clean.

Both are instances of the class fixed for the debate in PR #10: an absent
signal treated as a positive state. AGENTS.md's "No duplication — define once"
was applied to the debate's prose there; this spec applies it to the two
remaining loops.

## Goals

1. One definition of the gate loop's termination and of finding closure, owned
   by the driver; every gate skill points at it.
2. Every prior gate finding reaches a **defined disposition** — closed as
   fixed (verified), refuted (recorded disproof), or accepted (recorded
   risk) — never by the next round's silence.
3. The four gate skills carry an **identical** one-sentence summary of the stop
   rule beside the reference, pinned by a CI test that fails on any divergence
   between the four copies, so drift cannot land unnoticed while that check is
   required.
4. Every gate round ends in an affirmative report (`CLEAN` / `OUTSTANDING`)
   in all four gate skills, so an empty round is an attested statement, not
   unattested absence.
5. A defined "clean round" for the pilot: every checklist lens applied to the
   full diff with a stated result, and every prior finding's fix verified —
   with the lens results recorded in the handoff, so a voided round is
   distinguishable downstream.
6. Level-honest wording throughout: the loop rules are level-3 workflow
   doctrine (AGENTS.md, "What this plugin can and cannot enforce"); the drift
   pin is a repo CI control point (AGENTS.md: "a required CI check"), which is
   the only mechanical element here and constrains this repository, not a
   driver's run.

## Non-goals

- No change to any bundled `.mjs` helper; this is prose plus tests. In
  particular, no helper grows a findings-list input — closure verification is
  driver-side (see D1's honesty note).
- No change to the debate rules (PR #10) or to gate selection, stickiness
  (clarified, not changed — D1), metering, or the `SKIPPED` discipline.
- No new state file or protocol. The run ledger already records decisions; the
  fix record named here goes there.

## Design

### D1 — the loop's end, defined once in the driver

`skills/afk/SKILL.md`, External gate section, gains one block. Its content,
normatively:

- **Disposition.** The driver names each structural finding at triage (a
  short id in the record) and judges every later round's findings against
  that named list — same, reopening, or new — recording the judgment;
  reviewers are memoryless here, so identity lives in the driver's record or
  nowhere. Each named finding is triaged to one of three dispositions, each a
  closure when recorded:
  1. **Fixed** — verified against the artifact, by the check that pins it
     where one is expressible (a test that failed before the fix and passes
     after it), otherwise by a recorded verification step; finding → fix →
     how verified recorded.
  2. **Refuted** — closed by its recorded disproof. A later round re-raising
     it with new evidence reopens it; a second refutation of the same named
     finding escalates to the operator rather than looping.
  3. **Accepted** — real, but knowingly not fixed here: an accepted cost, or
     out of this PR's scope (then the record names the follow-up issue). The
     record lands in the ledger and the end-of-run report's deferred items —
     the same accept-and-record disposition the debate defines, and the only
     honest home for a true finding the scope fence forbids fixing.

  A finding the driver can neither confirm nor refute is handled as the
  debate handles `unverified`: if the PR does not depend on it, it is
  Accepted with its risk stated; if the PR depends on it, escalate to the
  operator — the debate's own exit for this state — and the loop does not
  end around it.
- **Silence closes nothing.** As in the debate above, a later round that does
  not mention a prior finding has not resolved it — rounds are stochastic.
  Unlike the debate, no critic revalidates by name here: the gate helpers
  accept a review target and flags such as `--implementer`, but no findings
  input, so closure rests on the driver's own verification, with the next
  round's fresh review of the full diff as the independent backstop. That is
  weaker than the debate's closure and is said so in the skill text.
- **Records live with the run.** In an afk run, the disposition record goes in
  the run ledger. A standalone gate invocation has no run directory; the
  record goes wherever that review is tracked (the PR thread or commit
  message) — untracked is not an option.
- **The loop ends** when a round reports no new structural finding and every
  prior structural finding is closed (fixed, refuted, or accepted). The
  open-findings record is **run-scoped**: it survives a mid-loop gate switch —
  the baseline reset in the stickiness rule resets what counts as *new* for
  the incoming gate, never the dispositions already recorded.
- **Narrowing.** A finding that only rewords the driver's last fix, naming no
  behavior difference — for a prose artifact, no consequence difference: no
  different decision, invariant, or outcome — does not count as a new
  structural finding. One that names such a difference is new — or a
  reopening — however small; the narrowing clause never discounts a
  resurfacing defect.
- **Design-doc rounds.** When the diff under review is a design doc, a
  remainder that the waterfall's tests-first step will enforce does not count
  as a new structural finding **only if** it is recorded in the design doc
  itself as a required test — the artifact present at that point, and the one
  the tests-first step consumes; the record is the closure, not the future
  test.
- **Accepted findings and the merge bar.** For the Autonomy rule's "open
  finding", a finding is open until it has a recorded disposition — so an
  Accepted finding does not block loop termination. It does change the merge:
  a PR whose record carries an Accepted **structural** finding is never
  auto-merged, whatever the merge policy — it is marked ready and left open,
  because a driver can record a risk but only the operator can own one at the
  merge boundary (fail toward less exposure). The Autonomy line gains the
  cross-reference.
- Three or more consecutive rounds with new structural findings mean the
  internal pass was too weak — stop patching finding-by-finding and re-review
  the whole diff for the shared root before spending another round.
- Level 3: nothing here executes; a driver that stops early has skipped a
  step, not disproved the rule.

The waterfall's arrow line currently carries its own compressed copy of this
loop ("fix every confirmed structural finding; one self-review pass between
gate runs; defer minor items to a single final pass"); it is rewritten to
point at this block so the file states the loop once.

### D2 — gate skills reference the driver, with a pinned summary

Each of the four gate skills states exactly this sentence, as a plain
paragraph, using the repo's backtick cross-reference convention (AGENTS.md
prescribes backtick relative paths; no `skills/` file uses markdown links):

> Stop when the loop-termination rule in `../afk/SKILL.md` ("External gate")
> holds: a round with no new structural finding and every prior structural
> finding closed by a recorded disposition — a driver-verified fix, a
> refutation, or an accepted risk.

`afk-codex-review` and `afk-kimi-review` replace their divergent Stop rule
bodies with it; `afk-glm-review` and `afk-claude-review` gain it where their
finding-handling ends. All four then close their round with the same report
contract: `CLEAN`, or `OUTSTANDING` with what remains — extended to glm and
claude, which today end a round with no affirmative statement (Goal 4). A
pointer alone would starve a standalone invocation of the rule; a free
rewording would drift like the last two did. An identical sentence, pinned
across the four files by a CI test, is the middle that survives both.

### D3 — the pilot's clean round, defined

`skills/afk-implementation-pilot/SKILL.md` §5 defines the term its stop
condition already uses:

- A round is **clean** only if every checklist lens was applied to the full
  diff and reported a result — "lens applied, nothing found" is a statement;
  a skipped or silent lens voids the round — and every finding from earlier
  rounds has its fix verified: by re-running the affected checks where one
  applies, otherwise by a recorded verification step (the gate loop's own
  fallback). A fix's absence from later rounds verifies nothing.
- Two consecutive clean rounds bound the **effort**, not correctness — the
  reason internal review and the external gate still follow.

§6 (handoff) additionally records the lens-by-lens results of the two clean
rounds, so the claim "clean" is auditable downstream rather than a bare pair
of round numbers.

### D4 — tests

New `scripts/loop-rules.test.mjs`, in the file style of
`debate-rules.test.mjs`. Its role, stated honestly: mostly **presence pins**
on the new definitions — narrow regression value, they fail on silent
deletion or rewording of a load-bearing sentence — plus `doesNotMatch` guards
on the wordings this spec refutes. They are not proof the loops work.

1. The driver defines termination and closure: pins on phrases **unique to
   the new block** (e.g. the disposition sentence, "run-scoped",
   "recorded refutation"), each additionally asserted to appear **exactly
   once** in the file — the exactly-once count is what catches both a vacuous
   pin (phrase already present elsewhere, e.g. the debate section's own
   "omitted finding" sentence) and an in-file duplicate creeping back.
2. The four gate skills each contain the D2 sentence, extracted and asserted
   strictly identical across the four files.
3. The drifted stop-rule wordings do not return (`doesNotMatch` per file on
   the old codex/kimi phrasings).
4. The pilot defines "clean" (unique-phrase pins) and the bare undefined stop
   line does not return.
5. The report contract (`CLEAN` / `OUTSTANDING`) is pinned in **all four**
   gate skills.

A note on the backtick reference: `check-links.mjs` validates only markdown
links, so the pinned `../afk/SKILL.md` path is invisible to it — but this test
file itself reads `skills/afk/SKILL.md` to run item 1, so a rename of the
flagship path fails CI loudly anyway. Residual, accepted: a renamer who
updates only the test's read path leaves item 2 green with a stale path in
the four pinned copies and the test's own sentence — no check catches that
half-update. Blast radius is near zero (the name-equals-directory rule
freezes the flagship path), which is why it is accepted rather than closed.

## Alternatives considered

- **Keep per-gate stop rules, just sync them.** Four copies with no pin is how
  the drift happened; a pin with no single owner leaves the semantics
  ownerless. Rejected.
- **Define the rule in AGENTS.md.** Wrong audience: AGENTS.md governs work on
  this repository; the loop governs runs of the pipeline in consuming repos.
  The driver owns the loop. Rejected.
- **Pointer-only references in gate skills.** Cheapest, and the letter of
  issue #11's "reference it instead of restating it". Rejected: a gate skill
  is loadable standalone and its reader may never resolve the link; the loop
  rule would be invisible exactly where findings are handled. The pinned
  identical summary is a knowing deviation from the issue's letter, recorded
  as such — the pin, not good intentions, is what keeps it from becoming the
  drift the issue complains about.
- **Extend the gate helpers to accept a findings list and revalidate by
  name** (true parity with the debate's closure). Rejected for this PR: it
  changes four helpers' CLI surface for a marginal gain over
  driver-verification-plus-fresh-round, and issue #11 is a prose defect. If
  the self-attestation residual (D1's honesty note) proves costly in
  practice, that is the follow-up to reach for.

## Files to change

| Path | Change | Reason |
|---|---|---|
| `skills/afk/SKILL.md` | add loop-end block; rewrite waterfall arrow segment to reference it; Autonomy "open finding" gains the disposition cross-reference and the accepted-finding no-auto-merge rule | D1, single definition; finding 24 |
| `skills/afk-codex-review/SKILL.md` | replace Stop rule body with D2 sentence | D2 |
| `skills/afk-kimi-review/SKILL.md` | replace Stop rule body with D2 sentence | D2 |
| `skills/afk-glm-review/SKILL.md` | add D2 sentence + report contract | D2, Goal 4 |
| `skills/afk-claude-review/SKILL.md` | add D2 sentence + report contract | D2, Goal 4 |
| `skills/afk-implementation-pilot/SKILL.md` | define clean round (§5); handoff records lens results (§6) | D3 |
| `scripts/loop-rules.test.mjs` | new | D4 |
| `package.json` + manifests | 0.2.4 → 0.2.5 via sync script | AGENTS.md version rule |

## Assumptions

- Claims about files in this repository (the drift, the absences, the missing
  report contracts) are verifiable by grep and re-verified by the D4 tests.
- The claim that the debate had this defect and PR #10 fixed it rests on
  PR #10's merged commit (7abfbe1) — its body states the omission-as-closure
  defect. The finer-grained gate-round history behind it lives in that run's
  ledger and PR thread, not in repository files; nothing in this design
  depends on that history being re-derivable.
- Residual risk, stated: gate-finding closure is driver-side verification —
  self-attestation with a fresh-round backstop, weaker than the debate's
  critic revalidation. Accepted for this PR; see Alternatives for the
  follow-up if it proves insufficient.

## Appendix — debate findings and their resolutions

Round 1 attacked revision 1 (findings 1–16, all resolved in revision 2 and
revalidated by name in round 2); round 2 attacked revision 2's new text
(findings 17–22, resolved in revision 3 and revalidated by name in round 3);
round 3 attacked revision 3's new text (findings 23–26, resolved in revision
4). Each row names what now prevents the defect.

| # | Finding (severity) | Resolution |
|---|---|---|
| 1 | Closure claimed parity with the debate while substituting self-attestation (P1) | D1 "Silence closes nothing" states the mechanism difference and its weakness; Assumptions records the residual; Alternatives records the rejected helper extension |
| 2 | Disputed findings had no closure path; termination could never hold after pushback (P1) | D1 "Disposition": refutation-with-record closes; re-raise reopens; second refutation escalates |
| 3 | Narrowing carve-out let the driver discount a resurfacing residue (P2) | D1 "Narrowing": behavior-difference re-raises are never narrowing |
| 4 | Open-findings set ambiguous across a gate switch (P2) | D1 "run-scoped"; baseline reset scoped to *new*-ness |
| 5 | Pinned sentence dropped "recorded" (P2) | D2 sentence carries "recorded" for both dispositions |
| 6 | D1 duplicated the debate's sentence in-file (P2) | D1 references the debate; D4 item 1's exactly-once count pins against recurrence |
| 7 | Minor-items rule restated; waterfall arrow left as second loop statement (P2) | D1 drops the restatement; arrow line rewritten to reference the block (change table) |
| 8 | Design-only/TDD carve-out closed on a future artifact (P2) | D1 "Design-doc rounds": the plan record is the closure |
| 9 | Two of four gates had no affirmative round report (P2) | Goal 4; D2 extends `CLEAN`/`OUTSTANDING` to glm and claude; D4 item 5 pins all four |
| 10 | "Level-2" mislabel for a CI test; "cannot drift" overclaim (P2) | Goal 6 names it a repo CI control point; Goal 3 scopes the claim to "while that check is required" |
| 11 | Whole-file pins vacuous — phrases already matched pre-change (P2) | D4 item 1: unique phrases + exactly-once counts |
| 12 | Markdown link broke `skills/` conventions; blockquote/paragraph ambiguity (P2) | D2: backtick path, plain paragraph |
| 13 | Standalone invocation had no ledger for the record (P2) | D1 "Records live with the run": PR thread/commit fallback, untracked not an option |
| 14 | Pilot lens results had no consumer (P2) | D3: §6 handoff records lens-by-lens results |
| 15 | D4's role description borrowed the narrow guard justification for presence pins (P2) | D4 states the presence-pin role honestly |
| 16 | PR #10 evidence claim not verifiable from repo files; Assumptions said "None" (P2) | Problem cites commit 7abfbe1's body; Assumptions scopes what is and is not re-derivable |
| 17 | Disposition set had no accepted/deferred path; an out-of-scope true finding stalled the loop forever (P1) | D1 "Disposition": three closures — fixed / refuted / accepted (with follow-up issue for out-of-scope); unverified handled per the debate |
| 18 | Finding identity undefined across memoryless rounds (P2) | D1 "Disposition": driver names findings at triage; same/reopening/new judged against the named record and recorded |
| 19 | Narrowing criterion ("behavior difference") undefined for prose artifacts (P2) | D1 "Narrowing": consequence difference — decision, invariant, or outcome — for prose |
| 20 | "Recorded in the plan" named an artifact that does not exist at design-doc review time (P2) | D1 "Design-doc rounds": the record lives in the design doc itself, which tests-first consumes |
| 21 | "Helpers accept only a diff target" contradicted `--implementer` (P2) | D1 wording: a review target and flags, but no findings input |
| 22 | Backtick reference invisible to check-links; silent four-copy break on rename (P2) | D4 note: the test's own read of `skills/afk/SKILL.md` fails CI on rename; item 2 catches a half-updated pin |
| 23 | Goal 2 and the D2 pinned sentence kept the two-disposition wording, contradicting D1's three and CI-pinning the wrong rule (P1) | Accepted swept into Goal 2 and the D2 sentence; D4 item 2 pins the corrected sentence |
| 24 | Accepted vs the Autonomy rule's "open finding" undefined at the merge decision (P1) | D1 "Accepted findings and the merge bar": open = no recorded disposition; an Accepted structural finding never auto-merges — ready + left open, operator owns the risk; Autonomy line cross-referenced (change table) |
| 25 | Load-bearing unverifiable finding had no exit (P2) | D1 unverified handling: escalate to the operator, the debate's own exit; the loop does not end around it |
| 26 | D4 note credited item 2 with catching the read-path-only half-update it cannot catch (P2, refuted by critic) | Note rewritten: that residual is named and accepted, blast radius stated, not claimed caught |
