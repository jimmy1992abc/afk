# Branch protection

The owner applies this ruleset to `main` in repository settings; it is the
primary enforcement of owner-only review. The `require-owner-approval` workflow
is defense in depth beside it, not a replacement.

## `main` ruleset (applied)

- **Require a pull request before merging** — no direct pushes to `main`.
  - Native required approvals: **0**. A solo owner cannot approve their own PR,
    so a non-zero native count would deadlock every owner-authored PR. Owner
    review is enforced by the `gate` status check instead (see below), and
    `CODEOWNERS` still routes review requests to the owner.
  - Dismiss stale approvals when new commits are pushed.
- **Require status checks to pass**, branches up to date (strict):
  - `checks` — the `validate` suite.
  - `gate` — `require-owner-approval`; red until an owner/maintainer approval
    lands on the current head commit, and green automatically for
    owner-authored PRs.
- **Enforce for administrators** — no bypass.
- **Require conversation resolution** before merging.
- **Require linear history** (squash-merge only; merge commits and rebase are
  disabled in repository settings).
- **Block force pushes** and **branch deletion** (applies to everyone).

## Why the extra workflow

Some of the above are settings-only and cannot be expressed in-repo. The
`require-owner-approval` workflow fails any PR that lacks an owner/maintainer
approval (unless an owner/maintainer authored it), so the guarantee travels with
the repository even if a setting is later relaxed.
