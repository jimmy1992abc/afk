# Gemini review gate integration

## Compared revisions

- Canonical base: `6e98cd5` (1.2.0).
- Parallel source: `2cc8960` from [the parallel repository](https://github.com/AlvinShenSSW/afk).
- Common ancestor: `735f5a1`. Parallel commits through `2958304` were already
  integrated by 1.0.0–1.2.0; this record covers the two later commits.

| Source commit | Change | Disposition |
| --- | --- | --- |
| `6d0bca4` | feat(gates): add an optional Gemini review gate defaulting to Gemini 4 Argon (#144) | Family registration and selection rules adopted. The REST transport and the snapshot gate's effort descriptor are superseded by `2cc8960` and never shipped here. |
| `2cc8960` | feat(gates): run the Gemini review gate through the Antigravity CLI (#146) | Adopted in its final form with its tests. |

## Integration-specific corrections

- Version is this repository's 1.3.0, not the parallel 1.4.0/1.4.1. Imported
  design documents keep their original version and issue references as history.
- The models reference records the Gemini selection.

## Review map

| Invariant | Enforcing code or doctrine | Pinning check |
| --- | --- | --- |
| Only a versioned `gemini-*` model is requested | `MODEL_PATTERN` in the Gemini gate | Gemini gate model suite |
| A verdict requires the `init` event to name the requested model | Gemini gate identity check | Identity and receipt suites |
| Delegated or unobserved step types discard the verdict | Gemini gate step allowlist | Delegation suite |
| Incomplete, timed-out or verdict-less turns are errors | Gemini gate classification order | Incomplete-turn and EPIPE suites |
| Unavailability skips; operator error does not | Gemini gate skip rules | Availability and model suites |
| The prompt never travels on argv | Stream-json stdin transport | Exact-argv suite |
| A Gemini receipt completes only on exit 0 with verified identity | Receipt checker | Gemini receipt regression |
| Gemini never enters built-in defaults or fallback | External review doctrine | Profile and routing suites |
| The Claude prompt is unchanged by the shared notes | `lib/gate/diff-context.mjs` | Byte comparison of `--print-prompt` before and after, with the drift caution present |

Helper checks are level 2 when invoked. Role selection and plan-mode
read-only behaviour remain level 3 doctrine and CLI behaviour.

## Verification boundaries

Deterministic tests use a stub `agy` behind a platform shim, including the
Windows `.cmd` shape. Live Antigravity behaviour, the model's availability to a
given account and rate-limit reporting are not exercised locally; the parallel
design records its live probes and their unverified assumptions.
