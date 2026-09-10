# afk-skills

[![validate](https://github.com/jimmy1992abc/afk/actions/workflows/validate.yml/badge.svg)](https://github.com/jimmy1992abc/afk/actions/workflows/validate.yml)
[![plugin version](https://img.shields.io/github/package-json/v/jimmy1992abc/afk?label=plugin)](plugin.json)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Away-From-Keyboard autonomous execution for AI coding agents.** Hand your
agent a scoped set of issues, walk away, and come back to PR-ready work that a
*different* model has already reviewed.

`afk-skills` packages a stack-agnostic waterfall — design, plan, tests,
implementation, self-review, internal review, ordered independent external
review, full test suite, handoff — as a cross-agent plugin. It works with Claude
Code, Codex, Copilot, and any host that reads a `skills/` directory.

The plugin stays generic. Project-specific commands, merge preferences,
invariants, reports, and run ledgers live in the consuming repository's
gitignored `.afk/` directory — nothing about your project is ever written back
into the plugin.

## What's new in 1.0.0

Version 1.0.0 makes
review evidence explicit so a resumed run can distinguish verified closure from
missing or stale information:

- [Review context](#carry-findings-into-re-review) carries the frozen scope,
  named findings, dispositions, and current-revision proof to supported reviewers.
- [Review receipts](#check-receipts-before-reuse) retain the inputs and outcomes
  needed to check whether earlier review evidence still matches the candidate.
- [Behavior evaluations](#behavior-evaluations) expose unnecessary repairs,
  missed defects, and unsafe readiness through repeatable, bounded scenarios.

This release integrates the parallel implementation's functional improvements
with the selected review policy: structural P2 repairs remain supported, there
is no numeric repair cap by default, and absent remote-CI policy means
`expected`. The helpers do not add an orchestration runtime or establish that
agents obey workflow instructions. See the [integration record](docs/port-v1.md).

## Why

Left alone, an agent grades its own homework. The three failure modes this
plugin is built around:

- **Self-review is not review.** Every external role runs as a *different*
  model from the one that wrote the code, read-only, on the real diff. A role
  that matches the implementer steps aside for an independent fallback.
- **Evidence limits churn.** Focused re-review checks verified closure and
  affected regressions. Stalled work gets a root-cause checkpoint; explicit
  repair limits remain optional.
- **A draft PR is not a finish line.** The waterfall has one end state: green
  checks, a clean internal review, clean external roles, and the full test suite
  passing on the final commit.

## Quick start

1. Install this repository through your agent host's plugin flow (see
   [Installation](#installation)).
2. Open a repository you want to work in. The first afk skill you run
   bootstraps `.afk/` for you; to do it explicitly, run `/afk-init`.
3. Hand over a scope:

   ```text
   /afk issue 123
   ```

`afk` only runs against an explicit operator-provided scope. It does not browse
a tracker and choose work by itself.

**Requirements:** git, Node 20+ for the bundled helpers (dependency-free ESM, no
`npm install`), and the CLI or API credential for whichever external review
roles you enable. Reading a tracked issue also needs that forge's CLI — `gh` for
GitHub, `az` with the `azure-devops` extension for Azure DevOps. Everything else
in the pipeline is plain git.

## What it provides

| Skill | Purpose |
|-------|---------|
| `afk` | Runs the full autonomous waterfall for an operator-provided scope. |
| `afk-init` | Bootstraps `.afk/` for a repository — auto-run when it is missing; detects commands and records the plugin root. |
| `afk-spec-planner` | Turns an issue into a reviewable implementation plan. |
| `afk-implementation-pilot` | Implements an approved plan and self-reviews it. |
| `afk-internal-review` | Performs the internal production-readiness review. |
| `afk-codex-review` | Runs the default Codex outer role. |
| `afk-claude-review` | Runs a Claude fallback role; declines to review Claude's own work. |
| `afk-kimi-review` | Runs Kimi as the final role when selected. |
| `afk-glm-review` | Runs a GLM fallback role with bounded diff context. |
| `afk-deepseek-review` | Runs an optional DeepSeek V4 Pro snapshot-backed role. |
| `afk-mimo-review` | Runs an optional MiMo V2.5 Pro Token Plan snapshot-backed role. |
| `afk-agent-relay` | Offloads large reads or scoping work to an external model. |

## Pipeline

```text
scope
-> design doc with a frozen issue contract
-> adversarial debate
-> design-stage external gate (opt-in pilot, default off)
-> targeted tests
-> implementation
-> self-review
-> pull request (draft; CI deferred)
-> internal review
-> Codex external role (or independent fallback; single by default)
-> Kimi final external role (only when a double profile is selected)
-> full final test suite on the final commit
-> Ready for review (trigger CI)
-> required CI runs pass on the current revision
-> owner approval or configured merge policy
```

Draft PRs keep review fixes from starting repeated CI jobs. This repository
skips validation and owner-approval jobs for Draft events and runs them on
`ready_for_review`; later commits to a ready PR still trigger validation.
Ready for review starts CI and does not declare the PR merge-ready. Draft-stage
skips are never reused as passing CI evidence. Return to Draft before pushing
another repair batch, then complete local validation before promoting.
Other repositories must configure the equivalent CI conditions themselves.
GitHub may still show a skipped workflow entry for a Draft event; this policy
reduces executed jobs, not every workflow entry. Main-branch and manual
validation remain available.

The plugin never deploys.

## External review roles

Each role is an independent model reading the diff and bounded by a timeout.
Claude is constrained to read-only tools, while GLM, DeepSeek, and MiMo receive
a bounded snapshot through a tool-less API call. Codex uses its read-only
sandbox on macOS and Linux; on Windows the CLI cannot launch that sandbox under
a normal user token, so the helper uses Codex's built-in review workflow without
OS sandbox enforcement. Kimi drives git itself, so its read-only behaviour is
requested in the prompt rather than constrained by the helper.

| Role | Default model | Runs via | Credential | Timeout |
|------|---------------|----------|------------|---------|
| `codex` | `gpt-5.6-sol` | Codex CLI | the CLI's own auth | 15 min |
| `claude` | `claude-opus-5` | Claude Code CLI (`Read,Grep,Glob` only) | the CLI's own auth | 15 min |
| `kimi` | CLI-selected | Kimi Code CLI or Kimi CLI | the CLI's own auth | 45 min |
| `glm` | `glm-5.3` | Z.ai REST API (OpenAI protocol by default) | `ZAI_API_KEY` or `GLM_API_KEY` | 15 min |
| `deepseek` | `deepseek-v4-pro` | DeepSeek REST API | `DEEPSEEK_REVIEW_API_KEY`, else `DEV_DEEPSEEK_API_KEY` | 15 min |
| `mimo` | `mimo-v2.5-pro` | Xiaomi MiMo REST API | `MIMO_REVIEW_API_KEY`, else `DEV_MIMO_API_KEY` | 15 min |

The Kimi helper supports both CLIs named `kimi`. It derives the installed CLI's
headless argument group from `--help` and constrains legacy Windows console
encoding only when the probe says it is needed, so the same gate works across
the current npm and Python CLI families.

The Codex reviewer stays on `gpt-5.6-sol` independently of the interactive
session model. `CODEX_REVIEW_MODEL=gpt-6-astra` selects Astra for an explicitly
assigned review; `--print-args` shows the resolved choice before a paid call.

Kimi gets longer because it drives git itself rather than receiving a
pre-injected diff. CLI availability and authentication probes are capped at 30
seconds. A timed-out review produces no verdict and follows the existing
transient-error retry and fallback rule; an abnormal child exit is never read as
a verdict.

Set `AFK_REVIEW_TIMEOUT_MS` to change the shared limit, or override one provider
with `CODEX_REVIEW_TIMEOUT_MS`, `CLAUDE_REVIEW_TIMEOUT_MS`,
`KIMI_REVIEW_TIMEOUT_MS`, `GLM_REVIEW_TIMEOUT_MS`,
`DEEPSEEK_REVIEW_TIMEOUT_MS`, or `MIMO_REVIEW_TIMEOUT_MS`. Values must be
positive integer milliseconds; an unusable value retains a bounded limit and
emits a warning.

CLI timeouts use a hard kill so a process that ignores graceful termination
cannot wedge the gate. On Windows, npm command shims run through a shell; the
gate returns on time, but a surviving shim grandchild may require manual cleanup.

See [models, prices, and aliases](docs/models-and-pricing.md) for the current
provider reference and the distinction between API rates and subscription quotas.

## Evidence-driven convergence

AFK does not ask for operator permission because a review counter was reached.
The issue contract is frozen before implementation, every reported finding starts
untriaged, and P1 is admitted only with a scope anchor, reachable trigger,
demonstrated wrong consequence, stage-blocking impact, and minimal causal fix.
Confirmed in-scope structural findings, including P2, may be repaired in a
batch. A deliberately deferred structural P2 leaves auto-merge for the operator
to authorize. Documentation and cosmetic items are collected for one final
pass; out-of-scope proposals do not expand the task.

There is no numeric repair cap by default. An explicit kickoff instruction or
`## review` → `max-fix-cycles` configuration may set one. When set, phases,
roles and resumes share the recorded allowance. Initial review is comprehensive;
re-review covers accepted finding closure, the repair diff and affected
regressions. Evidence can reopen a finding; reviewer identity cannot.
Each cycle accounts for closed and introduced blockers, acceptance coverage and
causal-boundary expansion. An explicit limit's exhaustion finishes current
validation, leaves remaining repair outstanding and continues independent work.
Two consecutive unfinished rounds without material progress trigger a root-cause
checkpoint; unresolved work remains visible in the handoff.

## Review evidence

### Carry findings into re-review

To avoid asking each reviewer to reconstruct prior decisions, supported gate
helpers accept `--review-context <packet.json>` and
`--review-phase initial|re-review`. A re-review packet binds the original scope,
prior revision, stable finding IDs, dispositions, and proof to the current target.
The complete review target stays intact; the repair range is additional context.
Missing, stale, inaccessible, recognized sensitive, or oversized evidence is an
error before the provider call, rather than silently shortened history.

Claude, Kimi, GLM, DeepSeek, MiMo, and Codex **design** review accept this channel.
Native Codex **diff** review does not: the driver retains history and applies
triage without claiming that custom context reached that reviewer. Packets are
claims for a reviewer to verify, not proof that the stated checks ran.

Keep packets and sanitized proof in the run's ignored `.afk/` directory. The
[context guide](skills/afk/SKILL.md#supported-review-context) explains target
binding, previews, provider limits, and the linked JSON schema.

### Check receipts before reuse

Opt-in `--review-receipt <request.json>` records preserve canonical inputs,
context digests, requested and available observed identity, sanitized review
text, and terminal outcomes. Each attempt has its own directory under
`.afk/runs/<run-id>/receipts/`; retries use new IDs so helper publication does not
overwrite earlier records. Without the flag, no receipts are created.

To check saved evidence against a proposed revision and role profile, use
`check-review-receipts.mjs` with `--candidate <candidate.json>` and one
`--receipt <attempt-directory>` per required role. Changes to the target,
selection, or expected context invalidate affected evidence. Missing terminals,
damaged artifacts, skips, errors, and previews cannot supply approval evidence.

An exit code of zero means complete, consistent evidence, which can include a
negative review. Inspect `allRequiredApproved` separately; false or unknown is
not approval. Requested identity never substitutes for an unobserved model, and
legacy runs without receipts stay unknown. These are local, unsigned records,
not provider attestation or permission to merge.

The [receipt guide](skills/afk/SKILL.md#canonical-review-receipts) provides the
request/candidate schemas, artifact layout, checker invocation, and native Codex
verdict and Codex/Kimi identity limitations. Existing run ledgers still carry
finding dispositions, repair allowances, and merge decisions.

## Behavior evaluations

The manual evaluator makes convergence claims testable without adding paid
trials to ordinary CI. Eight fixtures cover repeated refuted findings,
minor-only reviews, new blockers during closure, repair regressions, exhausted
budget resumes, missing/stale review context, obsolete approvals, and unavailable
reviewers. Deterministic outcome checks and human semantic adjudication remain
separate; synthetic reviewer observations are not external-model reviews.
The pilot explicitly sets a two-cycle limit and record-only P2/minor policy for
its subjects; its results do not measure this release's uncapped default or
structural P2 repair policy.

Run `node "<plugin-root>/scripts/evaluate-agent-behavior.mjs" --help` to inspect
the interface without a provider call. Resolve `<plugin-root>` to the installed
plugin directory or repository checkout. Actual prerequisite and trial commands
require explicit immutable `--candidate` and `--baseline` revisions during
preparation, and `--execute` to run; the operator must verify the host's isolation and tool
surface before qualifying a run. The frozen pilot limits host launches, elapsed
time, and output; these are not hard dollar, token, or internal model-call caps.
Cleanup observations cover the owned process group, not proof that escaped
descendants are absent.

The [imported pilot report](docs/evaluations/issue-98-pilot.md), for its original
parallel-project revision rather than this integration, records **29 passing
deterministic evaluator tests, three real prerequisite invocations, and 0 of 14
behavior trials covered**. Tool-surface isolation could not be qualified, and
the alternate-model prerequisite timed out. Behavioral completion, defect
recognition, and excess-repair rates therefore remain unobserved.
[Issue #98](https://github.com/AlvinShenSSW/afk/issues/98) tracks the outstanding
empirical acceptance; merging the evaluator did not close that gap. The
[design](docs/designs/specs/issue-98-behavior-evaluations.md) defines the scenarios,
comparison matrix, limits, and distinction between tested implementation and
later report-only commits.

## What this can and cannot enforce

These skills are markdown read by a host agent. **There is no afk runtime.**
Nothing executes the waterfall; an agent reads prose and chooses to comply, and
the agent being governed is also the orchestrator.

- **Prose only.** How hard a critic tries, which lenses it picks — evaluation,
  not mechanism.
- **Enforced when invoked.** A bundled helper's output shape, marker block, exit
  code, and skip reason are mechanically checked *within that helper's own
  execution*. Review bodies that contain a lookalike marker line are neutralized
  so a review cannot forge a verdict.
- **Not enforceable here.** "The gate must run", "an unresolved P1 blocks the
  merge" — a driver may skip a helper or ignore its exit code. These are
  doctrine the driver follows.

Claude, Kimi and the snapshot-backed GLM/DeepSeek/MiMo helpers validate an
explicit final nonempty verdict line when invoked. Diff verdicts are `APPROVE`,
`APPROVE WITH COMMENTS` or `REQUEST CHANGES`; design verdicts are `SOUND`,
`SOUND WITH CONCERNS` or `RETHINK`. Supported forms are `TOKEN`, `**TOKEN**`,
`Verdict: TOKEN`, `Verdict: **TOKEN**` and `**Verdict: TOKEN**`; up to three
leading spaces, trailing whitespace and Kimi's transport bullet are ignored. Quoted, fenced or indented-code examples,
trailing prose, wrong-mode words and conflicting standalone decisions produce
nonzero `ERROR` without an accepted review body. Codex retains its native
nonempty review-output contract. This checks output format, not review quality
or permission to merge.

Real non-bypassability needs a control point outside the agent's authority.
This repository supplies a `require-owner-approval` workflow; its presence alone
does not configure branch protection or make it required. Configure the host's
required checks and branch rules using the
[branch-protection guide](docs/branch-protection.md).

## Installation

Install this repository through the host agent's plugin flow. The repository
ships manifests for the supported host layouts:

- `.codex-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `.agents/plugins/marketplace.json`
- `.github/plugin/marketplace.json`
- `plugin.json`

No manual setup step is required: the first time an afk skill runs in a
repository it bootstraps `.afk/` automatically — creating the config, adding the
ignore entry, detecting commands, and recording the plugin root. To set it
up explicitly or re-detect commands, run:

```text
/afk-init
```

It never overwrites developer-authored values.

Hosts address these skills as `afk-skills:<name>` (Claude Code) or by their
unique `afk-`prefixed name on flat-namespace hosts. A personal skill with the
same name overrides a plugin skill — invoke the qualified form, or rename the
local one.

## Project configuration

The consuming repository may contain a local, gitignored `.afk/` directory:

```text
.afk/
  config.md
  runs/
    <run-id>/
      ledger.md
      PR#<n>-<title>.md
```

Each run owns one `runs/<run-id>/` directory — its ledger and its final reports
together. Runs never share a path, so concurrent runs in one repository cannot
overwrite each other. `.afk/` lives in the main working tree, so a run spanning
several linked worktrees keeps one ledger and stays visible to other runs.

All fields in `.afk/config.md` are optional. Blank or absent values resolve to
safe defaults or auto-detected commands.

```markdown
# afk config

## commands
test:  <cmd>
lint:  <cmd>
build: <cmd>

## external gate
gates:    codex
# gates:  codex > kimi   # opt-in: ordered double review (Codex outer → Kimi final)
priority: codex > claude > kimi > glm
# implementer:   # who writes the code, if not the driver; may only block a gate

## forge
# forge:                 # github · azure-devops
# azure-organization:    # https://dev.azure.com/<org>, for a cross-host setup
# github-repository:     # [HOST/]OWNER/REPO, likewise

## checks
# remote-ci:             # expected (default) · detect · absent

## merge
policy: leave-open

## resume
auto-resume: notify   # off · notify (default) · auto

## invariants
```

`gates` defines ordered required roles and their count; `priority` is only the
fallback pool. The built-in default is a single Codex review; per handoff,
explicit role flags (`-codex -kimi`) select that run's ordered roles and
override `gates`. Existing configs with legacy `priority`/`min-pass`/`mode`
and no `gates` keep their prior behavior until the operator opts in. A config
bootstrapped before 0.4.0 carries a template-written `gates: codex > kimi`;
delete the line (or set `gates: codex`) to adopt the single-gate default.

Explicit `gates:` and `priority:` profiles may also name `deepseek` or `mimo`.
They remain opt-in and do not alter the built-in sequence or fallback pool.

An optional `design-gate:` key runs one external role over the *design doc*
before any code is written — `off` (default), `risky` (design-heavy or
high-blast-radius issues only), or `on` (every issue).

## Credentials

Secrets never belong in `.afk/config.md`; use environment variables or a
gitignored `.env`. The API-backed gates call the provider directly and do not
import credentials from any editor or extension.

GLM defaults to the OpenAI Chat Completion protocol at the Coding Plan endpoint
`https://api.z.ai/api/coding/paas/v4`. Set `GLM_REVIEW_PROTOCOL=anthropic` to
use the Anthropic Messages endpoint at `https://api.z.ai/api/anthropic`.
`GLM_REVIEW_BASE_URL` overrides the selected default; the protocol is never
inferred from the URL, so the two settings must agree.

For the current shell, export only the provider you intend to use:

```bash
export ZAI_API_KEY="<your-zai-key>" # GLM; GLM_API_KEY is also accepted
export DEEPSEEK_REVIEW_API_KEY="<your-deepseek-key>"
export MIMO_REVIEW_API_KEY="<your-mimo-token-plan-key>"
```

For a persistent per-repository setup, put the same assignment without
`export` in the local `.env`. Before adding a real value, verify the ignore rule:

```bash
git check-ignore -v .env
```

If that command prints no matching rule, do not put a credential in the file;
run `/afk-init` or add `.env` to a local Git exclude first.

The snapshot-backed API gates (GLM, DeepSeek, MiMo) and the agent relay filter
their payload before it leaves the machine: secret-bearing paths (`.env`, keys,
credential and secret files) are dropped from the snapshot, and known token
shapes are redacted from what is sent.

GLM and DeepSeek default to a 160000-byte input snapshot and 65536 output
tokens; MiMo retains the shared 400000-byte / 8192-token defaults. Code-review
snapshots place exact referenced tracked files ahead of full changed-file
contents and report references omitted by the byte budget. Each family keeps
environment overrides for both limits.

### Which forge

`forge` decides which tracker an issue id is read from. Left unset it is detected
from the `origin` remote, and falls back to GitHub when nothing matches. Set it
explicitly when the code host and the tracker are not the same service: the id
reaches whichever CLI the forge selects, and the CLI of a different forge can
answer for that id and succeed, putting another tracker's issue into the plan.
That cross-host case also needs the key naming the tracker itself —
`azure-organization` or `github-repository` — because there is no remote to read
it from and each CLI would otherwise take one from the checkout or its own
environment. A forge that cannot be served is named where it is needed rather
than attempted.

### What an empty check reading means

`remote-ci` says what to do when the forge names no required check for a
revision, or cannot be asked at all. `detect` (the default) settles it once the
run's re-read window closes; `absent` settles it at once, for a repository the
operator knows runs none; `expected` never settles it, for one that must always
report. It adds no required check of its own; what counts as required is the
forge's answer — a forge that draws no required/advisory line has every check it
reports read as required.

Where no required check constrained a revision, the ordered roles and the local
suite are the whole of what the run applied, and both are evaluation the driver
performs on itself. A required check is one of the few control points outside
that authority, so every such revision is named in the end-of-run report.

## Merge policies

Configured in `.afk/config.md`:

- `leave-open` prepares the PR and leaves it for operator approval.
- `merge-to-unblock` merges only when needed to unblock the scoped queue.
- `merge-when-green` merges when checks and required gates pass.

## Resuming a paused run

An overnight run's wake-up tick is in-session and not durable: a rate limit,
window restart, or the host sleeping ends it silently, leaving the run
`state: active` with a going-stale heartbeat. A bundled `SessionStart` hook
(`hooks/afk-resume-detect.mjs`) closes the common recovery path — when you reopen
a window on the repo, it detects a paused, resumable run and surfaces its
run-id, ledger path, and scope so you do not have to hunt for it. It is a pure
no-op outside an afk repo, never blocks a session, and only ever surfaces a run
whose heartbeat is stale (a fresh heartbeat means a live tick still owns it).

The `auto-resume` knob in `.afk/config.md` sets the behaviour:

- `off` — no resume detection (the stale-install notice below is separate).
- `notify` (default) — surface the paused run; you decide whether to resume.
- `auto` — for a single unambiguous run, also direct an autonomous resume unless
  your first message redirects. Two or more paused runs are only ever listed,
  never auto-driven (each needs its own session).

The hook is not a scheduler — it cannot start a turn on its own, so it does not
replace a durable external scheduler.

## Staying up to date

The install cache is keyed by the plugin version, so an outdated install
silently keeps serving old skills — and invoking a satellite skill directly runs
no kickoff check that would say so. The `afk` driver checks at kickoff, and the
same `SessionStart` hook checks too. The answer is cached in
`.afk/update-check.json` (checked at most once a day), is read-only and bounded,
degrades silently offline, and never blocks. Silence it with
`AFK_UPDATE_CHECK=off`.

Installing the update stays yours to do from your agent host; no skill updates
itself.

## Common invocations

```text
/afk-init
/afk-spec-planner issue 123
/afk-implementation-pilot
/afk issue 123
/afk-internal-review PR 456
/afk-codex-review
/afk-claude-review
/afk-kimi-review
/afk-glm-review
/afk-deepseek-review
/afk-mimo-review
```

## Repository layout

```text
skills/       Source skills shipped by the plugin.
scripts/      Validation, manifest sync, receipt checking, and manual behavior evaluation.
lib/          Shared runtime imported by bundled scripts and hooks.
hooks/        Plugin-level hooks (SessionStart auto-resume, update notice).
templates/    Starter `.afk/` files for consuming repositories.
docs/         Design and operating notes.
```

## Developing this plugin

Run the local checks before opening a PR:

```bash
npm run sync:check
npm run lint:skills
npm run lint:links
npm run scan:provenance
npm test
```

Refresh generated manifests after changing the skill set:

```bash
npm run sync
```

Bump the plugin version in any PR that changes `skills/`, `scripts/`, `lib/`,
`hooks/`, `templates/`, or the manifests. Host install caches use the version as
the update key.

## Contributing

Read [AGENTS.md](AGENTS.md) before changing this repository. It is the canonical
guide for agents and humans; [CONTRIBUTING.md](CONTRIBUTING.md) is the short
human version.

## License

Apache-2.0. See [LICENSE](LICENSE).
