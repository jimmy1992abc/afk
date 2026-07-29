# Reviewer Model Identity and the Stale Install — Design Spec

- **Date:** 2026-07-29
- **Status:** Proposed (revision 2; the adversarial round that produced it is in
  the Appendix)
- **Scope:** Three defects that let an external gate run weaker than the
  pipeline claims: the Claude gate's model is an alias that silently resolves
  to an older generation and is never checked against what actually ran; the
  update notice reaches only the full `afk` driver; and a recorded `pluginRoot`
  survives an update and keeps resolving a superseded install. No change to
  gate selection, metering, the review prompt, closure dispositions, or the
  other three gates' models.

---

## Problem

### 1. The gate requests a generation it cannot pin

`skills/afk-claude-review/claude-gate.mjs` resolves its reviewer as
`process.env.CLAUDE_REVIEW_MODEL || 'opus'`, and `scripts/claude-gate.test.mjs`
pins that same alias. Probed against Claude Code CLI 2.1.214 on 2026-07-29:

| requested | `modelUsage` keys in the result envelope |
|---|---|
| `opus` | `claude-opus-4-8` |
| `claude-opus-5` | `claude-opus-5`, `claude-haiku-4-5-20251001` |

An alias is resolved host-side, on the host's schedule. `afk` requires each
gate to be a current-generation frontier model; with an alias, the gate cannot
know which generation it got, and a host that repoints `opus` downgrades every
review in the pipeline with no symptom. One real review had to be invalidated
and rerun for exactly this reason.

The second row also shows why "the alias is the only bug" is wrong: an
auxiliary model appears in `modelUsage` alongside the reviewer on a perfectly
correct run. Identity has to be checked, and checked in a way that tolerates
that.

### 2. Nothing verifies which model produced the review

The gate validates the argument it *sends* and never inspects the envelope it
gets back. `--print-args` asserts argv, which is a statement of intent, not of
outcome — the same class of defect the untracked-file test comment already
records ("the test pinned the wrong object"). Every silent-resolution path
therefore ends in an approved review attributed to a model that never ran.

### 3. A stale install is invisible unless the full driver runs

`scripts/update-check.mjs` correctly reports a version mismatch, but only
`skills/afk/SKILL.md` step 3 requires running it. A workflow that invokes
`afk-spec-planner`, `afk-implementation-pilot`, or a gate skill directly never
sees the notice, so it can run months-old wrappers believing they are current.
Observed on 2026-07-29 in this repository's own `.afk/config.md`: an installed
`v0.2.3` against a canonical `v0.2.10`.

### 4. `pluginRoot` outlives the install it points at

`.afk/config.md` records a version-keyed cache path, and `afk-init` is
documented as never overwriting an existing value, so re-running it after an
update preserves the *old* root. Helper resolution is `${CLAUDE_PLUGIN_ROOT}` →
recorded `pluginRoot` → the skill's own directory, so on a host that does not
set the env var the stale root wins.

This bites hardest on a newly added skill: `v0.2.3` has no
`skills/afk-claude-review`, `v0.2.10` does. The new skill's own SKILL.md tells
the driver to resolve its helper through the recorded root first — a root under
which that helper does not exist.

---

## Decisions

### D1 — The reviewer model is a pinned full ID; an alias is refused before the call

`CLAUDE_REVIEW_MODEL` defaults to `claude-opus-5`, and any value that is not a
full model ID is an `ERROR` that exits non-zero **before** the model is
invoked. A full ID is `claude-…` carrying at least one digit; every alias the
host resolves on its own schedule (`opus`, `sonnet`, `claude-opus-latest`) has
none. The predicate deliberately does not pin segment order — Anthropic has
shipped both `claude-opus-4-8` and `claude-3-5-sonnet-20241022`, and a
predicate that rejects a legitimate future ID would be a worse failure than the
one it guards.

Rejecting rather than accepting-and-checking is deliberate: an alias cannot be
verified after the fact either, so accepting one would spend a metered call to
discover a misconfiguration that was legible from the start. Failing before the
call is both cheaper and louder.

This narrows a documented knob. That is the point of the change: the knob's old
range included values that defeat the gate's central guarantee.

### D2 — The envelope's `modelUsage` decides whether the gate ran

