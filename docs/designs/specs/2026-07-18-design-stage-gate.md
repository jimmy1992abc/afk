# Design-Stage External Gate — Design Spec

- **Date:** 2026-07-18
- **Status:** Proposed (revision 5; rounds 1–4 debate findings and their
  resolutions are in the Appendix)
- **Supersedes:** the unmerged rev-3 spec on `feat/spec-design-gate` (based on
  pre-#10/#12 code). This rewrite aligns to merged #10 (debate) and #12 (gate
  loop / finding closure), corrects Decision 4 against the current Codex CLI,
  and fixes the pilot's self-scoring flaw.
- **Depends on:** the shared gate lib (`lib/gate/`, PR #8), the debate rules
  (#10), and the finding-closure model (#12) — all merged to main.
- **Scope:** Run one external gate over a completed design doc, before any code
  is written, as an **opt-in pilot** step in the `afk` waterfall.

---

## Problem

`afk`'s waterfall runs its first external gate on the **PR** — after the design
is settled, the tests are written, and the implementation is done. Everything
before that point is checked only by the driver and its own adversarial debate:
one model arguing with itself.

A design error is the most expensive kind to find late. By the time the PR gate
sees it, the tests encode it, the implementation encodes it, and the fix means
discarding all of it. `afk`'s own text says "the design doc matters more than the
code", yet the design is reviewed independently only as *incidental diff prose*,
inside a code-review brief that asks for `file:line` bugs — not a review of the
reasoning.

This is not hypothetical, and this spec is its own evidence: re-verifying the
old spec's Decision 4 against the current Codex CLI caught that
`codex exec review` had gained a custom-prompt argument and a sandbox-bypass
flag since the claim was written — a load-bearing external claim that had gone
stale. That is the class of error this step institutionalises a check for, one
level earlier, where a fix is cheap.

## What this step is for, precisely

PR #10 hardened the debate and named its structural limit: a same-model critic
**can only test claims it notices**, and shares the author's blind spot about
what was never considered at all. It is a check on the design's *claims*, not
proof of its *completeness*.

That gap is this step's entire justification, and it is narrow: an independent
model gives a **less-correlated search for omissions** — the requirement nobody
wrote down, the threat nobody modelled, the framing that was wrong from the
start. Those are mostly **not executable**, so the debate's verification
hierarchy cannot reach them however rigorous it is.

It is a plausible gap, not a measured one. Hence Decision 7: a pilot.

**Why not superpowers.** superpowers' review skill dispatches a same-model
subagent with fresh context — its value is a clean context window, not an
independent model. It belongs to the same category as the debate, not to this
step, which exists precisely to add a *different model*. And afk is standalone
and cross-agent by construction; a superpowers dependency (detectable only on
one host) would break that. This gate is afk-owned, always independent-model.

## Goals

1. One external gate over the design doc, after the adversarial debate, before
   tests and implementation, **when enabled**.
2. **Exactly one round per design version.**
3. A brief that hunts *omissions and framing*, not `file:line` code bugs —
   because that is the only thing this step adds over the debate.
4. Reuse the existing gate contract: same selection rule, same opt-out, same
   marker block, same independence rule, same finding-closure vocabulary (#12).
5. Read-only, **by construction**, in design mode as much as in diff mode.
6. **Produce evidence the operator can adjudicate**, so the default can be
   decided by recorded counts rather than by argument — without the driver
   scoring itself.

## Non-goals

- No iteration to convergence. A design gate that loops re-creates the metered
  ping-pong #12's loop rule exists to bound. One round per version; a
  design-invalidating finding restarts the design step, and the rewrite gets
  exactly one more gate (hard cap 2 per issue).
- No blocking authority. The gate reports; the driver triages under #12's
  disposition rules. A design gate that can veto turns a second opinion into a
  second author.
- No new gate providers. No superpowers dependency (see above).

---

## Decision 1 — Placement: after the adversarial debate

```text
design doc → adversarial debate (cap ~3) → EXTERNAL GATE ×1 (when enabled)
  → tests first → implementation → … → PR gate
```

The repo's order is "internal review first, external gate last", and the same
logic applies one level up: the debate is free and catches the cheap errors, so
a metered gate should only ever see a design that has survived it. "One round"
is only coherent on a settled design; on a first draft it is a snapshot of
something about to change anyway.

## Decision 2 — A design target that never touches the diff path

Every gate today takes a **diff** selector (`parseTarget` in
`lib/gate/target.mjs`, kinds `commit`/`uncommitted`/`branch`) and reviews
committed code. A design doc under review is typically not committed, and a
diff-shaped review of markdown yields prose nitpicks instead of an attack on the
reasoning.

`parseTarget` gains a fourth kind, `design`, selected by `--design <path>` and
taking precedence over every diff selector — it names a different *kind* of
review, not a different range.

**`design` must never enter `collectDiff`.** `collectDiff` has no `design`
branch, so a `design` target would fall through to the branch case and compute
`` `${undefined}...HEAD` ``. Per the file's own comment, `gitTry` surfaces that
as `error` now (not the silent empty-diff of the pre-#8 code) — but relying on
that is fragile. The `design` kind gets its own loader and never reaches
`collectDiff`:

```text
readDesign(target) -> { text, path }     // never collectDiff
```

| kind | selector | what the gate sends |
|---|---|---|
| `commit` / `uncommitted` / `branch` | diff selectors | the diff (+ files, for glm) |
| **`design`** | **`--design <path>`** | **the document's full text** |

`readDesign` lives in `lib/gate/target.mjs`, beside `parseTarget` — the same
module that owns every other target kind.

A missing or unreadable `--design` path is **operator error → `emitError`,
nonzero**, never a `SKIPPED`/exit-0. In the diff gates, skipping means *declining
to review one's own work* — safe. Here, skipping would mean *no review happened*
— unsafe. A typo'd path must fail loudly, not silently disable the gate.

**One owner for the existence check: `validateTarget`.** It gains a `design`
branch returning `{ ok: false, reason }` for a missing/unreadable path, exactly
as it already does for a bad commit/branch ref; the helper `emitError`s on
`!ok`. `readDesign` then assumes a validated path and only loads text. This
avoids the double-I/O / double-reason (or gap) that splitting the check between
`readDesign` and `validateTarget` would invite.

**The three lib-driven gates** (`claude`, `glm`, `kimi`) each call
`parseTarget` then `collectDiff` unconditionally today
(`claude-gate.mjs`, `glm-gate.mjs`, `kimi-gate.mjs`). Each grows a
`target.kind === 'design'` branch, taken **before** `collectDiff`, that runs
`readDesign` instead and selects the design context clause and
`buildDesignReviewPrompt`. Two gate-specific notes:

- `kimi-gate` hardcodes ``Inspect the target with `${target.command}` `` —
  meaningless for a design — so its branch must swap the whole context clause.
- `glm-gate` is not a three-line change: it assembles a diff-shaped payload
  (diff, per-file contents, byte budget). Design mode sends the **document
  text** instead, so glm's branch replaces the payload builder too, not just
  the prompt. This is the fourth branch point, called out because the
  "loader/context/prompt" triple undercounts it.

**`codex-gate` does not call `parseTarget` or `collectDiff`** — for a *diff*
target it parses argv directly (it already special-cases `--print-args`,
`--selftest-lock`, `--implementer`) and hands a diff selector straight to
`codex exec review`; it never builds a diff target object or computes a diff.

Design mode is different, and here codex **does** share the lib. The `design`
target is trivial — a kind, the path, and a scope label, with no diff to
compute — so codex's design branch constructs that literal itself —
`{ kind: 'design', path, label: 'the design document at <path>' }` (the same
shape `parseTarget` would produce for a `design` kind, built inline because
codex does not route through `parseTarget`). It then uses the **same**
`validateTarget` → `readDesign` → `buildDesignReviewPrompt` as the three lib
gates:

- `validateTarget(target)` gains a `design` branch (Decision 2 above, its sole
  owner of the missing-doc check); codex `emitError`s on `!ok`. Without this,
  `codex --design nope.md` would throw an uncaught `ENOENT` from `readDesign`
  and exit with a stack trace and **no marker block**, violating the protocol
  contract and the "a missing design doc fails loudly" invariant Test-plan
  item 6 checks on *every* gate.
- `readDesign(target)` loads the (now validated) text;
  `buildDesignReviewPrompt` uses `target.label` for the scope.

So codex imports `validateTarget`, `readDesign`, and `buildDesignReviewPrompt`
(not `parseTarget` — it builds the one-line literal instead) and never touches
the `review` subcommand or a diff selector. The distinction from the three lib
gates is only *how the target is obtained* (inline literal vs `parseTarget`);
once obtained, the design path is uniform across all four gates.

## Decision 3 — A design brief, not a code brief

`lib/gate/prompt.mjs` gains `buildDesignReviewPrompt`, sharing the
transport-invariant scaffolding and replacing the focus. The design brief asks
for:

- **Unstated assumptions** — what must be true that the doc never checks?
- **Contradictions** — where it argues against itself or a constraint it accepted.
- **Gaps** — a decision claimed but never specified; an invariant asserted with
  nothing enforcing it; a mechanism credited with something it cannot do.
- **Unconsidered alternatives** — a simpler approach never weighed, or a
  rejection that does not hold up.
- **Evidence** — claims stated as fact that were never verified.
- **Consequences** — what breaks elsewhere if this ships as written.

Findings cite a **section or quoted claim**, never `file:line` — a design doc
has no meaningful line numbers. Verdict vocabulary is design-shaped:
`SOUND` / `SOUND WITH CONCERNS` / `RETHINK`.

**`prompt.mjs` must be split, and by more than `FORMAT`.** Four of its five
constants are diff-specific, not two:

- `ROLE` (`prompt.mjs:10`) says "the last structural gate before a pull request
  merges" and "This is a read-only review." — the first half is false for a
  design gate that runs before any code.
- `FOCUS` (`:12`) is entirely code-bug-oriented ("correctness bugs, security
  loopholes… concurrency/data-integrity") — the wrong target for a design.
- `FORMAT` (`:14`) hardcodes "the **file:line**".
- `VERDICT` (`:16`) hardcodes the code verdicts.

Only `OUTPUT` (`:18`, "Output only the review.") is genuinely shared verbatim.
The severity scale is **not** shared verbatim: the diff brief's
`[P1]=blocker / [P2] / [minor]` is code-flavoured, while design severity is
P1/P2 with the design meanings this Decision defines above — so severity is a
**per-mode** clause too (a shared *concept*, two phrasings). What is genuinely
shared: `OUTPUT`, and the read-only posture sentence. Everything else — ROLE,
FOCUS/lenses, severity phrasing, locator (`file:line` vs section-or-quote),
verdict vocabulary — is per-mode. `buildReviewPrompt` (diff) and
`buildDesignReviewPrompt` (design) each assemble their per-mode parts over the
shared pair.

**The diff brief must not silently change.** `gate.test.mjs:343-351` pins only
substrings (`[P1]=blocker`, the no-`\n\n` rule), so a FORMAT/VERDICT split could
reword the *production* diff brief while staying green — and a prompt change is a
behaviour change. So the refactor adds a test pinning `buildReviewPrompt`'s
**full assembled output byte-for-byte** against its current string; the split is
a pure refactor only if that test passes unchanged. The diff brief is held
stable deliberately, not left to under-covering substring assertions.

The brief keeps a severity scale so findings map onto #12's dispositions
(Decision 5). It reuses [P1]/[P2] with design meanings: **P1** — the design is
wrong or rests on an unverified load-bearing claim; **P2** — a real weakness the
design survives.

## Decision 4 — Codex: `exec -s read-only`, re-verified against the current CLI

**The old spec's Decision 4 is partly stale.** Re-verified on **codex-cli
0.144.1** (this machine, 2026-07-18):

| claim (old spec) | 0.144.1 reality |
|---|---|
| `codex exec review` rejects a custom prompt | **false now** — `review [OPTIONS] [PROMPT]` accepts "Custom review instructions" |
| `codex exec review` has no sandbox-related flag | **false now** — it has `--dangerously-bypass-approvals-and-sandbox` |
| `codex exec review` cannot capture a final message | **false now** — it has `-o, --output-last-message` |
| `codex exec` has `-s, --sandbox` (`read-only`/`workspace-write`/`danger-full-access`) and `-o` | **still true** |
| `codex exec review` has **no** `-s/--sandbox` selector | **still true** |

The conclusion is unchanged; the reasoning is corrected. Design mode uses
**`codex exec -s read-only -o <file> "<brief+doc>"`**, and **never** the bypass.

**Verified by hermetic probe on this machine (Windows 11, codex 0.144.1,
2026-07-18)** — because the safety here is load-bearing and the diff-gate
header claims the OS sandbox cannot launch on Windows:

- **Probe A — `codex exec -s read-only -o f "…"`**: launched with
  `sandbox: read-only`, `approval: never`, returned the message, exit 0. So the
  header comment ("the OS sandbox cannot launch under a normal user token") is
  **stale for the `exec -s` path in 0.144.1** — the read-only sandbox *does*
  launch on Windows, and design mode needs no bypass. (The diff-mode `review`
  path is out of scope; its header may need the same re-check in its own PR.)
- **Probe B — `codex exec review "…" --dangerously-bypass-approvals-and-sandbox`**:
  launched with `sandbox: danger-full-access` — a **write-capable** agent. This
  is exactly why design mode must not take the `review`+bypass path: `review`
  has **no `-s` selector** to pin read-only, so with the Windows bypass it is
  full-access. The old spec's core safety insight, now demonstrated.

| mode | invocation |
|---|---|
| diff | `codex exec review --base … -o <file>` (+ bypass on Windows, as today) |
| design | `codex exec -s read-only -o <file> -` with **the brief + doc piped on stdin** (**never** bypass) |

**The design payload goes on stdin, never as an argv positional.** A design doc
is diff-sized or larger (this spec is ~20 KB), and `codex-gate` spawns with
`shell: isWin`, so a positional-argument doc would hit the Windows ~8191-char
command-line limit and fail the run outright — the same limit `claude-gate`
already routes its payload around via stdin. Codex reads the prompt from stdin
when the positional is `-` (`codex exec -`, verified in `--help`). **Probe C**
(Windows, 0.144.1): `printf '…' | codex exec -s read-only -o f -` launched
`sandbox: read-only`, exit 0 — stdin transport works and stays read-only. So
design mode pipes `brief + "\n\n" + docText` to the child's stdin and passes `-`
as the positional. The `--print-args` dry run shows `-` (not the doc), so the
argv stays small and inspectable.

**The concrete `spawnSync` change:** `codex-gate.mjs` currently spawns diff mode
with `stdio: ['ignore', fd, fd]` and no `input`. Design mode must instead pass
`{ input: payload, stdio: ['pipe', fd, fd] }` — if stdin stays `'ignore'`,
`input` is silently discarded and codex reads EOF on `-`, reviewing an empty
prompt: a silent no-review. This is the single line that carries the payload, so
it is named explicitly, not left to the implementer.

The lock and marker protocol are unchanged. For `claude-gate`, design mode keeps
`--tools "Read,Grep,Glob"` — an advantage here: a design cites code, and the
reviewer can check whether the code says what the design claims. Record the
Codex version with any design-mode result; a CLI this fluid must be re-verified
per platform, not trusted from this table — Decision 4 was already stale once.

## Decision 5 — One round per design *version*; findings close under #12

The gate is stateless and cannot know which round it is on. State lives in the
per-run directory `.afk/runs/<run-id>/ledger.md`.

- The driver records each design-gate invocation in the run ledger, keyed by
  issue and design version.
- **One gate per design version. Hard cap: 2 per issue.** If a finding
  invalidates the design, the waterfall restarts at the design step and the
  *rewritten* design gets exactly one gate. Never gating the rewrite would ship
  the version no independent model read (the Problem verbatim); gating it forever
  would be a loop.
- Each design-gate finding is triaged and closed by exactly one recorded
  disposition, using **the vocabulary #12 already defines** (`skills/afk/SKILL.md`,
  "External gate": fixed / refuted / accepted) — referenced, not restated here,
  so it cannot drift from that one definition. Two design-stage specifics:
  - **fixed** is #12's design-doc closure applied at this stage: the design is
    revised, and where the fix is "a test the implementation must carry" it is
    *recorded in the design doc as a required test* (#12's exact rule for a
    design artifact), which the tests-first step then consumes. Revising spends
    the one round the rewrite is allotted.
  - This is **not** #12's *loop* — there is no iterate-to-clean here — only its
    closure vocabulary, so no finding is closed by silence and the ledger reads
    consistently across both gates.
- At the cap, the debate's own P1/P2 rule applies — **not** "record and
  proceed". A still-open **P1** (a design-invalidating finding, which is what
  drives the rewrite the cap counts) is never shipped past: escalate to the
  operator, exactly as the debate does (`skills/afk/SKILL.md`: "Never proceed
  past a P1 because the rounds ran out… escalate"). Only a **P2** may be
  accepted knowingly and recorded, design untouched. The cap bounds spend on
  P2s; it never lowers the P1 bar.

**Interaction with #12's merge bar.** #12 keys the auto-merge bar on a PR whose
**run-ledger record** carries an accepted structural finding — record-scoped,
not code-scoped. Design-stage findings and PR-gate findings both live in that
ledger, so they must be **distinguishable** or a design-stage `accepted` would
trip the PR bar. The design gate therefore records its findings under a distinct
`design-gate` section of the ledger (keyed by issue + design version, Decision 5
above), separate from the PR-gate finding record #12's bar reads. A design-level
risk accepted now is recorded there; if it is still real in the shipped code the
**PR gate** raises it against the code and #12's bar applies there — the correct
place, no double jeopardy, and no design-stage finding silently barring merge.
This is a **scoped, reader-side clarification** of how #12's bar applies — its
`skills/afk/SKILL.md` note says the bar reads the PR-gate section, not
design-stage findings — plus the ledger-sectioning that makes the two
distinguishable (both in Files-to-change). It does not change the bar's core
semantics ("an accepted structural finding bars merge"); rewriting *that* rule
would be a separate topic. Stated precisely so the scope is neither overclaimed
(#12 untouched) nor underclaimed (it does touch how the bar is read).

Honest labelling: one-gate-per-version and the ledger record are **driver
convention with a ledger record**, not a mechanism the gate can refuse to
violate (level 3, AGENTS.md). The invariant table says so rather than
pretending otherwise.

## Decision 6 — Exactly one gate, and an explicit `SKIPPED` carve-out

The design step runs **exactly one gate regardless of `min-pass`**. `min-pass`
governs the PR gate, where multiple independent passes are worth their cost;
Goal 2 says one round, and inheriting `min-pass: 2` here would silently
contradict it.

`afk`'s PR-gate rule says a `SKIPPED` round "is not clean — do not mark ready".
The design step **carves out** of that: a skipped design gate is recorded and the
waterfall proceeds. Stated, not implied — a contract cannot be inherited and one
clause quietly inverted. (A design gate is a pilot enhancement; a PR that cannot
get a design review still gets the mandatory PR gate later.)

**A named tension.** Decision 2 makes a missing `--design` doc fail loudly
("skipping would mean no review happened — unsafe"), while this decision lets an
environmental `SKIPPED` (codex uninstalled/logged out) proceed. Both outcomes are
"no independent design review this run", handled oppositely on purpose: a typo'd
path is *operator error* the run cannot paper over, whereas an unavailable
reviewer is the ordinary gate-availability case that a **default-off pilot** must
degrade through rather than halt on — and the mandatory PR gate still follows. The
asymmetry is deliberate, not an oversight.

## Decision 7 — A pilot, default OFF, adjudicated by the operator not the driver

`.afk/config.md` gains:

```text
design-gate: off       # off (default) · risky · on
                       #   off   — never
                       #   risky — design-heavy or high-blast-radius issues only
                       #   on    — every issue
```

**Default `off`.** Nobody has run an external gate over a design doc, so its hit
rate is unknown; shipping an unmeasured metered call on every issue is the exact
reasoning this document exists to catch. The value is specific, plausible, and
untested — strong enough to build and weigh, not to bill every issue for.

**How the pilot resolves — and who scores it.** The old spec had the driver
record "findings the internal debate did not already have", judge that
uniqueness, and own the ledger — the evaluated party scoring itself on a record
it writes and can retrofit. Fixed here:

- **Pre-register the baseline.** Before the design gate runs, the driver writes
  the debate's findings for this design version into the ledger, in a section
  timestamped and closed **before** the gate is invoked. This closes the
  *post-hoc* gaming direction — a gate finding retro-labelled "the debate
  already had it" — but only that one. It is level-3 ledger-order convention
  (unpinned; the invariant table says so), not a guarantee: the same driver
  still writes the baseline, so it does not stop *pre-emptive* under-transcription
  (a thin baseline written to make the gate look productive). That residual is
  part of "self-reported" below, not eliminated by pre-registration.
- **The gate's findings are recorded verbatim**, separately, as the gate
  returned them — not paraphrased into the driver's own words.
- **The operator adjudicates, not the driver.** Whether a gate finding was
  genuinely absent from the pre-registered debate set, and whether the pilot
  promotes toward `on` or is deleted, is a call the **operator** makes reading
  the two recorded sets. The driver never writes a "unique: yes/no" verdict on
  the gate's behalf.
- **Label it honestly.** This yields **self-reported evidence an operator
  adjudicates**, not a measurement the plugin performs. The same-driver records
  both sets, so the evidence is only as trustworthy as the driver's honesty in
  transcribing them — stated as a known limit, not hidden. A stronger
  measurement (an independent party recording the debate set) is out of scope
  for a pilot and named as the follow-up if the evidence proves worth hardening.

Cost, stated plainly: `priority` puts **codex** first and codex is not the
implementer in the common case, so this is normally one extra codex call per
issue it runs on — roughly +25–50% on a typical 2–4 call issue.

`risky` follows the design scaling rule: an external review of a
three-paragraph design is waste. It is *not* the PR-gate exemption ("never scale
down gates" is about PR gates).

## Files to change

| Path | Change |
|---|---|
| `lib/gate/target.mjs` | `parseTarget` gains `design` kind + precedence; `validateTarget` gains a `design` branch that **owns** the missing/unreadable-doc check (`{ok:false,reason}`); new `readDesign` assumes a validated path |
| `lib/gate/prompt.mjs` | split ROLE/FOCUS/FORMAT/VERDICT into shared + per-mode; add `buildDesignReviewPrompt` |
| `skills/afk-claude-review/claude-gate.mjs` | `design` branch before `collectDiff`; design context clause; keeps `--tools "Read,Grep,Glob"` |
| `skills/afk-glm-review/glm-gate.mjs` | `design` branch: send doc text instead of the diff+files+budget payload |
| `skills/afk-kimi-review/kimi-gate.mjs` | `design` branch: swap the ``Inspect … `${command}` `` context clause |
| `skills/afk-codex-review/codex-gate.mjs` | intercept `--design` in argv (early branch, before `hasTarget`/`passThrough`, so it never reaches `codex exec review`); **build the `{kind:'design', path, label}` literal**, then `validateTarget → readDesign → buildDesignReviewPrompt`, `emitError` on `!ok`; `exec -s read-only -o <file> -` with brief+doc piped on **stdin** via `{ input, stdio: ['pipe', fd, fd] }`, never `review`/bypass; import `validateTarget`/`readDesign`/`buildDesignReviewPrompt` (not `parseTarget`) |
| the four gate `SKILL.md` + usage headers | document design mode + `--design` |
| `skills/afk/SKILL.md` | the design-gate step, placement, one-round/≤2, P1-escalate-at-cap, baseline-before-gate, the distinct `design-gate` ledger section, scaling carve-out, `SKIPPED` carve-out; **and a cross-reference at #12's own merge-bar sentence** (External gate / Autonomy) that the bar reads the PR-gate section only, so a driver at the merge boundary — who consults the bar's text, not the design-gate section — sees the carve-out where it is actually read |
| `templates/afk-config.example.md` | the `design-gate: off/risky/on` knob |
| `lib/gate/gate.test.mjs` (+ any gate test files) | the Test-plan cases |
| `.claude-plugin/marketplace.json` → **version bump**, then `node scripts/sync-marketplace.mjs` | AGENTS.md: skills/ + bundled scripts changed, so the plugin `version` (the install cache key) MUST bump and all manifests re-sync, or hosts ignore the change |

## Invariants

| Invariant | Enforced by | Pinned by |
|---|---|---|
| The codex design argv is read-only-shaped | `-s read-only` present, bypass and `review` absent | test: `--design x --print-args` → argv has `-s read-only`, NO `--dangerously-bypass-approvals-and-sandbox`, NO `review` (level 2: argv shape; the *runtime* read-only sandbox is verified by hermetic probe, Decision 4, not by this test) |
| A design target never reaches the diff path | separate `readDesign`; per-gate mode branch before `collectDiff` | test: `--design x` never yields "No changes found"; `collectDiff` not called (lib gates); codex builds no diff selector |
| A missing design doc fails loudly | `emitError`, nonzero | test: `--design nope.md` → ERROR, non-zero exit, distinct reason |
| `--design` overrides any diff selector | `parseTarget` precedence (lib gates); argv interception (codex) | test: `--design x --base main --commit y` → kind `design` / codex argv has no selector |
| A design review never asks for `file:line` | per-mode locator clause | test: design brief has no `file:line`; asks for section/quote |
| Diff and design briefs share the scaffolding | shared posture/output clause (severity is per-mode) | test: both briefs contain the shared clause; only diff contains `file:line`; diff brief output is byte-for-byte pinned |
| The design gate obeys the independence rule | existing `guardFor` | covered by the guard tests |
| The design step runs exactly one gate (ignores `min-pass`) | driver convention | **deliberately unpinned** (level 3): the helper reviews once per call; "one gate regardless of `min-pass`" is a driver-loop rule no helper can enforce |
| A skipped design gate proceeds; a missing doc does not | `emitSkip` (exit 0) vs `emitError` (nonzero) | test: unavailable reviewer → SKIPPED/exit 0; `--design nope.md` → ERROR/nonzero |
| The debate baseline is recorded before the gate runs | driver convention + ledger order | ledger inspection only; **deliberately unpinned** (level 3) |
| One gate per design version, ≤2 per issue | driver convention + ledger record | ledger inspection only; **deliberately unpinned** (level 3) |

## Test plan

1. `parseTarget` design kind + precedence over `--base`/`--commit`, against a
   real tmp doc.
2. `readDesign` loads text; a missing path errors non-zero with a distinct reason.
3. `collectDiff` is never reached for a design target (the three lib gates).
4. `buildDesignReviewPrompt` content: shared posture + `OUTPUT` present; no
   `file:line`; design verdicts (`SOUND`/`SOUND WITH CONCERNS`/`RETHINK`)
   present; design ROLE/FOCUS and design severity phrasing, not the diff ones.
4b. `buildReviewPrompt`'s **full assembled output is byte-identical** to its
   pre-refactor string (a new pin, not just the existing substring assertions),
   so the split cannot silently reword the production diff brief.
5. Per gate, via `--design <path> --print-args`, no metered call:
   - codex: argv is `exec … -s read-only -o <file> -` (payload on stdin, not
     argv), no `review`, no bypass, no diff selector.
   - claude: `--tools "Read,Grep,Glob"`, design context clause, doc text sent.
   - glm: design payload is the doc text, not diff+files+budget.
   - kimi: context clause is the design one, not ``Inspect … `${command}` ``.
6. `--design nope.md` on each gate → ERROR, nonzero; an unavailable reviewer →
   SKIPPED, exit 0 (the Decision 6 asymmetry).
7. Surface test: `afk` SKILL.md states the step, the one-round/≤2 rule, the
   P1-escalate-at-cap rule, the baseline-before-gate rule, the distinct
   `design-gate` ledger section, and the scaling carve-out.
8. Codex stdin transport: a design payload larger than the Windows argv limit is
   accepted (piped on stdin) — a unit check that the child receives the doc via
   stdin, not argv (the transport verified live by Probe C, Decision 4).

## Risks

- **A design gate is easy to make performative.** If the driver runs it and
  ignores the output, it is pure cost. Mitigated by the triage using #12's
  disposition rules and findings going to the ledger.
- **The evidence is self-reported** (Decision 7). Accepted for a pilot; the
  operator adjudicates and the limit is labelled. Hardening (independent
  baseline recorder) is the named follow-up.
- **One round can be too few** for a genuinely bad design. Accepted: a
  design-invalidating finding restarts the design step and buys the rewrite one
  more gate (cap 2).
- **The one-round and baseline rules are unenforced** (level 3). The ledger
  records them; nothing refuses a driver that violates them.
- **The Codex CLI surface is fluid** — Decision 4's table was already stale once.
  Design-mode results record the Codex version; the invocation is re-verified,
  not trusted.

---

## Appendix — round-1 debate findings and their resolutions

Revision 1 was attacked across eight lenses (findings 1–8, resolved in rev 2 and
revalidated by name in round 2); round 2 attacked rev 2's new text (findings
9–13, resolved in rev 3 and revalidated by name in round 3); round 3 attacked
rev 3's new text (findings 14–18, resolved in rev 4 and revalidated by name in
round 4); round 4 found that the rev-4 fix to #15 introduced two P2s (findings
19–20, resolved at their root in rev 5). Several P1s were resolved by hermetic
probe rather than argument (Probes A/B/C, Decision 4) — the design gate's own
thesis in action.

| # | Finding (severity) | Resolution |
|---|---|---|
| 1 | Decision 2's "all four helpers branch on `target.kind`" is false — `codex-gate` never uses `parseTarget`/`collectDiff` (P1) | Decision 2 now handles codex separately (argv interception, its own imports); the kind-branch model is scoped to the three lib gates |
| 2 | On Windows, `codex exec -s read-only` may not launch (the diff header says the OS sandbox can't), so the headline gate wouldn't run on the author's machine (P1) | **Refuted by hermetic probe**: Probe A launched `sandbox: read-only` on Windows 0.144.1, exit 0. Header comment is stale for the `exec -s` path; recorded in Decision 4 |
| 3 | The prompt split under-scoped to FORMAT+VERDICT; ROLE and FOCUS are also diff-specific (P2) | Decision 3 now splits ROLE/FOCUS too; only OUTPUT + severity + read-only posture are shared |
| 4 | Design `accepted` reused #12's disposition in the same ledger → would trip #12's PR merge bar; and `fixed` was weaker than #12's design-doc closure (P2) | Decision 5 adds the merge-bar interaction (design risk re-raised at the PR gate, not imported early) and references #12's design-doc closure for `fixed` |
| 4b | Decision 7 overclaimed "cannot be retroactively reclassified"; pre-registration does not stop pre-emptive under-transcription (P2) | Decision 7 softened to level-3 convention; under-transcription named as part of the self-reported limit |
| 5 | Decision 5 restated #12's disposition vocabulary inline (drift risk, Root A) (P2) | Decision 5 now references #12's single definition, does not restate it |
| 6 | Decision 6's SKIPPED carve-out vs Decision 2's "skipping = unsafe" left in tension (P2) | Decision 6 names the asymmetry: operator-error doc fails loud; unavailable reviewer degrades through (default-off pilot; PR gate still follows) |
| 7 | Invariant "loads no writable sandbox / enforced by `-s read-only`" claimed a runtime property the unit test can't prove (P2) | Row renamed to "argv is read-only-shaped" (level 2); runtime read-only verified by the Decision 4 probe, stated as such |
| 8 | Version bump + manifest sync omitted; glm's payload assembler is a 4th branch point; Decision 6 unpinned/untested; `readDesign` location unstated (P2) | Added Files-to-change (incl. version bump + sync), glm payload note in Decision 2, Decision 6 test rows + a level-3 invariant row, and `readDesign` located in `target.mjs` |
| 9 | Design payload passed as an argv positional → Windows ~8191-char limit fails any real doc; the headline gate is Windows-broken (P1) | Decision 4: payload piped on **stdin** (`codex exec … -`), verified by Probe C (`sandbox: read-only`, exit 0); Test plan item 8 |
| 10 | Decision 5 "beyond the cap, record and proceed" would ship past an unresolved design **P1** (P1) | Decision 5: at the cap the debate's P1/P2 rule applies — a still-open P1 escalates, never proceeds; only a P2 is accept-and-record |
| 11 | #12's merge bar is record-scoped, not code-scoped, so a design-stage `accepted` finding in the shared ledger would bar the PR merge (P2) | Decision 5 + Files-to-change: design findings recorded in a **distinct `design-gate` ledger section**, separate from the PR-gate record #12's bar reads |
| 12 | Shared severity clause is code-flavoured; splitting FORMAT silently rewords the production diff brief past under-covering tests (P2) | Decision 3: severity is per-mode (shared concept, two phrasings); a new test pins `buildReviewPrompt`'s full output byte-for-byte (Test plan 4b) |
| 13 | Missing-doc check attributed to both `readDesign` and `validateTarget` — ambiguous owner (P2) | Decision 2 + Files-to-change: `validateTarget` owns it (design branch → `{ok:false,reason}`); `readDesign` assumes a validated path |
| 14 | Decision 4 named the stdin transport but not the `spawnSync` `stdio:['ignore',…]`→pipe change; missing it = silent empty-prompt no-review (P2) | Decision 4 + Files-to-change now name `{ input: payload, stdio: ['pipe', fd, fd] }` explicitly |
| 15 | Consolidating the check into `validateTarget` left codex (which never calls it) throwing an uncaught ENOENT with no marker block on `--design nope.md` (P2) | Decision 2: codex's design branch calls `validateTarget` then `readDesign`, `emitError` on `!ok` — "fails loudly on every gate" now holds |
| 16 | Invariant "share the scaffolding" row still said `posture/severity/output` after severity became per-mode (P2) | Row updated to "posture/output (severity is per-mode)" + byte-for-byte diff-brief pin |
| 17 | Decision 5 both performed (SKILL.md edit) and disclaimed ("out of scope") a change to how #12's bar is read (P2) | Decision 5 reworded: a scoped reader-side clarification of how the bar applies; only rewriting the bar's core semantics is out of scope |
| 18 | Appendix column header "Resolution in rev 2" spanned rows 9–13, contradicting the intro (P2, minor) | Header changed to "Resolution" |
| 19 | The rev-4 fix to #15 told codex to call `validateTarget`/`readDesign` (both take a target object) while the spec still said codex "never builds a target object" — a contradiction; the target shape was unspecified (P2) | **Root fix** (rev 5): codex builds the trivial `{kind:'design', path, label}` literal inline and shares `validateTarget`/`readDesign`/`buildDesignReviewPrompt` with the lib gates; the "never builds a target object" claim is dropped — it never calls `parseTarget`/`collectDiff`, but the design target is a one-line literal. Resolves the #1/#15/#19 thread at its root (the codex↔lib relationship was under-specified) |
| 20 | The merge-bar carve-out was noted only in the design-gate section, not at #12's own bar sentence a driver reads at merge time (P2, minor) | Files-to-change: `afk/SKILL.md` cross-references the carve-out **at #12's merge-bar sentence** too |
| 21 | Files-to-change codex row lagged the rev-5 root fix — omitted "build the literal" and `buildDesignReviewPrompt` from the call sequence (P2, minor; a doc-sync gap, no new claim) | Row mirrored to Decision 2: "build the `{kind:'design', path, label}` literal, then `validateTarget → readDesign → buildDesignReviewPrompt`". A pure transcription of already-revalidated text; the debate ends here |
