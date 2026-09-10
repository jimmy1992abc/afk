---
name: afk-init
description: "afk-init: Part of the afk pipeline. One-time, idempotent bootstrap for a repository — detect build/test/lint commands, write .afk/config.md, ignore .afk/, and record the forge and plugin root. Run once per repo before the other afk skills. Triggers include \"/afk-init\", \"set up afk\", \"initialise afk\"."
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
   working tree — the first non-bare `worktree` record of `git worktree list --porcelain` —
   so every linked worktree resolves the same `.afk/`.
3. **Write `.afk/config.md`** from the plugin's `templates/afk-config.example.md`
   only when it does not already exist — never clobber an existing config.
4. **Detect commands.** Fill any blank `test`/`lint`/`build` line from the
   project's own manifest or task runner. Leave a line blank and say so when
   nothing is found — never guess a command.
5. **Record the forge.** Ask the shared resolver rather than reading the host
   yourself — the value written here outranks the remote at every later read, so
   a hand-derived one that disagrees with the adapter sends issue reads to the
   wrong tracker:

   ```text
   node "<plugin-root>/lib/forge.mjs" --remote "$(git remote get-url origin)"
   ```

   It prints `{ forge, reason, azureOrganization, githubRepository }`. Write
   `forge`, and leave the line blank when it is `null` — a written-in guess
   reads exactly like a detected value later. Report the reason either way.
6. **Record `pluginRoot`.** Resolve the plugin's install location
   (`${CLAUDE_PLUGIN_ROOT}` when set, else the directory this skill loaded from)
   into `.afk/config.md`, so bundled helpers resolve under a drop-in install
   where the env var is unset. When a value is already recorded, ask the helper
   what to do with it rather than deciding by hand — an install cache path is
   version-keyed, so a value written before an update names a directory that
   does not contain the skills now running:

   ```text
   node "<plugin-root>/lib/plugin-root.mjs" --configured <recorded> --resolved <resolved>
   ```

   It prints `{ action, root, reason }`: `record` (nothing recorded yet),
   `refresh` (a superseded same-install version or a missing recognized afk
   cache with a verified live replacement — write the resolved one), or `keep` (a custom or manual root, which is a
   deliberate choice and survives). Report the reason either way.
7. **Ignore local AFK state and credentials.** Append the missing entries from
   the plugin's `templates/gitignore-snippet.txt` to `info/exclude` under
   `git rev-parse --path-format=absolute --git-common-dir`. That file is shared
   by every linked worktree and is not tracked, so one write covers `.afk/`
   wherever it is read from without dirtying a checkout that another session may
   have mid-work on another branch.
8. **Surface the ordered-gate notice once.** Run the shared implementation used
   by SessionStart and AFK kickoff:

   ```text
   node "<plugin-root>/scripts/gate-profile-notice.mjs" --afk-dir "<main-worktree>/.afk" --plugin-root "<plugin-root>"
   ```

   Pass on any line it prints. It owns `.afk/gate-profile-notice.json`, including
   the signature and atomic write, so no entry point reimplements that protocol.
   `AFK_GATE_PROFILE_NOTICE=off` opts out.
9. **Surface the update notice.** Run
   `node "<plugin-root>/scripts/update-check.mjs"` and pass on any line it
   prints. It is silent when current, offline, or opted out, and never blocks —
   a stale install is otherwise invisible to anyone who does not run the full
   `afk` driver. Installing the update is the host's job and the operator's
   call; never self-update from a skill.
10. **Report** each action as created / updated / already present.

## Rules

- Idempotent and non-destructive: existing values win; re-runs only fill gaps.
  A superseded same-install version or missing recognized afk cache with a
  verified live replacement is an expired fact, not a custom-root choice.
- Secrets never enter `.afk/config.md`; keys stay in the environment or the
  ignored local `.env` installed by the same bootstrap rule.
- A blank or absent `config.md` is valid — the pipeline resolves safe defaults.
