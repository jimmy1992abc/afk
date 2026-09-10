# Bounded raw Git review collection

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

## Frozen contract

Issue83 requires actual source patches despite configured external diff or
textconv, across branch/commit/uncommitted targets and relay collection. Every
shared Git command has a bounded wait and unavailable content never becomes a
successful empty diff. Probe/content distinctions and literal path behavior
remain. Existing local Git configuration can run a helper; this is not a claim
of unconditional execution from repository content. No general configuration
manager, process service or provider change is added.

## Approach and boundary

Export one RAW_DIFF_FLAGS constant from lib/gate/git.mjs containing
--no-ext-diff and --no-textconv. Spread it explicitly into review diff/show/
diff-tree command arrays in target.mjs, approvedPatch in snapshot.mjs and the
relay inventory/approved patch calls. Metadata diff calls use the same raw flags
so configured helpers cannot replace intermediate inventory or summaries.
Blob-object reads retain their raw-content semantics. Existing target refs,
rename/copy selection, literal pathspecs and no-unrestricted-patch rule remain.
Git's documented flags suppress external diff and text conversion for the
invocations that carry them; no setting is edited.

Export the existing spawn boundary as runGit and route git, gitTry and hasRef
through it. One GIT_COMMAND_TIMEOUT_MS constant is30000; set spawnSync timeout
and killSignal SIGKILL on each routed command. Preserve existing encoding,
working directory and buffer caps. The runner exposes an injected spawnImpl seam
for tests; the production timeout is fixed, without a new environment knob.
Relay defaultRun reuses runGit only for Git, preserving its existing64MiB cap;
other gathering commands keep their current behavior.

gitTry sets okfalse for spawn errors, timeouts, signals or nonzero exits and
reports a distinct timeout/spawn/exit reason when stderr is absent. Existing
content consumers already refuse on okfalse. git and hasRef remain probe forms
that return empty/false on failure, as documented; they gain the same bound.
The raw runner still returns the spawn result so relay retains its status/error
shape and emits its existing distinct unavailable-collection notes. This does
not promise to kill an arbitrary descendant process tree or impose one overall
budget across many commands; each Git process is bounded when invoked here.

## Files and validation

Edit lib/gate/git.mjs, target.mjs, snapshot.mjs and relay gather.mjs; add focused
Git fixture tests and adjust exact-argv tests only where new raw flags belong.
Bump0.8.15 and synchronize manifests. No dependency or new CLI is required.

Tests first configure an executable diff.external fixture and a textconv driver
for a changed ordinary file. Each writes a sentinel and emits replacement text;
collection must retain actual source changes and leave the sentinel absent for
branch, commit and uncommitted targets, approved snapshots and relay. Synthetic
repositories preserve target/path tests and no paid reviewer is called.

For the timeout, inject a spawn adapter that verifies the production timeout and
kill signal, then launches a real stalled Node fixture with a shortened bound
at the test boundary. Assert prompt return and a classified content failure,
plus unchanged probe behavior. This avoids a30second unit stall and global PATH
mutation while exercising the actual spawnSync timeout mechanism. Existing
failed-content and empty-success tests remain distinct.

Run affected Git/snapshot/relay tests, tracked provenance and all static/version
checks, initial internal review and sole Kimi K3. Final native suite and CI
must identify the same clean reviewed SHA. Leave the stacked PR open for owner
review. Two cumulative review-driven fix cycles apply.

## Evidence and limits

Git documents --no-ext-diff and --no-textconv at
[git-diff documentation](https://git-scm.com/docs/git-diff). The new raw-collection fixture proves behavior
against installed Git, rather than treating flags alone as evidence. Each
helper's invoked command handling is level2; requiring the review in a workflow
remains level3 doctrine. The existing dependency stack supplies honest snapshot
coverage and explicit verdict validation; this issue adds only raw/bounded Git
collection and does not reopen those reviewed contracts without new evidence.
