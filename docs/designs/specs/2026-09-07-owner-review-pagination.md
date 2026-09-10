# Complete owner-approval review pagination

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

## Contract and scope

Issue #84 requires the owner-approval workflow to examine every review page before
accepting an approval. A current-head APPROVED review by an administrator may be
later than the first 30 chronological reviews. Old-head, dismissed, and non-admin
reviews remain insufficient. A failed page fetch must not accept earlier partial
output. Existing administrator-author exemption, review counts, and merge policy
remain unchanged; the separate identity policy belongs to issue #41.

This is a workflow control executed by GitHub Actions, with mechanically testable
shell behavior inside that execution. It does not establish that every merge path
uses this check or change repository protection settings.

## Decision

Keep the existing GitHub CLI endpoint and its exact --jq filter. Add --paginate
so the CLI retrieves every page sequentially and emits each page's qualifying
logins. The shell assignment completes before any approver permission check.
Wrap that assignment in an explicit failure conditional, emit a distinct Actions
error, and exit unsuccessfully if any page fails. Duplicate logins across pages
are harmless under the existing permission loop. No slurp, standalone jq,
checkout action, API helper, or new runtime is needed.

Primary references: the GitHub REST list-reviews documentation specifies
chronological ordering and a default page size of 30; the GitHub CLI api manual
specifies sequential pagination and separate arrays for page responses.

- [List pull-request reviews](https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request)
- [GitHub CLI API pagination](https://cli.github.com/manual/gh_api)

## Files and validation

Change only the review-fetch assignment in
.github/workflows/require-owner-approval.yml and add a dependency-free Node test
under scripts/. Bump the plugin cache version and synchronize manifests because
the PR adds a bundled test script.

The test extracts and executes the actual workflow run block under Bash, with a
disposable PATH containing a Node symlink and an injected gh stub. The stub models
the frozen existing --jq query, rejects unexpected queries, records page and
permission requests, and cannot resolve the real GitHub CLI. Synthetic fixtures
cover a qualifying approval after 30 comments; old-head, non-admin, and dismissed
reviews; and a qualifying first-page approval followed by a failed later page.
The latter must fail before consulting that approver's permission. Preserve a
fixture for the administrator-author exemption. POSIX-only execution has an
explicit Windows skip because the deployed workflow runs on Ubuntu.

The late-approval and partial-success fixtures must fail against the original
workflow before implementation. Run the focused test and static checks on staged
content, then commit and check the committed revision and its first CI result
before the sole Kimi K3 review. Run the native full suite on the final reviewed
revision. Review repair cycles are capped at two cumulatively.

## Risks and limits

The injected API boundary models the existing CLI selection, rather than calling
GitHub or submitting reviews. Its exact-query assertion keeps a future filter
change visible. GitHub's paginated endpoint is not an atomic review-history
snapshot; this issue adds complete traversal and does not change event or race
policy. Fetch failures exit before evaluation even if earlier pages printed a
qualifying login. Permission failures retain the existing non-admin behavior.
