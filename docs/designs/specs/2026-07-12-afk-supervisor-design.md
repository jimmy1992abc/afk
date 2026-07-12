# AFK Supervisor Design Specification

- **Date:** 2026-07-12
- **Status:** Proposed
- **Scope:** Cross-platform supervisor for macOS and Windows

## Summary

AFK keeps its existing in-session tick for workflow continuity. A new per-user
operating-system supervisor persists usage-window observations and a registry of
active AFK sessions. When an exact five-hour usage snapshot first reaches 90%,
the supervisor queues every recoverable AFK session for a resume attempt at the
known reset time plus a per-session delay between 60 and 180 seconds. The same
worker also classifies headless quota retries, maintains a non-drifting estimate
from the first successful supervisor response in each window, and recovers stale
sessions after an unexpected frontend exit, login, reboot, or sleep. Exact reset
times still come only from documented status-line data.

The supervisor invokes the separately installed `claude` CLI. It never depends
on VS Code, a terminal, or an interactive Claude Code process remaining open.
The existing approximately 15-minute tick remains responsible for progress
checks, ledger-driven continuation, overlap prevention, and run shutdown.

## Goals

- Preserve the existing AFK in-session tick unchanged in purpose.
- Observe exact reset data from documented Claude Code status-line JSON and use
  headless quota frames to classify rate-limit outcomes.
- Queue all recoverable AFK sessions when exact five-hour usage reaches 90%.
- Give each queued session a target start time 60–180 seconds after the exact
  reset, then start it subject to the configured concurrency limit.
- Recover unfinished sessions after frontend exit, sleep, login, or reboot.
- Prevent duplicate work between the in-session tick and OS supervisor.
- Support explicit, idempotent setup, status, configuration, repair, disable,
  trigger, and uninstall operations.
- Keep global mutable data outside repositories and plugin caches.
- Avoid real Claude requests in automated tests.

## Non-goals

- Replacing the in-session AFK tick.
- Reading private credentials or calling undocumented Anthropic endpoints.
- Running a permanent Node daemon.
- Resuming completed, blocked, or auto-paused runs.
- Claiming that the VS Code graphical UI executes status-line commands.
- Automatically anchoring an empty usage window unless the user opts in.

## Claude Code Interfaces

The design uses only behavior documented by Anthropic and confirmed against the
installed CLI where applicable.

### Headless stream data

Claude Code supports `--print --output-format stream-json`; the installed CLI
requires `--verbose` with that output mode. Inspection of the current CLI shows
wire-visible `system/api_retry` frames containing an error category such as
`rate_limit`, an HTTP status, and retry counters. The internal REPL has a richer
`system/api_error` object, but its `rate_limits.resets_at` and
`rate_limit_type` fields are not forwarded to the external stream.

The runner therefore uses stream frames only to classify a quota outcome and
terminate the CLI's built-in retry loop. They are not a reset-time provider.
Anthropic's public CLI documentation does not specify the retry-frame schema, so
parsing remains capability-gated and safely falls back to process exit and
StopFailure observations when the shape changes.

### Status-line data

Claude Code passes JSON to a configured status-line command on stdin. For
Claude.ai subscribers, after the first API response, it may contain:

- `rate_limits.five_hour.used_percentage`
- `rate_limits.five_hour.resets_at`
- `rate_limits.seven_day.used_percentage`
- `rate_limits.seven_day.resets_at`
- `session_id`, `cwd`, and `transcript_path`

`resets_at` is a Unix epoch timestamp in seconds. Rate-limit fields are absent
before a session's first API response and for API-key or third-party-provider
sessions. Such a payload observes nothing: it is neither published nor allowed to
relabel a previous snapshot. Recording it as an exact reading would both
misreport confidence and stop a later genuine exact snapshot from replacing
pending estimated schedules. Missing or malformed input never erases a previous
valid snapshot. The status-line command is local and does not consume API tokens.

### Hooks

Claude Code documents `SessionStart`, `Stop`, `StopFailure`, and `SessionEnd`.
`StopFailure` replaces `Stop` when a turn ends due to an API error and supports
the `rate_limit` matcher. Its common input includes `session_id`, `cwd`, and
`transcript_path`; it adds `error`, optional `error_details`, and optional
`last_assistant_message`. It does not document a structured reset timestamp.

`SessionEnd.reason` distinguishes `clear`, `resume`, `logout`,
`prompt_input_exit`, `bypass_permissions_disabled`, and `other`. These reasons
cannot prove that an AFK run completed, so SessionEnd never clears a run by
itself. The ledger and explicit AFK lifecycle transitions remain authoritative.

### CLI

The installed CLI and official reference support:

- `--resume <session-id>`
- `--print`
- `--max-turns <count>`
- `--no-session-persistence`
- `--tools ""`
- `--disallowedTools "mcp__*"`
- `--strict-mcp-config`
- `--safe-mode`

`--safe-mode` disables user customizations while retaining normal
authentication. `--bare` does not read OAuth or keychain credentials and is not
the default for subscription-backed window activation. AFK recovery must not
use safe mode because it needs project instructions, hooks, skills, and ledger
context.

### VS Code

The VS Code extension and standalone CLI share Claude Code settings from
`~/.claude/settings.json`, including hooks, permissions, environment variables,
and MCP configuration. Official documentation does not confirm that the
graphical extension executes custom status-line commands. Setup therefore
offers a canary and reports status-line capability as `confirmed`, `unobserved`,
or `unsupported`. Hooks and standalone CLI recovery continue without it; exact
reset time can remain stale until another confirmed status-line observation.

## Architecture

### Layer 1: In-session AFK watchdog

The existing approximately 15-minute tick continues to:

- read `.afk/afk-ledger.md`;
- resume the first unfinished scoped step;
- refresh heartbeat and progress state;
- prevent overlapping workers;
- detect completion, permanent blocking, and auto-pause; and
- remove its run-specific tick when the run terminates.

AFK lifecycle steps also call a small bundled registration command. Registration
is best-effort but loud: failure is recorded in the ledger and surfaced to the
operator without changing the existing run semantics.

Because the lifecycle calls it repeatedly, registration is idempotent with
respect to recovery state. It refreshes identity and liveness only. Schedules,
quota backoff, and retry counters belong to the supervisor and survive
re-registration; discarding them would let a later tick erase a pending threshold
schedule or an active quota backoff. A run registered for the first time after
the threshold event but before its reset inherits the schedule already armed for
that reset.

