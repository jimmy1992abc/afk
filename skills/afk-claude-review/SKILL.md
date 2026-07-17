---
name: afk-claude-review
description: Part of the afk pipeline. Runs Claude (Claude Code CLI) as an independent, read-only external review gate on the current PR/branch, then triages and fixes the findings. For use when another model implemented the change — it declines to review its own work. Interchangeable with afk-codex-review, afk-kimi-review and afk-glm-review, subject to .afk/config.md gate priority and min-pass. Triggers include "/afk-claude-review", "run claude review", "claude gate".
---

# afk-claude-review

An independent second-opinion review by Claude, used as an external gate after
`afk-internal-review`. Interchangeable with `afk-codex-review`,
`afk-kimi-review` and `afk-glm-review`: run the number of gates required by
`.afk/config.md`, and never use a gate whose model matches the implementer's.

**This gate exists for the case where Claude is not the implementer** — Codex,
Kimi, Gemini or Copilot wrote the change and Claude reviews it. It refuses to run
otherwise (see Independence below), so under a Claude Code driver it will
normally self-skip and the next gate in `priority` takes its place. That is the
intended behaviour, not a fault.

The helper `claude-gate.mjs` ships with this skill and travels with the plugin.

## Independence — this gate declines to review its own work

The gate resolves who wrote the change and skips if the answer is Claude:

1. `--implementer <family>` — per invocation. The only source that may permit a
   run as well as block one.
2. `implementer:` in `.afk/config.md` — may only **block**. A per-repo file
   written once must not outrank a live per-run signal.
3. `CLAUDECODE` in the environment — set by Claude Code in every process it
   spawns. Present and undeclared means the driver, and so probably the
   implementer, is Claude.

An unrecognised implementer value fails **closed**: the gate skips rather than
guess that it is independent.

Pass `--implementer <family>` whenever the implementer is not the driver — most
often when `afk-agent-relay` relayed the implementation to another model. Known
families: `claude`, `codex`, `kimi`, `glm`, `gemini`, `copilot`.

**Known gap:** `CLAUDECODE` identifies the driver, not the model. A Claude
implementer driven from Copilot, Cursor, CI, or a plain terminal leaves it
unset, so the gate would run. Close it with `--implementer claude` or an
`implementer: claude` line in `.afk/config.md`.

## Read-only

The reviewer session loads `Read`, `Grep` and `Glob` and nothing else — no Bash,
no Write, no Edit. It is read-only by construction rather than by an allowlist,
so there is no command list to maintain and none to get wrong.

Because the reviewer has no shell, the gate pre-injects the diff and its stat
into the prompt; the reviewer uses its read tools for anything the diff does not
answer. This is the gate's advantage over `afk-glm-review`, whose reviewer is
limited to the snapshot it was sent.

## Metering

Metered like any external gate. Batch confirmed structural findings into one fix
pass, self-review, then re-run once. Defer minor items to a single final pass.

## Run it

The bundled helper `claude-gate.mjs` sits beside this SKILL.md. Locate its
directory as `${CLAUDE_PLUGIN_ROOT}/skills/afk-claude-review` if the env var is
set, else `<pluginRoot>/skills/afk-claude-review` from `.afk/config.md`, else this
skill's own directory. If `.afk/` is absent, the `afk-init` bootstrap runs
automatically first:

```text
node "<helper-dir>/claude-gate.mjs" --implementer codex
```

Run it in the **background** with a generous timeout; redirect stdout to a file
and read it when it completes. Pass through any target flag (`--base <branch>` /
`--commit <sha>` / `--uncommitted`). Do not poll in a sleep loop.

Read the verdict between the `===== CLAUDE REVIEW (final message) =====` markers.
A `SKIPPED: …` line is not a failure — record it and continue per the `afk`
gate-selection rule. The reasons are distinct on purpose, so the ledger can tell
"correctly declined" from "could not review":

- `SKIPPED: independence check — …` — the gate refused to review Claude's own
  work. Correct behaviour; use another gate.
- `SKIPPED: Claude gate disabled via CLAUDE_REVIEW_GATE.`
- `SKIPPED: Claude CLI not installed …`
- `SKIPPED: Claude not authenticated (HTTP 401) …`
- `SKIPPED: Configured model "…" is unavailable (HTTP 404) …`
- `SKIPPED: No changes found for …`

An `ERROR: …` line with a non-zero exit means the gate ran and could not produce
a verdict; that is not a clean round.

## Handle findings

Same discipline as the other gate skills:

1. Sort structural findings from minor items.
2. Verify each finding against the cited `file:line`.
3. Fix confirmed structural findings in one batch and sweep for the same pattern.
4. Self-review once.
5. Re-run the gate once if structural findings were fixed.
6. Resolve minor items in a single final pass without another gate round.

Apply any invariant in `.afk/config.md` as an extra lens.

## Setup

Optional and self-skipping. Needs the Claude Code CLI installed and logged in,
plus Node and `git` on PATH. Uses the operator's existing Claude subscription —
no API key. Disable with `CLAUDE_REVIEW_GATE=off`.

Config knobs:

- `CLAUDE_REVIEW_MODEL` (default `opus`)
- `CLAUDE_REVIEW_EFFORT` (default `medium`)
- `CLAUDE_REVIEW_MAX_CTX_BYTES` (default `400000`)
- `CLAUDE_GATE_BIN` — override the resolved `claude` binary

No fallback model is passed: a quiet downgrade to a weaker reviewer is a quality
regression with no visible symptom, so an unavailable model surfaces as a skip.
