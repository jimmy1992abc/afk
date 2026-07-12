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
   automatically (create `.afk/` from the template, add the `.gitignore` entry,
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

design doc → adversarial debate (cap ~3 rounds; a repeating finding goes to the
ledger, move on) → tests first (targeted) → implementation → adversarial sweep →
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

## External gate (the independent check)

An external gate is **mandatory**: run the number set by `min-pass` in
`.afk/config.md` (default 1) each round, never skipped by choice. Constraints:
each gate's model is **not** the implementer's model, and is a
current-generation mainstream frontier model.

- **Selection** follows `.afk/config.md`: `priority` (default
  `codex > kimi > glm`),
  `min-pass` (default 1), and `mode` (`waterfall` = try in priority order,
  stopping once `min-pass` gates pass; `parallel` = run `min-pass` at once).
  Skip any gate that is the implementer's own model or cannot run (uninstalled,
  logged out, out of credit, below tier); the next in priority takes its place.
- **Stickiness:** a gate chosen in round 1 is locked for later rounds of the same
  PR; a mid-loop switch resets that gate's finding baseline and is recorded.
- **`SKIPPED` is the last resort only** — when no qualifying reviewer can run.
  Record it in the ledger and end-of-run report and continue. Stopping early or
  handing the gate to the operator is not a valid skip. When `min-pass` cannot be
  met, the round is not clean — do not mark ready.

The gate skills (`afk-codex-review`, `afk-kimi-review`, `afk-glm-review`) carry
the invocation, batching, and metering rules; they load when the gate runs.

## Autonomy

Decide with best-practice defaults and record each decision; do not block on
in-scope work. Risky changes ship safe-direction (behind a default-off flag,
fail-safe, additive). Only stop for: out-of-scope work, a destructive or
outward-facing action without authorization, or genuine ambiguity with no safe
default. Never merge a PR that is not green or has an open finding; never touch
another session's branch; never deploy (merge ≠ deploy).

## Continuity and self-pause

The run's ledger lives at `.afk/afk-ledger.md` (gitignored), updated in place; if
missing, reconstruct it from the state checks below.

- **If the host supports scheduled re-invocation** (a cron or wake-up), set up a
  recurring tick that re-invokes you; the tick prompt is static (scope, order,
  merge policy, constraints, ledger path) — never embed the ledger itself.
  Otherwise run to completion in-session, checkpointing the ledger before any
  yield so a later session resumes the same issue at its next step.
- **Rate-limited tick → aim the next one at the reset.** When a tick fails on a
  rate limit, ask the window-activation supervisor for the observed reset:
  `node "<plugin-root>/scripts/supervisor/cli.mjs" next-reset`. If it reports
  one, schedule the next tick for shortly after `resetAt` (plus ~2 minutes)
  instead of the fixed interval, keeping the recurring cron as the fallback —
  a failed invocation must never unschedule the loop. The supervisor opens the
  new five-hour window at the reset; your aimed tick then resumes work
  immediately instead of up to one interval late. If `next-reset` reports
  nothing or the supervisor is not installed, just keep the normal cadence.
- **Overlap guard — first action each tick:** refresh a UTC heartbeat in the
  ledger at each step and during long waits. A tick that finds a heartbeat
  fresher than ~20 min exits immediately (another tick is working); such exits
  do not count toward auto-pause.
- **State checks** (scoped, not global): view each scoped issue; list PRs for
  your branches; check the current branch and status; resume the first
  unfinished step. One branch per issue off the default branch; push early.
- **Auto-pause:** track substantial new content per tick (a commit, a pushed
  branch, an opened PR, a new design doc, a resolved CI failure or finding).
  Two consecutive working ticks with none → stop the tick loop, post a status
  report (blocking + remaining), and stop. Queue complete → stop with a final
  report. Always tear down any scheduled tick on stop — never leave one running.

## End-of-run report

Every PR with its state (merged / open-awaiting-review), every notable decision,
each external-gate outcome (including any `SKIPPED`), deferred/remaining items,
and anything blocking. In the operator's preferred language.