The SessionStart hook also checks the current cwd for a valid
`.afk/afk-ledger.md`. It reconstructs missing registration only when the ledger
contains the supervisor metadata block, explicitly reports a recoverable
non-terminal state, contains unfinished scoped work, and has a heartbeat within
the configured registration-recovery age. A completed, blocked, auto-paused,
ambiguous, or old ledger is ignored. The hook only updates registration metadata;
it never acquires an action lease, spawns a runner, or invokes Claude, including
when SessionStart was triggered by the supervisor's own `--resume` call.

### Layer 2: OS-level AFK supervisor

A shared dependency-free Node ESM reconciler performs one short pass per
invocation. A per-user LaunchAgent or Windows scheduled task invokes it every
60 seconds and once at login/load. Each pass:

1. acquires the global lock;
2. re-reads and validates state;
3. imports fresh ledger heartbeats for registered sessions;
4. evaluates all sessions in stable order;
5. records an action-specific lease and releases the global lock;
6. detached-spawns at most one runner when capacity is available; and
7. exits immediately with a distinct action, skip, or error reason.

The detached runner owns one Claude child, renews its lease, enforces its timeout,
and finalizes the matching attempt under the lock. The reconciler does not wait
for either process. It normally finishes within one second, so platform overlap
suppression cannot block observation import, lateness accounting, or later
selection passes.

Each pass starts at most one new runner. `maxConcurrentInvocations` limits live
runners globally and defaults to `1`; operators with independent repositories
may raise it explicitly. Due sessions remain queued in `(scheduledResumeAt,
runId)` order. Jitter supplies stable ordering and spreads eligible start times;
it does not guarantee that every run starts within three minutes when the queue
exceeds available concurrency.

The short global lock protects state transactions only. It is never held while
Claude, a notification adapter, or an existing status-line command runs.

## Repository Layout

```text
skills/afk-supervisor/SKILL.md
hooks/hooks.json
scripts/supervisor/
  cli.mjs
  config.mjs
  state-store.mjs
  state-machine.mjs
  lock.mjs
  usage-provider.mjs
  statusline-bridge.mjs
  observation-inbox.mjs
  hook-handler.mjs
  ledger.mjs
  reconciler.mjs
  runner.mjs
  supervisor.mjs
  claude-runner.mjs
  platform.mjs
  platform-macos.mjs
  platform-windows.mjs
  install.mjs
  notify-windows.ps1
templates/supervisor/
  launch-agent.plist
  windows-task.xml
test/supervisor/
```

Platform-independent state and reconciliation code remains shared. Platform
adapters generate scheduler definitions, install stable worker copies, display
notifications, and resolve native paths.

## Persistent State

The worker uses a stable per-user directory:

- macOS: `~/Library/Application Support/afk-supervisor/`
- Windows: `%LOCALAPPDATA%/afk-supervisor/`

It contains `state.json`, `config.json`, a lock record, a bounded observation
inbox, bounded logs, a stable copy of the worker bundle, and scheduler metadata.
It contains no credentials, prompts, transcript contents, or repository
contents.

```json
{
  "schemaVersion": 1,
  "revision": 0,
  "usage": {
    "fiveHourResetAt": null,
    "fiveHourUsedPercentage": null,
    "sevenDayResetAt": null,
    "sevenDayUsedPercentage": null,
    "observedAt": null,
    "source": "unknown",
    "confidence": "unknown",
    "windowAnchorAt": null,
    "thresholdResetAt": null,
    "lastImportedObservationAt": null,
    "sevenDaySuppressedUntil": null
  },
  "runs": {
    "example-run-id": {
      "sessionId": "00000000-0000-0000-0000-000000000000",
      "cwd": null,
      "ledgerPath": null,
      "state": "RUNNING",
      "lastHeartbeatAt": null,
      "nextExpectedTickAt": null,
      "firstRateLimitedAt": null,
      "rateLimitedUntil": null,
      "resetConfidence": "unknown",
      "scheduledResumeAt": null,
      "scheduledResetAt": null,
      "lease": {
        "attemptId": null,
        "lastRenewedAt": null,
        "expiresAt": null
      },
      "retry": {
        "attempts": 0,
        "nextAttemptAt": null
      },
      "quotaRejections": {
        "consecutive": 0,
        "backoffLevel": 0,
        "nextProbeAt": null,
        "lastNotifiedAt": null
      }
    }
  },
  "activation": {
    "handledResetAt": null,
    "inProgress": false,
    "attemptId": null,
    "lastAttemptAt": null,
    "lastResult": null,
    "activationAttempts": []
  }
}
```

`runs` is keyed by validated run ID. Each record contains the session ID, cwd,
ledger path, run state, heartbeat, expected tick, rate-limit reset, recovery
lease token and expiry, retry state, and optional threshold recovery schedule.
Each threshold schedule records its reset timestamp, due time, state
(`pending`, `leased`, `handled`, `cancelled`, or `failed`), and outcome.
`firstRateLimitedAt` and an estimated reset are per-run because StopFailure is
session-scoped. Exact usage snapshots are account-level and replace compatible
per-run estimates during reconciliation.

The global lock is a **directory**, not a file. Windows keeps a just-removed file
in a delete-pending state and reports an attempt to touch it as `EPERM` rather
than `EEXIST` or `ENOENT`, so a lock built on creating and deleting a file cannot
distinguish held from free from failed. `mkdir` is atomic and exclusive on every
supported system and holds no file handle, so there is no such state to misread.
The holder's record lives inside the directory.

Four rules follow, and all four are load-bearing. Every one of them exists because
its absence lets two callers into the critical section, where both pass the
revision compare-and-set and the loser's write vanishes **with no error at all**:

- **A failed probe never means the lock is free.** An unreadable record, an
  unstattable directory, or a contended `mkdir` all count as held.
- **Contention is not failure.** `EPERM`, `EACCES`, and `EBUSY` mean *wait and
  retry*, not *abort*. Raising them fails a transaction that would have committed.
- **Reclaiming is an atomic rename, never a delete.** `reclaimable()` is a read,
  so two contenders can both judge the same expired lock reclaimable; if one
  reclaims and becomes the live holder, a delete by the other destroys that live
  lock. Only one contender can *move* a directory, and the winner then re-checks
  what it actually moved: a lock that turns out to be live goes straight back.
  Deletion only ever touches a directory this process exclusively owns.
- **A holder confirms the lock still names it before committing.** Even an atomic
  steal leaves a hair-thin window. This turns a silent lost write into a retry.

