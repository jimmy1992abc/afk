# Deterministic Claude gate fixtures

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

## Frozen issue contract

Issue #85 requires envelope stubs to consume stdin before emitting their result
or terminating. Ordinary review fixtures must have a small, deterministic diff
independent of the plugin checkout's commit size and merge history. Success must
work with small and larger-than-pipe-buffer input; nonzero and POSIX signal
outcomes must remain distinct after input delivery. Fixture tests spend no model
calls, and genuine platform skips stay explicit.

The causal boundary is `scripts/claude-gate.test.mjs`. Production transport,
child-outcome validation, reviewer selection, and other gate suites are unchanged.
No user-visible behavior changes are intended. No diagnostic refactor is needed.

## Approach and evidence

The current `withStub` writes and exits without reading stdin; `runGate` reviews
`nonMergeHead()` from the plugin checkout. Issue evidence reports EPIPE under
large stdin on macOS / Node 24.18.0 and a clean focused suite after draining the
stub. The local environment also runs Node 24.18.0.

Use a test-lifetime temporary repository with two fixed commits and a local
`origin/main` tracking ref so ordinary commit and branch-resolution checks retain
their intended targets. Fail loudly if fixture Git setup fails, and remove it
with the test runner's teardown hook. Existing specialized repositories stay
local to their tests because their unusual working-tree state is the assertion.

Read stdin to EOF before emitting an envelope. Preserve the requested exit code
or signal after stdout is flushed. Capture received input in the stub directory
so regression tests can compare it with the gate's printed prompt; this makes
complete delivery observable even if a platform's pipe can buffer the payload.
Use a large disposable design document for explicit transport cases because its
size does not depend on history or the production diff budget.

## Execution surface

| Path | Access | Reason |
| --- | --- | --- |
| `scripts/claude-gate.test.mjs` | Write | Owns the failing fixture and regression coverage. |
| This design | Write | Preserves the bounded contract and validation rationale. |
| `.claude-plugin/marketplace.json` | Write | Version 0.8.9 invalidates the install cache. |
| `scripts/sync-marketplace.mjs` | Execute | Mirrors the authoritative version into manifests. |
| Production gate and shared libraries | Read and execute | Existing behavior is the regression oracle. |

Run `node scripts/sync-marketplace.mjs` after updating the marketplace version;
it reads that marketplace and `skills/`, and may update the marketplace,
`.github/plugin/marketplace.json`, `.agents/plugins/marketplace.json`,
`.codex-plugin/plugin.json`, `plugin.json`, and `package.json` when they differ.
Tests write only disposable fixture repositories, stubs, and gate output.

## Validation and risks

Add input-delivery assertions first and demonstrate failure with the original
stub. Then implement the drain and deterministic Git fixture. Run the Claude
suite with real-CLI integration tests excluded by explicit test-name filtering;
retain their source and platform skip conditions. Check large successful,
nonzero, and signal outcomes and exact delivered prompt bytes. Assert the small
fixture prompt contains its fixed change and fits a bounded size.

Run manifest, skill, link, provenance, Markdown, and version checks. The parent
runs the full suite once after the sole external Kimi gate on the final commit.

The main risk is replacing a history-dependent target with a fixture that no
longer reaches the intended gate branch; fixed-content and target-resolution
assertions cover that risk. POSIX signal coverage cannot establish Windows signal
semantics and retains its explicit skip. No external-system assumptions are
needed beyond the existing Node/Git APIs exercised by the tests.
