# Complete required snapshot coverage

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

## Frozen contract and scope

Issue81 requires honest changed-content coverage, including omitted deletions,
later files, partial hunks and mixed rendered/unrenderable changes. The three
shared HTTP providers must reject incomplete required content before accepting a
review. Intentional sensitive/unsafe exclusions and optional unchanged reference
omissions remain distinct. No batching framework, provider or service is added.

## Approach

Replace the current60percent diff allocation and prefix truncation with one
complete required payload: the approved redacted patch and all selected changed
file blocks. No partial patch or partial changed block earns coverage. A required
payload that exceeds maxBytes returns an actionable error naming the byte budget
and configuration variable, suggesting a narrower target or raised budget.
A changed entry that cannot render (binary/large/missing) also returns an error.
On either refusal payload is empty, changedFiles is empty, hasChanges false,
unreviewable true, and omittedChangedPaths contains every approved nonexcluded
endpoint because no changed bytes will be sent. Separate unrenderableChangedPaths
identifies actual rendering limitations. Excluded entries remain in excludedPaths
and excludedCount; optional references are not misclassified as missing changes.

Use reviewable entries after existing loaded.excluded handling for required
paths. Existing intentional unsafe-path policy remains; do not weaken confinement
or reclassify its safety refusals as available content. Ordinary loaded errors
already fail closed; retain their actionable error. Text deletion content is required
in the complete patch and needs no current file block. A standalone Git binary
diff marker (including a binary patch encoding) means required content was not
rendered as reviewable text, even when current-side loading succeeds or a deleted
entry has no current file. Refuse that entire target with a distinct binary-patch
reason and all required endpoints in omittedChangedPaths; do not infer a precise
binary path from Git quoted headers. Current-side unrenderableChangedPaths
remains the exact loading-failure list, separate from this whole-patch reason. Safe rename/copy entries
remain the existing patch representation; changedFiles reports entry destinations
whose complete patch/content was emitted. The missing-path report may include
both endpoints because either may contain required removed/source content.

Construct and measure required payload before optional reference discovery or
loading. If complete, discover the same bounded exact references and append only
whole reference blocks that fit the remaining bytes; include their heading only
when at least one fits. Preserve budgetOmittedReferencedPaths, unavailable and
excluded reference diagnostics. On success omittedChangedPaths and
unrenderableChangedPaths are empty, unreviewable false, and changedFiles is the
actual complete required coverage. An unchanged or intentionally excluded-only
target remains a benign no-change snapshot.

## Causal boundary and validation

Edit lib/gate/snapshot.mjs and its tests; shared lifecycle error handling already
exits nonzero before HTTP calls and needs no new control path. Add tests in the
existing HTTP fixture harness for GLM, DeepSeek and MiMo with synthetic credentials
and loopback provider server: incomplete snapshot yields ERROR/nonzero and zero
requests, while optional-reference omission still accepts a valid response.
Snapshot regressions reproduce the15000line edit plus later deletion at160000,
a later modified file, a partial hunk, mixed unrenderable change, mixed deleted-binary plus safe edit,
old-binary to current-text transition, and sufficient
budget success. Adjust tests that previously expected partial success. Existing
exclusion/confined-read/reference tests remain. Bump0.8.13 and sync manifests.

Run affected snapshot/HTTP tests, tracked-file provenance and all static/version
checks. Initial self/internal review precedes sole Kimi K3; final native suite
and CI must identify the same clean reviewed revision. Leave the stacked PR open
for owner review. Two cumulative review-driven fix cycles apply; no extra clean
sweeps or speculative hardening.

## Risk and enforcement level

A complete patch plus selected full contents can reject targets that previously
fit only by truncation; this deliberate availability tradeoff supplies a bounded,
actionable refusal rather than false coverage. Raising maxBytes cannot bypass
existing per-file loading limits; those errors should request a narrower,
renderable target or a tool-capable reviewer instead. Level2: the shared invoked
helper refuses incomplete payloads; level3: running the helper and respecting its
result remain driver doctrine. No claim of whole-workflow enforcement is made.

## Accepted design finding

I81-D01 exposed a complete but nontextual binary deletion patch: Git emits only
a binary marker, so byte completeness alone cannot prove reviewable content.
Cycle1 adds the binary-patch refusal criterion above and its regression; no old
blob loader or header-based path parser is needed. Allowance consumed1/2.
