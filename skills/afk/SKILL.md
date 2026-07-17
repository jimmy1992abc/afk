---
name: afk
description: Away-From-Keyboard autonomous execution. Use when the operator hands off a PRE-SCOPED, pre-reviewed set of issues/PRs for full autonomous execution until the queue is done. Requires an operator-provided scope — never pick work from the tracker yourself. Triggers include "/afk", "AFK mode", "go AFK on …".
---

# afk

Hand-off mode: the operator designed and reviewed a scope; you execute exactly
that queue autonomously and stop yourself when done or stuck. This file is the
self-contained spec.

## Kickoff (every time)

1. **Require a scope.** The operator must name the explicit issues/PRs (and/or
   file areas) to touch. **No scope → stop and ask.** Never browse the tracker
   and pick work yourself; the scope fences everything you may touch.
2. **Auto-bootstrap first.** If `.afk/` is absent, run the `afk-init` bootstrap
   automatically (create `.afk/` from the template, add the ignore entry,
   detect commands, record `pluginRoot`) — idempotent — announce it, and
   continue. This runs before any config-dependent step, so a first run reads a
   populated config rather than only defaults. No manual step; `/afk-init` stays
   available to re-run detection.
3. **Update check.** Run the bundled update check; if the installed plugin is
   behind the canonical repo's latest version, surface a one-line notice. Never
   block on it (silent when offline).
4. **Confirm the merge policy** (from `.afk/config.md`: `leave-open` default /
   `merge-to-unblock` / `merge-when-green`) and any constraints (branches not to
   touch, naming, safe-direction-only, deploy is the operator's job, summary
   language, explicit gate choice).
5. **Restate the scope** in one line, then start.

## Per issue — the full waterfall (one at a time)

**Every issue runs the full waterfall — no exceptions.** Each in-scope PR passes
internal review AND the external gate(s) AND lands green (merged, or under
`leave-open` marked ready only after internal review + gate + full test suite all
pass). A design doc, a pushed branch, or a draft PR is a mid-waterfall
checkpoint — never a stopping point and never an operator handoff. "Next:
operator runs the review" is a bug, not an end state.

