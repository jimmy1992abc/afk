# Functional integration for 1.0.0

## Scope

Integrate the functional changes between the current 0.2.11 base
`735f5a1` and the parallel implementation at `1b6f77c`. Preserve this
repository's identity, owner approval, legacy configuration compatibility,
and explicit operator control over behavioral policy changes.

The release is 1.0.0. Model identifiers and pricing documentation use
official sources checked on 2026-09-10. Provider aliases are documented
only where their meaning and product surface are established.

## Contract

- Carry over optional DeepSeek and MiMo review gates, shared snapshot and HTTP
  infrastructure, CLI compatibility fixes, review context, review receipts,
  behavior evaluation tooling, forge support, and validation hardening.
- Preserve the canonical repository, marketplace owner, and CODEOWNERS.
- Preserve existing consuming configurations without rewriting their policy.
- Introduce no provider calls, subscriptions, remote protection changes, or
  publication as a side effect of installation or local verification.
- Record behavioral selections separately from mechanical integrations.
- Treat imported evaluation results as evidence for their recorded revision,
  never as measurements of this integration.

## Integration approach

Port the reviewed source snapshot with its boundary tests, then reconcile
repository identity and the selected policy. This retains coupled fixes
across shared helpers without replaying obsolete intermediate releases.
The comparison manifest records every upstream commit's disposition.

Code remains dependency-free Node ESM. Source and fixture reads are limited
to the selected repository and disposable test directories. Local verification
uses the repository's test and validation commands; publishing remains separate.

## Boundary review

| Invariant | Implementation | Verification |
| --- | --- | --- |
| Malformed targets cannot yield a review | `lib/gate/target.mjs` | Gate target and real Git fixture tests |
| A crashed child cannot yield approval | `lib/gate/child-outcome.mjs` | Child-outcome and CLI process fixtures |
| Required snapshot content is complete | `lib/gate/snapshot.mjs` | Full-patch, binary, exclusion, and byte-budget fixtures |
| Sensitive paths are excluded before content reads | `lib/gate/file-boundary.mjs`, relay gatherer | Path and diff exclusion fixtures |
| Credentials and marker lookalikes cannot masquerade as protocol | `lib/secret.mjs`, `lib/gate/protocol.mjs` | Secret-shape and protocol fixtures |
| Selected and observed model identity remain separate | `lib/gate/model-select.mjs`, receipt helper | Model selection and receipt fixtures |
| Review context is bound to the current target | `lib/gate/review-context.mjs` | Real-repository revision and proof fixtures |
| Receipt reuse checks an explicit candidate | `lib/gate/review-receipt.mjs` | Cross-role, stale-target, and corrupted-receipt fixtures |
| Forge configuration cannot silently select a different repository | `lib/forge.mjs` | GitHub/Azure remote and command fixtures |
| The installed version is consistent across manifests | `scripts/sync-marketplace.mjs` | Sync, version-bump, and identity checks |

## Timeline review

Targets resolve before provider invocation. Snapshot and review-context bytes
belong to that target. Receipt start/input artifacts precede execution; terminal
artifacts follow the actual outcome. Reuse compares the retained target,
profile, selection, and per-role context against an explicitly named candidate.
An imported report retains its original revision rather than borrowing the
new release's version as evidence.

## Verification

Run the pre-port suite, imported boundary tests, the complete final suite,
manifest synchronization, skill/frontmatter lint, internal links, provenance,
syntax, Markdown lint, and release-version checks. Run new parsers and
classifiers over all tracked inputs they apply to. Paid real-agent evaluations
remain opt-in; deterministic fixtures validate the evaluation harness itself.

These checks establish helper behavior when invoked. They do not establish
agent compliance with workflow prose or authorization to merge.
