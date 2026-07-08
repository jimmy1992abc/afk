# AFK Plugin — Design Spec

- **Date:** 2026-07-08
- **Status:** Approved (pending spec review)
- **Scope:** Package an autonomous-PR-pipeline skill set as a standalone,
  open-source, cross-agent plugin in a fresh repository.

---

## Problem

A set of agent skills — an autonomous execution driver plus a
plan → implement → review pipeline with independent review gates — currently
lives inside a private application repository. The skills are entangled with
that repository's specifics (test commands, gate names, internal rule numbers,
issue numbers, domain nouns, doc paths). They cannot be shared or reused as-is:
they leak private context, assume one project's conventions, and are wired only
for one host agent.

## Goal

Ship a standalone plugin that:

1. Works across all mainstream coding agents (Claude Code, Codex, Copilot,
   Gemini, and any agent reading a `skills/` directory).
2. Carries zero private, personal, or non-public information.
3. Adapts to any consuming project through a per-project, gitignored config —
   never by baking a project's specifics into the plugin.
4. Enforces owner/admin-only review on every contribution.
5. Guards its own cleanliness with a broad CI suite.

## Non-goals

- No README (authored separately, downstream).
- No new review-provider gate beyond the two that already exist; a third
  ("internal Claude gate") remains a documented future slot.
- No runtime coupling to any application; these are development-time skills.
- No attempt to auto-migrate an existing project's conventions; adaptation is
  explicit via config.

---

## Requirements traceability

| Req | Where addressed |
|-----|-----------------|
| 1. Cross-agent compatibility | §Packaging model, §Skill inventory |
| 2. Owner/admin-only review | §Owner-only review |
| 3. Maximal CI gates | §CI gates |
| 4. Adaptation out of the plugin, into gitignore | §The `.afk/` adapter |
| 5. No README | §Non-goals, §Docs |
| 6. Internal-review output redesign | §Internal-review redesign |
| No private info | §Provenance scrubbing, §CI gates (provenance scan) |
| Concise, why-only comments | §Contribution rules |

---

## Packaging model (cross-agent)

`skills/` is the single source of truth: one subdirectory per skill, each with a
`SKILL.md`. Five manifests point at it and are regenerated from the skills on
disk by `scripts/sync-marketplace.mjs`, so identity is edited in exactly one
place:

| File | Agent | Content |
|------|-------|---------|
| `.claude-plugin/marketplace.json` | Claude Code | enumerates every skill |
| `.agents/plugins/marketplace.json` | Codex | one bundled plugin |
| `.github/plugin/marketplace.json` | Copilot | one bundled plugin |
| `plugin.json` (root) | Copilot | identity-only manifest |
| `.codex-plugin/plugin.json` | Codex | identity-only manifest |

Codex and Copilot auto-discover skills from the bundled plugin's `skills/`
folder; only the Claude marketplace enumerates skills explicitly. Adding a skill
therefore edits only the Claude file plus the discovered set — the sync script
keeps all five consistent and prunes removed skills.

Root instruction files carry the contribution rules to whichever agent a
contributor uses:

- `AGENTS.md` — canonical, agent-agnostic.
- `CLAUDE.md` — Claude Code; defers to `AGENTS.md` and adds Claude specifics.
- `GEMINI.md` — pointer to `AGENTS.md`.

Marketplace identity: marketplace `afk`, plugin `afk-skills`.

### Skill-name collision safety

Skill names are globally unique so they survive host agents that flatten all
skills into one namespace (where `codex-review` from two sources would clash)
and so bare-trigger auto-selection is unambiguous:

- Flagship: `afk`.
- Satellites carry the plugin prefix: `afk-spec-planner`,
  `afk-implementation-pilot`, `afk-internal-review`, `afk-codex-review`,
  `afk-kimi-review`, `afk-agent-relay`.

Descriptions lead with the namespaced trigger and identify the skill as part of
the afk pipeline; a bare alias may be listed but is not canonical. A consuming
user's same-named personal skill overrides a plugin skill — documented in
`AGENTS.md` and `CONTRIBUTING.md` with the qualified-invocation and rename
workarounds.

---

## Skill inventory

