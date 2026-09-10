# Per-run reviewer selection

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

## Frozen contract

Issue #44 adds explicit model and effort selection to Codex and Claude review
helpers. The operator-selected Codex default is GPT-5.6 Sol (PR #75), with
medium effort; Claude keeps claude-opus-5 and medium. Other providers and
transport boundaries remain unchanged.

- A shared `lib/gate/model-select.mjs` resolves each field independently from
  explicit `--model`/`--effort`, then environment, then defaults. It consumes
  both split and equals spellings, rejects duplicates and missing operands,
  and removes these helper flags before Codex receives its target arguments.
- Codex retains the existing last-wins `-c model=...` and
  `-c model_reasoning_effort=...` escape hatch. Resolve and validate these
  overrides too so diagnostics name the actual requested model and effort.
- CLI model aliases expand from closed tables: Codex terra, sol, astra;
  Claude opus, fable, sonnet, haiku. Full family-appropriate versioned IDs
  remain valid. Environment aliases do not expand; Claude's existing pinned
  identity check and response verification remain intact. Codex inheritance
  spellings remain supported, including its existing blank environment value.
- Explicit unknown models and efforts produce nonzero ERROR before any paid
  call, including with a disabled or self-declining gate. Override validation
  applies to the winning source, so an explicit correct value can repair a
  stale environment value.
- Current Codex effort choices are low, medium, high, xhigh, max; legacy minimal
  remains usable only outside GPT-5.6 and GPT-6 families. Ultra is a client
  delegation mode, not a backend reasoning effort selected by this helper.
  Claude accepts low, medium, high, xhigh, max, as its local help documents.
- The shared helper also resolves a token list directly following a selected
  role flag. Recognized model/effort tokens may arrive in either order. The
  first unrecognized token ends the qualifier list and is returned as prose;
  this does not guess whether an ordinary word was intended as a typo.
  Repeated qualifiers fail explicitly. Explicit helper flags resolve that
  ambiguity when an operator intends a particular value.
- A small direct CLI in the shared module exposes this qualifier resolver to
  the driver; handoff intent and role selection remain agent doctrine. The
  driver forwards its result as explicit helper flags and records model,
  effort, sources, and remaining prose before spending a call.
- `--print-args` reports resolved model and effort in both modes and gates.
  Qualifiers extend the existing per-role ledger entries. Changes invalidate
  the selected role and later roles whose ordering depends on it; earlier
  unchanged roles can retain their stamps on the same content revision.
  Code changes still invalidate all roles. Existing role/config profile hash
  rules remain, with selection receipts recorded separately alongside stamps.
- Qualifiers are bound to the preferred provider. On fallback, resolve the
  substitute's own environment/defaults and record the discarded selection;
  never translate another family's model or effort. Repeated role flags retain
  the first selection; a later conflicting qualifier is a driver error before
  paid work, while identical repetitions only reaffirm that selection.

## Scope and verification

Change the shared selection module, both helper consumers, their skill docs,
the driver's handoff/receipt doctrine, regression tests, and plugin manifests.
Version is 0.8.7 after PR #75's 0.8.6. No generated artifact requires an external
generator beyond `scripts/sync-marketplace.mjs`; it writes the agent manifests
and package version from the Claude marketplace.

Tests cover independent precedence, aliases and explicit IDs, duplicate and
missing options, environment compatibility, raw Codex overrides, inheritance,
handoff prose boundaries, both design/diff argv paths, diagnostics, and error
markers. Existing Claude identity tests and all gate tests remain the security
regression boundary. Run full local checks after the independent external gate.

## Evidence and limits

Codex CLI 0.153.4 accepts model/config flags, and a read-only GPT-6 Astra call at
medium effort completed successfully. The account model catalog lists low,
medium, high, xhigh, max and client ultra. Claude help lists low, medium, high,
xhigh, max and a full claude-fable-5 model identifier. Provider access to each
alias target is not claimed; unavailable models retain existing failure paths.

No Kimi/HTTP qualifier behavior, authentication change, automatic model upgrade,
role-count change, or natural-language intent parser is added. Typo rejection
is strict for explicit options; free-text handoffs stop at unknown prose.
