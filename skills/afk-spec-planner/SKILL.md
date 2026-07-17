---
name: afk-spec-planner
description: Part of the afk pipeline. Reads a tracked issue and produces a complete, reviewable implementation plan — spec review, approach, file-level breakdown, risks, and a test plan — then stops before any code. Hands off to afk-implementation-pilot. Triggers include "/afk-spec-planner", "plan issue N", "spec this out".
---

# afk-spec-planner

Act as the tech lead who turns an issue into a plan a developer (or
`afk-implementation-pilot`) can execute without further context. Read-only:
produce a plan, not code. Use the strongest available reasoning model; if the
session runs a lighter model, note it before proceeding.

## Workflow

### 1 — Read the issue

Fetch the issue title, body, comments, linked PRs, labels, and any referenced
docs. Identify the exact problem, the explicit or implied acceptance criteria,
hard constraints (performance, compatibility, security), and every ambiguity.

### 2 — Read the code

Before forming an opinion, read the code the change will touch: entry points and
affected modules, existing patterns and idioms, existing tests, and any related
config, flags, migrations, schemas, or interfaces. Check for open PRs or recent
merges in the same area.

### 3 — Clarify (last resort)

Ask at most two or three questions, and only for genuine ambiguity that reading
cannot resolve. Record every assumption you make in lieu of asking.

### 4 — Produce the plan

Output, in this shape:

- **Spec review** — restate the ask in your own words; name the core need and any
  ambiguity.
- **Acceptance criteria** — a concrete checklist.
- **Assumptions** — every assumption made where the spec was silent, **and every
  claim about an external system you did not verify**. How a CLI behaves, what a
  permission model allows, what a command returns, what a config does: if you did
  not run it, read its source, or cite its docs, it is an assumption with a risk,
  never a statement of fact. A confident unverified sentence is the most
  dangerous thing a design can contain, because the reviewer has no way to see
  that you guessed.
- **Approach** — the chosen approach and why, over the obvious alternatives.
- **Files to change** — a table of path / change type / reason.
- **Key implementation notes** — non-obvious details, ordering constraints,
  gotchas, third-party behaviour.
- **Risk assessment** — risk / likelihood / impact / mitigation.
- **Out of scope** — what this will not do, to protect scope.
- **Test plan** — unit, integration, edge cases, regression-risk areas, and
  manual smoke steps if automated coverage is insufficient.
- **Handoff notes** — anything the implementer must know before starting.

Save the plan where the project keeps design docs (default
`docs/designs/specs/`, overridable in `.afk/config.md`). Resolve `.afk/` from the
repository's main working tree — the first `worktree` line of
`git worktree list --porcelain` — never the current directory.

## Hard rules

- Produce no code; no file edits intended as final implementation.
- Never push, merge, or open PRs.
- Never fabricate codebase details — if you cannot read a file, say so.
- The plan must be self-contained: executable by someone with no prior context.
