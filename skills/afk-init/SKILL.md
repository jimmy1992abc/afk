---
name: afk-init
description: Part of the afk pipeline. One-time, idempotent bootstrap for a repository — detect build/test/lint commands, write .afk/config.md, add .afk/ to .gitignore, and record the plugin root. Run once per repo before the other afk skills. Triggers include "/afk-init", "set up afk", "initialise afk".
---

# afk-init

Prepare a repository so the afk pipeline works in it. Idempotent: safe to re-run;
it fills gaps and never overwrites a value a developer set by hand. The pipeline
skills run this same bootstrap **automatically** when `.afk/` is absent, so it
rarely needs invoking by hand — `/afk-init` is for an explicit re-detect.

## Steps

1. **Confirm the repo.** Require a git working tree with a remote; stop with a
   clear message if either is absent.
2. **Create `.afk/`** (with `runs/` inside) if missing, in the repository's main
   working tree — the first `worktree` line of `git worktree list --porcelain` —
   so every linked worktree resolves the same `.afk/`.
3. **Write `.afk/config.md`** from the plugin's `templates/afk-config.example.md`
   only when it does not already exist — never clobber an existing config.
4. **Detect commands.** Fill any blank `test`/`lint`/`build` line from the
   project's own manifest or task runner. Leave a line blank and say so when
   nothing is found — never guess a command.
5. **Record `pluginRoot`.** Resolve the plugin's install location
   (`${CLAUDE_PLUGIN_ROOT}` when set, else the directory this skill loaded from)
   into `.afk/config.md`, so bundled helpers resolve under a drop-in install
   where the env var is unset.
6. **Ignore `.afk/`.** Append the line from the plugin's
   `templates/gitignore-snippet.txt`, if absent, to the `.gitignore` of the same
   main working tree the directory was created in — a `.gitignore` is per
   checkout, so writing it to the invoking worktree would leave `.afk/` visible,
   and committable, where it actually lives.
7. **Report** each action as created / updated / already present.

## Rules

- Idempotent and non-destructive: existing values win; re-runs only fill gaps.
- Secrets never enter `.afk/config.md`; keys stay in the environment.
- A blank or absent `config.md` is valid — the pipeline resolves safe defaults.
