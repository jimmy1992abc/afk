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
2. **A live run whose scope overlaps yours → stop and ask the operator.** For
   your own scope-matching successor, live means `state: active` with a heartbeat
   under ~20 min and no valid `rotation` or `yield` marker whose `written` is at
   or after that heartbeat (see [Handoff block](#handoff-block)). That marker
   permits resuming the same run, not creating an overlapping run. For all
   **other** runs, a fresh heartbeat still means live regardless of any marker.
   Two runs would drive the same issue. Exact scope matches remain collisions
   unless you are resuming that validly yielded run; disjoint scopes proceed
   silently.
3. **Resume** only a run that is `active` but not live — the directory whose
   ledger scope matches yours, or whose `run-id` the operator handed you. Apply
   step 2's same-run definition of live: a validly yielded run is resumable by
   its own scope-matching successor despite a fresh heartbeat. Revalidate the
   ledger and other-run collisions before takeover, then in the first takeover
   write refresh the heartbeat and consume the marker by overwriting `reason:`
   with `compaction` or deleting the block. A `complete` run is
   finished history: never resume it, never count it as a collision, and leave
   its directory untouched.
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
  fresher than ~20 min in **its own** ledger exits immediately unless that ledger
  has a valid `rotation` or `yield` marker with `written` at or after the
  heartbeat. Revalidate under the claiming rules, then in the same first takeover
  write refresh the heartbeat and overwrite the marker's `reason:` with
  `compaction` or delete the block, so later arrivals stand down even if the
  timestamp is unchanged. Without a valid marker another tick is working; such
  exits do not count toward auto-pause.
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
  cannot progress, write a Handoff with reason `auto-pause`, stop the tick loop,
  post a status report, and leave
  `state: active` so the run can resume. Queue complete → stop with a final report
  and set `state: complete` in the same breath, ending the tick and claim.
  Always tear down any scheduled tick on stop — never leave one running.

## Handoff block

Place one `## Handoff` section immediately after the ledger header, before
other sections. Overwrite it in place at every checkpoint; do not append a
history. Keep the machine-facing fields within the hook's 16 KB prefix read.
The block is an index into the ledger and evidence, never a second run-state
authority. Scope, approvals and publication authority do not travel through it.

Use single-line `key: value` fields and the following lists:

| Field | Required content |
| --- | --- |
| `written` | ISO-8601 UTC timestamp, ending in `Z`. Any takeover-eligible write stamps this field and the header heartbeat with the same UTC instant, obtained once. |
| `reason` | One of `rotation`, `yield`, `compaction`, `auto-pause`, using the trigger mapping below. |
| `next-action` | Non-empty, one concrete next step with its evidence or target locator; display-only, never an authority grant. |
| `done` | List of completed work with evidence pointers. |
| `settled` | List of decisions; every entry cites its source. |
| `do-not-redo` | List of work the successor should reuse after checking its evidence. |
| `open` | List of unresolved findings, RED checks, assumptions and unavailable prerequisites, with locators. |

Keep empty lists explicit as `- None`. Keep the action concise; the hook bounds
its displayed length using the same limit as scope. The canonical trigger map is:

| Checkpoint trigger | Reason |
| --- | --- |
| Deliberate session end at an issue boundary, on a context/compaction signal, or for operator-requested rotation | `rotation` |
| Deliberate mid-run yield | `yield` |
| Pre-compaction checkpoint where the session continues | `compaction` |
| No-progress stop after the root-cause checkpoint | `auto-pause` |

Only `rotation` and `yield` mark a vacated run eligible for immediate takeover.
A valid marker has a recognized reason, a parseable calendar-valid timestamp
within the heartbeat validator's future-skew tolerance, and a non-empty action.
Immediate takeover also requires a known heartbeat with `written` at or after
it. `compaction` means the writer continues; `auto-pause` leaves a blockage that
an immediate retake would repeat. Both use the ordinary stale-heartbeat path.
Unknown heartbeat ownership remains notify-only. An absent, malformed or
out-of-prefix block leaves existing detection unchanged; a marker can add a
candidate but cannot hide one. The detector reads the first Handoff section and
stops at the next H2. Completed runs never become candidates.

The first takeover write refreshes the heartbeat and removes the marker's
takeover eligibility in that same write: overwrite `reason:` with `compaction`
or delete the block. Consumption therefore does not depend on clock resolution.

Writing and consuming this index are level 3 doctrine. Parser eligibility is
level 2, enforced when invoked. Judging which decisions are settled is level 1
evaluation; the block does not mechanize it.

## Stage and session transitions

Before a handoff, yield or host-supported compaction, the driver checkpoints its
existing ledger and evidence and overwrites the [Handoff block](#handoff-block).
Read [stage output](output.md) before preparing that view and
[delegation](delegation.md) before spawning a nested child stage or adopting its return.
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

### Proactive rotation

Rotate after completing each issue's merge/publication stage (or its configured
local-completion endpoint), on a host compaction/context-pressure signal, or on
operator instruction. If the queue is complete, use the terminal completion
rule instead of scheduling another session. A signal that only checkpoints a
continuing session uses the Handoff trigger map rather than marking a vacancy.

Never rotate to escape a RED check or open finding. Preserve each under `open`
with its evidence and the next authorized validation; an unavoidable context
transition does not close a finding or reset an allowance. Finish the checkpoint
content, post the status report, and schedule the next tick where the host
supports re-invocation. Make the Handoff block and heartbeat, using the block
definition's single-instant rule, the last ledger write before the session ends.
Only mark a vacancy when actually yielding. The successor revalidates ownership
under the claiming rules, then in the same first takeover write refreshes the
heartbeat and overwrites the marker's `reason:` with `compaction` or deletes the
block, before dependent work. This consumes the marker even if the timestamp
is unchanged; it is not an atomic lock.

When scheduled re-invocation is unavailable, continue in-session using bounded
reads and evidence pointers; do not advertise a vacancy while still working.
The plugin cannot open a conversation. Rotation, scheduling and takeover are
level 3 workflow doctrine, not runtime enforcement.

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
