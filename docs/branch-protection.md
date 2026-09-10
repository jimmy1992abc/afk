# Branch protection

Required GitHub controls make the documented PR path apply to repository updates.
Owner review remains workflow doctrine; the current `gate` accepts an admin-authored
PR automatically and therefore does not establish that a human reviewed it.
The separate admin-author identity policy is outside this settings change.

## Intended main controls

The repository ruleset for `refs/heads/main` is active with no bypass actors:

- Require a pull request, with zero native required approvals, stale-review
  dismissal and resolved review conversations. Zero preserves the existing
  admin-author policy without making owners approve their own PRs.
- Require `checks` and `gate` from GitHub Actions, with strict up-to-date checks.
- Require linear history; prohibit force pushes and branch deletion.
- Allow squash merging only, both in the PR rule and repository settings.

These controls constrain updates while the settings remain active. Administrators
can change settings; neither this document nor a workflow guarantees otherwise.
`gate` applies its existing admin-permission/current-head approval policy, with
its admin-author exemption. `CODEOWNERS` routes requests but is not proof of review.

## Read-only drift audit

Run from an authenticated GitHub CLI environment with permission to read ruleset
bypass settings:

```bash
node scripts/audit-branch-protection.mjs OWNER/REPO
```

`COMPLIANT` exits 0, verified `DRIFT` exits 1, and `UNVERIFIABLE` exits 2 for API
failures or incomplete evidence. The command reads repository merge methods,
main's protection flag, all pages of effective main rules and repository ruleset
details. It expects one complete active repository ruleset with no bypass;
it does not infer compliance from a failed lookup or compose organization policy.
It never changes settings. This is a point-in-time audit, not a required CI gate.

## Observation and transition

The 2026-09-07 preparation audit observed no effective main rules, an unprotected
main branch, and merge/rebase/squash all enabled. That evidence supersedes the
previous unsupported “applied” description. Live application requires an API
receipt; run the audit to establish current state rather than treating this
historical observation as current compliance.

The legacy sync workflow pushes manifest repairs directly to main, so disable it
and verify its disabled state before activating the ruleset. Keep it disabled
until the reviewed read-only workflow has reached main, then re-enable it.
Record any partial application as incomplete and verify each setting before
claiming completion; do not grant the workflow a bypass to restore its writes.

The replacement workflow checks consistency with read-only permissions. Authors
run `node scripts/sync-marketplace.mjs` locally and submit generated changes in
the same reviewed topic PR, so manifest repair follows the protected path.

GitHub documents the [effective rules and ruleset APIs](https://docs.github.com/en/rest/repos/rules)
and [workflow disable/enable APIs](https://docs.github.com/en/rest/actions/workflows).