A lock is reclaimed only when its record is readable and expired, or when the
directory has outlived a whole lock lifetime, so a crashed holder cannot wedge
the supervisor. Replacing `state.json` retries on the same contended codes,
because Windows refuses to replace a file a concurrent reader still has open.

A plain read is public and **unlocked**, so it never repairs corrupt state — a
reader that rewrote `state.json` while a writer held the lock would let both
commit a default state over every registered run. Repair happens only under the
lock, and it copies the corrupt file aside *before* replacing it: renaming it
away first leaves no `state.json` at all if the process dies in between.

Writes use a same-directory temporary file, fsync where supported, atomic
rename, and parent-directory sync where supported. Readers validate the entire
shape. Every committed state replacement increments `revision`; compare-and-set
transactions reject a stale revision and restart selection. Unknown fields are
preserved during compatible migrations. Corrupt state is moved to a timestamped
quarantine file only after a valid replacement is written; recovery defaults to
no invocation.

Each successful reconciliation removes terminal runs older than seven days,
expired observation files, and activation attempts older than 24 hours. The
activation cap is evaluated over that rolling 24-hour history, not a calendar
day, so it has no timezone reset boundary.

## Configuration

Global configuration is separate from repository `.afk/config.md`:

```json
{
  "enabled": true,
  "thresholdPercentage": 90,
  "thresholdJitterMinSeconds": 60,
  "thresholdJitterMaxSeconds": 180,
  "windowMode": "notify",
  "activeRunRecovery": "auto",
  "catchUpMode": "notify",
  "graceSeconds": 90,
  "heartbeatStaleSeconds": 1500,
  "overdueAutoActivationSeconds": 7200,
  "maxWindowActivationsPer24Hours": 4,
  "sevenDaySuppressionPercentage": 99,
  "maxRecoveryAttempts": 3,
  "maxConsecutiveQuotaRejections": 3,
  "quotaEscalationBaseSeconds": 86400,
  "quotaEscalationMaxSeconds": 604800,
  "recoveryAttemptTimeoutSeconds": 14400,
  "leaseRenewalSeconds": 60,
  "leaseMissedRenewals": 3,
  "maxConcurrentInvocations": 1,
  "pollIntervalSeconds": 60,
  "terminalRunRetentionSeconds": 604800,
  "registrationRecoveryMaxAgeSeconds": 86400
}
```

Automatic recovery of registered unfinished AFK runs defaults on. Empty-window
activation defaults to notification. Configuration changes are schema-validated
and atomically replaced.

## Usage Provider Precedence

The state store uses these reset sources in order:

1. **Status-line snapshot:** the only confirmed exact reset source. While an
   interactive surface emits status-line data, it also enables proactive 90%
   scheduling and can avoid a quota failure.
2. **Supervisor window anchor:** when a runner that issued its first request at
   time `T` receives a successful response, it may record `windowAnchorAt = T`
   and estimate the next reset at `T + 5 hours`. The anchor is the moment the
   request was issued, never the moment the run finished: the five-hour window
   opens at the first request, so anchoring on completion would push every
   estimate out by the recovery's own duration, which for AFK is usually hours.
   A quota-classified response does not create an anchor. The
   anchor is write-once within a window: later successes before its estimated
   boundary never move it forward. After that boundary, or after an exact reset
   proves the prior window ended, the first subsequent success may establish the
   next anchor. This is expected to be tight when the supervisor made the first
   successful request in the window. If a human used the account earlier, the
   estimate is late, but a compatible status-line observation replaces it
   immediately when available.
3. **Rate-limit upper bound:** when no exact reset or successful supervisor
   anchor exists, the first observed rate limit estimates an upper bound at
   `firstRateLimitedAt + 5 hours`.

The headless retry frame is a classification signal for deciding whether a
runner succeeded and may create an anchor, or hit a quota and must terminate. It
is not a reset source. Both estimates use `confidence: "estimated"`, never arm
the 90% queue, and never claim exact timing.

An exact observation always replaces a compatible estimate. Conflicting exact
observations fail toward no invocation and produce a diagnostic until a newer
observation resolves the conflict.

### Estimated reset fallbacks

A successful supervisor response records an account-level `windowAnchorAt` and
estimates the next five-hour reset from that anchor without scheduling any run.
Only a run that actually becomes `RATE_LIMITED` may consume an anchor estimate,
and it schedules only itself. An anchor is usable for that purpose only before
its estimated boundary plus grace; a stale anchor falls back to the per-run
`firstRateLimitedAt + 5 hours` upper bound. A later exact observation replaces
either estimate immediately.

Estimated resets never arm the 90% queue and are never presented as exact. They
only make otherwise stranded recoverable runs eligible for bounded recovery,
with the normal retry policy and user-visible confidence.

## Ninety-percent Scheduling

Only an exact status-line snapshot with a valid reset time may arm the 90%
schedule. The status-line bridge does not acquire the supervisor lock or mutate
`state.json`. It validates stdin and writes only when the reset timestamp changes,
the integer usage bucket changes, or 60 seconds have elapsed since the last
accepted write for that session. It then atomically publishes a uniquely named
event file in the observation inbox and exits. It emits no stdout and does no
cross-run work. Unique files prevent an older concurrent writer from replacing
a newer unimported observation. Each file carries `session_id` and `observedAt`;
the reconciler applies an account-level import watermark and ignores older
account snapshots. A small per-session atomic marker provides best-effort
write-side throttling; races may create a duplicate event but cannot remove or
corrupt a newer one.

During the next pass, the reconciler imports all valid observations in timestamp
order. When usage crosses from below 90% or unknown to at least 90% for a reset
timestamp not previously armed, the locked import transaction:

1. records the exact usage snapshot;
2. marks that reset timestamp as the threshold event;
3. visits every `RUNNING` or `RATE_LIMITED` run;
4. computes a stable per-run delay from 60 through 180 seconds; and
5. records `scheduledResumeAt = resetAt + delay`.

The delay is derived from a cryptographic hash of run ID, session ID, and reset
timestamp mapped uniformly into the inclusive range. It is random-looking but
stable across repeated snapshots, process restarts, and reboot. No duplicate
tasks are created for the same run and reset.

`scheduledResumeAt` is the target start time. Under normal awake operation, the
next 60-second interval pass observes it at or shortly after that target. Native
scheduler granularity, process startup, exhausted concurrency, sleep, or power
loss can delay the actual invocation. The supervisor records this lateness and
never claims a strict 180-second guarantee that the operating system cannot
provide. It does not start early to compensate.

