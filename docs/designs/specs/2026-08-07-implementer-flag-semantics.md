# Gate skills: one `--implementer` doctrine, PR mode vs design mode

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#22 (from the #19 audit, item 4 + related prose P2s).
Docs-only scope; brief design per the scaling rule. The SKILL.md prose IS the
program — a host agent executes it — so these are logic fixes, not wording
polish.

## Frozen issue contract

Acceptance criteria:

1. Every gate skill (codex, claude, kimi, glm, deepseek, mimo) documents
   `--implementer` in its run/flag section with one shared, byte-identical
   sentence deferring design-mode semantics to `../afk/SKILL.md`: in design
   mode the flag names the design's **author**, never the eventual code
   implementer. Today codex/kimi/glm never mention the flag at all, and
   deepseek/mimo instruct exactly the forbidden declaration ("plus
   `--implementer <family>` when another model wrote **the change**" beside
   `--design`).
2. The claude sample command no longer hardcodes `--implementer codex`
   (`afk-claude-review/SKILL.md:70`) — the one flag that can *permit* a run
   must not sit in a copy-paste sample; a short note states when to add it.
3. The kimi skill carries the requested-not-enforced read-only caveat (body
   and frontmatter description) — `afk/SKILL.md:211-215` already states it;
   the kimi skill currently overclaims, the vocabulary-level borrowing
   AGENTS.md forbids.
4. A level-2 prose test pins the contract: the shared rule block extracted
   from each of the six gate skills and asserted **byte-equal** across them
   (drift anywhere in the block fails, not just in one substring), the claude
   sample carrying no hardcoded `--implementer`, and the kimi caveat present
   (`scripts/design-gate.test.mjs`, where design-mode prose is already
   pinned). Identical hard-wrapping across the six files is part of the
   contract; MD013 is disabled so the wrap is free to match.
5. `afk-claude-review`'s Independence section (the file's dedicated
   `--implementer` documentation, cited by the issue) gains the same
   design-mode qualifier — its "pass the flag whenever the implementer is not
   the driver" instruction must not survive as an unconditional rule an agent
   can read in isolation and stop at.
6. Version bumped (skills/ and scripts/ change).

Engineering invariants: the shared sentence is byte-identical across all six
skills (drift in one copy is invisible — the defect class this repo keeps
finding); all existing prose-pinning tests stay green; `lint-skills` passes
(description length bounds); helper `.mjs` code untouched.

Non-goals: guard logic in `lib/gate/implementer.mjs` (the helper mechanically
excludes the declared family — what the value *means* is defined by prose,
which is exactly why the prose must be right); the implementer-identity-after-
driver-fix-passes question (#19 P2-4, operator-owned); extending
`lint-skills.mjs` into a general prose linter (#19 improvement 8).

## Design

The shared sentence, placed immediately after each skill's "Pass through any
target flag …" sentence (codex/kimi/glm/claude) or replacing the misleading
clause (deepseek/mimo):

> Pass `--implementer <family>` when another model wrote the change. In design
> mode (`--design`) the flag instead names the design's **author**, never the
> eventual code implementer — see `../afk/SKILL.md` ("Design-stage external
> gate"): declaring the code implementer there can hand a driver-authored
> design to the driver's own model for review.

- claude: sample becomes `node "<helper-dir>/claude-gate.mjs"`; a following
  note says to add `--implementer <family>` only when another model truly
  implemented, because the flag can permit a run as well as block one. The
  Independence section's item on when to pass the flag gains the design-mode
  qualifier in place (AC 5) so no path through the file reads the old
  unconditional rule.
- kimi: body "Kimi reviews the diff read-only" gains "— read-only is requested
  in the prompt, not enforced by construction (Kimi drives git itself)";
  frontmatter description "read-only" becomes "read-only (prompt-requested)".
  Per-skill descriptions enter no manifest (verified in debate:
  `sync-marketplace.mjs` mirrors only the plugin-level description), so no
  manifest churn beyond the version bump.
- Tests in `scripts/design-gate.test.mjs`: (a) extract the rule block from
  each gate skill by a spanning regex, assert the extraction non-null per
  skill (presence — otherwise six absent blocks would compare vacuously
  equal), then assert all six byte-equal; (b)
  `afk-claude-review/SKILL.md` does not match /claude-gate\.mjs" --implementer/;
  (c) kimi matches /not enforced by construction/.

## Test plan

Tests-first: add the three assertions (RED against today's prose), apply the
edits, GREEN; bump the version (0.4.5 → 0.4.6) and `npm run sync` +
`sync:check`; `npm run lint:skills`; full suite.

## Debate record

- R1: semantic accuracy of the shared sentence, kimi caveat accuracy,
  consistency with afk/SKILL.md, RED/GREEN direction, and no-existing-test-
  breakage all verified clean against the helpers and test files. P2-1
  (dropped version-bump AC) → restored as AC 6 + test plan. P2-2 (claude
  Independence section keeps the unconditional rule the issue cited) → AC 5 +
  design bullet. P2-3 (byte-identity invariant unpinned by a substring test)
  → cross-file byte-equality assertion + identical-wrap requirement. Minor
  (false "descriptions mirror" claim) → corrected to the verified behavior.
- R2: P2-1/P2-2/P2-3 and the minor resolved by name. New minor: the
  byte-equality test needed a per-skill presence assertion first (vacuous
  pass on six absent blocks) → test design amended.
- R3: amendment resolved by name, no new findings — clean round.
  Implementation starts here.