Seven skills, ported and fully genericized. Cross-references between skills use
relative paths (`../afk-kimi-review/SKILL.md`), preserved by the shared
`skills/` layout.

| Skill | Role | Ships with |
|-------|------|-----------|
| `afk` | autonomous waterfall driver | — |
| `afk-spec-planner` | read-only planning to a durable plan | — |
| `afk-implementation-pilot` | implement + self-review loop | — |
| `afk-internal-review` | final internal production-readiness review | — |
| `afk-codex-review` | external gate (independent model) | `codex-gate.mjs`, `REVIEW_INVARIANTS.example.md` |
| `afk-kimi-review` | external gate (independent model) | `kimi-gate.mjs` |
| `afk-agent-relay` | offload token-heavy reads to a cheaper model | `brief.mjs`, `scope.mjs`, `lib/`, `hooks/`, `tests/` |

### Genericization rules (applied to every skill)

- Remove all project nouns, internal rule numbers, issue numbers, and file
  paths tied to one project.
- Replace fixed commands (test/lint/build) with a read of `.afk/config.md`, and
  a stated auto-detect fallback when config is absent.
- Replace project-invariant checklists with a read of the config's
  `Project invariants` section.
- Replace host-specific model identifiers with "strongest available reasoning
  model" (planning/review) or "efficient coding model" (implementation);
  frontmatter keeps at most a generic tier hint, never a vendor model id.
- Design-doc paths default to `docs/designs/specs/` and are overridable via
  config.

---

## The `.afk/` adapter (adaptation lives in the consuming project)

The plugin ships generic. Everything a developer tunes for running afk against a
project is *personal preference*, not shared project config, so all of it lives
in a gitignored `.afk/` directory — nothing afk-specific is committed to the
consuming repo, and no project detail ever enters the plugin:

```text
<consuming-repo>/.afk/          # entire directory gitignored (personal)
  config.md                     # personal run preferences (see below)
  reports/                      # saved final reports (req 6, auto-merge)
  afk-ledger.md                 # AFK run ledger
```

`config.md` is deliberately minimal: every field is optional and defaults to
auto-detect, so a project sets only what it overrides. Starter template:

```markdown
# afk config — all optional; omit a line to auto-detect.

## commands
test:  <cmd>
lint:  <cmd>
build: <cmd>

## external gate
priority: codex > kimi   # preferred order
min-pass: 1              # independent gates that must pass clean
mode:     waterfall      # waterfall: try in order, stop at min-pass · parallel: run at once

## merge
policy: leave-open       # leave-open · merge-to-unblock · merge-when-green

## invariants            # must-check rules a reviewer applies — one per line
```

External-gate policy is the primary tunable:

- **priority** — order the gates are tried/preferred in.
- **min-pass** — how many *independent* gates must return clean for a round to
  pass (default 1). Each counted gate is a distinct model and none may equal the
  implementer's model — enforced by the skill, not the config.
- **mode** — `waterfall` runs gates in priority order and stops once `min-pass`
  is met (cheapest); `parallel` launches `min-pass` gates at once (faster, more
  metered cost). When `min-pass` cannot be met (too few eligible gates), the
  round is not a clean pass — fail-closed, do not mark ready.

Defaults (`codex > kimi`, `1`, `waterfall`) reproduce a single sequential gate,
so the current flow needs no configuration.

Advanced fields default sensibly and stay out of the starter template: default
branch (`origin/HEAD`), design-docs dir (`docs/designs/specs/`), reports dir
(`.afk/reports/`), commit convention.

On first run, a skill creates `.afk/` from `templates/afk-config.example.md` and
adds `.afk/` to the project's `.gitignore` (both idempotent), announcing each.
Markdown was chosen only for ease of hand-editing and the free-text `invariants`
field; `config.md` holds nothing sensitive and is gitignored because it is
personal, not because it is secret.

A blank or absent `config.md` behaves identically to a file of all-defaults —
never an error, never a block. Per-field fallback is config value →
auto-detect → skip with a logged reason (never a silent skip):