Runs registered after the threshold event but before reset inherit a schedule
for the current reset. Completed, blocked, and auto-paused runs retain audit
fields but become ineligible. A newer exact reset replaces only schedules that
have not started. Missing or estimated reset data never invents a threshold
schedule.

When an exact seven-day snapshot reports at least
`sevenDaySuppressionPercentage` usage and a future seven-day reset, it suppresses
five-hour recovery probes and empty-window activation alike until that reset plus
grace; neither can succeed before the weekly window reopens. The threshold is not
a strict 100 because `used_percentage` is a float derived from a utilization
ratio and an exhausted weekly window can report just under 100. This prevents
bounded retries from repeatedly hitting a known weekly limit. Missing seven-day
data does not block recovery.

At or after a schedule's due time, a heartbeat newer than the associated reset
proves that the session already made progress in the new window. The supervisor
marks that schedule `handled` without invoking Claude. A fresh heartbeat from
before the reset only postpones selection through the normal tick grace; it
does not satisfy or discard the post-reset schedule. This distinction prevents
both duplicate resumes and delayed resumes of work that already continued.

## Run Lifecycle

Run states are:

```text
NONE -> RUNNING
RUNNING -> RATE_LIMITED | RECOVERY_DUE | COMPLETED | BLOCKED | AUTO_PAUSED
RATE_LIMITED -> RECOVERY_DUE | RUNNING | COMPLETED | BLOCKED | AUTO_PAUSED
RECOVERY_DUE -> RECOVERING | RUNNING | COMPLETED | BLOCKED | AUTO_PAUSED
RECOVERING -> RUNNING | RATE_LIMITED | FAILED | COMPLETED | BLOCKED | AUTO_PAUSED
FAILED -> RECOVERY_DUE | COMPLETED | BLOCKED | AUTO_PAUSED
```

Only explicit AFK lifecycle registration may set `COMPLETED`, `BLOCKED`, or
`AUTO_PAUSED`. Hooks may update session metadata and set `RATE_LIMITED`, but may
not declare terminal run state.

Usage-window states are derived rather than duplicated:

```text
UNKNOWN | ACTIVE_EXACT | ACTIVE_ESTIMATED | RESET_DUE | ACTIVATING | FAILED
```

## Reconciliation Order

Before locking, the reconciler reads and validates observation files, ledger
heartbeats, and retention candidates into bounded in-memory inputs. During the
short locked transaction it re-reads state, merges those inputs, and evaluates:

1. disabled configuration;
2. corrupt or unsupported state;
3. expired-lease cleanup and state retention;
4. terminal runs, which are skipped;
5. exact seven-day suppression;
6. available invocation capacity;
7. scheduled 90% resume times;
8. exact rate-limit reset plus grace;
9. estimated rate-limit recovery probes;
10. escalated quota backoff;
11. stale non-rate-limited recovery; and
12. empty-window reset policy.

For each candidate, it applies retry backoff and rolling activation caps. It
then releases the lock, re-reads only the selected ledger, reacquires the lock,
and verifies the state revision before writing a lease. A changed revision
restarts selection. A post-reset heartbeat satisfies its threshold schedule;
other fresh progress defers recovery without discarding the schedule. After
releasing the lock, the reconciler deletes only inbox files whose identities
were committed as imported and removes filesystem retention candidates. The
in-session tick calls the same lease helper before beginning resumable work, so
both lifecycle layers share the authoritative guard in addition to checking the
ledger heartbeat.

The lease transaction stores a random attempt token, `lastRenewedAt`, and
`expiresAt = lastRenewedAt + leaseRenewalSeconds * leaseMissedRenewals` before
releasing the global lock. The detached runner renews the lease through short
locked writes while the child is alive. Finalization only updates an attempt
whose token still matches, so a stale process cannot overwrite a later result.
The invocation is spawned without a shell.

**An expired lease is not an abandoned one.** A suspended machine stops the
renewal timer while the runner and its Claude child stay alive, so re-issuing a
lease on expiry alone starts a second `claude --resume` against the same session.
The runner records its pid on every renewal, and a live pid means the run is
occupied — **with no time bound**. Bounding it by the action timeout is
self-defeating: that timeout is a timer too, and suspend stops timers while the
wall clock keeps running, so the bound expires in exactly the case the check
exists for.

The residual risk is pid reuse, which leaves a run occupied by a stranger's
process. The supervisor does not paper over that by guessing the runner is dead —
it notifies the operator, and `trigger-now` clears the lease by hand. **That
command is the only manual escape hatch, so it must actually work on the runs an
operator reaches for it with**: it clears the lease, the retry counter, and the
quota backoff, because the selector short-circuits on all three long before it
looks at a schedule.

A lease expiry is written from the same clock as a heartbeat and gets the same
distrust: a forward clock step during a renewal would otherwise persist an expiry
years out and hold the only invocation slot for ever. The ceiling admits the
longest lease anyone legitimately takes — the in-session tick's, which runs for
`heartbeatStaleSeconds`.

**Only a supervisor invocation counts against `maxConcurrentInvocations`.** The
in-session AFK tick leases its own run as well; counting that would let one
interactively-running repo disable recovery for every other repo. It still marks
its run occupied, so the supervisor never resumes a run the tick is working on. An
empty-window activation *does* count, because its Claude child lives as long as
any recovery.

The lease re-check before an invocation is given **the same inputs the selection
saw**. Narrowing the heartbeat map to the selected run makes every other run fall
back to its persisted heartbeat, so the re-check can disagree with the selection
even though the state never changed — and the pass then skips for ever while the
genuinely due run is never resumed.

Lease expiry and action timeout are independent. Missing three default renewals
makes a lease stale after three minutes; the four-hour action timeout separately
bounds a healthy runner and its Claude child. The runner sends a graceful
termination and then a forced termination when that timeout is exceeded, using
a platform process group so descendants do not remain detached. After an
unclean runner exit, a later pass waits for lease expiry and retry backoff, then
re-reads the ledger before retrying. Process detection is only a secondary
conservative signal; a matching live process postpones recovery but never proves
progress.

New AFK ticks use the shared lease helper. An older installed tick that does not
yet know the helper is still protected by the pre-invocation ledger heartbeat
check. Setup reports this reduced overlap protection and repair refreshes the
stable worker and skill installation.

## Claude Invocation

AFK recovery runs in the validated original cwd and uses the recorded session:

```text
claude --resume <session-id> --print --verbose --output-format stream-json
  <static AFK resume prompt>
```

