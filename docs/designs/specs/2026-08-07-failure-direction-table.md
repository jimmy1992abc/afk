# One skip-vs-error table for upstream review failures

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#25 (from the #19 audit: "HTTP 429 is classified in
opposite directions by current gates, each with a confident comment, both
test-pinned"). Moderate scope — one new shared module, two consumers, test
reconciliation.

## Frozen issue contract

Acceptance criteria:

1. One classification module in `lib/gate/` decides the skip-vs-error
   direction of every upstream failure class once:
   - **SKIP (reviewer unavailable → the next family takes its place):**
     `auth` (401/403), `rate_limit` (429 — the documented selection rule:
     "an out-of-credit or rate-limited reviewer is UNAVAILABLE"; blocking a
     PR on a quota blip is the defect), `model_unavailable` (404 — the
     configured model cannot answer for this account; claude-gate already
     classifies it this way), `no_key`.
   - **ERROR (the round is unclean; says nothing about availability):**
     `upstream` (5xx), `http_error` (other non-OK), `transport`, `bad_json`,
     `empty`, `timeout`, unsafe finish reasons — and **any unknown code**
     (fail closed).
2. Both current classifiers consume it: the snapshot lifecycle
   (`lib/gate/openai-snapshot-gate.mjs` catch block) and claude-gate's
   envelope branch. `mapHttp` in `lib/http/openai-provider.mjs` is replaced
   by the shared `httpFailureCode` (no duplicated threshold). Messages stay
   per-gate; only the direction is table-owned.
3. Deliberate behavior changes, named: deepseek/mimo 429 flips ERROR→SKIP
   (was the contradiction) and 404 flips ERROR→SKIP (aligning with
   claude-gate's model-unavailable rule; a widening of issue #25's literal
   direction list — ratified by a comment on the issue recording the
   rationale). Everything else keeps its current direction. Retry-class
   consequence, stated: these failures move from "transient nonzero ERROR —
   one sticky retry" to "stable-unavailable SKIPPED — immediate fallback",
   matching how claude's 429 skip already behaves.
4. **The driver doctrine changes in the same PR** (R1-F1 — the crux: helpers
   flipping direction while the prose asserts the old world recreates the
   exact prose/helper divergence the #19 audit exists to kill).
   `skills/afk/SKILL.md` "Classify the complete outcome" drops "Claude-only":
   stable-unavailable SKIPPED reasons become "disabled/missing
   executable/credential; a skip naming quota/rate-limit/model-unavailable
   from any gate" — scoped to reasons that *name* those classes, so GLM's
   undifferentiated HTTP skips stay in its transient class until #26
   migrates it (R2-NEW-1: two doctrine classes must never match one skip).
   Gate-skill
   docs follow: claude's enumerated skip list gains its (pre-existing but
   undocumented) 429 line; deepseek/mimo SKILLs document the new
   rate-limit/model-unavailable skips beside their ERROR list.
5. The HTTP-gate 404 skip reason names **both** the model env var and the
   base-URL env var as suspects (R1-F6: on a raw endpoint a typo'd base URL
   404s exactly like an unavailable model; a skip naming only the model
   would bench the family for the PR with the wrong remedy).
6. A table-driven parity test asserts 401/403/404/429/500/non-JSON/empty map
   to the same direction in every consumer, with the selection-rule rationale
   in the test name. The previously contradictory pins are reconciled: the
   429 case moves out of http-gates' reject-list into a skip test (plus a new
   404 skip case — currently zero 404 coverage); claude-gate's existing skip
   pins stand unchanged. Unit-level table assertions live in a new small
   file; integration cases land inside `http-gates.test.mjs`, whose
   `withServer`/`runGateAsync` harness is file-local (R1-F8 — no harness
   duplication).
7. Version bumped 0.4.8 → 0.4.9 (lib/ + skills/ ship) with manifests synced.

Engineering invariants: unknown codes fail toward ERROR (less exposure — a
skip hands the review to another family and hides the failure); no silent
skips (every SKIP prints its distinct reason naming the remedy); the shared
table is the only place a direction is written (no copied threshold).

