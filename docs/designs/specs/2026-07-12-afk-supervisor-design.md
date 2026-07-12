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
worker also recovers stale sessions after an unexpected frontend exit, login,
reboot, or sleep.

The supervisor invokes the separately installed `claude` CLI. It never depends
on VS Code, a terminal, or an interactive Claude Code process remaining open.
The existing approximately 15-minute tick remains responsible for progress
checks, ledger-driven continuation, overlap prevention, and run shutdown.

## Goals

- Preserve the existing AFK in-session tick unchanged in purpose.
- Observe exact five-hour and seven-day usage data through documented Claude
  Code status-line JSON.
- Queue all recoverable AFK sessions when exact five-hour usage reaches 90%.
- Resume each queued session 60–180 seconds after the exact reset time.
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

## Confirmed Claude Code Interfaces

The design uses only behavior documented by Anthropic and confirmed against the
installed CLI where applicable.

### Status-line data

Claude Code passes JSON to a configured status-line command on stdin. For
Claude.ai subscribers, after the first API response, it may contain:

- `rate_limits.five_hour.used_percentage`
- `rate_limits.five_hour.resets_at`
- `rate_limits.seven_day.used_percentage`
- `rate_limits.seven_day.resets_at`
- `session_id`, `cwd`, and `transcript_path`

`resets_at` is a Unix epoch timestamp in seconds. Rate-limit fields may be
absent, so missing or malformed input must not erase a previous valid snapshot.
The status-line command is local and does not consume API tokens.

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

### Layer 2: OS-level AFK supervisor

A shared dependency-free Node ESM worker performs one reconciliation pass per
invocation. A per-user LaunchAgent or Windows scheduled task invokes it about
once per minute and once at login/load. Each pass:

1. acquires the global lock;
2. re-reads and validates state;
3. imports fresh ledger heartbeats for registered sessions;
4. evaluates all sessions in stable order;
5. performs at most one Claude invocation globally;
6. records the outcome atomically; and
7. exits with a distinct action, skip, or error reason.

Limiting each pass to one Claude invocation prevents bursts. Due sessions remain
queued and are handled on later scheduler passes.

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
  hook-handler.mjs
  ledger.mjs
  reconcile.mjs
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

It contains `state.json`, `config.json`, a lock record, bounded logs, a stable
copy of the worker bundle, and scheduler metadata. It contains no credentials,
prompts, transcript contents, or repository contents.

```json
{
  "schemaVersion": 1,
  "usage": {
    "fiveHourResetAt": null,
    "fiveHourUsedPercentage": null,
    "sevenDayResetAt": null,
    "sevenDayUsedPercentage": null,
    "observedAt": null,
    "source": "unknown",
    "confidence": "unknown",
    "thresholdResetAt": null
  },
  "runs": {},
  "activation": {
    "handledResetAt": null,
    "inProgress": false,
    "attemptId": null,
    "lastAttemptAt": null,
    "lastResult": null,
    "dailyAttempts": []
  }
}
```

`runs` is keyed by validated run ID. Each record contains the session ID, cwd,
ledger path, run state, heartbeat, expected tick, rate-limit reset, recovery
lease, retry state, and optional threshold recovery schedule.