The prompt directs Claude to read `.afk/afk-ledger.md`, continue the first
unfinished step, and preserve existing scope, constraints, merge policy, and
overlap guard. Recovery loads normal project and user configuration. Session
IDs must satisfy the documented UUID shape, cwd must be an existing directory,
and the ledger must resolve within that cwd.

The runner parses stdout incrementally as JSON Lines and treats normal assistant
content as opaque. On a validated wire-visible retry frame with `error:
"rate_limit"` and a quota-compatible status, it terminates the Claude process
group immediately and finalizes the run as rate limited. It does not wait for
the CLI's built-in retry loop or the action timeout. Because the wire frame has
no reset or five-hour/seven-day discriminator, finalization uses a still-valid
exact status-line reset, then a window-anchor estimate, then the
`firstRateLimitedAt + 5 hours` upper bound. An ambiguous quota cannot create a
seven-day suppression boundary.

On a successful runner response at time `T`, finalization sets a window anchor
only when the write-once rules allow it and clears that run's consecutive quota
counter. Success does not schedule any run. A later exact status-line snapshot
replaces the account estimate and any pending per-run schedules that consumed
it. Repeated success or quota frames for the same attempt are idempotent.

Because the retry-frame contract is undocumented, the parser accepts only a
version-tested event envelope, enumerated rate-limit error, numeric status, and
bounded retry counters. Unknown, malformed, or changed frames fall back to
process exit and StopFailure observations. It never searches rendered error text
for reset times. Raw frames and rendered API errors are not logged.

Empty-window auto activation, when explicitly enabled, uses print mode,
`--safe-mode`, `--no-session-persistence`, `--max-turns 1`, `--tools ""`,
`--disallowedTools "mcp__*"`, and `--strict-mcp-config` from an empty stable
working directory. Success marks the old reset handled and estimates the next
reset at activation time plus five hours. A later exact snapshot replaces it.

Setup reports the installed Claude version and compares required flags with the
officially supported capability set. A zero exit from argument parsing is not
accepted as proof because some CLI versions tolerate unknown flags. The runner
always enforces a wall-clock timeout and validates structured print output, so
`--max-turns 1` is defense in depth rather than the only bound. Setup also runs
a local, non-requesting argument-construction check for the empty `--tools`
value; if the installed version cannot be confirmed compatible, auto activation
is disabled while AFK recovery remains available.

Authentication is checked during setup through supported CLI behavior without
reading credential stores. Missing CLI or authentication disables invocation
and reports a repairable error.

## Retry Policy

Failures never retry every minute. `maxRecoveryAttempts` counts **invocations, not
retries after them**: three permitted failures means three `claude --resume`
calls, spaced by 5 and 20 minutes, and then no more. A validated quota result
updates or estimates the reset and reschedules the run without incrementing
`retry.attempts`; classifying a quota rejection is expected control flow, not a
failed recovery.

Quota outcomes have an independent consecutive counter. A successful runner
response clears it. Before the configured threshold, a quota result uses an
exact reset, a valid window anchor, or the per-run upper bound. At three
consecutive quota rejections without success, the supervisor notifies the user,
marks the run as a possible long-window limit without claiming an exact
seven-day boundary, and switches to 24-hour exponential probe delays capped at
seven days. Later quota rejections advance that backoff and remain visible in
status.

The escalation is the inference *"this account is against a long-window limit"*.
An ordinary five-hour reset does not disprove that — it happens every five hours,
and clearing on it would put the ladder permanently out of reach. Only **headroom
in the weekly window**, a success, or an explicit `trigger-now` disproves it. And
clearing the counter alone is not enough: the escalation also parked the run on a
24-hour resume, which has to be released with it.

A successful heartbeat or a terminal transition clears ordinary retry state.
Exhaustion marks the attempt failed and notifies the user. A new exact reset or
explicit `trigger-now` starts a new bounded non-quota attempt series.

## Hooks and Status-line Installation

The plugin provides `SessionStart` and `StopFailure` hooks. SessionStart performs
fast reconciliation of registered metadata. StopFailure with `rate_limit`
records the structured failure without guessing a reset time or launching
Claude. Version 1 does not install a SessionEnd hook because its documented
reasons cannot establish AFK completion and add no authoritative transition.

Setup explicitly asks to install the status-line bridge. It parses the current
user setting, writes a backup before modification, and installs a stable wrapper
that passes the same stdin payload to both AFK and the previous command. The
backup record is the only copy of the user's previous status line, so it is
committed before the settings are touched: writing it afterwards would lose that
command for good if the process died in between, because a second setup then
recognizes its own marker, records no previous command, and uninstall would
delete the status line outright.

A setup that cannot register a scheduler rolls the settings back. Leaving the
wrapper installed would hijack the user's status line for a supervisor that is
never going to run, and the next setup would recognise its own marker, record no
previous command, and lose the original for good.

The wrapper runs the previous command first. Its stdout and exit code remain the
visible status line; AFK emits no stdout, and an AFK-side failure — an unwritable
data directory, a corrupt inbox — is swallowed rather than allowed to blank the
status line or delay its render. A previous command that exits without draining
stdin is normal and does not raise. Repeated setup recognizes its marker and does
not layer wrappers. Uninstall restores the prior configuration only when the
installed marker still matches, avoiding overwrite of later user edits.

Malformed input, slow previous commands, and cancelled status-line executions
cannot erase valid usage state. The AFK update is bounded and does not wait for
network access.

## Platform Behavior

### macOS

Setup copies the worker into the stable data directory and installs a per-user
LaunchAgent under `~/Library/LaunchAgents/`. It runs at load and every 60 seconds
without administrator access. Launchd's single-job semantics prevent concurrent
reconciler copies. Logs rotate by size and retained-file count.
Notifications use `osascript`; actionable behavior is capability-tested and
falls back to an informational notification.

### Windows

Setup copies the worker into `%LOCALAPPDATA%` and installs per-user Task
Scheduler entries for a 60-second recurring trigger and user-logon catch-up.
Task settings use `IgnoreNew` for overlapping reconciler instances.

Four Task Scheduler behaviours would otherwise stop the supervisor from ever
installing or running, and all four were found only by installing it for real:

- **The logon trigger is scoped to the installing user.** A `LogonTrigger`
  without a `UserId` means *at log on of any user*, which only an administrator
  may register — so an unscoped trigger makes `setup` fail with
  `ERROR: Access is denied` for every ordinary user. The principal carries the
  same `UserId`. The task stays per-user and unprivileged.
