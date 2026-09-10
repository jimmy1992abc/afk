# Fold glm-gate onto the shared snapshot lifecycle

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#26 (from the #19 audit; depends on #25's direction
table, merged). The one HTTP wrapper outside `runOpenAiSnapshotGate` drifted
on exactly the verdict-safety checks the lifecycle centralizes — the
lifecycle's own header says why this fold exists.

## Frozen issue contract

Acceptance criteria:

1. An Anthropic-protocol provider lands in `lib/http/anthropic-provider.mjs`
   and `glm-gate.mjs` becomes a thin config over `runOpenAiSnapshotGate`
   (mirroring `deepseek-gate.mjs`), preserving: endpoint default
   `https://api.z.ai/api/anthropic`, key order `ZAI_API_KEY` → `GLM_API_KEY`,
   `GLM_REVIEW_MODEL` default `glm-5.2` (passes `isVersionedModelId`),
   `GLM_REVIEW_BASE_URL`, `GLM_REVIEW_MAX_CTX_BYTES`, `GLM_REVIEW_GATE=off`,
   `GLM_REVIEW_TIMEOUT_MS`/`AFK_REVIEW_TIMEOUT_MS` semantics, `--print-args`
   / `--print-prompt`, design mode, and snapshot notes/redaction behavior.
