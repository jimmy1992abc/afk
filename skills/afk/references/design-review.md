# Design review

Read [review convergence](review-convergence.md) before triaging findings or
repairing a design; it owns common admission, allowance, dispositions and net
progress. Read the section needed for the current design stage.

## Adversarial debate

The critic is a subagent, usually the driver's own model. It is cheap, so it runs
on every design — but being same-model, it can only test claims it *notices*, and
it shares the author's blind spot about what was never considered at all. It is
therefore a check on the design's **claims**, not proof of the design's
**completeness**; an external design gate, where configured, covers omissions and
framing that this step structurally cannot.

**Posture, not verdict.** The critic is dispatched to break the design across
named lenses, and each finding lands as `supported`, `refuted`, or `unverified`.
Do **not** predetermine the outcome: a critic told the answer is "refuted"
invents objections and can never return a clean pass on a sound design. "No
finding" is a valid, reportable result. Reject an unsupported finding as firmly
as an unsupported design claim.

**Every finding carries a severity proposal.** Posture says whether the finding
holds; severity says what it costs. A reviewer does not admit its own blocker:
the author validates and classifies it against the frozen contract.

- **P1** — the design is wrong, or rests on a claim that is wrong or unverified.
  Building it yields a defect, a rewrite, or a hole.
- **P2** — a real weakness the design survives: a cost, a gap, or a risk worth
  taking knowingly.
- **minor** — a non-structural improvement with no demonstrated wrong user or
  system outcome. It is never promoted merely because a reviewer repeats it.

