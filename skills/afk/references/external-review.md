# External review

For a driver-managed PR sequence, resolve the profile and assignment below.
A standalone invocation selects the requested gate for that review; it does
not start the driver's full waterfall or authorize extra roles. Apply common
independence, authorship, finding and evidence rules in either case. Provider
invocation and capability limits stay in the selected gate skill.

An external role sequence is **mandatory**. New/profileless configurations run
a **single Codex review**; ordered multi-role sequences — e.g. Codex as
**outer**, then Kimi as **final** — run only when explicitly selected by
handoff role flags or a config `gates` value. Every required clean result must
cover the same final revision. Each actual reviewer is a current-generation
mainstream frontier model, differs from the implementer, and differs from
every other role in the sequence.

## PR gate profile and compatibility

`gates` is the ordered required role list: first = `outer`, last = `final` when
there are two or more, and positions between are stable `intermediate-N` roles.
Its length is the required count. `priority` is the closed fallback pool for an
ineligible/unavailable preferred role; it does not add roles. Roles are always
waterfall—final is never parallelized.

Resolve the effective profile as one total function:

1. **Handoff role flags select ordered roles for this run.** A role flag is a
   whitespace-delimited token of the form `-<family>` or `--<family>` —
   one or two leading dashes, the family name matched case-insensitively (the
   config grammar's case rule), surrounding punctuation stripped — where `<family>`
   is `codex`, `claude`, `kimi`, `glm`, `deepseek`, or `mimo`. Flags are taken
   in writing order (first = outer, last = final when two or more; length =
   required count; `-codex -kimi` ⇒ Codex outer → Kimi final). A
   repeated family collapses into its first occurrence — a handoff typo must
   never silently add a paid role. A dash-led token plausibly intended as a role
   flag but naming no family (`-gemini`, `-kim`) selects nothing and is
   recorded in the ledger as an ignored lookalike; ordinary options like
   `--implementer` are not lookalikes. Quoted or declined mentions ("skip
   -kimi this time") are not selections — intent governs, and the step-7
   restatement makes any misread visible before paid work. Flags never mutate
   `.afk/config.md` and override a config `gates` value for this run only.
2. Otherwise a present `gates` key selects ordered roles. It uses `>` separators, ignores
   surrounding whitespace/case and a trailing comment, and must contain no empty
   segment. Valid role families are `codex`, `claude`, `kimi`, `glm`, `deepseek`, and `mimo`;
   an unknown preference is recorded and uses fallback. A later duplicate
   preference is ineligible and also uses fallback. Legacy `min-pass` and `mode`
   beside a valid `gates` key are ignored for PR roles without rewriting the file.
3. With no flags and no `gates`, any legacy external-gate field (`priority`,
   `min-pass`, or `mode`) preserves the complete legacy profile. Omitted legacy
   `min-pass` retains the former one-gate default.
4. Otherwise use built-in `gates: codex` — a single external review — and
   built-in priority `codex > claude > kimi > glm`.
   `design-gate` and `implementer` do not select PR role count/order.

**Fail-closed exception:** a present-but-empty `gates` key (or a malformed
value) is a blocking config error at every step — flags select roles; they
never mask a broken config, and it is never a fallback to one gate.

**Effective-profile lifetime.** The profile is resolved at kickoff, recorded
in the ledger with its source, and restated at [kickoff](kickoff.md). A flag-derived profile
is per-run and ledger-held: ticks and resumes read it from the ledger;
flag absence in a later kickoff-bearing handoff is no statement, deferring to
the recorded profile; a flag statement resolving to an identical role list is a
ledger-recorded affirmation (no source switch, nothing stales). Only a
*differing* resolved list is a profile edit — every stamp stales and
assignment re-derives, announced by the [kickoff restatement](kickoff.md) first. A config-,
legacy-, or built-in-sourced profile keeps live-config behavior: editing the
`## external gate` section stales stamps via the role-profile hash, as
always. A mid-run message that mentions a flag token without re-entering
kickoff is conversation, never a silent re-resolve.

**Per-run qualifiers.** Codex and Claude role flags may carry adjacent model
and effort tokens in either order. Resolve them with
`node "<plugin-root>/lib/gate/model-select.mjs" --family <family> --qualifiers
<tokens...>`; resolve the plugin root by `CLAUDE_PLUGIN_ROOT`, then the recorded
`pluginRoot`, then two directories above the owning `afk` skill directory, not this reference directory. The helper's `remaining`
tokens are prose, never silently interpreted as qualifiers. Forward the returned
`argv` as the gate's explicit `--model`/`--effort` options. Unknown explicit
options fail; unknown free-text words end the qualifier run. Alias expansion
belongs to the helper, so a driver never guesses which version a nickname means.

Qualifiers bind to the preferred family. On fallback, discard them visibly and
resolve the substitute's own defaults/environment. A repeated family retains
its first selection; conflicting later qualifiers are a driver error, identical
ones reaffirm it. At kickoff and before each call, record effective model,
effort and sources in the existing role ledger entry alongside the profile hash.
These are separate selection receipts: a changed selection invalidates that
role and downstream stamps on the same content revision, while a content change
still invalidates every stamp. Resume reuses recorded qualifiers; an identical
role list alone does not erase them or validate a changed selection.

Do not rewrite an existing legacy config. Emit one bounded notice with the exact
opt-in snippet. An existing no/profileless config gets a
one-time default-change notice; `gates: codex > kimi` in config, or
`-codex -kimi` on one handoff, is the explicit double opt-in. Hook, `afk-init`, and
kickoff all call `scripts/gate-profile-notice.mjs`; that shared implementation
owns the atomic at-least-once receipt keyed by plugin version plus recognized
external-gate profile fields (`AFK_GATE_PROFILE_NOTICE=off` opts out).

## Assignment, availability, and outcomes

Resolve every stable role before a paid verdict. Walk roles left-to-right; for
each, deduplicate `[preferred, ...priority]`, exclude every current content-author family
and already-used families, then choose the first locally plausible candidate.
The implementer must be known; a relay declares it. A missing complete plan is
recorded at kickoff but blocks **ready**, not safe implementation work. Recheck
unstamped roles immediately before review.

Local presence is deliberately narrow: Codex requires its binary plus `codex
login status`; Claude/Kimi require their binaries (and Claude rejects an alias in
`CLAUDE_REVIEW_MODEL`); GLM requires `ZAI_API_KEY`/`GLM_API_KEY`, DeepSeek
requires `DEEPSEEK_REVIEW_API_KEY`/`DEV_DEEPSEEK_API_KEY`, and MiMo requires
`MIMO_REVIEW_API_KEY`/`DEV_MIMO_API_KEY`, from the environment or ignored
`.env` locations. Remote auth, credit, network, and model identity may still
fail on first invocation.

- **Record every content author.** The revision's ledger holds the families
  that authored content still present in the diff. A driver-authored fix adds
  the driver's family; it never replaces or erases the executor's authorship.
  Exclude all recorded authors and already-used reviewers when filling roles.
  A removed contribution may be removed from the set only with recorded diff
  evidence. Unknown authorship prevents a ready declaration until resolved.
  Pass `--implementer <family>` whenever work was relayed or the driver is not
  Claude. `CLAUDECODE` detects only a Claude host; it does not identify Codex,
  Kimi, or API-driven authors. The single-family helper guard applies only to
  the declaration/host evidence it receives, not the complete authorship set.
  The driver owns that set and the corresponding role exclusion as doctrine.
  A helper cannot constrain a round it was never asked to run — the rule that
  the gate runs at all is doctrine (workflow doctrine).
- **Stickiness:** a provider is locked to its stable role for the PR and changes
  only for independence or availability. A substitution is recorded, resets the
  incoming provider's comparison baseline, and keeps the PR-wide finding archive
  and no-progress streak.
- **Classify the complete outcome.** Only a review message is a verdict.
  Stable-unavailable `SKIPPED` reasons (disabled/missing executable/credential;
  a skip naming quota/rate-limit/model-unavailable from any gate) trigger fallback. Independence refusal
  makes that provider ineligible. A rejected/missing driver-supplied implementer
  or bad target stops as a driver error. Transient nonzero `ERROR` gets one
  sticky retry per role per full sequence, then fallback. Unknown `ERROR` stops with its transcript. Skip/error attempts
  are not verdicts, do not increment the no-progress streak, and never count as
  clean.

Default assignment under built-in `gates: codex` is a
single role: Codex for a Claude/GLM/Kimi/DeepSeek/MiMo implementer; Claude for a Codex
implementer. When a two-role profile is selected (flags or config), the default
assignments are Codex outer + Kimi final for a Claude/GLM implementer;
Claude outer + Kimi final for a Codex implementer; and Codex outer + Claude final
for a Kimi implementer. If the required roles cannot be filled by distinct
eligible families, the PR is not clean/ready—one pass is never presented as two.
Neither optional family (DeepSeek/MiMo) changes the built-in role sequence or
fallback pool.

## Authorship declaration

Pass `--implementer <family>` when another model wrote the change. In design
mode (`--design`) the flag instead names the design's **author**, never the
eventual code implementer — read [external design review](design-review.md#external-design-review): declaring the code implementer there can hand a driver-authored design
to the driver's own model for review. A persistent `implementer:` line in
`.afk/config.md` also names the code implementer, and in design mode it can
wrongly block that family's independent review of a driver-authored design —
declare the design's author explicitly then: the per-run flag outranks the
config line.

Before invocation read [environment](environment.md) and
[review convergence](review-convergence.md). Apply the latter for admission,
repairs, closure and ordered-role invalidation. Before supplying context or
receipts, read [review evidence](review-evidence.md).