After the envelope parses and its `is_error` branches are handled, the gate
requires `modelUsage` to carry the requested identity: a key on the same
lineage as the request, meaning the two are equal or one extends the other at a
segment boundary. A `claude-opus-5` request is satisfied by a
`claude-opus-5-20260115` key, and a request pinned to that snapshot is
satisfied by a `claude-opus-5` key. Matching at a segment boundary is what
keeps `claude-opus-50` from satisfying `claude-opus-5`, and lineage is
generation-scoped, so `claude-opus-4-8` never satisfies `claude-opus-5` — the
substitution this whole decision exists to catch.

Extra keys are ignored. The probe above shows an auxiliary model on a correct
run, so "the requested model is the only key" would fail every real review.

Two failure shapes, both `ERROR` and non-zero:

- **Mismatch** — the requested identity is absent. The observed keys go in the
  message, because "which model actually answered" is the fact the operator
  needs.
- **Unverifiable** — `modelUsage` is missing or empty. The gate cannot tell
  what ran, and an unverifiable review is not a clean round (AGENTS.md, "fail
  toward less exposure").

`ERROR`, not `SKIPPED`: a skip means the gate could not run and the next gate
in `priority` takes its place. Here the gate *did* run and produced a review of
unknown provenance. Recording that as "unavailable" would hide a
misconfiguration behind a routine substitution.

The existing HTTP 404 → `SKIPPED` branch is unchanged: a model this account
cannot use is genuine unavailability, and it is reached before any review text
exists.

### D3 — The update notice states the action, and the action stays host-controlled

`updateNotice()` names the supported update path — update the plugin from the
agent host — instead of the bare "update to get the newer skills". The wording
stays host-agnostic with a Claude Code hint, because this plugin ships
manifests for four hosts and a command that is right for one of them is wrong
advice for the other three. A skill never installs or
mutates its own plugin: the install is the host's, an agent rewriting its own
running code mid-run is a change no reviewer sees, and the plugin's own
vocabulary rule forbids claiming an enforcement it does not have. The notice
informs; the operator acts.

### D4 — The SessionStart hook is the central check for direct satellite entry

`hooks/afk-resume-detect.mjs` already fires on every window (re)open, before
any skill is chosen, and is registered in the plugin's own `hooks.json`. It is
the one control point in this plugin that a direct `/afk-codex-review`
invocation cannot route around, which is precisely what requirement "an
equivalent central check" asks for. Prose in ten SKILL.md files is not
equivalent to it: the driver can decline to read prose, and satellite entry is
the case where it does.

The hook gains a version notice alongside its resume context, under these
constraints:

- **Cached.** `.afk/update-check.json` holds `{ checkedAt, latest }`; the
  network is touched at most once per 24h. A session start must not become a
  network round-trip. The entry records that a check *happened*, not that one
  succeeded (`latest: null` for a failure) — otherwise the machine that can
  never reach GitHub is the one that pays the fetch timeout at every window it
  opens, and it is the one with nothing to gain from the retry. Deferring an
  advisory notice for a day is the cheaper side of that trade.
- **Silent on every failure**, as the rest of the hook is. No network, no
  manifest, no cache — no notice.
- **Independent of `auto-resume`.** That knob governs resume detection; a
  stale install is a different fact and an operator who silenced resume
  prompts did not ask to be kept on old code. `AFK_UPDATE_CHECK=off` silences
  the notice specifically.
- **Only where `.afk/` exists.** The hook's no-op-outside-an-afk-repo contract
  is unchanged.
- **Never blocking**, exit 0 always, within the existing 10s hook timeout (the
  fetch is already bounded at 4s and normally does not happen at all).

`afk-init` also runs the check and reports the notice on every run, so an
explicit `/afk-init` re-detect surfaces it too.

### D5 — Re-init refreshes a superseded versioned cache root, and only that

`lib/plugin-root.mjs` decides, as a pure function over two paths plus an
injectable existence check:

| configured | resolved | action |
|---|---|---|
| absent | any | `record` |
| equal to resolved, or resolved is empty | — | `keep` |
| versioned cache root, same plugin, different version | versioned cache root | `refresh` |
| anything else (a custom or manual root) | any | `keep` |

A "versioned cache root" is a path whose final segment is a semver-shaped
version and which sits under a `plugins/cache` segment — the host's install
layout. Same plugin means an identical parent path, so a different plugin or a
different marketplace is never silently adopted.

The decision reads paths and touches no filesystem. Absence was considered as a
second signal and rejected: a version-keyed directory disappears because the
host removed it, but a developer's checkout can be absent for an evening, and
discarding a deliberate value on a transient condition is worse than carrying a
stale one. The version key already says everything the decision needs, and it
is in the string.

Everything outside that shape is a developer's deliberate choice and is
preserved, which keeps `afk-init`'s idempotence promise where it means
something. A recorded root that is recognizably one version of the very install
being resolved is not a choice — it is a fact that expired.

The decision ships as a module with a CLI entry (`--configured`, `--resolved`,
JSON to stdout), the same shape as `scripts/update-check.mjs`. A rule stated
only in prose would be re-derived differently by every driver that reads it;
this plugin has no runtime, so the smallest honest mechanism is a helper the
skill can call and CI can test.

---

## Non-goals

- Changing the model of `afk-codex-review`, `afk-kimi-review`, or
  `afk-glm-review`. Each has its own provider and its own identity signal;
  this spec fixes the gate whose defect is demonstrated.
- Self-updating the plugin from a skill (D3).
- Attributing individual output tokens to a model. `modelUsage` reports usage,
  not authorship; requiring the reviewer's identity to be present is what the
  envelope can honestly support.

---

## Invariants

| Invariant | Enforcing code | Pinning test |
|---|---|---|
| The Claude gate never requests an alias | `claude-gate.mjs` model validation | `claude-gate.test.mjs` — alias errors before the call |
| The default reviewer is a full Opus 5 ID | `claude-gate.mjs` default | `claude-gate.test.mjs` — `--print-args` pins `claude-opus-5` |
| A review whose `modelUsage` lacks the requested identity is never emitted | `claude-gate.mjs` identity check | `claude-gate.test.mjs` — mismatch case |
| An auxiliary model in `modelUsage` does not fail a correct run | same check (prefix/equality over keys) | `claude-gate.test.mjs` — extra-key case |
| An unverifiable envelope is not a clean round | same check | `claude-gate.test.mjs` — missing `modelUsage` |
| The CLI envelope really does key `modelUsage` by full ID | external contract | `claude-gate.test.mjs` — real-CLI probe, self-skipping |
| No fallback model is ever passed | `claude-gate.mjs` argv | existing test, retained |
| A superseded versioned cache root is refreshed | `lib/plugin-root.mjs` | `plugin-root.test.mjs` — old root lacks a newly added helper |
| A custom root is preserved | `lib/plugin-root.mjs` | `plugin-root.test.mjs` — custom root keeps |
| The update notice never blocks a session | hook: cached, bounded, catch-all, exit 0 | `afk-resume-detect.test.mjs` — offline and cache paths |
| One network attempt per TTL, success or failure | `resolveUpdateNotice` records every attempt | `update-check.test.mjs` — failed attempt is cached |

---

## Appendix — adversarial round 1

Findings raised against revision 1 and what changed.

1. **The alias predicate was shaped like today's model IDs.** Revision 1
   required `claude-<family>-<digits>`, which rejects
   `claude-3-5-sonnet-20241022` — a real historical ID form. A predicate that
   refuses a legitimate pin is a harder failure than the alias it guards
   against, since the operator has no valid value to supply. Replaced with
   "starts with `claude-` and contains a digit" (D1).
2. **Prefix matching was one-directional.** Revision 1 accepted only
   `<requested>-…` keys, so an operator pinned to a dated snapshot whose host
   reports the undated family key got a hard `ERROR` with no workaround.
   Widened to lineage matching in both directions, still at a segment
   boundary (D2).
3. **The notice named a Claude-only command.** `/plugin update afk-skills` is
   wrong advice on the three other hosts this plugin ships manifests for (D3).
4. **The hook's early return would have swallowed the notice.**
   `auto-resume: off` returns before the scan; folding the notice in after that
   point would silence it for exactly the operators who never see the driver's
   own check. The notice is computed independently of the knob, and a failure
   in either half must not suppress the other (D4).
5. **A SessionStart hook that writes is a new race.** Concurrent windows can
   write the cache at once. Written atomically (temp file plus rename) with
   failures ignored — a lost cache write costs one extra bounded fetch and
   nothing else (D4).

Left standing: `ERROR` rather than `SKIPPED` for both the alias and the
identity mismatch. The counter-argument — that a hard error blocks a PR on a
config typo — is answered by the message naming the exact value to set, and by
the alternative being a gate that silently does not run.

## Rollout

One PR. The model change takes effect on the next gate run; an operator whose
`CLAUDE_REVIEW_MODEL` is an alias gets a loud error naming the full ID to use
instead, which is the intended migration. The plugin `version` is bumped
because `skills/` and bundled scripts change.
