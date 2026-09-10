# Sync workflow: full managed-path coverage; validate pushes to main

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#29 (from the #19 audit: the sync workflow's path
filter covers two of the six files it manages, `validate` runs only on
pull_request, and the bot commit is `[skip ci]` — a direct push to main
editing four of the manifests triggers nothing). Workflow-only scope; no
version bump (`.github/workflows/` does not ship).

## Frozen issue contract

Acceptance criteria:

1. `sync-marketplace.yml`'s `paths` lists every file the job manages —
   `skills/**`, `scripts/sync-marketplace.mjs`, and all six committed files
   (`.claude-plugin/marketplace.json`, `.github/plugin/marketplace.json`,
   `.agents/plugins/marketplace.json`, `.codex-plugin/plugin.json`,
   `plugin.json`, `package.json`) — so hand-drift on any managed file
   triggers the resync.
2. `validate.yml` gains `push: branches: [main]`, so every direct push to
   main runs the full check set (the version-bump step stays PR-gated by
   its existing `if:` — verified in debate as the only PR-coupled step).
   Concurrency semantics stated accurately (R1-F2): the group keys on
   `github.ref` with `cancel-in-progress: true`, so the NEWEST main run
   supersedes (cancels) an in-flight one — latest-state validation,
   deliberately not per-commit; on a linear main the newest tree contains
   the older push's state.
3. **Deviation from issue #29's AC 3 as written, ratified on the issue
   (R1-F1)**: neither OR-branch is achievable — a `GITHUB_TOKEN` push
   triggers no workflow runs at all, so the bot commit cannot "be validated
   by the push job", and removing `[skip ci]` cannot make it "non-skipping".
   Shipped resolution: the marker is removed as dead weight with the real
   mechanics recorded in the workflow; the sync job gains an in-run
   post-regeneration `node scripts/sync-marketplace.mjs --check` plus a
   JSON parse of the six files, so even `workflow_dispatch`-produced
   commits are validated in-run for manifest consistency and JSON validity — the full validate suite still waits for the next triggering push (zero new tokens); and the determinism
   argument is recorded — the commit is an idempotent serialization of a
   tree the same push already validated. PAT-based triggering stays a
   recorded non-goal. The workflow comment also names the alarm shape
   (R1-F7): a hand-drift push to main is EXPECTED to show a red validate
   run while sync self-heals with an unchecked commit — the red run is the
   alarm, not flakiness — and notes that idempotence bounds any future
   PAT-world loop to one extra no-op run (R1-F4).

Engineering invariants: no new secrets or tokens; permissions stay as they
are (`contents: read` for validate, `contents: write` for sync); pinned
action SHAs unchanged.

Non-goals: a scheduled main check (recorded option in #19; a push-triggered
run covers the drift-on-main blind spot the issue names); gitleaks pinning
and `require-owner-approval` policy (separate #19 items, operator-owned);
PAT-based bot commits.

## Design

Four edits, all in `.github/workflows/`:

- `sync-marketplace.yml` `paths`: add the four missing manifests and
  `package.json` (six managed files total), keeping `skills/**` and the
  script itself.
- `sync-marketplace.yml` commit step: message becomes
  `chore: sync manifests` with a comment above the step explaining the
  GITHUB_TOKEN no-trigger mechanics and where validation of the commit
  actually happens.
- `validate.yml` `on:`: add `push: branches: [main]`.
- sync job: after regeneration, run `node scripts/sync-marketplace.mjs
  --check` and JSON-parse the six files (the AC 3 in-run guard — a belt for
  serialization instability and dispatch-produced commits, not armor).

## Test plan

No unit surface (workflow YAML; Actions is currently not executing on this
repo at all — the run-wide known issue). Verification is STRUCTURAL, not
parse-only (R1-F3: a bare parse is blind to the realistic bug class —
mis-nested `paths:`, a typoed key, a list attached to the wrong event):
a Python `yaml.safe_load` assertion that reads the trigger map under the
YAML-1.1 `True` key (`on:` parses as boolean), asserts the six managed
files plus the kept `skills/**` and `scripts/sync-marketplace.mjs` are a
subset of the sync workflow's `push.paths`, and asserts
`push.branches == ['main']` on validate. The workflows' first real
execution remains gated on the operator fixing the repo's Actions
enablement.

## Debate record

- R1 (3×P2 + 2 minor; central token-mechanics claims confirmed): F1 AC3
  OR-branch unachievable → deviation ratified on #29 with the in-run sync
  --check and determinism argument; F2 "serializes" misdescribed cancel-in-progress →
  supersede-latest semantics stated as deliberate; F3 parse-only check
  blind to the real bug class → structural assertions (True-key aware);
  F4 no-trigger/no-loop confirmed + idempotence addendum; F5/F6 file list
  and push-cleanliness verified; F7 red-then-heal alarm shape recorded.
- R2: F2/F3/F7 resolved; F1 resolved at contract level with the Design
  section lagging (fourth bullet) + one scope qualifier — both applied in
  place per the verdict's "with those two edits, no remaining findings".
  Clean. Implementation starts here.
