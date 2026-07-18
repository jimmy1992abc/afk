# SessionStart Auto-Resume Hook — Design Spec

- **Date:** 2026-07-18
- **Status:** Proposed
- **Scope:** A cross-platform, plugin-level `SessionStart` hook that detects a
  paused (resumable) afk run in the repository and, when a window is (re)opened,
  surfaces it — or, opted in, directs an autonomous resume. Ships with the
  plugin; adds one `.afk/config.md` knob (`auto-resume`, default `notify`).

---

## Problem

afk's overnight continuity depends on an **in-session** tick — a
`ScheduleWakeup`/`/loop` timer or an in-memory `CronCreate`. That tick is not
durable. A rate limit, a window restart, or the host sleeping destroys it, and
because each tick self-reschedules, the chain ends silently: nothing re-invokes
it, and the run sits `state: active` with a going-stale heartbeat until a human
notices. The dead gap between the last tick and the manual recovery is unbounded.

A host `SessionStart` hook cannot fix the durability gap in general: a hook runs
a command and injects context, but it **cannot start a turn on its own**, so it
is not a scheduler and cannot replace the wake-up tick. What it *can* do is
remove the manual step from the common recovery path: when the operator reopens
a window against the repo, detect the paused run and put its identity, ledger
path, and scope in front of the agent — so resuming is one confirmation, not a
hunt through `.afk/runs/` and a re-paste of the handoff.

## Goals

1. On a real window (re)start, detect any afk run that is **paused and
   resumable** — `state: active` with a heartbeat staler than the overlap guard
   — and surface it as injected `SessionStart` context.
2. Be a **pure no-op** outside an afk repository, on non-`startup`/`resume`
   sources, and whenever no resumable run exists — no output, exit 0.
3. **Never crash or slow a session.** Every path is wrapped; any error exits 0
   with no output; total wall-clock is well under a second in the common case.
4. Ship **with the plugin** (fires wherever afk is installed) via the plugin's
   own hook-registration mechanism — no per-user `settings.json` edit.
5. Give the operator a single **`auto-resume`** knob: `off` (silent), `notify`
   (surface only — default), `auto` (surface + direct an autonomous resume for a
   single unambiguous run).
6. Respect the afk continuity rules already in `skills/afk/SKILL.md`: resolve
   `.afk/` against the **main working tree**; never drive two runs from one
   session; a fresh heartbeat means a live tick owns the run — leave it alone.

## Non-goals

- **Not a durable scheduler.** The hook cannot fire a turn by itself. A
  durable external scheduler (cron/daemon that re-invokes the agent) is a
  separate, later option, explicitly out of scope here.
- **No change to the run/ledger format**, the waterfall, or any gate.
- **No mutation of the operator's stopgap** (`~/.claude/hooks/afk-resume-detect.ps1`
  or `~/.claude/settings.local.json`) — that is retired separately once this ships.
- **No consumer-repo config edits.** The knob is added to the plugin's config
  *schema, template, and docs* only; downstream repos opt in after distribution.

## Reference behavior (ported, not reused)

A pipe-tested PowerShell prototype (operator-local, not part of this repo)
established the correct detection: select `state: active` ledgers whose heartbeat
is stale beyond the guard, skip fresh-heartbeat and `complete` runs, no-op
outside afk. This spec ports that behavior to Node and fixes two limitations
found while porting:

1. **Worktree resolution.** The prototype uses `git rev-parse --show-toplevel`
   (or cwd). A run legitimately spans linked worktrees, and `.afk/` has one
   canonical home — the **main** working tree (first `worktree` line of
   `git worktree list --porcelain`), exactly as `skills/afk/SKILL.md` and the
   gate lib require. `--show-toplevel` returns the *current* worktree, which for
   a linked worktree is the wrong tree and hides the run. The Node port resolves
   the main tree.
2. **Scope extraction.** The prototype parses only a `## scope` markdown block.
   Real ledgers (and the format `skills/afk/SKILL.md` mandates) carry scope as a
   single-line **`scope:` header field**; a `## scope` block is not present.
   Parsing only the block yields empty scope on every real ledger. The port reads
   the `scope:` header line first and falls back to a `## scope` block, so both
   shapes work.

## Design

### Module layout

