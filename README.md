# AFK Skills

Autonomous PR-pipeline skills for AI coding agents.

`afk-skills` packages a stack-agnostic workflow for handing a scoped software
task to an AI coding agent and getting back PR-ready work: planning,
implementation, self-review, internal review, independent external review, final
checks, and handoff.

The plugin stays generic. Project-specific commands, merge preferences,
invariants, reports, and run ledgers live in the consuming repository's
gitignored `.afk/` directory.

## What It Provides

| Skill | Purpose |
|-------|---------|
| `afk` | Runs the full autonomous waterfall for an operator-provided scope. |
| `afk-init` | Bootstraps `.afk/config.md` for a consuming repository. |
| `afk-spec-planner` | Turns an issue into a reviewable implementation plan. |
| `afk-implementation-pilot` | Implements an approved plan and self-reviews it. |
| `afk-internal-review` | Performs the internal production-readiness review. |
| `afk-codex-review` | Runs Codex as an independent external review gate. |
| `afk-kimi-review` | Runs Kimi as an independent external review gate. |
| `afk-agent-relay` | Offloads large reads or scoping work to an external model. |

## Pipeline

```text
scope
-> design / plan
-> targeted tests
-> implementation
-> self-review
-> pull request
-> CI
-> internal review
-> independent external gate
-> full final test suite
-> owner approval or configured merge policy
```

`afk` only runs against an explicit operator-provided scope. It does not browse a
tracker and choose work by itself.

## Installation

Install this repository through the host agent's plugin flow.

The repository ships manifests for the supported host layouts:

- `.codex-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `.agents/plugins/marketplace.json`
- `.github/plugin/marketplace.json`
- `plugin.json`

After installing the plugin in a target repository, run:

```text
/afk-init
```

`afk-init` creates or fills local `.afk/` configuration without overwriting
developer-authored values.

## Project Configuration

The consuming repository may contain a local, gitignored `.afk/` directory:

```text
.afk/
  config.md
  reports/
  afk-ledger.md
```

All fields in `.afk/config.md` are optional. Blank or absent values resolve to
safe defaults or auto-detected commands.

```markdown
# afk config

## commands
test:  <cmd>
lint:  <cmd>
build: <cmd>

## external gate
priority: codex > kimi
min-pass: 1
mode:     waterfall

## merge
policy: leave-open

## invariants
```

Secrets never belong in `.afk/config.md`; use environment variables or a
gitignored `.env`.

## Common Invocations

```text
/afk-init
/afk-spec-planner issue 123
/afk-implementation-pilot
/afk issue 123
/afk-internal-review PR 456
/afk-codex-review
/afk-kimi-review
```

## Merge Policies

Configured in `.afk/config.md`:

- `leave-open` prepares the PR and leaves it for operator approval.
- `merge-to-unblock` merges only when needed to unblock the scoped queue.
- `merge-when-green` merges when checks and required gates pass.

The plugin never deploys.

## Developing This Plugin

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

Bump the plugin version in any PR that changes `skills/`, bundled scripts, or
manifests. Host install caches use the version as the update key.

## Repository Layout

```text
skills/       Source skills shipped by the plugin.
scripts/      Manifest sync, lint, link, provenance, and version checks.
templates/    Starter `.afk/` files for consuming repositories.
docs/         Design and operating notes.
```

## Contributing

Read [AGENTS.md](AGENTS.md) before changing this repository. It is the canonical
guide for agents and humans; [CONTRIBUTING.md](CONTRIBUTING.md) is the short
human version.

## License

Apache-2.0. See [LICENSE](LICENSE).