Writes use a same-directory temporary file, fsync where supported, atomic
rename, and parent-directory sync where supported. Readers validate the entire
shape. Unknown fields are preserved during compatible migrations. Corrupt state
is moved to a timestamped quarantine file only after a valid replacement is
written; recovery defaults to no invocation.

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
  "maxWindowActivationsPerDay": 4,
  "maxRecoveryAttempts": 3,
  "pollIntervalSeconds": 60
}
```

Automatic recovery of registered unfinished AFK runs defaults on. Empty-window
activation defaults to notification. Configuration changes are schema-validated
and atomically replaced.

## Ninety-percent Scheduling

Only an exact status-line snapshot with a valid reset time may arm the 90%
schedule. When usage crosses from below 90% or unknown to at least 90% for a
reset timestamp not previously armed, the bridge transaction:

1. records the exact usage snapshot;
2. marks that reset timestamp as the threshold event;
3. visits every `RUNNING` or `RATE_LIMITED` run;
4. computes a stable per-run delay from 60 through 180 seconds; and
5. records `scheduledResumeAt = resetAt + delay`.

The delay is derived from a cryptographic hash of run ID, session ID, and reset
timestamp mapped uniformly into the inclusive range. It is random-looking but
stable across repeated snapshots, process restarts, and reboot. No duplicate
tasks are created for the same run and reset.

Runs registered after the threshold event but before reset inherit a schedule
for the current reset. Completed, blocked, and auto-paused runs retain audit
fields but become ineligible. A newer exact reset replaces only schedules that
have not started. Missing or estimated reset data never invents a threshold
schedule.

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

Under the global lock, the worker evaluates:

1. disabled configuration;
2. corrupt or unsupported state;
3. terminal runs, which are skipped;
4. fresh ledger or registered heartbeat;
5. next expected tick plus grace;
6. scheduled 90% resume times;
7. exact rate-limit reset plus grace;
8. stale non-rate-limited recovery;
9. empty-window reset policy; and
10. retry backoff and daily caps.

Before any invocation it re-reads the selected run's ledger and state. A fresh
heartbeat cancels the attempt. A per-run recovery lease plus the global lock
prevents the supervisor and in-session tick from launching overlapping work.
The invocation is spawned without a shell.

## Claude Invocation

AFK recovery runs in the validated original cwd and uses the recorded session:

```text
claude --resume <session-id> --print <static AFK resume prompt>
```

The prompt directs Claude to read `.afk/afk-ledger.md`, continue the first
unfinished step, and preserve existing scope, constraints, merge policy, and
overlap guard. Recovery loads normal project and user configuration. Session
IDs must satisfy the documented UUID shape, cwd must be an existing directory,
and the ledger must resolve within that cwd.

Empty-window auto activation, when explicitly enabled, uses print mode,
`--safe-mode`, `--no-session-persistence`, `--max-turns 1`, `--tools ""`,
`--disallowedTools "mcp__*"`, and `--strict-mcp-config` from an empty stable
working directory. Success marks the old reset handled and estimates the next
reset at activation time plus five hours. A later exact snapshot replaces it.

Authentication is checked during setup through supported CLI behavior without
reading credential stores. Missing CLI or authentication disables invocation
and reports a repairable error.

## Retry Policy

Failures never retry every minute. Each run has at most three attempts for a
reset event, with delays of 5, 20, and 60 minutes. A successful heartbeat or a
terminal transition clears retry state. Exhaustion marks the attempt failed and
notifies the user. A new exact reset or explicit `trigger-now` starts a new
bounded attempt series.

## Hooks and Status-line Installation

The plugin provides `SessionStart` and `StopFailure` hooks. SessionStart performs
fast reconciliation of registered metadata. StopFailure with `rate_limit`
records the structured failure without guessing a reset time or launching
Claude. SessionEnd may record an observation but never clears a run.

Setup explicitly asks to install the status-line bridge. It parses the current
user setting, writes a backup before modification, and installs a stable wrapper
that passes the same stdin payload to both AFK and the previous command. The
previous command's stdout and exit behavior remain the visible status line;
AFK emits no stdout. Repeated setup recognizes its marker and does not layer
wrappers. Uninstall restores the prior configuration only when the installed
marker still matches, avoiding overwrite of later user edits.

Malformed input, slow previous commands, and cancelled status-line executions
cannot erase valid usage state. The AFK update is bounded and does not wait for
network access.

## Platform Behavior

### macOS

Setup copies the worker into the stable data directory and installs a per-user
LaunchAgent under `~/Library/LaunchAgents/`. It runs at load and every 60 seconds
without administrator access. Logs rotate by size and retained-file count.
Notifications use `osascript`; actionable behavior is capability-tested and
falls back to an informational notification.

### Windows

Setup copies the worker into `%LOCALAPPDATA%` and installs per-user Task
Scheduler entries for a one-minute recurring trigger and user-logon catch-up.
It uses the resolved absolute Node executable and a stable wrapper, with paths
passed as argument arrays or correctly XML-escaped values. It does not use a VS
Code extension binary or require WSL. Notifications use a PowerShell-compatible
interactive-user adapter and fall back to an informational dialog when actions
are unavailable.

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
skip:reset-already-handled
skip:recovery-lease-held
skip:run-terminal
skip:retry-backoff
skip:daily-activation-cap
action:resume-afk
action:activate-window
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

Coverage includes:

- exact and malformed status-line parsing;
- preservation and replacement of snapshots;
- 90% crossing for every active run;
- stable independent 60–180 second delays;
- sessions registered after threshold crossing;
- terminal-run cancellation;
- existing status-line chaining and idempotence;
- lifecycle registration and explicit completion;
- rate-limit StopFailure without reset-time guessing;
- exact-reset and stale-heartbeat recovery;
- fresh heartbeat and tick-grace no-op;
- tick/supervisor race and stale-lock cleanup;
- login, reboot, and sleep-style catch-up;
- empty-window notify and opt-in auto modes;
- daily activation cap and bounded retries;
- corrupt state recovery and schema migration;
- missing CLI and authentication;
- duplicate reset handling;
- VS Code status-line unobserved fallback;
- Windows quoting and task generation;
- macOS LaunchAgent generation; and
- repeated setup, repair, disable, and uninstall.

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