- **The document is UTF-16 with a byte-order mark**, which `schtasks /create
  /xml` requires and which Node does not emit on its own.
- **`DisallowStartIfOnBatteries` and `StopIfGoingOnBatteries` both default to
  true**, which would stop the supervisor the moment a laptop is unplugged — the
  AFK case exactly — so both are set to false.
- **`ExecutionTimeLimit` leaves headroom above a pass** rather than matching the
  poll interval, so a slow pass is not killed mid-reconcile.

The scheduler also **pins the data root** it installed into, on both platforms.
The worker would otherwise re-derive a root from an environment the scheduler
does not share, so setup and the running supervisor could read two different
state directories and the supervisor would never see a registered run.

The adapter uses the resolved absolute Node executable and a stable wrapper, with
paths passed as argument arrays or correctly XML-escaped values. It does not use
a VS Code extension binary or require WSL. Notifications are detached and never
awaited by a supervisor pass, and they dismiss themselves: a modal dialog would
wait for a click that, by definition of away-from-keyboard, nobody is there to
give, blocking the pass until the scheduler killed it.

Install, repair, status, and uninstall are idempotent on both platforms. Worker
updates are copied to a temporary path and verified before replacing the stable
copy. Uninstall removes scheduler integration and wrappers but preserves state
unless the user explicitly requests purge.

## Sleep, Shutdown, and Catch-up

No process runs while the machine is powered off. At next login/load, the same
single-pass reconciliation reads overdue schedules. Unfinished AFK sessions
resume automatically when leases, heartbeat, and retry policy allow it. For no
active runs, resets overdue by more than the configured threshold notify rather
than auto-activate unless `catchUpMode` is `activate`. Waking from sleep follows
the same path on the next scheduler pass.

## Logging and Privacy

Logs are structured, bounded, and contain timestamps, run IDs, session IDs in
truncated form, action codes, and result categories. They never contain tokens,
credentials, full prompts, source code, ledger contents, or transcripts.

Every no-action path has a distinct reason, including:

```text
skip:disabled
skip:no-active-run
skip:heartbeat-fresh
skip:tick-grace
skip:reset-not-due
skip:estimate-not-due
skip:quota-backoff
skip:reset-already-handled
skip:tick-guard-held
skip:tick-owns-run
skip:runner-active
skip:recovery-disabled
skip:run-state-unknown
skip:state-lock-held
skip:concurrency-exhausted
skip:runner-alive
skip:state-changed
skip:stale-attempt
skip:seven-day-limit
skip:run-terminal
skip:retry-backoff
skip:rolling-activation-cap
action:resume-afk
action:activate-window
result:quota-rescheduled
result:quota-backoff-escalated
error:state-corrupt
error:claude-cli-missing
error:claude-auth-missing
error:resume-failed
```

## Security

- State is untrusted and schema-validated before use.
- Claude and Node are spawned directly without shell interpolation.
- Session IDs, cwd, ledger containment, and executable paths are validated.
- Mutable state cannot supply commands, flags, or prompts.
- Credential stores and private endpoints are never inspected.
- Ambiguous state fails toward no invocation.
- Empty-window background activation requires explicit opt-in.
- Scheduler installation requires an explicit setup command.

## Test Strategy

Tests inject a fake clock, filesystem, process runner, scheduler adapter, and
Claude runner. Normal tests never make Claude requests or modify the real user
scheduler or settings.

A test that only asserts a field starts null and stays null cannot observe the
invariant it names, and a green suite is not evidence: an earlier version of this
suite passed with the entire window-anchor path deleted from the source. **Every
guard below is mutation-tested — reverting it must fail the test that names it.**
A guard whose skip code no test ever asserts is a guard nothing protects.

Coverage includes:

- exact and malformed status-line parsing;
- a status-line payload with no rate limits is neither exact nor published;
- the window anchor is the request's start time, not the run's finish time;
- a fresh window anchor is consumed for a quota estimate;
- a successful recovery clears the run's rate-limit timestamps, so a later limit
  cannot derive an upper bound in the past and re-probe immediately;
- a successful response reschedules no run, including other active runs;
- seven-day suppression blocks recovery probes and empty-window activation, and
  triggers below a strict 100% reading;
- registration preserves recovery state and inherits an armed threshold schedule;
- the previous status line runs first, keeps its exit code, and survives an
  AFK-side failure;
- the previous status line is recorded before the settings are overwritten;
- the Windows task carries a byte-order mark and runs on battery;
- the Windows logon trigger is scoped to the installing user;
- the scheduler pins the data root it installed into;
- a setup that cannot register a scheduler restores the previous status line;
- a Windows notification is detached and never awaited;
- a reclaim that finds a live lock puts it straight back, and a genuinely expired
  one is removed;
- a holder can tell whether the lock still names it;
- a lease is never re-issued while its runner is still alive;
- a superseded attempt reports itself stale and changes nothing;
- the lease is renewed while the child is alive, and only for its own attempt;
- the lease re-check sees the same heartbeats the selection did;
- a healthy run never starves the other due runs behind it;
- a heartbeat from the future is a clock artefact, not progress;
- a running activation occupies the one invocation slot;
- a run whose state the code does not know is never selected;
- a back-dated reset never schedules a resume in the past;
- a payload with no five-hour reset cannot relabel the stored one as exact;
- a new exact reset starts a fresh attempt series for an exhausted run;
- an unlocked read fails closed without rewriting corrupt state;
- observations are committed only after the import that used them is durable;
- a stop failure that is not a rate limit never parks the run;
- headless rate-limit classification and changed-schema fallback;
- active child termination after a validated quota frame;
- successful-run window anchoring and exact status-line replacement;
- repeated success within one window does not move its anchor;
- successful anchoring does not schedule non-rate-limited runs;
- stale anchors fall back to the per-run rate-limit upper bound;
- ambiguous quota fallback without false seven-day suppression;
- consecutive quota rejection escalation, notification, and success reset;
- exact status-line and trigger-now clear escalated quota backoff;
- preservation and replacement of snapshots;
- status-line write throttling and account-level import ordering;
- 90% crossing for every active run;
- stable independent 60–180 second delays;
- sessions registered after threshold crossing;
- terminal-run cancellation;
- existing status-line chaining and idempotence;
- lifecycle registration and explicit completion;
- SessionStart reconstruction guards for completed, old, and ambiguous ledgers;
- rate-limit StopFailure without reset-time guessing;
- quota rescheduling without consuming the non-quota retry budget;
- exact-reset and stale-heartbeat recovery;
- fresh heartbeat and tick-grace no-op;
- tick/supervisor race and stale-lock cleanup;
- runner crash after lease acquisition and action timeout cleanup;
- detached runner capacity and scheduler overlap suppression;
- login, reboot, and sleep-style catch-up;
- empty-window notify and opt-in auto modes;
- rolling 24-hour activation cap and bounded retries;
- exact seven-day suppression and missing seven-day fallback;
- terminal-run, observation, and activation-attempt retention cleanup;
- observation parsing and deletion outside the global lock;
- corrupt state recovery and schema migration;
- missing CLI and authentication;
- duplicate reset handling;
- VS Code status-line unobserved fallback;
- Windows quoting and task generation;
- macOS LaunchAgent generation; and
- repeated setup, repair, disable, and uninstall.

