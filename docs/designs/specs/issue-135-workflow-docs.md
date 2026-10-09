# Standalone review scope and tracked link validation

## Frozen contract

Issue #135 removes conflicting instructions that turn a requested standalone
review into a full AFK waterfall, and excludes ignored runtime evidence from
repository link checks. Standalone invocations run only the requested independent
reviewer and return its verdict. Ordered roles and internal-before-external
sequencing remain doctrine for driver-managed AFK runs.

Link checks inspect tracked Markdown working-tree content across the repository,
including tracked local edits. Ignored/untracked scratch content is outside that
inventory. A tracked broken link still fails; an unavailable inventory or required
file read never reports a clean result. Existing link syntax and anchor handling
stay unchanged. No new configuration, model calls, runtime state or review gate
is introduced.

## Implementation

Qualify full-waterfall introductions in review satellites as driver-managed AFK
only, and route standalone behavior to the canonical external-review reference.
Keep reviewer independence and existing requested-gate stop behavior. Replace
remaining duplicate plugin-root selection prose in external-review and GLM with
the environment reference; this also closes the minor documentation drift noted
in issue #133 without expanding its code repair.

Replace recursive filesystem Markdown discovery in check-links with checked Git
root discovery and NUL-delimited tracked inventory from that root. Deduplicate
tracked paths, select Markdown case-insensitively, and read their current bytes.
Validate regular source files and reject symlink traversal, including parent
directories, so changing inventory does not start reading outside the repository.
Missing/unsafe source files, invalid UTF-8, non-repositories and Git failures are
explicit errors; the CLI reports an inventory/read diagnostic and exits nonzero.
An empty tracked Markdown inventory is valid and reports its reason. Keep the
existing relative/root-relative link existence checks and external-link skips.
This helper checks artifacts only when invoked; workflow prose does not make a
host obey the review sequence.

## Validation and release

Use disposable real Git repositories and a linked worktree. Preserve current
link-form cases, then verify ignored AFK and unrelated untracked Markdown are
excluded, tracked edits and root/nested invocation share the same inventory,
tracked broken links still fail, unusual whitespace/newlines in filenames stay
intact, and missing or unsafe tracked sources cannot produce a clean result.
Check inventory failures with a non-repository/missing root; exercise the CLI
nonzero diagnostic with a disposable copy inside a fixture. Routing tests cover
all six review satellites and the canonical standalone/driver distinction.

Run focused tests, configured checks and final full tests.
Owner review and configured external roles remain the merge boundary. Bump canonical
marketplace version to 1.2.0 and regenerate mirrors. Writes are limited to review
satellite instructions and canonical references, link-check tooling and focused
tests, this design and release metadata. Leave the reviewed PR open.
