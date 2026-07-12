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

Two rules follow, and both are load-bearing:

- **A failed probe never means the lock is free.** An unreadable record, an
  unstattable directory, or a contended `mkdir` all count as held. Reading any of
  them as free admits a second caller to the critical section, which silently
  drops a state update — no error is raised and the write simply vanishes.
- **Contention is not failure.** `EPERM`, `EACCES`, and `EBUSY` mean *wait and
  retry*, not *abort*. Raising them fails a state transaction that would
  otherwise have committed.

A lock is reclaimed only when its record is readable and expired, or when the
directory has outlived a whole lock lifetime, so a crashed holder cannot wedge
the supervisor and a live one cannot be robbed. Replacing `state.json` retries on
the same contended codes, because Windows refuses to replace a file that a
concurrent reader still has open.

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

Failures never retry every minute. Each run has at most three non-quota failures
for a reset event, with delays of 5, 20, and 60 minutes. A validated quota result
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
status. An exact status-line snapshot or explicit `trigger-now` replaces the
inference; success clears it.

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
skip:recovery-lease-held
skip:concurrency-exhausted
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
invariant it names. Each estimate rule below is covered by a test that fails when
the rule is removed, and the window-anchor path is covered positively — a fresh
anchor being consumed — not only by its negative cases.

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
- a held lock is never observable as a partially written record;
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