## Alternatives

### Always-running daemon

A daemon would avoid about 1,440 short reconciler process starts per day and
could schedule sub-minute timers directly. It also adds a continuously resident
process, daemon health supervision, upgrade handoff, crash-loop handling, and a
larger cross-platform lifecycle surface. Version 1 uses short deterministic
passes because launchd and Task Scheduler already provide restart and login
recovery. Process-start overhead is measured during manual validation; a later
daemon is justified only if that evidence shows material battery or CPU cost.

### Native one-shot triggers

A replaceable one-shot trigger improves an interval schedule by at most one
poll interval but adds a second mutable scheduler path on both platforms. It
does not wake a sleeping or powered-off machine. Version 1 uses interval and
login triggers only and records scheduling lateness.

### Claude Code retry alone

Claude Code's in-session behavior cannot recover after its frontend, terminal,
or host process exits and cannot perform login/reboot catch-up. It remains the
first-line in-session mechanism, while the supervisor handles lost process
lifecycle.

## The two claims on a run

A run can be driven by two different things, and they are **not** the same claim:

- **`recoveryLease`** — a supervisor runner is driving this run. Written by the
  reconciler, renewed by the runner for the life of its Claude child, and carrying
  the runner's `{pid, startedAt}` so its liveness can be *verified*.
- **`tickGuard`** — an in-session AFK tick is driving this run. Taken by
  `afk-supervisor lease` at each resumable step, and released by expiry.

Collapsing them into one field is what stopped the supervisor from working at all.
The reconciler leased the run, resumed it, and the session it started asked for the
lease, found the supervisor's own claim, was told another lifecycle layer owned
recovery, and exited having done nothing — for ever, while every log line said
`result:success`. **A session the supervisor resumed must be able to take its own
guard.** Only *another session* may block it.

### One question, one answer

`runnability(run, state, config, now, inputs)` is the single answer to *"may this
run be driven right now, and by whom?"*. The selector, the pruner and status all
ask it. Nine uncoordinated predicates across three files used to answer parts of
it, and four review rounds each tightened one and silently changed the meaning of
two others.

It returns a `notBefore`: the earliest moment the run could become runnable.
**Pruning may never delete a run with a future `notBefore`** — a run parked on a
seven-day quota probe is waiting, not abandoned. Retention must exceed the longest
legitimate hold, and `validateConfig` now makes any other configuration impossible.

### Liveness is verified, not assumed

A pid is not an identity: the operating system reuses it, aggressively on Windows.
The runner records the process start time beside it, and only a pid whose process
is *the one we started* counts as alive. That is what allows a live runner to be
trusted with **no time bound** — which suspend requires, because suspend stops the
very timers any time bound would rely on.

A claim whose liveness cannot be determined holds its own run — we never
double-drive it — but it does **not** consume the global invocation slot. A
recycled pid must be able to wedge one run, never the whole supervisor. The
operator is notified, and `trigger-now --force` releases it.

### What `--force` may and may not override

`--force` overrides the timers, the tick guard, and a claim we cannot **verify** —
the states an operator actually reaches for it in. It does **not** override a
Claude we can see is alive. Clearing a live claim leaves one Claude writing to the
session and starts a second on top of it: the corruption everything else here
exists to prevent, with the operator's name on it. A live runner is ended by
ending it — the notification names the pid — or by its own action timeout.

Both `lease` and `trigger-now` probe liveness **outside** the state lock, because
the probe shells out to PowerShell or `ps` and is bounded at ten seconds. A
supervisor pass fits inside that gap easily. The probe's answer is therefore
advisory: each command re-validates the claim **under the lock** and refuses when
the claim it probed is no longer the claim that is there. Deciding outside and
writing inside is how a command came to erase a claim that had been taken while it
was still deciding.

## Who may drive a run

Two things can drive one run, and they must never do it at once: a supervisor
runner, and the in-session tick. The claims are `recoveryLease` and `tickGuard`,
and the mutex between them needs an identity that survives `--resume`.

**`claude --resume` keeps the same session id.** The session that wedged and the
session the supervisor starts to replace it are therefore *indistinguishable* by
session identity. This is the trap: refuse a tick because a recovery lease is held,
and the supervisor deadlocks the very session it just resumed. Let it through, and
a wedged session that comes back to life runs a second `claude --resume` on top of
the runner's — the corruption the whole liveness apparatus exists to prevent.

The discriminator is the **recovery attempt**. The runner puts its attempt id in
the environment of the child it spawns; that child's `afk-supervisor lease` call
inherits it, and nothing else has it. So:

- a live claim whose attempt id is *not* the caller's → `skip:runner-active`;
- a live claim whose attempt id *is* the caller's → the resumed session works;
- a live tick guard held by *another session* → `skip:tick-guard-held`.

The tick guard carries the **caller's** session id, not the run's. Comparing the
run's id against the run's id is always true, and a guard that always says "mine"
guards nothing.

Environment inheritance is load-bearing here, and it is verified end-to-end against
the real CLI, not assumed: an attempt id set on the spawned Claude is visible to a
Bash tool subprocess inside it.

## Liveness has three answers, not two

`alive` / `dead` / `unknown`. A probe that **could not run** is `unknown` — never
`dead`. Conflating them meant that on any host where PowerShell or `ps` could not
be executed, every live runner read as dead and the supervisor started a second
Claude on top of each one.

An identity is `(pid, process start time)` and is stamped **at the spawn**, by the
reconciler that holds the pid — not at the runner's first renewal a minute later. A
runner that dies inside that minute used to leave a claim nothing could verify, and
an unverifiable claim was read as free.