2. Started-review failures follow the shared table (#25): 5xx / transport /
   non-JSON / empty completion / unsafe finish reason / timeout are `ERROR`;
   auth and rate-limit and model-unavailable are `SKIPPED` with the table's
   named classes (404 dual-suspect message). Truncated completions
   (`stop_reason` ≠ end_turn, e.g. `max_tokens`) are discarded as `ERROR`;
   reported-model lineage is enforced (`sameVersionedModelLineage`).
3. No transport-skeleton duplication: the abort/timeout/fetch/classified-
   failure scaffolding is shared between the OpenAI and Anthropic providers
   (extracted, not copied); `openai-provider`'s observable behavior is
   unchanged and stays pinned by its existing tests.
4. `glm-gate.test.mjs` is reconciled precisely (R1-F4 corrected the
   inventory): the HTTP-500 pin flips (exit 0→nonzero, SKIPPED→ERROR, and
   the "Z.ai" label string is gone — output label is GLM); the timeout pin
   keeps its direction but loosens its message regex to `/timed out/i`
   (lifecycle wording, deepseek precedent); the success-path no-echo pin is
   rewritten onto an Anthropic-shaped fixture carrying `model`,
   `stop_reason: end_turn`, and `content` text blocks (its old OpenAI-shaped
   fixture exercised the retired branch and is impossible post-fold);
   non-JSON and empty-completion get their FIRST tests (ERROR — the old
   behaviors were untested skips); disabled/design/print/plugin-surface pins
   keep unchanged. glm joins exactly the http-gates 429-skip and
   404-dual-suspect loop (the per-family env ternaries become a small
   table: ZAI_API_KEY / GLM_REVIEW_BASE_URL / GLM_REVIEW_MODEL — plus a
   glm 401-auth skip case naming ZAI_API_KEY, R2-N2), NOT the
   OpenAI-shaped CASES loop (R1-F5: its header/body asserts are
   protocol-specific); a glm-specific request-shape test pins URL
   `…/v1/messages`, the three headers, top-level `system`, `max_tokens`,
   `temperature: 0.2`, and the `GLM_REVIEW_MAX_OUTPUT_TOKENS` →
   `body.max_tokens` override.
5. Doctrine follows in the same PR (the #25 promise): `skills/afk/SKILL.md`
   "GLM transient `SKIPPED` and other gates' transient nonzero `ERROR` get
   one sticky retry…" becomes "Transient nonzero `ERROR` gets one sticky
   retry…" (verified in debate: no test pins "GLM transient"; the
   stable-unavailable pin region is untouched; #25's scoped clause already
   captures every post-fold GLM skip, and the generic `is unavailable
   (code)` line is unreachable for glm). `afk-glm-review/SKILL.md` replaces
   its now-false "`SKIPPED: …` (no key, auth failure, HTTP error, …)" line
   with the deepseek-template skip/error split, gains
   `GLM_REVIEW_MAX_OUTPUT_TOKENS` (lifecycle knob, default 8192 — the old
   hardcoded max_tokens), `GLM_REVIEW_EXCLUDE_GLOBS`, and the
   `--print-args`/`--print-prompt` mentions (R1-F7), plus a migration
   sentence (R1-F1): the base URL must be an Anthropic-protocol endpoint —
   the OpenAI-compatible Z.ai URL is no longer auto-detected. The README
   GLM/ZAI block carries the same sentence.
6. Version bumped 0.4.9 → 0.4.10 (lib/ + skills/ ship) with manifests
   synced.

Engineering invariants: fail direction per the #25 table (unknown → error);
no silent skips; no duplicated transport or threshold; superseded glm code
overwritten in place (no wrapper shims left).

Allowed behavior changes (enumerated — R1-F9): the AC 2 direction flips;
the OpenAI-compatibility branch retirement (an operator on the
OpenAI-shaped Z.ai URL now 404s into the dual-suspect model_unavailable
SKIP naming GLM_REVIEW_BASE_URL — mitigated by the AC 5 migration
sentence, R1-F1); generic non-auth 4xx SKIP→ERROR (http_error); ordering —
a missing key now skips before the snapshot builds (lifecycle order,
already pinned by http-gates); `--print-args` with an unversioned model now
errors before printing (lifecycle model check); cosmetic — the POST log
loses `mode=`, and the timeout ERROR carries the lifecycle's generic
wording without the old "Raise GLM_REVIEW_TIMEOUT_MS" hint (accepted:
deepseek/mimo already live with it).

Non-goals: prompt/snapshot content changes; marker protocol (#28); other
gates' configs; temperature — the old 0.2 is carried by the Anthropic
provider config, not generalized.

## Design

- `lib/http/transport.mjs` (new): `postClassifiedJson({ name, url, headers,
  body, httpTimeoutMs, fail, fetchImpl, credential })` — the
  abort/timeout/fetch + `httpFailureCode`/`timeout`/`transport`/`bad_json`
  classification skeleton extracted verbatim from `openai-provider`,
  including the credential-redacting `transportDetail` (R1-F2: the
  transport-diagnostics-cannot-echo-the-credential pin requires the key in
  the signature); both providers consume it, and `openai-provider`'s
  observable behavior stays pinned unchanged.
- `lib/http/anthropic-provider.mjs` (new): `makeAnthropicProvider(cfg)` with
  the same provider contract (`hasKey`/`available`/`complete` →
  `{ text, usage, reportedModel, finishReason }`): URL `${base}/v1/messages`;
  headers `x-api-key` + `anthropic-version: 2023-06-01` + `Authorization:
  Bearer` (Z.ai accepts either — both kept, matching today); body `{ model,
  max_tokens, temperature: 0.2, system, messages: [user] }`; response text =
  join of `content[]` blocks with `type === 'text'`; `finishReason` maps `end_turn` → `stop`
  (the lifecycle's clean value), anything else passes through raw so the
  lifecycle's unsafe-finish error names it (`max_tokens` truncation
  included); `reportedModel` = `json.model`; usage from
  `input_tokens`/`output_tokens`/`cache_read_input_tokens`.
- `skills/afk-glm-review/glm-gate.mjs`: thin config (family glm, label GLM,
  slug glm-gate, keyEnvs, model/baseUrl/ctx/output/exclude envs, provider).
  The ~200-line wrapper is deleted in place.
- Tests: exactly per AC 4 — glm-gate.test.mjs reconciled per the inventory;
  glm joins only the 429/404 skip loop in http-gates (env ternaries →
  table; the server harness answers any path, so `/v1/messages` lands on
  the same stub) plus the glm-specific request-shape test; an
  anthropic-provider unit test covers the response parsing (text-block
  filter, stop_reason mapping, usage) with injected fetch.

## Test plan

Per AC 4 plus: openai-provider behavior pinned unchanged by its existing
tests after the transport extraction; `--print-args` shape for glm now
includes `maxTokens` (lifecycle shape — glm's old shape lacked it; pinned);
an anthropic-provider unit test covers text-block filtering, stop_reason
mapping, and the rest of the provider contract. **Recorded live smoke before
merge (R1-F3):** the fold makes `json.model` and `stop_reason` load-bearing
(lineage + finish checks) and Z.ai's live values are unverified — run the
folded gate once against the real endpoint (`--commit HEAD`), record the
observed `model`/`stop_reason` in the ledger; if the key is unavailable,
record the assumption and its wrong-side outcome (every live review would
ERROR) explicitly. Full suite green by exit code.

## Debate record

- R1 (no P1): F1 (P2) compat-branch retirement strands an OpenAI-shaped
  base URL → migration sentence in SKILL + README, dual-suspect skip
  mitigates. F2 (P2) extracted transport signature lacked the credential —
  an existing no-echo pin proves it → signature fixed. F3 (P2, unverified)
  live Z.ai model/stop_reason values now load-bearing → recorded live smoke
  in test plan. F4 (P2) test inventory corrected (only 500 had a direction
  pin; success fixture impossible post-fold; non-JSON/empty get first
  tests). F5 (P2) parity fit narrowed to the 429/404 loop + glm-specific
  request-shape test. F6 exact doctrine sentences verified with pin-safety.
  F7 knob docs completed. F8 text-filter kept. F9 behavior-change list made
  exhaustive. Refuted/clean: stop_sequence false-ERROR, json-vs-text parse,
  SNAPSHOT_NOTE parity, credential order, versioned model id, timeout envs,
  fetchImpl injection.
- R2: F1-F9 resolved by name — clean round (two editorial nits and an
  optional 401 case applied in place, sanctioned by the verdict).
  Implementation starts here.