Non-goals: glm-gate (migrates onto the lifecycle in #26 and picks the table
up there; note GLM already skips every non-OK status today, so #26 will
*tighten* its 5xx direction to ERROR via this table); CLI-gate spawn-level
failures (#24 shipped those); message wording beyond what direction changes
force; the retry *rule* itself (one sticky retry for transient failures —
unchanged; what changes is only which class 429/404 belong to, per AC 3);
the design-gate skip-proceeds rule (pre-existing doctrine — a quota blip now
waves a deepseek/mimo design review through exactly as it already does
claude's; the mandatory PR gate still follows, recorded here).

## Design

- New `lib/gate/failure.mjs`:

  ```js
  export function httpFailureCode(status) // 401|403→auth, 404→model_unavailable,
                                          // 429→rate_limit, >=500→upstream, else http_error
  export function failureDirection(code)  // table lookup; unknown → 'error'
  ```

  The table names every provider code: skip — `auth`, `rate_limit`,
  `model_unavailable`, `no_key` (pre-checked in both gate paths, so
  unreachable in their catch blocks — unit-test-only row, recorded as such);
  error — `upstream`, `http_error`, `transport`, `bad_json`, `empty`,
  `timeout`, `no_model` (relay-only reach, R1-F4), and any unknown code.
- `lib/http/openai-provider.mjs`: `mapHttp` deleted; `httpFailureCode`
  imported (relative `../gate/failure.mjs`). The unused `cfg.normalizeError`
  hatch is deleted too — it let a provider config remap status→code outside
  the shared table, violating the one-owner invariant (R1-F4; verified
  unused before deletion). Shared-consumer note (R1-F5): the relay
  (`skills/afk-agent-relay/lib/providers.mjs`) imports this provider; its
  429/500 code pins survive, and a relay 404 relabels `http_error` →
  `model_unavailable` (no relay logic branches on codes — tag-only).
- `openai-snapshot-gate.mjs` catch block: `failureDirection(error.code)`
  chooses `emitSkip` (reason per code: auth names the key env; rate_limit
  names the selection rule and the fallback; model_unavailable names both
  the model env var and the base-URL env var per AC 5) or `emitError`
  (unchanged wording).
- claude-gate envelope branch: statuses feed `httpFailureCode` →
  `failureDirection`; the existing per-status skip messages are kept and
  selected by code; the final catch-all `emitError` is unchanged. Net
  behavior for claude is identical (the table encodes claude's current
  rules); the change is that the direction now has one owner.
- Parity tests split per AC 6: `scripts/failure-direction.test.mjs` holds the
  unit-level table assertions (no harness needed); the integration matrix
  lands inside `http-gates.test.mjs` (its file-local server harness) and
  `claude-gate.test.mjs` (its envelope stubs — existing pins already cover
  the skip side).

## Test plan

Unit: every named code maps to its contract direction; unknown → error.
Integration: http-gates — 429 → SKIPPED naming rate-limit/fallback (moved
from the reject list, test name carries the selection-rule rationale), 404 →
SKIPPED naming both the model env and the base-URL env (AC 5), 401 → SKIPPED
(existing), 500/non-JSON/empty → ERROR (existing); claude-gate — existing
401/404/429 skip pins stand, 500 → ERROR. Doctrine-prose pin: the afk SKILL
no longer contains "Claude-only" in the outcome classification. Full suite
green.

## Debate record

- R1: F1 (HIGH, supported — the crux): doctrine prose ("Claude-only
  quota/model-unavailable") would go stale → AC 4, same-PR SKILL edits.
  F2 (MEDIUM): retry-class change was hidden by the non-goal wording →
  AC 3 states it; non-goal reworded. F3: stale/silent gate-skill doc sites
  enumerated → AC 4. F4: `no_model` unnamed, `no_key` unreachable,
  `normalizeError` hatch violates one-owner → table completed, hatch
  deleted. F5: relay consumer enumerated. F6 (MEDIUM): HTTP 404 ambiguity
  (bad base URL) → AC 5 dual-suspect message. F7: all-skip scenario refuted
  for the PR gate (roles unfillable → not ready); design-gate residual
  recorded in non-goals. F8: harness locality → AC 6 placement. F9: 404
  widening beyond issue #25's literal list → ratified on the issue.
- R2: F1-F9 resolved by name (F9: intent-in-spec suffices for the round; the
  issue comment must exist by PR review). New: NEW-1 (LOW) doctrine-class
  overlap with GLM's undifferentiated skips → clause scoped to skips naming
  the classes; NEW-2 (LOW) design bullet lagged AC 5's dual-suspect wording
  → aligned.
- R3: NEW-1/NEW-2 resolved by name, no new findings — clean round.
  Implementation starts here.