design doc → adversarial debate (rules below; cap ~3 rounds; at the cap an
unresolved P1 escalates instead of proceeding, an accepted P2 risk goes to the
ledger) → tests first (targeted) → implementation → adversarial sweep →
commit → push early → open the PR as draft → deterministic CI green (fix red
now) → **internal review** (`afk-internal-review`) → fix every finding →
**external gate(s)** (rule below) → fix every confirmed structural finding;
one self-review pass between gate runs; defer minor items to a single final pass
→ **full test suite once** (the project's test command from `.afk/config.md`) on
the final commit → mark ready → merge per policy. The design doc matters more
than the code.

- Scale design/debate depth to the work: mechanical, well-specified work gets a
  brief design and one debate round; design-heavy work gets the full treatment.
  Never scale down tests or gates.
- **Green** = deterministic CI green AND the full test suite green on the final
  commit. A green PR page alone is not green. Never mark ready before the suite
  is green.

## Adversarial debate (the design-stage check)

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

**Every finding carries a severity.** Posture says whether the finding holds;
severity says what it costs. Every rule below turns on it, so a finding without
one cannot be acted on:

- **P1** — the design is wrong, or rests on a claim that is wrong or unverified.
  Building it yields a defect, a rewrite, or a hole.
- **P2** — a real weakness the design survives: a cost, a gap, or a risk worth
  taking knowingly.

An unlabelled finding is a P1 until someone labels it — the cheap error is
debating a P2 twice, not shipping a P1 nobody graded.

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

**The round, and how the debate ends.** A round is: the critic reports, the author
validates each finding independently, and the design is revised for every
supported finding. Then one of:

- **A clean round ends the debate** — no supported P1 and no unverified claim the
  design depends on. Any P2 taken knowingly is in the ledger with its reason.
  Implementation starts here and nowhere earlier.
- **Otherwise, debate the revised design again.** A revision is a new design: its
  fixes are themselves claims nobody has checked yet. A supported P1 is not
  discharged by editing the doc — only by a round that no longer finds it.
- **~3 rounds is the cap**, and reaching it is not an ending. See below.

**Exit criteria — the cap bounds spend, not correctness.** Reaching the round cap
is not a pass. At the cap:

- With an unresolved **P1**, or an unverified claim the design depends on, **do
  not start implementing**. Escalate to the operator, or to the external design
  gate if one is configured. Never proceed past a P1 because the rounds ran out.
- An unresolved **P2** proceeds only as a risk you accept explicitly and record
  in the ledger with its reason. A helper cannot accept a risk on the operator's
  behalf; what gets written is a decision you made and are accountable for.

This is level 3 — doctrine, not a guarantee (AGENTS.md, "What this plugin can and
cannot enforce"). Nothing stops a driver from implementing anyway. It stops if it
follows this file, which is the same basis as every other step in the waterfall.

**Record what was refuted.** A claim the design made, believed, and got wrong
stays in the doc — but only where it links to what now prevents it: the corrected
decision, and the test or control that pins it. A refuted-claims list with no
such link is a diary; either give it a consumer or leave it out.

The ledger record — an accepted risk, or a P1 that stopped the run — is the only
durable artifact here, and it is what the operator reads.

## External gate (the independent check)

An external gate is **mandatory**: run the number set by `min-pass` in
`.afk/config.md` (default 1) each round, never skipped by choice. Constraints:
each gate's model is **not** the implementer's model, and is a
current-generation mainstream frontier model.

- **Selection** follows `.afk/config.md`: `priority` (default
  `codex > claude > kimi > glm`),
  `min-pass` (default 1), and `mode` (`waterfall` = try in priority order,
  stopping once `min-pass` gates pass; `parallel` = run `min-pass` at once).
  Skip any gate that is the implementer's own model or cannot run (uninstalled,
  logged out, out of credit, below tier); the next in priority takes its place.
- **Declare the implementer when it is not the driver.** Pass
  `--implementer <family>` to the gate whenever another model wrote the change —
  most often after `afk-agent-relay`. Each gate applies the no-self-review rule
  **on the runs routed through its helper** and, absent a declaration, assumes
  the driver is the implementer; under a Claude Code driver `afk-claude-review`
  therefore self-skips and the next gate in `priority` takes its place. That is
  correct behaviour, and it is why the flag matters: without it, a Codex-driven
  relay to Claude would let Claude review its own work.
  A helper cannot constrain a round it was never asked to run — the rule that
  the gate runs at all is doctrine (see AGENTS.md, "What this plugin can and
  cannot enforce").
- **Stickiness:** a gate chosen in round 1 is locked for later rounds of the same
  PR; a mid-loop switch resets that gate's finding baseline and is recorded.
- **`SKIPPED` is the last resort only** — when no qualifying reviewer can run.
  Record it in the ledger and end-of-run report and continue. Stopping early or
  handing the gate to the operator is not a valid skip. When `min-pass` cannot be
  met, the round is not clean — do not mark ready.

The gate skills (`afk-codex-review`, `afk-claude-review`, `afk-kimi-review`,
`afk-glm-review`) carry the invocation, batching, and metering rules; they load
when the gate runs.

## Autonomy

Decide with best-practice defaults and record each decision; do not block on
in-scope work. Risky changes ship safe-direction (behind a default-off flag,
fail-safe, additive). Only stop for: out-of-scope work, a destructive or
outward-facing action without authorization, or genuine ambiguity with no safe
default. Never merge a PR that is not green or has an open finding; never touch
another session's branch; never deploy (merge ≠ deploy).

## Continuity and self-pause

Each run owns a directory `.afk/runs/<run-id>/` (gitignored) holding everything
that run produces: `ledger.md`, updated in place, and the per-PR final reports
written beside it. If the ledger is missing, reconstruct it from the state checks
below.

Resolve `.afk/` against the repository's **main working tree** — the first
`worktree` line of `git worktree list --porcelain` — never against the current
directory, and never by taking the parent of the common git dir (under
`--separate-git-dir`, or in a submodule, that parent is git metadata rather than
a working tree). The directory is per **run**, never per worktree: one run
legitimately spans several worktrees, and each linked worktree has its own tree,
so a path resolved from the current directory would split one run's state across
trees and hide concurrent runs from each other.

**Claiming your run directory** — part of kickoff, in this order; each check is
only meaningful before you adopt anything:

1. **Read every `.afk/runs/*/ledger.md`**: its `run-id`, `scope`, `state`, and
   heartbeat. Do this first — once a directory is yours it is no longer "other",
   and stops being checked.
2. **A live run whose scope overlaps yours → stop and ask the operator** — live
   meaning `state: active` with a heartbeat under ~20 min. Two runs would drive
   the same issue. This holds however the scopes overlap, exact match included: a
   live same-scope run is a collision, not an invitation to resume. Disjoint
   scopes proceed silently.
3. **Resume** only a run that is `active` but not live — the directory whose
   ledger scope matches yours, or whose `run-id` the operator handed you. A
   `complete` run is finished history: never resume it, never count it as a
   collision, and leave its directory untouched.
4. **Otherwise allocate** `<run-id>` as `<YYYY-MM-DD>-<scope-slug>`, the slug
   sanitized for the filesystem and length-capped. Create the directory with an
   operation that **fails if it already exists** (`mkdir` without `-p`) — testing
   the path first and writing second leaves a window for a concurrent run to take
   it in between. Write `ledger.md` with its header as the very next action: the
   directory *is* the claim, so a directory with no ledger is a run still
   starting, not a free path.

   Creation failing means someone holds that path — never blindly move to the
   next suffix, which would fork a duplicate run. Read what is there: an `active`
   ledger whose scope overlaps yours sends you back to step 2; a `complete`
   ledger, or one whose scope is disjoint, is a spent or colliding slug, so retry
   the next suffix; no ledger yet means a run is mid-claim — wait briefly,
   re-read, and treat it as live if it stays ledgerless.

The ledger opens with a header carrying `run-id`, the run's `scope` as the
operator gave it, `state`, and the UTC `heartbeat` — written when the directory is
claimed and kept current thereafter. These four are what every other run reads to
identify this one, so a ledger without them is unmatchable.

`state` is `active` from the claim until the queue is done, and `complete` only
once it is. The two ways a run ends are not the same state: **finishing the queue
sets `complete`** — its scope is spent, and a later run over that scope starts
fresh rather than reopening it — while **auto-pausing leaves it `active`**, with
only the heartbeat going stale, which is precisely what makes the work resumable.
Marking a pause `complete` would strand it; never marking anything `complete`
would leave a finished run forever resumable and its scope never free again.

- **Never write into another run's directory.** Concurrent runs in one repository
  are normal; a shared ledger path is what makes them collide.
- **If the host supports scheduled re-invocation** (a cron or wake-up), set up a
  recurring tick that re-invokes you; the tick prompt is static (scope, order,
  merge policy, constraints, run directory) — never embed the ledger itself.
  Otherwise run to completion in-session, checkpointing the ledger before any
  yield so a later session resumes the same issue at its next step.
- **Overlap guard — first action each tick:** refresh a UTC heartbeat in your own
  ledger at each step and during long waits. A tick that finds a heartbeat
  fresher than ~20 min in **its own** ledger exits immediately (another tick of
  this run is working); such exits do not count toward auto-pause.
- **Never identify a run by recency.** Match the operator's scope; the newest
  ledger is as likely to belong to another run as to yours.
- **Legacy layout:** a `.afk/afk-ledger.md` or `.afk/reports/` predates run
  directories and carries no scope header, so it cannot be scope-matched. Ask the
  operator whether it belongs to this run; adopt it on a yes by moving it into
  your run directory, otherwise leave it untouched. Never adopt one silently.
- **State checks** (scoped, not global): view each scoped issue; list PRs for
  your branches; check the current branch and status; resume the first
  unfinished step. One branch per issue off the default branch; push early.
- **Auto-pause:** track substantial new content per tick (a commit, a pushed
  branch, an opened PR, a new design doc, a resolved CI failure or finding).
  Two consecutive working ticks with none → stop the tick loop, post a status
  report (blocking + remaining), and stop, leaving `state: active` so the run can
  be resumed. Queue complete → stop with a final report and set `state: complete`
  in the same breath, ending the tick and the claim on your scope together.
  Always tear down any scheduled tick on stop — never leave one running.

## End-of-run report

Every PR with its state (merged / open-awaiting-review), every notable decision,
each external-gate outcome (including any `SKIPPED`), deferred/remaining items,
and anything blocking. In the operator's preferred language.