Thin executables over testable pure logic — the pattern the gate scripts already
use (a `*-gate.mjs` executable over `lib/gate/*.mjs`).

| File | Role |
|------|------|
| `hooks/hooks.json` | Plugin-level registration: `SessionStart` → run the hook. Auto-discovered at the plugin root. |
| `hooks/afk-resume-detect.mjs` | Executable. Reads stdin JSON, resolves the main tree, calls the detector, writes the `SessionStart` output, always exits 0. No logic beyond I/O + orchestration. |
| `lib/resume/detect.mjs` | Pure logic: parse a ledger header, select resumable runs, build the `additionalContext` string, normalize the `auto-resume` value. Unit-tested directly. |
| `lib/config.mjs` | `readConfigValue(configPath, key)` — one single-line `key: value` reader for `.afk/config.md`. |

### Decision 1 — Registration: a standalone `hooks/hooks.json`

Claude Code auto-discovers `hooks/hooks.json` at the plugin root (per the
plugins reference); no `plugin.json` field is required. This matters because
`scripts/sync-marketplace.mjs` regenerates `plugin.json` as
`{name, description, version}` and would clobber an inline `hooks` key. A
standalone file is outside sync's control and stable.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/afk-resume-detect.mjs\"" }
        ]
      }
    ]
  }
}
```

No `matcher`: the source filter lives in the hook (the spec requires acting only
on `startup`/`resume`, read from stdin), and matching in-code keeps one source of
truth for that rule. The `node "<path>"` shell form matches the repo's existing
hook convention (`afk-agent-relay/hooks/precompress-hook.mjs`) and is required on
Windows, where a bare `.mjs` path is not executable.

### Decision 2 — Resolve the main working tree, then derive both paths

`root = mainWorktree({cwd}) || cwd`, where `cwd` comes from the hook stdin.
Everything derives from `root`: `<root>/.afk/runs/` and `<root>/.afk/config.md`.
`mainWorktree` reads the first `worktree` line of `git worktree list --porcelain`.
The gate lib already has this logic (private in `lib/gate/implementer.mjs`); to
honor AGENTS.md "define once", it is promoted to the shared `lib/gate/git.mjs`
(whose header is literally "Git access shared by every gate"), exported, given an
optional `{cwd}`, and imported by both `implementer.mjs` and the hook. Behavior
for the existing caller is unchanged (no `cwd` = `process.cwd()`).

### Decision 3 — Selection: active AND heartbeat stale beyond the guard

For each `.afk/runs/*/ledger.md` (read UTF-8): parse header `state`, `heartbeat`,
`run-id`, and scope. Select a run iff `state === 'active'` and the heartbeat is
older than **20 minutes** (`STALE_MINUTES`, defined once in `detect.mjs`). This
mirrors the afk overlap guard: a heartbeat fresher than ~20 min means a live tick
owns the run, so surfacing it would invite a second driver.

Boundary rules, fail-safe:

- `state` missing or not `active` → skip (only a paused *active* run is
  resumable; `complete` is finished history).
- `heartbeat` missing or unparseable → treat as **stale** (surface it). An
  active run with no readable heartbeat is not owned by a live tick; the safe
  direction is to surface, not hide. Its staleness renders as `unknown`.
- A garbled ledger that throws → skipped, not fatal.

### Decision 4 — Output by mode and run count

Read `auto-resume` from `<root>/.afk/config.md` (absent/blank/unrecognized →
`notify`). Then:

| Situation | Output |
|-----------|--------|
| `off` (any) | none; exit 0 |
| no resumable run (any mode) | none; exit 0 |
| `notify`, ≥1 run | Surface each run — run-id, ledger path, scope, staleness — and state it is resumable. **No** autonomous-drive directive. |
| `auto`, exactly one run | Same info **plus** a directive: unless the operator's first message redirects, resume the full waterfall autonomously per the afk skill — refresh the heartbeat first (overlap guard) and honor the run's merge policy. |
| ≥2 runs (any mode, incl. `auto`) | **List** them; drive none. One session must not drive two runs — each needs its own worktree/session. Confirm with the operator which to resume. |

Output shape (JSON to stdout, exit 0):

```json
{ "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "…" } }
```

The `auto`-single directive is deliberately conditional ("unless the operator's
first message redirects"): injected context must not override an operator who
opened the window to do something else. `notify` never injects a drive
instruction at all — it is the safe default precisely because a false positive
costs only a few lines of context, never an unwanted autonomous run.

### Decision 5 — `hooks/` is shipped code (version-bump invariant)

Introducing a plugin-root `hooks/` directory means `hooks/` now ships to every
install, so a change under it must bump the version like `skills/`, `scripts/`,
and `lib/`. `scripts/check-version-bump.mjs` currently lists only those three;
`hooks/` is added to `SHIPPED_DIRS`, with a test. (This PR changes `lib/` too, so
it requires a bump regardless — the fix is for future hook-only changes.)

## Invariants

| Invariant | Enforced by | Pinned by |
|-----------|-------------|-----------|
| Acts only on `source` ∈ {startup, resume} | `detect`/hook source filter | test: clear/compact → empty stdout |
| No output & exit 0 outside an afk repo (no `.afk/runs/`) | hook early return | test: non-afk tmp dir → empty stdout |
| `off` and no-run → empty stdout, exit 0 | mode gate / empty selection | tests: off mode; zero-run |
| `.afk/` resolved from the **main** worktree, not cwd/toplevel | `mainWorktree({cwd})` from `git.mjs` | test: porcelain call present; existing implementer guard test |
| Only `active` + heartbeat-stale > 20 min surfaced | `selectResumable` | tests: active+stale surfaced; active+fresh skipped; complete skipped |
| Missing/garbled heartbeat → surfaced (fail-safe), staleness `unknown` | `selectResumable` | test: missing/garbled heartbeat |
| ≥2 runs never produce a single-run drive directive | `buildContext` run-count branch | test: multi-run lists, no drive verb |
| `auto` single-run emits the conditional drive directive | `buildContext` | test: auto+1 → directive; notify+1 → no directive |
| Any error → exit 0, no output (never crash a session) | top-level try/catch in hook | test/inspection: wrapped main; unreadable inputs |
| `hooks/` change requires a version bump | `SHIPPED_DIRS` | test: `requiresBump(['hooks/…'])` |
| Default is `notify` (absent/blank/garbled config) | `normalizeMode` | tests: absent/blank/unknown → notify |

## Testing

Unit tests (`node --test`), no shell dependency — Node `fs`/`child_process` only,
against temp `.afk/runs/` fixtures:

- Detection: active+stale → surfaced; active+fresh → skipped; `complete` →
  skipped; missing/garbled heartbeat → surfaced with `unknown`; multi-run → all
  listed.
- Scope extraction: `scope:` header line; `## scope` block fallback; neither.
- Config: each mode (`off`/`notify`/`auto`); absent/blank/unknown → `notify`.
- Output contract: emitted JSON shape (`hookSpecificOutput.hookEventName ===
  "SessionStart"`, string `additionalContext`); `off`/no-run → empty stdout;
  `notify` carries no drive verb; `auto`-single carries the directive; ≥2 runs
  never carry a single-run drive directive.
- Source filter: `clear`/`compact` → empty stdout; `startup`/`resume` act.
- Non-afk dir → empty stdout.
- `readConfigValue` parity with the existing `implementer:` parse.
- `requiresBump(['hooks/…'])` is true.

## Alternatives considered

- **Inline `hooks` in `plugin.json`** — rejected: `sync-marketplace.mjs`
  overwrites that file.
- **A `matcher` on the SessionStart entry** instead of an in-code source filter
  — rejected: the spec's authoritative rule is "act on startup/resume", and
  keeping it in one place (code, tested) avoids a second, drifting copy in JSON.
- **Reimplementing worktree/config parsing locally** — rejected as duplication;
  the gate lib already owns both, so they are shared.
- **Env opt-out (like the gates' `*_REVIEW_GATE`)** — unnecessary; the
  `auto-resume: off` knob already gives a first-class disable, and a second
  mechanism would be a second source of truth.

## Level honesty (per AGENTS.md)

This hook is a real host **control point** (level 2 within its own execution):
Claude Code runs it and injects its output. What it injects is **context**, not
compulsion — the agent may still be redirected by the operator's first message
(level 1/3: the resume itself remains doctrine the driver follows). The wording
throughout says "surface" and "direct", never "guarantee a resume".
