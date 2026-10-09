# AFK environment

Read before a stage resolves consuming configuration, output paths or bundled
helpers. Reading this reference alone does not start a run or grant publication
authority. If the current operation needs `.afk/` and it is absent, perform
[afk-init](../../afk-init/SKILL.md) automatically and continue. When init itself
is the current operation, follow its steps without dispatching init again.
A blank or absent `config.md` resolves safe defaults; an existing unreadable
config is an error for operations depending on its identity. Never write
consuming project specifics into the installed plugin.

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

Before the first bundled helper dispatch in a stage, reconcile the recorded
`pluginRoot` even when `.afk/` already exists. Resolve the currently loaded install
from `CLAUDE_PLUGIN_ROOT`, else two directories above the owning
`skills/<name>/` directory. Resolve from that skill, not this reference directory
or the recorded root, which may name a superseded installation.

Invoke the loaded install's existing decision helper:

```text
node "<loaded-root>/lib/plugin-root.mjs" --configured <recorded> --resolved <loaded-root>
```

It returns `{ action, root, reason }`. For `record` or `refresh`, update only
`pluginRoot` in the consuming ignored config after a successful decision. For
`keep`, preserve intentional custom roots. Report the reason in every case;
an unavailable helper or unreadable config is an error, not permission to guess.
The helper owns recognition of superseded same-install caches and missing known
caches with a verified live replacement; do not duplicate that policy here.

Then resolve bundled helpers from `CLAUDE_PLUGIN_ROOT`, else the reconciled
configured root, else the loaded install. Never invoke a helper through a bare
working-directory relative path. This first-dispatch procedure is driver
doctrine (level 3); the helper only checks the decision for invocations routed
through it. Init follows the same procedure and still owns bootstrap detection
and notice invocations.

A stale install is a one-line, non-blocking notice at kickoff, init and
SessionStart. The hook caches its check in `.afk/update-check.json` for at most
one check a day; `AFK_UPDATE_CHECK=off` silences it. Installation remains the
host's and operator's action, never a skill's self-update.