An unverifiable claim holds its own run, but not for ever: a live runner renews, so
a claim unrenewed for longer than a runner can even live has no runner behind it.
Without that bound, a recycled pid wedged its run permanently — never recovered,
never pruned, burning an OS probe every pass.

Retention is the outer bound on all of it. A hold beyond the retention horizon —
a status line reporting a reset years away — protects nothing from the reaper.

## Notes on what only a real machine could find

Three defects survived six adversarial review rounds and three hundred unit tests,
because none is visible from inside the process. All were found by running the
thing.

- **`--tools <tools...>` is variadic.** Activation passed `--tools '' <prompt>`, so
  Claude parsed the *prompt* as a tool name and received no prompt at all. Every
  activation exited 1 with `Input must be provided`. The empty-window activation
  path had never once worked, and the test asserted the flags were *present* —
  which is just as true of the broken order. The prompt is now fenced off with
  `--`. Both arg shapes are checked against the real CLI: activation exits 0, and
  resume fails on a bogus *session id* rather than on a missing prompt.

- **A detached child on Windows loses its stdout.** The runner spawned Claude with
  `detached: true`; on Windows that gives the child its own console and its output
  never reaches our pipe. The runner read **zero frames** from
  `--output-format stream-json`: it could not see a success, could not see a quota
  rejection, and recorded **every recovery as a failure** while Claude was doing
  the work. `detached` exists only so POSIX can signal a process group; Windows
  kills by pid and never needed it.
- **npm installs Claude on Windows as `claude.cmd`.** There is no `claude.exe`.
  Preflight asked `where.exe` for `claude.exe` and reported the CLI as missing when
  it was on PATH — and Node refuses to spawn a `.cmd` without a shell. Every npm
  user was locked out.

A shim is now run through `cmd.exe` with its arguments still an **array**: a shell
string would put a prompt and a path in a shell's hands.

## History: the lease overload

The fifth adversarial round found that **the supervisor's core function did not
work at all, and every log line said it did.**

`run.lease` serves two different concepts with different owners and lifetimes:
the supervisor's *"I am driving this run"* claim, and the in-session tick's
*overlap guard*. Because they are one field:

1. The reconciler leases `run.lease` and the runner renews it for the whole life
   of the Claude child.
2. The runner spawns `claude --resume` with a prompt telling that session to
   continue the AFK run.
3. That session enters the AFK skill, which tells it to take `afk-supervisor
   lease` before any resumable step.
4. `lease` finds a live lease owned by someone else — **the supervisor itself** —
   and returns `skip:recovery-lease-held`.
5. The skill tells the session that another layer owns recovery, so it exits.

The resumed session does nothing. Claude exits 0, the runner records
`result:success`, and 25 minutes later the stale heartbeat makes the supervisor
resume it again. For ever. A `todo` test in `test/supervisor/cli.test.mjs` names
this so it cannot be lost.

The same overload also lets a per-run pid consume the *global* invocation slot —
one stale pid stops the supervisor from invoking anything, on any repository,
permanently — and lets `cli lease` wipe a live runner's pid.

Four consecutive rounds each introduced about five new defects; round 4's nine
individually-correct fixes composed into a new CRITICAL. The root cause was that no
single place answered *"may this run be driven right now, and by whom?"* — nine
uncoordinated predicates across three files each answered part of it, over a shared
mutable blob whose invariants lived only in prose.

The restructuring that ended it (all four done):

1. **Split the lease.** `run.recoveryLease` (supervisor) and `run.tickGuard`
   (in-session). Different concepts, different lifetimes, different owners. This
   alone removes the livelock, the `in-session-` string sniff, and the pid wipe.
2. **Make liveness verifiable.** Store `{pid, startedAt}` and match the
   OS-reported process start time, so pid reuse cannot masquerade as a live
   runner. **Until that exists, a live pid must never consume the global
   invocation slot** — per-run occupancy is not a global capacity claim.
3. **One `runnability(run, state, config, now)` function** consumed by
   `selectCandidate`, `pruneState`, and `status`. `pruneState` must never delete a
   run with a future `notBefore`, rather than growing a fourth exception clause.
4. **Stop overloading one constant.** `terminalRunRetentionSeconds` equals
   `quotaEscalationMaxSeconds` (604800), so a run in maximum quota backoff is
   deleted the moment its probe becomes due. Retention must exceed the longest
   legitimate hold by construction, asserted in `validateConfig`.

## Open Questions and Manual Validation

Windows setup, task registration, execution, and uninstall were validated on a
real unprivileged machine on 2026-07-12: `setup` registers the task, the task
runs the reconciler (`skip:no-active-run`, exit 0) against the pinned data root,
`status` reports the task the operating system actually holds, and `uninstall`
removes the task and restores `settings.json` byte for byte. macOS remains
unvalidated on real hardware.

- Canary whether the current VS Code graphical extension executes user
  status-line commands; absence keeps exact usage capability `unobserved`.
- Measure reconciler startup overhead and scheduler lateness on macOS and
  Windows before claiming operational timing.
- With explicit approval, capture one successful first request in a fresh
  five-hour window and compare `T + 5 hours` with the next exact status-line
  reset before treating the window-anchor estimate as operationally tight.
- With explicit approval, capture one real quota-limited
  `--print --verbose --output-format stream-json` run and confirm the installed
  CLI emits the expected rate-limit classification and retry counters, without
  assuming it emits a reset timestamp.
- Exercise subscription authentication, empty `--tools` behavior, and
  `--max-turns` with an explicitly approved minimal request; automated tests do
  not spend Claude usage.

## Documentation and Release

README and `skills/afk/SKILL.md` document the two lifecycle layers and explain
that reaching 90% queues all active sessions but does not launch requests before
reset. A new `afk-supervisor` skill exposes setup, status, enable, disable,
configure, repair, uninstall, and trigger-now commands.

Because skills, scripts, hooks, and manifests change, the plugin version is
bumped and all generated manifests are refreshed. The final branch must pass
manifest sync, skill lint, link checks, provenance scan, version check, and the
full Node test suite before PR creation.

## Delivery Plan

The work is delivered as three reviewable PRs when repository dependency order
allows it:

1. core state, providers, bridge, hooks, reconciliation, and tests;
2. macOS and Windows installation, scheduling, notification, and tests;
3. AFK lifecycle integration, documentation, manifest regeneration, and release
   version bump.

If splitting would leave an unsafe or unusable intermediate public release,
the same boundaries remain separate commits in one PR instead.
