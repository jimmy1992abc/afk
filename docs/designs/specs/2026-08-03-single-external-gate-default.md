# Single External Gate Default, Ordered Roles by Explicit Flags

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

- **Issue:** [#11 — Default to a single external gate (Codex); ordered double gates only on explicit -codex -kimi](https://github.com/AlvinShenSSW/afk/issues/11)
- **Status:** Revision 6 — after adversarial rounds 1–5 (F1–F23); converging
  on operator instruction
- **Author:** Claude (Fable 5)
- **Date:** 2026-08-03

## Problem

Since issue #1 the built-in PR gate profile is the ordered double
`gates: codex > kimi`. Every repository without an explicit profile therefore
pays two sequential external reviews per PR revision, and when the final-role
family is unavailable or flaky on a host, the second role becomes the
bottleneck for every wave: fallback-pool exhaustion leaves PRs stuck in draft
(the operator hit exactly this on Windows; see #10 and #12). The operator's
decision in #11: one independent external family is the right default, and
deeper sequences must be a deliberate, visible choice — made either per
handoff or persistently.

Everything here is level-3 driver doctrine plus the shared notice helper
(level 2 for the runs routed through it); see AGENTS.md, "What this plugin can
and cannot enforce".

## Frozen issue contract

Acceptance criteria:

1. New/profileless configurations resolve to exactly **one** required external
   role, preferred `codex`. The fallback pool stays `codex > claude > kimi > glm`.
2. Ordered multi-role sequences are strictly opt-in, by either channel:
   - **Per handoff:** explicit role flags in the operator's handoff message —
     `-codex`, `-claude`, `-kimi`, `-glm`, `-deepseek`, `-mimo` — form the
     ordered role list for that run in the order written (`-codex -kimi` ⇒
     Codex outer → Kimi final). A single flag selects a single-gate profile
     *preferring* that family; independence and fallback rules still apply, so
     the actual reviewer may be a fallback family (F9).
   - **Persistent:** an explicit `gates:` value in `.afk/config.md` (existing
     mechanism, grammar unchanged).
3. Precedence per run: invocation flags > config `gates` > complete legacy
   profile (`priority`/`min-pass`/`mode`) > built-in `gates: codex`.
   **Fail-closed exception (F3):** a present-but-empty or malformed config
   `gates` key remains a blocking configuration error even when flags are
   present — flags select roles; they never mask a broken config.
4. Every active document and the shared notice helper state the single-gate
   default; artifact tests pin it.
5. Existing configs keep their behavior: explicit `gates` values and legacy
   profiles resolve exactly as before. (For `gates` lines that were written by
   the bootstrap template rather than by the operator, see D5 — Migration.)

Engineering invariants:

- One pass is never presented as two: a role list of length N requires N clean
  stamps from distinct eligible families on the same final revision.
- Invocation flags never mutate `.afk/config.md`; they are per-run input.
- **The effective profile is resolved at kickoff — and re-resolved only
  through the source-scoped channels of D2 (F23) — restated to the
  operator, and recorded** in the ledger together with its source
  (`flags` / `config` / `legacy` / `built-in`). Kickoff step 6 restates the
  effective gate profile **and its source** alongside the scope (F16), so a
  surprise role list is visible before any paid work (F2).
- The role-profile hash stamped around every PR role covers the **effective**
  profile: when flags are present, the flag-derived list **plus the
  normalized section minus its `gates` key** — flags replace only what they
  override, so mid-run edits to `priority` or the `implementer` declaration
  still stale stamps on a flag-derived run (F21) — otherwise the normalized
  `## external gate` section (or the absent sentinel). Two runs
  with different effective profiles can never share a stamp. The
  "Ordered-role revision and convergence rules" paragraph of the AFK skill,
  which today names the section hash unconditionally, changes with this design
  (F1).
- The notice remains bounded, at-least-once, non-mutating (issue #1 spec D6);
  only its wording changes.

Explicit non-goals:

- No changes to any gate helper (`*-gate.mjs`), the implementer guard, marker
  protocol, model pins, or provider routing.
- No change to the `gates` grammar, legacy compatibility rules (issue #1 spec
  D2), role stickiness, merge-base stamping, counters, or convergence rules
  beyond the hash-input clarification above — they apply to whatever effective
  role list was selected.
- No change to the design-stage gate (still one independent role, default off).
- No change to the fallback pool or to DeepSeek/MiMo remaining outside it.
- No automatic rewriting of any existing `.afk/config.md` (migration is
  documentation, D5).
- No rewriting of historical design specs; the issue #1 spec remains the
  record of the ordered-roles machinery, which this design keeps.

Allowed user-visible behavior changes: repositories without an explicit
profile drop from two required external reviews to one; the bounded notice and
the bootstrap template change wording accordingly (the changed notice
signature re-fires the notice once per affected repo, by design).

## Decisions

### D1 — Built-in default becomes `gates: codex`

Resolution rule 3 of the AFK skill ("Otherwise use built-in
`gates: codex > kimi`") becomes built-in `gates: codex`; built-in priority is
unchanged. A one-item list is an explicit single gate under the issue #1
grammar, so no new grammar is introduced. Default assignment consequences:

| Implementer | Single required role |
|---|---|
| Claude / GLM / Kimi / DeepSeek / MiMo | Codex |
| Codex | Claude |

The explicit two-role matrix from the issue #1 spec (Codex outer + Kimi final
for a Claude/GLM implementer; Claude outer + Kimi final for a Codex
implementer; Codex outer + Claude final for a Kimi implementer) still governs
whenever a two-role profile is selected by flags or config.

The bootstrap template ships `gates: codex` with the double profile shown as a
commented opt-in, so newly bootstrapped repositories get the same default
explicitly. `afk-init` behavior is otherwise unchanged.

### D2 — Invocation role flags select this run's ordered roles

A new per-run input channel, read by the driver from the operator's handoff
message — the same message that carries the scope (one surface, not two;
F10). This is level-3 doctrine: the driver interprets the operator's text, and
the grammar below defines the affirmative form the tests pin.

**Grammar (F10, F13).** A role flag is a whitespace-delimited token of the
form `-<family>` or `--<family>` — one or two leading dashes, family name
matched case-insensitively (mirroring the config grammar's case rule), after
stripping surrounding punctuation (`,` `.` `;` `:` `!` `?` and enclosing
brackets/quotes). `<family>` is one of the six gate families; the GNU-style
double dash and case variants are accepted rather than recorded as errors
because they are the likeliest well-intended spellings of the same choice.
Tokens the operator is quoting or explicitly declining ("skip -kimi this
time", "yesterday I ran -codex -kimi") are not selections — intent governs,
and the mandatory kickoff restatement of the effective profile (contract
invariant, F2) is what makes a misread visible before paid work.

**List construction.** Flags are taken in writing order: first = outer, last =
final when length ≥ 2, and the list length is the required count — the same
positional semantics as the config `gates` list. Two deliberate divergences
from the config rules, both because this is unreviewed free text rather than a
persistent reviewed file:

- **A repeated family collapses** into its first occurrence instead of
  becoming an ineligible slot filled from the fallback pool (F4): `-codex
  -codex` is a single Codex gate. A config duplicate keeps issue #1's
  fallback-fill rule unchanged; a handoff typo must never silently add a paid
  role the operator did not name.
- **A dash-led token whose word names no gate family is not a role flag**
  (F5, F13): it is ignored for role selection and recorded in the ledger as
  an ignored lookalike, so the operator can see a typo (`-gemini`, `-kim`)
  did not select anything. The recorded class is scoped to tokens *plausibly
  intended as role flags* — near-misses of a family name — not every dash-led
  token a handoff contains (`--implementer`, `--base`, and a bare markdown
  `-` are not lookalikes; F18). With double-dash and case variants accepted
  as valid flags (grammar above), the recorded class covers the remaining
  misspellings rather than the likeliest correct-intent forms. A config
  unknown keeps issue #1's recorded-ineligible-slot rule. The "mirrors the
  config list" claim is therefore scoped to order, position, and count — not
  to token-error handling.

**Precedence and failure.** Flags override a config `gates` value for that run
only. With no flags, config and legacy resolution are exactly as before; with
neither, D1 applies. A present-but-empty or malformed config `gates` key
blocks regardless of flags (contract rule 3, F3). A flag naming the
implementer's own family is an ordinary preference whose slot the existing
independence and fallback rules fill (F9).

**Run lifetime (F6, F12, F17, F19, F20) — scoped by source.** The effective
profile is resolved at kickoff, recorded in the ledger with its source, and
restated (step 6) before any paid work. What may change it depends on where
it came from:

- A **flag-derived** profile is per-run and ledger-held: ticks and resumed
  sessions read it from the ledger rather than re-deriving it from their own
  (flagless) prompts, and the static tick prompt carries it alongside scope,
  order, merge policy, constraints, and run directory. The only channel that
  changes it is a kickoff-bearing handoff **that states role flags** (F12,
  F17); **flag absence is no statement** — a flagless kickoff-bearing
  message, a resume of an existing run above all, defers to the ledger's
  recorded profile. A mid-run message that merely mentions a flag token
  without re-entering kickoff is conversation, not a profile edit — the
  driver may ask, but never silently re-resolves.
- A **config-, legacy-, or built-in-sourced** profile keeps today's live
  behavior, unchanged (F20): its hash input is the normalized
  `## external gate` section (or the absent sentinel), so a mid-run edit to
  that section stales stamps and re-derives assignment exactly as the
  existing operator-edit rule already prescribes. "Resolved once" for these
  sources describes the default flow, not a new immunity to the config file.
- **The changed effective-profile hash is the single arbiter of staleness**
  (F19, F20): any channel's edit takes effect as a changed hash, and a
  handoff or config touch that resolves to an identical effective profile is
  a restatement — nothing stales, no sequence restarts. Repeating yesterday's
  flags verbatim on a resume is therefore a no-op, and **a flag statement
  resolving to a role list identical to the current effective profile is
  recorded in the ledger as an affirmation: it does not switch the profile's
  source and stales nothing** (F22) — only a *differing* resolved list is an
  edit, which follows the existing rule for operator edits to
  `gates`/`priority` (every existing role stamp becomes stale and assignment
  is re-derived). A flag-channel edit is announced by the step-6 restatement
  before any consequence lands; a config edit surfaces at the next
  before/after-role hash check, as today (F23).

Equal effective profiles reached by different sources (flags vs config vs
built-in) hash differently; a cross-run stamp under a differently-sourced but
identical profile is conservatively re-reviewed rather than reused (F15) — a
deliberate simplification, since cross-run stamp reuse is already rare.

The kickoff constraint already called "explicit gate choice" is this channel,
now with a defined grammar. The role-profile hash covers the effective
profile (contract invariant, F1): the AFK skill's "Ordered-role revision and
convergence rules" paragraph and its test pin change from "the normalized
external-gate-section hash" to the effective role-profile hash (flag-derived
list when present, else the normalized section / absent sentinel).

### D3 — Notice wording matches the new default

`scripts/gate-profile-notice.mjs` keeps its classification, signature, and
receipt mechanics untouched and changes only message text:

- **profileless:** states the single-review default (`gates: codex`) and names
  both opt-in channels for ordered double review (`gates: codex > kimi` in
  config, or `-codex -kimi` on one handoff);
- **legacy:** announces the ordered-roles `gates:` opt-in coverage-neutrally
  (F8): the snippet advice is to choose a list at least as long as the
  config's effective `min-pass`, with `gates: codex` and `gates: codex > kimi`
  both shown, so the notice never reads as advice to reduce coverage; the
  existing kickoff downgrade confirmation still guards any actual reduction.

The AFK skill's name for the profileless notice changes from "one-time cost
notice" to "one-time default-change notice" (F8): the flipped default reduces
rather than raises cost, and the notice's job is to surface the change of
resolution, not a cost increase. The signature already keys on plugin
version, so existing repos see one fresh bounded notice for this behavior
change — intended, not incidental.

### D4 — Documentation and artifact tests

Active documents updated to the single default and the flag channel:
`skills/afk/SKILL.md` (kickoff steps 4 and 6, "External gate" intro,
resolution rules, default-assignment paragraph, notice paragraph, the
convergence-rules hash sentence, and the Continuity tick-prompt tuple),
`AGENTS.md`, `CONTRIBUTING.md`, `README.md`,
`templates/afk-config.example.md`. Two satellite skills need accuracy
fixes (F7): `skills/afk-internal-review/SKILL.md` at **both** double-default
sites — "outer through final" and the later "ordered outer-to-final role
sequence" — becomes "outer through any later configured roles" phrasing, and
`skills/afk-codex-review/SKILL.md` parenthetically states "(Kimi is the
default final)" as pipeline composition ("Kimi is the default final when a
final role is configured"). Gate skills otherwise keep
their stable role names — Codex "default outer", Kimi "default final" — which
describe role preference when the role exists, not the required count.
Historical specs untouched.

Tests follow the repository's rules-as-tests pattern:
`scripts/external-gate-profile.test.mjs` pins the single default, the flag
grammar (collapse, lookalike, restatement, run lifetime), the precedence
order with its fail-closed exception, the updated assignment matrix, and the
effective-profile hash wording; `scripts/gate-profile-notice.test.mjs` pins
the new notice texts; `scripts/optional-http-gates.test.mjs` and
`hooks/afk-resume-detect.test.mjs` follow the template/notice wording. No new
runtime module: flags are driver doctrine, and inventing a parser executable
nothing calls would be the same false level-2 assurance the issue #1 spec
already rejected.

### D5 — Migration note for template-written double profiles (F11)

Bootstrapped repositories hold a `gates: codex > kimi` line the *template*
wrote, not the operator; a present `gates` key suppresses every notice, so
D1's flip and D3's notice never reach them — they keep paying double silently,
including on the hosts that motivated this issue. Rewriting configs stays a
non-goal (it would erase the explicit-vs-default distinction issue #1
protected, and this plugin cannot know which lines the operator has since
endorsed). Two in-scope mitigations, aimed where they can actually land
(F14): the **README config section** gains one sentence — a config
bootstrapped before this version carries a template-written
`gates: codex > kimi`; delete the line (or set `gates: codex`) to adopt the
single-gate default — and the **kickoff step-6 restatement is the migration
surface that reaches every affected operator on every run**: it names the
effective profile *and its source*, so a `codex > kimi (source: config)` line
in front of an operator who never wrote that config line is the prompt to
act. The template itself is not a migration surface (existing configs never
receive new template text; fresh bootstraps have nothing to migrate) — it
carries only the commented double opt-in. Anything stronger (receipt-keyed
migration notice for template-authored values) needs a way to distinguish
template-written from operator-written lines that does not exist today;
recorded as OUT-OF-SCOPE for the operator.

## Alternatives considered

- **Keep the double default, document the single-gate escape hatch harder.**
  Rejected by the operator in #11: the default itself is the cost decision.
- **Flags as a new config key (`run-gates:`).** Rejected: the operator's
  channel is the handoff message; a config key is neither per-run nor simpler
  than the existing `gates` key it would duplicate.
- **`--gates codex>kimi` single-flag syntax.** Rejected: the issue names the
  `-codex -kimi` shape; one token per role also survives hosts that split
  arguments and needs no quoting.
- **Duplicate flags fill from fallback (mirror config exactly).** Rejected in
  round 1 (F4): a free-text duplicate is a typo, and expanding it adds a paid
  role from a family the operator never named.
- **Erroring on duplicate or lookalike flags.** Rejected: a handoff message is
  not a config file; blocking an autonomous run on a typo the restatement
  already surfaces trades availability for nothing — collapse/ignore plus
  mandatory restatement and ledger records keep the choice visible.

## Files to change

| File | Change |
|---|---|
| `skills/afk/SKILL.md` | Kickoff step 4 (built-in `gates: codex`), step 6 (restate effective profile + source), External-gate intro, resolution precedence (flags + fail-closed exception), flag grammar/lifetime doctrine, default-assignment paragraph, notice-paragraph rename, convergence-rules hash sentence (effective profile), Continuity tick-prompt tuple. |
| `templates/afk-config.example.md` | `gates: codex`, double profile as commented opt-in. |
| `scripts/gate-profile-notice.mjs` | Message text only (D3). |
| `AGENTS.md`, `CONTRIBUTING.md` | Single default + explicit opt-in wording. |
| `README.md` | Single default, flag channel, migration sentence (D5). |
| `skills/afk-internal-review/SKILL.md` | Both double-default phrasings → "outer through any later configured roles" (F7). |
| `skills/afk-codex-review/SKILL.md` | "Kimi is the default final when a final role is configured" (F7). |
| `scripts/external-gate-profile.test.mjs` | Pin single default, flag doctrine, precedence + fail-closed, matrix, effective-profile hash, default-change-notice rename. |
| `scripts/gate-profile-notice.test.mjs` | Pin new notice texts. |
| `scripts/optional-http-gates.test.mjs`, `hooks/afk-resume-detect.test.mjs` | Follow template/notice wording. |
| `package.json`, `plugin.json`, manifests | Version bump via `scripts/sync-marketplace.mjs`. |

## Test plan

RED first: update the artifact assertions to the new default/flag doctrine and
watch them fail against current prose/template/notice. GREEN: implement the
prose, template, and notice changes; then the full local gates —
`sync-marketplace --check`, `lint-skills`, `check-links`, `scan-provenance`,
`node --test`, `check-version-bump`.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Default coverage drops to one review | Fewer independent eyes per PR by default | Operator decision in #11; double review remains one flag or one config line away, and the bounded notice names both channels. |
| Template-written `gates: codex > kimi` keeps existing bootstrapped repos on double review with no notice (F11, F14) | The population most likely to want the new default never hears about it | README migration sentence + the every-run step-6 restatement naming the profile's source; stronger notice needs template-vs-operator provenance that does not exist — recorded OUT-OF-SCOPE. |
| A stale host skill keeps the double default | Mixed defaults across machines | Version bump + update check surface staleness; the effective profile and source are in the ledger. |
| Flag tokens collide with other handoff text | A stray `-kimi`-like token silently changes roles | Strict token grammar; duplicates collapse; lookalikes ignored but recorded; kickoff **restates the effective profile and source** (now a required step, F2) so a surprise is visible before paid work. |
| Flagless ticks/resume re-derive a different profile (F6) | Stamps stale mid-run; a sequence restart is consumed by accident | Effective profile is resolved once, ledger-recorded, and read back by ticks/resume; the tick prompt carries it. |
| Existing repos misread the notice change as silent behavior change | Trust erosion | The notice fires once precisely because the default changed; it names the old and new resolution. |

## Adversarial review outcome

**Round 1** (same-model critic, lenses: contract completeness, totality,
consistency sweep, flag grammar, stamp/hash integrity, notice semantics,
omissions) reported F1–F11; the author validated each against the artifacts.

- **F2 (admitted P1, fixed):** the risk table cited a kickoff restatement of
  the effective profile that did not exist and was not planned. Revision 2
  makes the restatement a contract invariant, adds it to kickoff step 6 and
  the change map.
- **F1 (admitted P1, fixed):** the change map missed the convergence-rules
  paragraph whose unconditional "external-gate-section hash" contradicted the
  effective-profile hash invariant, and the test plan missed its pin.
  Revision 2 names both.
- **F3 (P2, fixed):** flags × present-but-empty/malformed `gates` was
  undefined; now a fail-closed exception in the precedence rule.
- **F4 (P2, fixed):** duplicate flags no longer expand via fallback; they
  collapse. Recorded as a deliberate divergence from the config rule.
- **F5 (P2, fixed):** lookalike tokens are ignored **and recorded**; the
  "mirrors config" claim is scoped to order/position/count.
- **F6 (P2, fixed):** flag lifetime across ticks/resume defined
  (resolve-once, ledger-carried, tick prompt includes it; new flags = profile
  edit → stamps stale).
- **F10 (P2, fixed):** token grammar and scanned surface defined; negation/
  quoting handled by intent + mandatory restatement, stated as doctrine.
- **F11 (P2, fixed via D5):** template-written double profiles documented as
  unreachable by the notice; migration sentence added; stronger mechanism
  OUT-OF-SCOPE for the operator.
- **F7 (minor, fixed):** internal-review and codex-skill one-line accuracy
  edits added to the change map.
- **F8 (minor, fixed):** notice concept renamed to "default-change notice";
  legacy notice made coverage-neutral.
- **F9 (minor, fixed):** contract criterion 2 reworded — a single flag selects
  a single-gate profile *preferring* that family.

No finding was refuted in round 1; every disposition above is a revision, so
all eleven remained open pending round-2 revalidation by name.

**Round 2** (same critic, against Revision 2) revalidated every round-1 ID:
F1, F2, F3, F4, F5, F6, F8, F9, F10 **resolved by name** (both admitted P1s
closed with evidence); F7 and F11 partially resolved, their residues carried
as revision targets; and reported four new findings against the revision
itself, none P1:

- **F12 (P2, fixed):** the mid-run profile-edit trigger the F6 fix introduced
  was undefined and sat outside the restatement control. Revision 3 defines
  the only edit channel as a new kickoff-bearing handoff, whose step-6
  restatement announces the new profile before any consequence; a mid-run
  flag mention without kickoff is conversation, never a silent re-resolve.
- **F13 (P2, fixed):** the strict single-dash, case-sensitive token form made
  the likeliest correct-intent spellings (`--codex`, `-Codex`) select nothing
  and fall outside the recorded lookalike class. Revision 3 accepts one or
  two dashes and case-insensitive family names (mirroring the config
  grammar's case rule), widens punctuation stripping, and scopes the recorded
  class to genuine misspellings.
- **F14 (minor, fixed):** D5's template sentence could not reach its audience
  (existing configs never receive new template text). Revision 3 retargets
  migration at the README plus the every-run step-6 restatement, which names
  the profile's source.
- **F7 residue (minor, fixed):** the second internal-review double-default
  phrasing ("ordered outer-to-final role sequence") added to the change
  prescription.
- **F15 (minor, deferred):** equal effective profiles from different sources
  hash differently, so a cross-run stamp under a differently-sourced
  identical profile is conservatively re-reviewed. Accepted as a deliberate
  simplification, recorded in D2; cross-run stamp reuse is already rare.

**Round 3** (same critic, against Revision 3) closed every revalidation
target by name — F7, F11, F12, F13, F14 resolved; F15 properly deferred — and
found the F12 fix itself defective plus two minors:

- **F17 (admitted P1, fixed):** "a kickoff-bearing handoff resolves flags
  afresh" over-included flagless resumes: a resume message necessarily
  carries a scope, so a flag-started run resumed with a plain message would
  re-derive a *different* profile, stale every stamp, and re-review at the
  coverage the operator opted up from — contradicting the resolve-once
  invariant in the same paragraph. Revision 4 scopes the edit channel to a
  kickoff-bearing handoff **that states role flags**; flag absence is no
  statement and defers to the ledger's recorded profile.
- **F16 (minor, fixed):** the contract invariant now requires the step-6
  restatement to name the profile's **source**, which D5's migration surface
  load-bears on.
- **F18 (minor, fixed):** the recorded lookalike class is scoped to tokens
  plausibly intended as role flags (near-misses of a family name), not every
  dash-led token (`--implementer`, `--base` are not lookalikes).

**Round 4** (same critic, against Revision 4) closed F16, F17, F18 by name —
including two directed probes on F17 that held (mid-run opt-down is
achievable by a flag-stating re-handoff; the cross-run misreading is
foreclosed by Continuity's scope-matched claiming) — and found the
reformulated edit-channel sentence carried two unchecked claims:

- **F20 (admitted P1, fixed):** "the only edit channel" plus source-agnostic
  resolve-once contradicted the preserved live-config hash mechanism: a
  mid-run `## external gate` edit must stale stamps (today's rule, kept by
  the non-goals), yet the sentence said the profile "holds for the life of
  the run" for every source — one reading reached ready at lower coverage
  than the operator's explicit config. Revision 5 scopes run-lifetime rules
  by source: flag-derived profiles are per-run and ledger-held; config/
  legacy/built-in-sourced profiles keep the live-section behavior.
- **F19 (P2, fixed):** the edit trigger fired on *stating* flags, not on a
  *differing resolved profile*, so an identical-flag resume literally staled
  every stamp while the hash rule said nothing changed. Revision 5 makes the
  changed effective-profile hash the single arbiter of staleness; an
  identical resolution is a restatement, never an edit.

**Round 5** (same critic, against Revision 5) closed F19 and F20 by name and
reported three boundary findings, none P1 — the core design's third
consecutive round without a structural objection:

- **F21 (P2, fixed):** the flag-sourced hash input covered only the flag
  list, so mid-run `priority`/`implementer` edits escaped the staleness
  arbiter on flag-derived runs. Revision 6 widens the flag-sourced hash input
  to the flag-derived list plus the normalized section minus its `gates` key.
- **F22 (P2, fixed):** "identical effective profile" was ambiguous at a
  within-run source transition (config `gates: codex` re-stated as
  `-codex`). Revision 6 defines it: an identical-list flag statement is a
  ledger-recorded affirmation — no source switch, nothing stales; only a
  differing list is an edit.
- **F23 (minor, fixed):** the frozen "resolved once at kickoff" invariant is
  qualified to the source-scoped channels, and the step-6 announcement claim
  is scoped to the flag channel (config edits surface at the hash check, as
  today).

**Convergence note (operator instruction, 2026-08-04).** The operator
directed the debate to converge. Rounds 3–5 produced no structural finding:
every remaining item was a one-clause boundary definition, and each fix
landed verbatim in the paragraph it corrects. Round 6 is a revalidation-only
pass over F21, F22, F23; any further non-P1 finding it or later stages raise
against this design is recorded with a Deferred disposition rather than
opening a new revision round.
