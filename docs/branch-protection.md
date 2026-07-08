# Branch protection

The owner applies this ruleset to `main` in repository settings; it is the
primary enforcement of owner-only review. The `require-owner-approval` workflow
is defense in depth beside it, not a replacement.

## `main` ruleset

- **Require a pull request before merging.**
  - Required approvals: **1**.
  - **Require review from Code Owners** (see [`.github/CODEOWNERS`](../.github/CODEOWNERS)).
  - Dismiss stale approvals when new commits are pushed.
- **Require status checks to pass**, and require branches to be up to date:
  - `validate / checks`
  - `require-owner-approval / gate`
- **Block force pushes** and **branch deletion**.
- **Require linear history** (squash-merge only; merge commits and rebase are
  disabled in repository settings).
- **Do not allow bypass** — the rules apply to admins too.

## Why the extra workflow

Some of the above are settings-only and cannot be expressed in-repo. The
`require-owner-approval` workflow fails any PR that lacks an owner/maintainer
approval (unless an owner/maintainer authored it), so the guarantee travels with
the repository even if a setting is later relaxed.
