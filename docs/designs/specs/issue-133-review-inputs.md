# Repository-wide review inputs and upgrade consistency

## Frozen contract

Issue #133 prevents three sources of silently wrong review context. Uncommitted
review invoked below the worktree root must include all repository untracked
files with root-relative paths, and inventory failures must be explicit errors.
Configured tracker identity must not fall back to another forge or repository
when its config exists but cannot be read. A loaded plugin upgrade must reconcile
a stale recorded cache root before dispatching a bundled helper, while retaining
intentional custom roots and explicit environment precedence.

Keep existing default behavior for absent configuration and existing secret/path
boundaries. No new provider, external role, orchestration layer or configuration
key is needed. Owner review and configured external roles remain unchanged.

## Implementation

Move repository-wide untracked collection into `collectDiff`: resolve the current
worktree root with checked Git output, list there with NUL delimiters, and return
that root alongside the inventory. Keep tracked diff metadata repository-relative.
Use checked reads for the changed-file inventory so failures cannot become an
empty target. Remove snapshot's duplicate compensating listing and use the
collected root for current-worktree content. The uncommitted context digest uses
the same root and full inventory. Claude launches its uncommitted reviewer at
that root so root-relative new-file names also resolve through its read tools;
preview output exposes the effective review directory for hermetic verification.
Pin explicit relative CLI paths against the original invocation directory before
changing child cwd, so the caller-selected executable retains its identity.
The original cwd-change proposal omitted this requirement (D133-1); a fixture
with distinct root and nested executables must verify both the selected binary
and its root working directory. I133-1 extends the same identity boundary to
relative and empty POSIX PATH entries: normalize the child search path against
the invocation directory, with actual distinct-executable regressions for both.

Use the existing strict section reader for forge config. The relay reads the
forge fields once, passes that snapshot to `resolveForge`, and takes organization
and repository selectors from it. Direct `resolveForge` callers retain the
config-path interface and receive an explicit unreadable-configuration error.
A relay config error aborts gathering before any tracker CLI or model dispatch;
absent config still permits existing remote/default selection. No secret-bearing
config content or machine paths enter diagnostics.

Make the environment reference own first-dispatch reconciliation as well as init.
Resolve the loaded install independently from the recorded root, invoke its
existing `lib/plugin-root.mjs`, apply only its record/refresh decision to the
ignored consuming config, and report its reason. Then use environment override,
reconciled configured root, or loaded install in that order. Keep custom roots
on a keep decision. Route init and receipt-check instructions through this
canonical procedure, avoiding another copy of root-selection policy.
This routing is level 3 driver doctrine; helper decisions and target collection
are level 2 only when invoked. Do not claim automatic enforcement by the plugin.

## Validation and release

Tests first in real temporary Git repositories: root and nested invocation have
the same untracked inventory and digest; root-only and nested new files appear
in Claude's actual preview, and the reviewer launch directory is the root;
changes to any new file change the digest. Inject a failed inventory command to
prove explicit error handling. Retain snapshot and path-exclusion regressions.

Use directory/unreadable and malformed UTF-8 config fixtures to verify no tracker
CLI runs on unreliable config. Missing config and explicit cross-host selectors
retain their existing behavior. Existing plugin-root decision tests cover stale
same-install caches, missing recognized caches and custom-root preservation; add
focused instruction-route assertions for first-dispatch reconciliation and the
absence of competing receipt-resolution instructions. Such text assertions check
artifact consistency, not that a host follows prose.

Run targeted suites, repository lint/checks and the final full suite.
Owner review and configured external roles remain the merge boundary. Bump the canonical marketplace
version to 1.2.0 and regenerate mirrors. Writes are limited to the named shared
modules, direct gate/relay consumers, applicable instructions, their regression
tests, this design and generated release metadata. No live settings change is
required; leave the reviewed PR open.
