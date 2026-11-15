# Gemini review gate (issue #143)

## Spec review

Add an opt-in external review family `gemini`, backed by Gemini 4 Argon
(`gemini-4-argon`), through the same snapshot HTTP lifecycle as DeepSeek and
MiMo. `gemini` is already an implementer family (`lib/gate/implementer.mjs`),
so this change adds the reviewer side only.

## Frozen issue contract

1. `skills/afk-gemini-review/` ships `SKILL.md` and `gemini-gate.mjs`, built on
   `runOpenAiSnapshotGate` + `makeOpenAiProvider`; no new HTTP client.
2. Defaults: model `gemini-4-argon`; base URL
   `https://generativelanguage.googleapis.com/v1beta/openai`; `Authorization:
   Bearer`; `max_tokens`; `reasoning_effort: "high"`.
3. `GEMINI_REVIEW_REASONING_EFFORT` accepts only `minimal`, `low`, `medium`,
   `high`; any other non-empty value is an `ERROR` before a provider request.
   The resolved effort is recorded as the receipt's requested effort and shown
   by `--print-args`.
4. Controls: `GEMINI_REVIEW_GATE`, `GEMINI_REVIEW_API_KEY` (fallback
   `GEMINI_API_KEY`), `GEMINI_REVIEW_MODEL`, `GEMINI_REVIEW_BASE_URL`,
   `GEMINI_REVIEW_MAX_CTX_BYTES` (default 400000), `GEMINI_REVIEW_MAX_OUTPUT_TOKENS`
   (default 65536), `GEMINI_REVIEW_EXCLUDE_GLOBS`, `GEMINI_REVIEW_TIMEOUT_MS`
   (derived by the existing per-family rule).
5. `gemini` is a receipt family, a valid `gates:`/`priority:`/role-flag family in
   the driver doctrine, and a recognised gate skill in evaluation/routing.
   Built-in `gates: codex` and priority `codex > claude > kimi > glm` stay
   unchanged.
6. Same targets, markers, secret exclusion/redaction, failure directions,
   identity and finish-reason checks as the other snapshot HTTP gates.
7. Tests use local stub servers only. Version 1.3.7 → 1.4.0 with manifests
   synced.

Non-goals: native `generateContent`/`interactions` API, `@google/genai`, Vertex
auth, changing default role profiles, rewriting historical specs.

## Approach

The one shared change is an optional `reasoningEffort` descriptor on the
snapshot-gate config (`{ env, default, allowed }`). When present, the lifecycle
resolves it once, refuses an invalid value through the existing `emitError`
path, records it in the receipt selection and `--print-args`, and passes the
resolved value to the provider through `providerEnv`. Gates without the
descriptor (DeepSeek, MiMo) behave exactly as before: their selection still
records `effort: null` and their preview output is unchanged.

Alternative rejected: validating inside `buildExtraBody`. It runs after the
snapshot is built and outside the marker protocol, so a typo would surface as
an unclassified provider error instead of a pre-request `ERROR`.

`max_tokens` defaults to 65536 because Gemini counts thinking and visible
output against the same cap; the shared 8192 default would truncate a
high-effort review into `finish_reason: "length"`, which the gate discards.

## Files to change

| Path | Change | Reason |
| --- | --- | --- |
| `skills/afk-gemini-review/{SKILL.md,gemini-gate.mjs}` | add | gate |
| `lib/gate/openai-snapshot-gate.mjs` | edit | optional effort descriptor |
| `lib/gate/review-receipt.mjs` | edit | `gemini` receipt family |
| `lib/evaluation/{scenarios,native-control}.mjs` | edit | recognise the gate skill; keep the issue-112 campaign's frozen forms |
| `scripts/gate-test-env.mjs` | edit | scrub Gemini env in tests |
| `skills/afk/SKILL.md`, `skills/afk/references/*.md` | edit | family lists |
| `README.md`, `templates/afk-config.example.md` | edit | setup docs |
| tests under `scripts/` and `lib/gate/` | edit | parity + request shape |
| version manifests | generated | `npm run sync` after `package.json`/`plugin.json` bump |

## Repository correction found during implementation

`ADVERTISED_FORMS` served two consumers: the public skill registry (the routing
test requires every `skills/` directory to appear) and the frozen issue-112
evaluation campaign, whose control trials (37 forms, 180 controls, 252 rows)
are derived from it. Adding Gemini to the registry would have resized that
campaign. The fix splits the map: `CAMPAIGN_ADVERTISED_FORMS` keeps the 37
campaign forms and drives `ADVERTISED_CONTROLS`; `ADVERTISED_FORMS` extends it
with Gemini for routing. Campaign counts and identities are unchanged.

## Assumptions (unverified external behavior)

- **Response `model` field.** Google does not document what the OpenAI layer
  returns. The gate requires the existing lineage match; if Google returns a
  prefixed name such as `models/gemini-4-argon`, the verdict is discarded with
  an identity `ERROR` (fail closed), never accepted. No live key is available
  to confirm; no speculative prefix normalisation is added.
- **`finish_reason`.** Assumed `stop` on normal completion, as with other
  OpenAI-compatible providers; anything else is discarded.
- **Silently ignored parameters.** Google's OpenAI layer ignores unsupported
  parameters. If `reasoning_effort` were dropped, the model would run at its
  default `medium`; review still completes. Accepted risk.
- **`max_tokens`.** Vertex documents `max_tokens` as supported and
  `max_completion_tokens` as its alias.

## Test plan

Add `gemini` to the HTTP gate `CASES` and family loops: missing-credential
skip, request shape (URL `/chat/completions`, Bearer header, model,
`max_tokens` 65536, `reasoning_effort: "high"`), output override, unversioned
alias refusal, upstream-body non-echo, `length` discard, 401/429/404 skips,
design vocabulary, invalid verdicts, coverage budget. New: invalid effort is
an `ERROR` with zero requests; an override reaches the request body; the
`GEMINI_API_KEY` fallback is honoured. Receipt and routing tests include the
new family.

## Debate (one round, mechanical scope)

- *Should `GEMINI_API_KEY` be read?* It is Google's documented variable, so an
  operator who already has it set gets the gate without extra setup. That
  broadens which credentials the gate can pick up. The key reaches only
  Google's endpoint, and the review-specific name wins, so the fallback is kept.
- *Should the effort descriptor live in the provider instead?* No. Validation
  must happen before the snapshot request inside the marker protocol (see
  Approach).
