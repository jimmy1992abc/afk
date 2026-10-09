# Unversioned provider model IDs (DeepSeek allow-list)

Status: frozen for implementation (2026-09-26). Operator-approved scope; no
tracker issue.

## Problem

The REST snapshot gates refuse any `*_REVIEW_MODEL` without a digit
(`isVersionedModelId`) before the call, and the post-call identity check and the
receipt validator reuse the same rule (`sameVersionedModelLineage`). The rule
was inherited from the Claude gate, where the CLI host resolves aliases such as
`opus` on its own schedule.

DeepSeek now names its current model `deepseek-flash` with no version
([API docs](https://api-docs.deepseek.com/)). The request `model` enum is
`deepseek-flash` and `deepseek-v4-pro`. The docs also note that the retired
`deepseek-v4-flash` is still accepted and served by DeepSeek-V4.1-Flash. So the
digit rule refuses the provider's official current ID. It still accepts a
retired name that the provider reroutes. Several users reported the refusal.

## Frozen issue contract

Acceptance criteria:

1. `lib/gate/model-identity.mjs` owns one allow-list,
   `UNVERSIONED_MODEL_FAMILIES`, containing only `deepseek`.
2. For an allow-listed family, a model ID without a digit is accepted when it is
   a single provider token (`[a-z][a-z0-9._-]*`) that is neither the bare family
   name nor ends in `latest`, `default` or `auto`. `DEEPSEEK_REVIEW_MODEL=deepseek-flash`
   reaches the provider. `deepseek` and `deepseek-latest` are still refused
   before any request.
3. For every other family, the pre-call rule is unchanged: a digit is required.
   GLM and MiMo behavior and messages are unchanged in substance.
4. The post-call check still requires the response `model` to equal the
   requested ID or to extend it with a dated/numeric suffix. `deepseek-flash`
   reported for a `deepseek-flash` request verifies. Anything else discards the
   verdict as today.
5. Receipt validation (`validateModel`) applies the same family-aware rule, so a
   `verified` DeepSeek `deepseek-flash` receipt is consistent. The same receipt
   under the `glm` or `mimo` family stays a conflict.
6. The OpenAI-protocol provider returns the response `system_fingerprint` when
   present. The snapshot gate records it in the receipt model observation as
   `fingerprint` (string or null). Receipts written before this change, which
   lack the key, remain valid.
7. The Claude gate (`isPinnedModelId`, `sameModelLineage`) is untouched.
8. The DeepSeek SKILL.md and the README say that `deepseek-flash` is usable and
   `deepseek-v4-flash` is retired. The receipt contract documents `fingerprint`.
9. The plugin version is bumped 1.2.2 → 1.2.3 through the existing sync.

Invariants: no request is sent for a refused ID; identity mismatch remains a
non-zero `ERROR`; no credential appears in any new output; the default model
stays `deepseek-v4-pro`.

Allowed user-visible changes: DeepSeek accepts unversioned exact IDs; the
DeepSeek refusal message names the floating-alias rule; receipts carry
`fingerprint`.

Non-goals: changing defaults; allow-listing GLM/MiMo/Kimi/Codex; refusing
retired DeepSeek names (the provider decides what it accepts); requalifying
direction audits (operator decision D-1 below); agent-relay model handling.

## Approach

The allow-list is keyed by family rather than by model name, so a future
unversioned DeepSeek name needs no afk release. A new provider that ships
unversioned names is a deliberate one-line addition. Two family-aware helpers
replace the digit-only pair:

- `isAcceptedModelId(family, id)`: versioned, or allow-listed and not floating.
- `sameReportedModelLineage(family, reported, requested)`: the existing
  exact-or-dated-suffix comparison, gated by `isAcceptedModelId` instead of the
  digit rule.

`openai-snapshot-gate.mjs` and `review-receipt.mjs` call these with the gate's
family. The fingerprint is recorded as evidence only. It is never compared,
because the provider documents it as a backend configuration that varies across
requests.

Rejected alternatives: allow-listing individual model names needs an afk release
each time a provider renames a model. A `*_ALLOW_UNVERSIONED` switch adds a
setting that users only discover after the refusal. Dropping the rule for all
REST gates is wider than the demonstrated need.

## Files to change

| Path | Change | Reason |
| --- | --- | --- |
| `lib/gate/model-identity.mjs` | edit | allow-list and the two family-aware helpers |
| `lib/gate/openai-snapshot-gate.mjs` | edit | pre/post-call checks, fingerprint capture |
| `lib/http/openai-provider.mjs` | edit | return `systemFingerprint` |
| `lib/gate/review-receipt.mjs` | edit | family-aware verified match; optional `fingerprint` |
| `lib/gate/gate.test.mjs`, `scripts/http-gates.test.mjs`, `lib/gate/review-receipt.test.mjs`, `lib/http/openai-provider.test.mjs` | edit | criteria 2–6 |
| `skills/afk-deepseek-review/SKILL.md`, `README.md`, `docs/designs/specs/issue-97-review-receipts.md` | edit | criterion 8 |
| `package.json` and the synced manifests | edit | criterion 9 (`npm run sync`) |

## Risks

| Risk | Mitigation |
| --- | --- |
| An allow-listed provider silently reroutes an unversioned name | Same exposure as a versioned name that the provider reroutes (`deepseek-v4-pro` → V4-Pro-0813). The response echo check and the recorded fingerprint are the available evidence. |
| Receipt schema drift breaks old receipts | `fingerprint` is optional in the validator; there is a legacy-shape test. |
| D-1: `lib/direction/qualification.json` binds digests of `model-identity.mjs`, `review-receipt.mjs` and `openai-provider.mjs` | Operator decision: ship without requalifying. Opt-in direction audits report `qualification_stale` until someone runs `scripts/qualify-direction-transport.mjs` again. The README states this. |

## Test plan

- Unit: accepted/refused IDs per family, lineage per family, and the old digit
  semantics for GLM/MiMo.
- Gate: DeepSeek `deepseek-flash` against a local server returns APPROVE with
  exit 0. `deepseek-latest` is refused before any request. GLM/MiMo unversioned
  IDs are still refused (the existing loop).
- Receipt: a DeepSeek `deepseek-flash` verified receipt validates, with the
  fingerprint recorded. A legacy four-key model validates. The same unversioned
  verified model under `mimo` is a conflict.
- Full `npm test` once on the final commit.
