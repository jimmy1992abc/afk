# AFK Window Activation Design

- **Date:** 2026-07-13
- **Status:** Accepted
- **Scope:** Cross-platform (Windows, macOS) window-activation task
- **Supersedes:** the full supervisor design (PR #5, kept unmerged as an archive)

## Purpose

Two goals, set by the operator:

1. Know when the five-hour rate-limit window resets, and fire one minimal
   request just after the reset so the new window opens immediately — quota
   regenerates overnight instead of starting only when a human returns.
2. Let a rate-limited AFK session resume shortly after the reset. The session's
   own recurring ~15-minute tick already does this within one interval; the afk
   skill additionally aims its next tick just past the observed reset.

## The one deliberate descope

The archived design also had the OS supervisor resume sessions itself
(`claude --resume` spawned from the scheduler). That single feature created a
distributed mutual-exclusion problem — two independent drivers on one session,
undistinguishable by session id — and with it leases, process-identity
verification, claim repair, and orphan reaping. Fourteen adversarial review
rounds each found real defects there, and the defect count did not converge.

This design removes the problem class instead of solving it: **the supervisor
never touches a session.** The only thing it ever starts is a throwaway
`--no-session-persistence --max-turns 1` request. The central invariant of the
archived design — at most one driver per session — holds here by construction,
because the supervisor drives nothing.

What is given up: automatic resume after a reboot, sleep, or closed editor
(the in-session tick dies with its host; the human restarts in the morning),
and sub-interval resume latency when the tick cannot aim (both accepted by the
operator). A notify-only staleness alert can be added later without touching
sessions.

## Interfaces (empirically verified against the installed CLI)

- **Status line** is the only external source of an exact reset:
  `rate_limits.five_hour.{used_percentage, resets_at}` on stdin, epoch seconds.
  The wire-visible headless stream (`system/api_retry`) carries no reset time.
- **StopFailure hook** with the `rate_limit` matcher says *that* a limit
  happened, not when it lifts. It is the estimate fallback: reset is at most
  five hours after the failure, tightened by the last known window anchor.
- **Activation invocation:** `--tools <tools...>` is variadic and swallows a
  trailing prompt; the prompt is fenced with `--`. npm installs Claude on
  Windows as `claude.cmd`, which Node cannot spawn without a shell; shims run
  through `cmd.exe` with the arguments still an array. A detached child on
  Windows loses its stdout, so children are never detached there. The window
  opens at the request's start, so the anchor is the spawn time.

## Architecture

Three single-writer files under the per-user data root, no locks:

- `latest-observation.json` — written only by the status-line wrapper.
- `latest-stopfailure.json` — written only by the StopFailure hook.
- `state.json` — written only by the supervisor pass
  (`{handledResetAt, windowAnchorAt, attempts[], nextAttemptAt, lastResult,
  notifiedResetAt}`).

A scheduled task (Task Scheduler / launchd, every minute, `StartWhenAvailable`
so a sleep is caught up on wake) runs one pass:

1. Resolve the target reset from the freshest evidence: an exact observation
   showing usage at or above the threshold, or a StopFailure estimate. Exact
   beats estimated for the same episode.
2. Gates, in order: disabled → no evidence → already handled → not yet due
   (reset + grace) → stale (too long past; mark handled without firing) →
   attempts cap per reset → retry backoff.
3. Fire the activation inline with a hard timeout, classify the outcome from
   the stream (`result` frame vs `api_retry rate_limit`), and record it:
   success marks the reset handled and anchors the window at the spawn time;
   a quota rejection means the estimate was early — back off and retry; a
   failure backs off, and exhausting the cap notifies the operator once.

Worst-case concurrency (a manual `trigger-now` racing the scheduled pass) is
one duplicate minimal request; state files are written atomically
(temp + rename) and last-writer-wins.

## CLI

`setup` (preflight, status-line wrapper with marker + restore, scheduler
registration with rollback), `uninstall`, `status [--json]`, `enable`,
`disable`, `trigger-now`, `next-reset` (JSON `{resetAt, confidence}` — consumed
by the afk skill to aim its next tick), `run-once`.

## Security

- The supervisor never inspects or resumes sessions and reads no transcripts.
- Claude and the notifier are spawned without shell interpolation.
- Mutable state cannot supply commands, flags, or prompts.
- Malformed observation input never erases previous valid state.
- Scheduler installation requires the explicit `setup` command; uninstall
  restores `settings.json` byte-identically when the user has not changed it.

## Test strategy

Pure decision logic (`decide`, `resolveReset`) is enumerated directly. Process
handling is tested with injected fakes plus the real-CLI regressions carried
over from the archived branch (variadic fence, `.cmd` shim, detach, kill).
Normal tests never call Claude or touch the real scheduler. Fixes land with a
mutation check: a fix whose removal keeps the suite green is not landed.