| knob | default when blank/absent |
|------|---------------------------|
| test / lint / build | auto-detect; none found → skip + log |
| gate `priority` | `codex > kimi` (whichever is installed and eligible) |
| `min-pass` | `1` (floored at 1 — a clean pass always needs ≥1 independent gate) |
| `mode` | `waterfall` |
| merge `policy` | `leave-open` — never auto-merges |
| `invariants` | none → reviewer uses only the built-in generic checklist |
| default branch | `origin/HEAD` |
| design-docs dir | `docs/designs/specs/` |
| reports dir | `.afk/reports/` |

---

## Internal-review redesign (req 6)

The internal review is not the last gate — an external gate follows it — so its
routine output must be cheap to produce and cheap for the next agent to consume,
not a long human report.

- **Interim output = concise, agent-actionable handoff.** A terse, structured
  block: overall decision, then `blockers[]` and `suggestions[]`, each with
  `file:line` and a proposed fix. Optimized for the fixing agent and the
  external gate to act on. No long prose, no full checklist dump.
- **Full human report is produced only when internal review AND the external
  gate both come back clean** (no unresolved findings). It summarizes the whole
  review round for a human.
- **Auto-merge modes** (`merge-when-green`, `merge-to-unblock`): the final
  report is written to `.afk/reports/PR#<n>-<title>.md` for later audit. The
  filename always leads with `PR#<n>-<title>`; the title is sanitized for the
  filesystem (illegal characters and whitespace collapsed to `-`, case
  preserved, length-capped) and a numeric suffix is appended only to avoid
  clobbering an existing file. **Interactive mode:** shown in-session, and also
  saved when the config opts in.

Touched skills:

- `afk-internal-review` — output split into interim handoff vs final report;
  report-save convention.
- `afk` — waterfall's final-report step writes to `.afk/reports/` under
  auto-merge; ledger path is `.afk/afk-ledger.md`.

Hard rules retained: never approve with an unresolved blocker; never merge,
push, or deploy; always cite `file:line`; spec compliance is a first-class
check.

---

## Owner-only review (req 2)

Layered enforcement:

1. `CODEOWNERS` — the owner owns every path, so a Code-Owner review is required.
2. `docs/branch-protection.md` — documents the `main` ruleset the owner applies
   in repository settings: require a pull request, one approval, require review
   from Code Owners, dismiss stale approvals, block force-push and deletion,
   linear history.
3. `.github/workflows/require-owner-approval.yml` — a CI gate that fails a PR
   lacking an approving review from an owner/admin, as defense in depth for the
   parts of (2) that are settings-only.

Fork PRs (external contributors) cannot approve their own PRs; the owner gate
holds regardless of who opened the PR.

---

## CI gates (req 3)

`.github/workflows/validate.yml` — runs on every PR:

| Job | Checks |
|-----|--------|
| skill-lint | each `skills/*/SKILL.md` has valid frontmatter; `name` matches its directory and the `afk`/`afk-` convention; description within length bounds; referenced sibling files exist |
| marketplace-sync | `sync-marketplace.mjs --check` fails on any manifest drift |
| syntax | `node --check` on every `.mjs`; `bash -n` on every `.sh`; `JSON.parse` on every manifest |
| node-tests | run the `.mjs` unit tests bundled with the skills |
| markdown-lint | markdownlint across `skills/` and `docs/` |
| link-check | internal relative links in every `SKILL.md` resolve on disk |
| provenance-scan | fail on private-project nouns (denylist), non-`example.com` emails, and RFC1918 IP literals |
| secret-scan | gitleaks-style scan for credential-shaped strings |

`.github/workflows/sync-marketplace.yml` — on push to `main`, regenerate the
five manifests and commit any drift back (`[skip ci]`).

Third-party actions are pinned by commit SHA. Custom check scripts live under
`scripts/` and are themselves covered by `syntax` and `node-tests`.

---

## Provenance scrubbing (method, applied during the port)

Each ported skill is scrubbed before it lands:

1. Grep the source skill for project nouns, internal rule tokens, issue-number
   patterns, private hostnames/IPs, and project-specific file paths.
2. Replace each with a generic equivalent or a `.afk/config.md` reference.
3. Rewrite examples so they carry no real project detail.
4. The `provenance-scan` CI job is the standing backstop against regressions.

The denylist that drives `provenance-scan` is maintained in `scripts/` and
contains only generic patterns plus a short list of private nouns to reject — it
does not itself embed sensitive context beyond the tokens it must block.

---

