# Continuity and self-pause

Each run owns a directory `.afk/runs/<run-id>/` (gitignored) holding everything
that run produces: `ledger.md`, updated in place, and the per-PR final reports
written beside it. If the ledger is missing, reconstruct it from the state checks
below.

Read [environment](environment.md) before resolving the shared `.afk/` directory.

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
  merge policy, constraints, effective gate profile, run directory) — never
  embed the ledger itself.
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
  unfinished step. One branch per issue off the default branch; push early unless
  `remote-ci: off` selects local completion.
- **Auto-pause:** read and use the [one material-progress definition](review-convergence.md#ordered-role-revision-and-convergence-rules).
  Commits, pushes, and notes outside that definition are activity, not progress. Two consecutive
  working ticks with none → run the [automatic root-cause checkpoint](review-convergence.md#root-cause-checkpoint). Count a
  barren tick only while the current stage is unfinished. If the checkpoint also
  cannot progress, stop the tick loop, post a status report, and leave
  `state: active` so the run can resume. Queue complete → stop with a final report
  and set `state: complete` in the same breath, ending the tick and claim.
  Always tear down any scheduled tick on stop — never leave one running.

## Stage and session transitions

Before a handoff, yield or host-supported compaction, the driver checkpoints its
existing ledger and evidence; a child returns its bounded result and evidence
locations to that driver. Read [stage output](output.md) before preparing that
view. Nested stages use the same run supplied by the driver, not a new claim.
Keep the claiming/collision rules above for actual run claims and resumes.

Retain source authority: the operator's scope and publication instructions,
consuming-repository constraints and resolved policy. Already granted authority
persists across stages and sessions; resolve its source instead of asking again.
A child, summary or verdict cannot expand it. If authority is missing or
conflicting, seek a concrete decision only for dependent actions while retaining
independent authorized work.

Before dependent work after resume or compaction, reload the same run's source
authority, frozen issue contract and open assumptions; inspect the actual
worktree, branch/status and target; reread stable findings, evidence and consumed
and reserved allowances. Compare the next action with those sources. A stale
summary cannot establish the current target or an approval. Read
[review convergence](review-convergence.md) for reservation, reconstruction and
staleness rules, and [review evidence](review-evidence.md) before reusing review
artifacts. Missing sources remain explicit; reconstruct from retained evidence
under those rules before dependent work, never assume fresh allowances.

When direction records exist, read [direction state](direction-state.md) before
reloading their baseline, policy and audit consumption. Use the canonical sequence
and retained expected bindings; a narrative summary cannot repair invalid state.
Absent records remain direction-off. Existing lifecycle and content-repair
accounting retain their owners.

When retained policy enables audits, read [direction audits](direction-audit.md)
at resume and stage/signal boundaries before choosing the next audit action.
Reload actual target and matching reservation/result bindings; a missing expected
sequence cannot disable retained required policy or replenish an old attempt.

Do not assume portable clear/compact commands, cache lifetimes or model-switch
semantics. If no supported transition is available, continue in-session with
bounded reads and evidence pointers. These are level 3 workflow instructions.

## Restricted executor handoff

A separate implementation model may be able to
edit a linked worktree while its sandbox cannot write the linked-worktree Git
metadata stored under the main checkout. That is a valid dirty-tree handoff, not
a reason to broaden its filesystem authority. The executor records the actual
diff identity and every command result, then returns control without claiming a
commit. Before committing, the driver inspects the diff itself and reruns the
declared checks in an environment authorized for the required Git metadata and
test resources. Commit authority does not imply push, PR, or merge authority;
each remains a separate operator-controlled action.

Classify a command as `ENVIRONMENT-BLOCKED` only when evidence shows that the
execution environment denied a prerequisite before the relevant assertion or
contract behavior ran. A denial-looking message is insufficient when the
product chose the refused path or assertions also executed. This state is
neither RED nor green: rerun the unchanged command in an authorized environment,
without an intervening content edit, and classify only that result.
