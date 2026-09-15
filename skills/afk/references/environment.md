# AFK environment

Read before a stage resolves consuming configuration, output paths or bundled
helpers. Reading this reference alone does not start a run or grant publication
authority. If the current operation needs `.afk/` and it is absent, perform
[afk-init](../../afk-init/SKILL.md) automatically and continue. When init itself
is the current operation, follow its steps without dispatching init again.
A blank or absent `config.md` resolves safe defaults; never write consuming
project specifics into the installed plugin.

## Shared state location

Resolve `.afk/` against the repository's **main working tree** — the first non-bare
`worktree` record of `git worktree list --porcelain` — never against the current
directory, and never by taking the parent of the common git dir (under
`--separate-git-dir`, or in a submodule, that parent is git metadata rather than
a working tree). One run may span several linked worktrees; resolving from the
current checkout would split its state and hide concurrent runs.

Consuming preferences live in the gitignored `.afk/config.md`. Run state lives
in `.afk/runs/<run-id>/`, keyed by run, never by repository or worktree. Before
claiming, resuming or writing a run directory, read [continuity](continuity.md).
Do not allocate a run merely to read configuration. Secrets stay in environment
variables or an ignored local `.env`, never in `config.md` or shipped content.

## Bundled helper location

Resolve the plugin root from `CLAUDE_PLUGIN_ROOT`, else `pluginRoot` recorded in
`.afk/config.md`, else two directories above the owning `skills/<name>/`
directory. A helper beside a satellite's `SKILL.md` may use that skill directory
directly as its final fallback. Resolve from the skill directory, not this
reference directory, and never invoke a helper through a bare working-directory
relative path.

For init, resolve the currently loaded install from `CLAUDE_PLUGIN_ROOT` or the
loaded skill's directory before comparing it with the recorded value. Init
uses `lib/plugin-root.mjs` to refresh superseded same-install cache roots while
preserving custom roots. Its steps also own bootstrap detection and notice
invocations; do not reimplement those operations in another entry point.

A stale install is a one-line, non-blocking notice at kickoff, init and
SessionStart. The hook caches its check in `.afk/update-check.json` for at most
one check a day; `AFK_UPDATE_CHECK=off` silences it. Installation remains the
host's and operator's action, never a skill's self-update.
