# Kickoff

Before resolving or announcing policy, read [environment](environment.md),
[run claiming and resumption](continuity.md), [external profile](external-review.md),
[the issue allowance](review-convergence.md#review-cycle-allowance), and
[the CI mode](publication.md#remote-checks). Claim or resume the run before
writing its ledger; retain the scope collision checks.

1. **Require a scope.** The operator must name the explicit issues/PRs (and/or
   file areas) to touch. **No scope → stop and ask.** Never browse the tracker
   and pick work yourself; the scope fences everything you may touch.
2. **Notice and auto-bootstrap.** If `.afk/` is absent, run the `afk-init`
   bootstrap automatically; it calls the shared notice CLI. Otherwise run
   `node "<plugin-root>/scripts/gate-profile-notice.mjs" --afk-dir
   "<main-worktree>/.afk" --plugin-root "<plugin-root>"` now and pass on any line
   it prints. This one implementation owns the receipt for kickoff, init, and
   SessionStart. Bootstrap remains idempotent: add the ignore entry, detect
   commands, record `pluginRoot`, announce it, and continue. No manual step;
   `/afk-init` stays available to re-run detection.
3. **Update check.** Run the bundled update check; if the installed plugin is
   behind the canonical repo's latest version, surface a one-line notice. Never
   block on it (silent when offline).
4. **Resolve the PR gate profile.** Explicit role flags in the handoff (e.g.
   `-codex -kimi`) select this run's ordered roles; otherwise a config `gates`
   key, else a legacy profile (`priority`, `min-pass`, or `mode` with no
   `gates` keeps the legacy behavior), else built-in `gates: codex` — a single
   external review ([external profile](external-review.md) owns the full rules). The bounded
   notice was resolved by step 2. Resolve the implementer and a
   complete locally plausible role assignment now. Missing reviewer capacity is
   an anticipated readiness blocker, not a reason to discard safe issue work.
5. **Confirm the merge policy** (from `.afk/config.md`: `leave-open` default /
   `merge-to-unblock` / `merge-when-green`) and any constraints (branches not to
   touch, naming, safe-direction-only, deploy is the operator's job, summary
   language, explicit gate choice). Resolve `remote-ci` ([Remote checks](publication.md#remote-checks)) now,
   record its value and source in the ledger, and reuse it on resume unless the
   operator changes it. Announce `off` as local completion before remote writes.
   Retain scope and its source, explicit publication instructions and their source,
   merge policy and constraints in that same ledger. Stage transitions reuse
   these grants; a child or summary cannot broaden them.
6. **Resolve the review-cycle allowance** ([Review-cycle allowance](review-convergence.md#review-cycle-allowance)) and record
   its source before reviewing any issue.
7. **Restate the scope and the effective gate profile with its source**
   (`flags` / `config` / `legacy` / `built-in`), and the resolved forge with
   its source (`config` / `remote` / `default`), in one or two lines, then
   start. The restatement is what makes a misread flag or a template-written
   profile visible before any paid work. The forge decides which tracker an
   issue id is read from, and the CLI of another one can answer for that id
   and succeed.