## Contribution rules (encoded in AGENTS.md / CLAUDE.md)

- **Comments and skill prose are concise and state only *why*.** No background,
  no worked examples, no case citations. Rationale belongs in a design doc,
  issue, or PR body — not inline.
- **No personal, project, or non-public information** in any file.
- **English only** for all repository content.
- **Owner reviews every PR** before merge; squash by default.
- **Branch/PR discipline:** never commit to `main`; one topic per branch.

These rules are enforced by review and, where mechanizable, by the CI jobs
above (provenance-scan, secret-scan).

---

## Repository layout

```text
afk/
  skills/
    afk/SKILL.md
    afk-spec-planner/SKILL.md
    afk-implementation-pilot/SKILL.md
    afk-internal-review/SKILL.md
    afk-codex-review/{SKILL.md, codex-gate.mjs, REVIEW_INVARIANTS.example.md}
    afk-kimi-review/{SKILL.md, kimi-gate.mjs}
    afk-agent-relay/{SKILL.md, brief.mjs, scope.mjs, lib/, hooks/, tests/}
  templates/
    afk-config.example.md
    gitignore-snippet.txt
  scripts/
    sync-marketplace.mjs
    lint-skills.mjs
    check-links.mjs
    scan-provenance.mjs
  .claude-plugin/marketplace.json
  .agents/plugins/marketplace.json
  .github/plugin/marketplace.json
  .codex-plugin/plugin.json
  plugin.json
  .github/
    CODEOWNERS
    pull_request_template.md
    workflows/{validate.yml, sync-marketplace.yml, require-owner-approval.yml}
  docs/
    designs/specs/2026-07-08-afk-plugin-design.md
    branch-protection.md
  AGENTS.md
  CLAUDE.md
  GEMINI.md
  CONTRIBUTING.md
  LICENSE            # Apache-2.0 (present at repo creation; unchanged)
  .gitignore
```

No README (req 5).

---

## Error / fail-closed behavior

- Missing `.afk/config.md`: skills fall back to auto-detect, then to a logged
  skip — never a silent no-op.
- Missing external gate tool (Codex/Kimi absent or logged out): the gate
  self-skips with a parseable `SKIPPED` marker and the pipeline continues.
- Manifest drift: CI fails the PR (`marketplace-sync`) rather than shipping
  inconsistent manifests.
- A CI check that cannot run states why; it does not pass by omission.

---

## Testing plan

- **Unit:** the `.mjs` helpers keep their bundled tests; `sync-marketplace.mjs`,
  `lint-skills.mjs`, `check-links.mjs`, and `scan-provenance.mjs` each get tests
  covering the drift, invalid-frontmatter, broken-link, and denylist-hit cases.
- **Structural:** `skill-lint` and `link-check` run against the real `skills/`
  tree in CI.
- **Provenance:** `scan-provenance` runs against the whole tree; a fixture with
  a planted private noun must fail it.
- **Cross-agent smoke:** manifests validated by `JSON.parse` and by the
  sync-check; a manual install smoke test on at least Claude Code and Codex is
  recorded in the PR.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Residual private content slips through | med | high | provenance-scan + secret-scan CI, manual scrub pass per skill |
| Manifest formats drift across agent versions | med | med | single sync script, `--check` gate, SHA-pinned actions |
| `agent-relay` port is heavy and destabilizes the suite | med | med | port it last, in its own phase, behind its own tests |
| Bare-trigger auto-selection still ambiguous | low | med | prefixed names + namespaced canonical triggers + docs |
| Owner-approval settings misconfigured | low | high | CI gate as defense in depth beside the documented ruleset |

---

## Phasing

- **P1 — Scaffold:** manifests + sync script + CI + `CODEOWNERS` +
  instruction files + templates + `.gitignore`. Establishes the gates before
  content lands.
- **P2 — Review pipeline:** port `afk`, `afk-spec-planner`,
  `afk-implementation-pilot`, `afk-internal-review` (with the req-6 redesign),
  `afk-codex-review`, `afk-kimi-review`; wire the `.afk/` convention.
- **P3 — Relay:** port `afk-agent-relay` with its `lib/`, `hooks/`, and tests.

Each phase is a reviewable unit under the owner-only-review rule.