Apply the [common finding admission standard](review-convergence.md#finding-admission).

**Verify claims about external systems — by the cheapest SAFE means.** A design
that asserts how a CLI behaves, what a permission model allows, what a command
returns, or what a config does is asserting a fact, and the debate's job is to
check it rather than reason about it. In descending preference:

1. A hermetic experiment in a disposable workspace (temp dir, scratch repo,
   fixture). Preferred — this is what catches an author and critic sharing a
   wrong belief.
2. Source, official documentation, or a recorded fixture.
3. Neither available → record it in the design as an **assumption and its risk**.
   An unverified claim is reported as unverified; it is never promoted to fact.

Bounds, which override the preference order: never mutate production, never run a
destructive action outside a disposable workspace, never paste credentials or
secrets into a finding. Record the environment and version with any result — a
local pass does not prove another OS, version, or configuration.

**Validate a finding independently; do not re-run it blindly.** The author
confirms a finding by the cheapest safe means — preferably a failing test — not
by repeating a destructive action, and never on the critic's authority alone.
Repeating it in the same environment is not independent confirmation.

**The round, and how the debate ends.** Assign every finding a stable ID. A round
is: the critic reports — first
the status of every finding still open from earlier rounds, each by name, then
anything new — the author validates each finding independently, then resolves it.
A supported P1 requires revision within the allowance, else an outstanding
handoff. For a supported P2, revise or mark it `Deferred` with its reason.
Deferring closes the finding without blocking the next stage. A finding resolved
by a revision stays **open** until a later round
revalidates the revised design against it, by name, and reports it resolved.
Critics are stochastic and miss things, so silence about an open finding is not
closure — an omitted finding is unexamined, not resolved. Then one of:

- **A clean round ends the debate** — no open finding, no unverified claim the
  design depends on, and no revision made this round. Implementation starts here
  and nowhere earlier.
- **Otherwise, debate the revised design again.** A revision is a new design: its
  fixes are themselves claims nobody has checked yet. A supported P1 is not
  discharged by editing the doc — only by a round that revalidates it by name
  and reports it resolved.

**Exit criteria — verified closure within the allowance.** Ask only: has the
design in front of you had a clean round? If yes, advance. If no — an untriaged
finding or admitted P1 is open, a claim the design depends on remains unverified,
or the design was revised after its last clean round — **do not start
implementing**. Continue repairs only within the shared allowance and the [net
material-progress rule](review-convergence.md#ordered-role-revision-and-convergence-rules). A design version lands with its frozen contract
and a named next validation as initial progress; review-driven revisions consume
the issue allowance.

Read and apply the [root-cause checkpoint](review-convergence.md#root-cause-checkpoint)
when the common no-progress condition holds; inspect the affected design and
continue independent queued work if it remains `OUTSTANDING`. Escalate only if the task depends on scope expansion, an
unavailable external capability, or a product choice with no safe default. Round
count never requests operator permission. Abandoning or replanning a verified P1
that cannot be fixed inside the frozen contract is also an operator authority
decision, not a driver-owned deferral.

This is level 3 — doctrine, not a guarantee. Nothing stops a driver from implementing anyway. It stops if it
follows this file, which is the same basis as every other step in the waterfall.

**Record what was refuted.** A claim the design made, believed, and got wrong
stays in the doc — but only where it links to what now prevents it: the corrected
decision, and the test or control that pins it. A refuted-claims list with no
such link is a diary; either give it a consumer or leave it out.

The ledger record — a deferred concern, or a P1 that stopped the run — is the only
durable artifact here, and it is what the operator reads.

## External design review

A pilot step, **default off**. When enabled it runs **one** external gate over the
design doc, after the adversarial debate and before tests: the debate is a
same-model check on the design's *claims*, and an independent model adds the one
thing it structurally cannot — a less-correlated search for *omissions and wrong
framing*. Configured in `.afk/config.md`:
`design-gate: off` (default, never) · `risky` (design-heavy or high-blast-radius
issues only) · `on` (every issue). `risky` follows the design **scaling** rule —
an external review of a three-paragraph design is waste — and is NOT the
never-scale-down-gates rule, which governs PR gates only.

- **Invocation.** Read [external review](external-review.md) for selection (`priority`) and authorship. Use the same gate helpers, with
  a design target: `--design <path>` in place of a diff selector. The gate reviews
  the document, not a diff. It is read-only **by construction** for `codex`
  (`exec -s read-only`), `claude` (`Read,Grep,Glob` only), and `glm`, `deepseek`,
  and `mimo` (tool-less API calls); `kimi` is the exception — its read-only is only *requested in the
  prompt* (the same weaker guarantee it carries for diff reviews), so prefer
  another gate for design when one qualifies. A missing or unreadable `--design`
  path is operator error → the gate errors (nonzero), never a skip — skipping here
  would mean no independent review happened at all.
- **Independence is from the design's AUTHOR.** The guard's `--implementer` here
  identifies whoever wrote the *design*, not the code implementer a PR-gate
  `--implementer` names. Declare the design author explicitly: `CLAUDECODE`
  identifies only a Claude host, not a generic driver, and a persistent config
  declaration can instead name the eventual code implementer. Exclude every
  family that authored content in the current design revision, including a
  driver that rewrote a relayed design, before choosing its reviewer. The
  single-family helper declaration cannot validate that complete author set;
  recording and applying it is driver doctrine.
- **Exactly one gate per design evaluation, regardless of PR `gates` length or
  legacy `min-pass`.** Those fields govern the PR gate; one independent role is
  the whole point here. A design-invalidating finding restarts the design step;
  later evaluations share the issue's review-cycle allowance and net-progress
  checkpoint, with no invocation counter that requests permission.
- **Findings close under the same vocabulary** the PR gate uses ([finding dispositions](review-convergence.md):
  fixed / refuted / deferred / suppressed / contested); no design-stage finding is closed by silence. A
  `fixed` whose fix is "a test the implementation must carry" is recorded in the
  design doc as a required test, which the tests-first step then consumes.
- **A distinct `design-gate` ledger section.** Design-gate findings are recorded
  under their own section of `.afk/runs/<run-id>/ledger.md`, keyed by issue +
  design version, **separate from the PR-gate finding record**. The merge bar
  ([publication](publication.md#merge-bar)) reads the PR-gate section only, so a design-stage `Deferred`
  never bars the PR merge — if that risk is still real in the shipped code, the PR
  gate raises it against the code, where the bar applies.
- **Baseline before the gate.** Before the gate runs, the driver pre-registers the
  debate's findings for this design version into the ledger, timestamped and
  closed before the gate is invoked, so a gate finding cannot be retro-labelled
  "the debate already had it". This is **self-reported evidence the operator
  adjudicates** — the same driver records both sets — not a plugin measurement:
  the operator, not the driver, decides whether a gate finding was genuinely new
  and whether the pilot is promoted toward `on` or retired.
- **A skipped design gate proceeds.** Unlike the PR gate — whose `SKIPPED` round
  is not clean — an environmental skip (no qualifying reviewer available) is
  recorded and the waterfall continues; the mandatory PR gate still follows.

All of this is level 3 — doctrine, not a guarantee.
