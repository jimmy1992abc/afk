# Claude External Review Gate — Design Spec

- **Date:** 2026-07-17
- **Status:** Proposed (revision 3; revisions 1 and 2 were refuted — see Appendix)
- **Scope:** Add `afk-claude-review`, a fourth external review gate driven by the
  Claude Code CLI, and extract the logic the existing gates share into a lib the
  four of them import.

---

## Problem

The pipeline requires an external gate whose model is **not** the implementer's
(`skills/afk/SKILL.md`, "External gate"). The three gates that exist are Codex,
Kimi, and GLM. When Codex is the implementer, the surviving choices are Kimi and
GLM. An operator whose only other frontier subscription is Claude therefore has
no qualifying gate, and the round degrades to `SKIPPED` — which `afk` admits only
as a last resort and which means the PR is never independently checked.

The original plugin spec named this gap and deferred it: an "internal Claude
gate" was recorded as "a documented future slot"
(`2026-07-08-afk-plugin-design.md`, Non-goals). This spec fills that slot.

A second problem is structural. The three gates were written by copying the
previous one. `detectBase`, `optVal`, the `--base/--commit/--uncommitted`
selector, `emitSkip`, and the marker-block protocol exist in two or three
near-identical copies. AGENTS.md forbids exactly this ("No duplication. Import a
shared helper or constant; never copy it"). A fourth gate written the same way
makes four copies and cements the pattern.

## Goals

1. A Claude gate interchangeable with the existing three: same CLI surface, same
   opt-out, same marker-block output contract, same self-skip discipline.
2. A gate that is read-only **by construction**, not by enumeration.
3. A gate that does not review a Claude implementer's work, with every remaining
   fail-open path named.
4. One definition of each shared behavior, imported by all four gates.
5. Where the migration changes an existing gate's behavior, that change is
   **named and versioned**, not smuggled in as a refactor.

## Non-goals

- No Anthropic REST transport (Decision 1).
- No sandbox or container for the reviewer. Decision 6 removes the need for one.
- No new implementer-identity subsystem in `afk`. The gate accepts an optional
  `--implementer`; `afk` gains one sentence telling it to pass the flag when the
  implementer is not the driver. Revision 2 claimed this was out of scope while
  depending on it — see Decision 2.

## Scope honesty: who this gate actually runs for

Under Decision 2 the gate self-skips whenever the implementer resolves to Claude,
which includes the default case of Claude Code driving `afk`. **For an operator
whose driver is Claude Code, this gate is inert and the effective priority is
unchanged from today.** It earns its place for the operator in the Problem
statement: Codex (or Kimi/Gemini/Copilot) implements, Claude reviews. The
`priority` default is not a promise that it runs for most installs.

---

## Decision 1 — Transport: the Claude Code CLI, not the REST API

**REST (`ANTHROPIC_API_KEY` → `/v1/messages`).** `glm-gate.mjs` already speaks the
Anthropic message shape, so a Claude REST gate is ~90% of it with a different
base URL and model.

**CLI (`claude -p`).** Spawn the CLI headless with a read-only tool set.

CLI wins on two counts:

- **Auth.** It uses the operator's existing Claude subscription. The REST path
  needs a separate API key on separate metered billing, which few subscription
  holders have. The two CLI gates already establish subscription auth as the norm.
- **Review quality.** A REST gate sees a bounded snapshot — the diff plus changed
  files, truncated at a byte budget; `glm-gate`'s own skill warns the reader to
  "verify findings that depend on files outside that context". The CLI reviewer
  gets `Read`/`Grep`/`Glob` over the whole tree and can chase a finding wherever
  it leads. This survives Decision 6: unbounded repo access comes from the read
  tools, never from a shell.

## Decision 6 — Read-only by construction: no Bash

*(Ordered first among the mechanism decisions because two revisions died here.)*

The reviewer runs with `--tools "Read,Grep,Glob"`. There is no Bash tool, so
there is nothing to enumerate, nothing to allowlist, and no list that can rot as
git's flag surface grows.

**Why not an allowlisted Bash.** Two revisions tried and both were broken on the
first attempt:

- `Bash(git *)` — the reviewer ran `git checkout -- file.txt`; the harness
  permitted it and the working tree was reverted.
- `Bash(git diff:*)` and seven other read-only-looking verbs — the reviewer ran
  `git diff --output=src.js`; the harness permitted it, and git **truncated the
  file before diffing it**, destroying uncommitted work that was never committed
  and has no reflog or stash to recover from. `git log` and `git show` carry the
  same `--output`/`-o` primitive.

The root cause is a granularity mismatch: Claude Code's Bash permission matcher
works at **command-prefix** granularity, while the danger lives at **flag**
granularity. `Bash(git diff:*)` structurally cannot express "…but not
`--output`". A denylist fails identically — `--disallowedTools "Bash(git diff
--output:*)"` is also prefix-anchored and misses `-o x`, `--output x`, and
`git diff HEAD --output=x`. `git diff` cannot be made safe by enumeration, so the
mechanism is wrong, not the list.

Verified for the chosen design: asked to run `git diff --output=src.js`,
`git log --output=…`, `git show --output=…`, and to write a file by any means, the
reviewer reported all four impossible — *"not by a policy check, but because this
agent session simply has no shell-execution or file-write tools loaded"* — the
tree was byte-identical afterward, and it still read the file correctly.

**Consequence:** the reviewer has no shell, so the gate must **pre-inject** the git
output it needs (diff, stat, scope label). `glm-gate.mjs` already computes exactly
this. That gives the context builder a second consumer, so it moves into the
shared lib rather than staying gate-local.

`--setting-sources ""` is still passed: `--allowedTools` and the settings
allowlists are additive, and `--safe-mode` disables customizations but explicitly
keeps permissions working normally. With no Bash it is defense in depth rather
than load-bearing — an operator's `permissions.allow` cannot grant a tool that
`--tools` never loaded.

**The claim, stated exactly:** Write, Edit, and shell execution are absent from the
reviewer's session. The gate does not claim a sandbox and does not need one.

## Decision 2 — Self-review guard: explicit flag, config may only tighten

The `afk` rule "each gate's model is not the implementer's model" is prose. For
the other three gates that is tolerable: a Codex implementer will not reach for
`afk-codex-review`, because it is obviously wrong. The Claude gate is different —
**the default afk driver is Claude Code** — so the natural failure is silent and
constant.

Resolution:

1. `--implementer <family>` — per-invocation. May tighten **or** loosen. It is the
   only source that cannot go stale, so it is the only one allowed to loosen.
2. `implementer:` in `.afk/config.md` — **tightener only**. It can cause a skip; it
   can never permit a run that `CLAUDECODE` would have blocked.
3. `CLAUDECODE` in the environment — the default signal. Claude Code sets it in
   every process it spawns.

The gate skips iff the resolved implementer is Claude. Family strings are
enumerated (`claude`/`anthropic` + Claude model aliases → Claude; `codex`,
`kimi`, `glm`, `gemini`, `copilot`, …). An **unrecognized** value is unreliable
input and fails **closed** — skip, with its own reason.

Two rejected alternatives, both the same pathology:

- A sticky `CLAUDE_REVIEW_ALLOW_SELF=1` env var: an operator using
  `afk-agent-relay` sets it once in a shell profile and permanently kills the
  guard — including on runs where Claude really is the implementer.
- Config `implementer:` outranking `CLAUDECODE` (revision 2's design): identical
  failure one layer down. `.afk/config.md` is per-repo, gitignored, and written
  once; `CLAUDECODE` is live and per-run. Letting a stale per-repo file outrank a
  live per-run signal is how the guard dies quietly. Hence tightener-only.

Config **earns its place** as a tightener: an operator whose Claude implementer
runs from Copilot or Cursor writes `implementer: claude` and closes the fail-open
below.

**Named fail-open** (AGENTS.md requires this): source 3 detects the *driver*, not
the model. A Claude implementer driven from a non-Claude-Code surface, a CI
re-run, or a plain terminal against a branch Claude wrote leaves `CLAUDECODE`
unset, so the gate runs. Sources 1 and 2 are the only ways to close it. The guard
closes the common case; it is a backstop to `afk`'s prose rule, not a replacement.

The self-guard's skip reason is distinct from every "cannot run" reason, so a
ledger reader can tell "correctly declined" from "could not review".

## Decision 3 — Shared lib at `lib/gate/`

Verified against a real install
(`~/.claude/plugins/cache/afk/afk-skills/0.2.0/`): the whole repo ships. The
`skills: [...]` array enumerates skills for *discovery*; `source: './'` is what
ships, and there is no `files` allowlist. A repo-root `lib/` resolves at runtime
in an installed plugin. Gates import it relatively (`../../lib/gate/…`), resolved
from the importing file's own URL and so independent of `pluginRoot`.

Root, rather than under a skill, because **no gate should own the lib the other
three import**. The repo's per-skill `lib/` precedent
(`skills/afk-agent-relay/lib/`) has exactly one consumer — the case that justifies
per-skill placement. Cross-skill ownership is the difference.

| Module | Contents | Consumers |
|---|---|---|
| `protocol.mjs` | `emitSkip` / `emitReview` / `emitError`; marker block from a gate label | 4 |
| `env.mjs` | `isGateDisabled(varName)` | 4 |
| `git.mjs` | `git`, `hasRef`, `detectBase`, `resolveBase` (Decision 7) | 4 |
| `target.mjs` | selector parsing → scope label + diff/stat/changed files | glm, claude (parsing only: codex, kimi) |
| `prompt.mjs` | severity taxonomy, finding format, verdict line, "output only the review" | kimi, glm, claude |

`prompt.mjs` holds **only the transport-invariant part**. The context clause is
*not* duplication — it is a real difference between a reviewer that can read the
repo (kimi, claude) and one that cannot (glm, which gets a snapshot and no tools).
A single shared clause would either tell a tool-less model to "inspect with
`git diff`", inviting a fabricated "I ran git and found…", or strip the
read-the-surrounding-files push that is half of Decision 1's quality argument.
Each gate supplies its own context clause.

Honest accounting: `emitError` is a **new** function, not a consolidation — glm has
none, kimi has none, codex writes its error markers inline. Codex consumes
`target.mjs`'s parsing only; it forwards selector flags to `codex exec review`
and builds no scope label and no prompt.

**Not extracted** (one consumer): Codex's machine-wide lock, Codex's `exec review`
invocation, glm's full-file-contents packing (claude needs the diff, not the
files — it can `Read` them).

**`lib/` must be added to the version-bump gate.** `scripts/check-version-bump.mjs`
requires a bump only for `skills/`, `scripts/`, and the manifests. Moving shipped
runtime behavior into `lib/` would put it in the one directory the guard does not
watch — and the version being the install cache key, every install would keep
running the stale lib. `requiresBump` gains `lib/`, with a test.

## Decision 7 — Base resolution: a named fix, not a refactor

The three gates disagree today. `glm-gate.mjs` promotes a bare base to its
remote-tracking ref (`main` → `origin/main` when that ref exists); `codex-gate.mjs`
and `kimi-gate.mjs` diff against the bare local ref. One shared `resolveBase`
must pick one, so the extraction **cannot** be behavior-preserving here.

The promotion is correct: a stale local `main` makes a gate review the wrong
commit range and report findings against commits that are not in the PR. Codex
and Kimi carry that defect today. The shared `resolveBase` adopts glm's
promotion, which **fixes codex and kimi** and leaves glm unchanged.

This ships as a deliberate behavior change: its own invariant row, a test pinning
the resolved range against a real repo with a stale local `main`, a note in the
PR body, and the version bump. Test-plan step 2's "green unchanged" is retracted
for these assertions specifically — they are written against the new behavior.

## Decision 8 — kimi's missing marker block is a bug, pinned to new behavior

`kimi-gate.mjs` writes only to stderr and exits nonzero with **no marker block**
when no review is produced; `codex-gate.mjs` always emits one. Two invariants
below are therefore already false of kimi. Characterization tests pin *current*
behavior, so pinning this one would pin the bug and `protocol.mjs` would not be
"one definition" after all.

So each inter-gate difference is classified up front — **preserve** or **fix**:

| Difference | Verdict |
|---|---|
| kimi emits no marker block on failure | **fix** — always emit; pin to new behavior |
| kimi/codex do not promote the base ref | **fix** — Decision 7 |
| Marker strings, opt-out spellings, exit codes, codex's lock | **preserve** — green before and after |

"Behavior-preserving" is neither achievable nor desirable across three gates that
already disagree. What is achievable: every difference is decided on purpose.

## Decision 4 — Parse `--output-format json`, never the exit code

Verified: `claude -p --output-format json` with an unavailable model returns
**exit code 0** with `{"is_error": true, "api_error_status": 404, "result": "…"}`.
An exit-code-driven gate would report a failed review as a successful one.

| Condition | Outcome |
|---|---|
| `is_error` + status 401/403 | `SKIPPED: not authenticated` |
| `is_error` + status 404 | `SKIPPED: configured model unavailable` |
| `is_error`, other | `ERROR` + nonzero exit |
| otherwise | `result` is the review |

This replaces `kimi-gate`'s stderr keyword-sniffing with a machine-readable
contract. The envelope's `permission_denials` array goes to the transcript, so a
reviewer blocked from a tool it needed leaves a trace.

## Decision 5 — No silent model fallback

`CLAUDE_REVIEW_MODEL` defaults to `opus`. `--fallback-model` is deliberately not
passed: a gate that quietly reviews with a weaker model than the operator
believes is a quality regression with no visible symptom. An unavailable model
becomes a recorded `SKIPPED` (Decision 4).

---

## Behavior

```text
node "<helper-dir>/claude-gate.mjs" [--base <branch> | --commit <sha> | --uncommitted]
                                    [--implementer <family>]
```

Skips cleanly (marker block, `SKIPPED: …`, exit 0), each reason distinct: disabled
via `CLAUDE_REVIEW_GATE=off`; implementer resolves to Claude; implementer value
unrecognized; the `claude` CLI is absent; not authenticated; configured model
unavailable; target has no changes.

```text
claude -p "<review prompt with the diff pre-injected>"
  --model <CLAUDE_REVIEW_MODEL|opus>
  --effort <CLAUDE_REVIEW_EFFORT|medium>
  --output-format json
  --tools "Read,Grep,Glob"
  --setting-sources ""
  --safe-mode
  --no-session-persistence
```

`--safe-mode` is the Claude equivalent of `codex-gate`'s `project_doc_max_bytes=0`:
review the diff, not the project's doc corpus. It also stops the afk plugin's own
skills from loading into the reviewer. `--bare` would be closer but forces
`ANTHROPIC_API_KEY`-only auth, defeating Decision 1. `--disable-slash-commands` is
redundant under `--safe-mode`.

`CLAUDE_GATE_BIN` overrides the resolved `claude` binary so the skip matrix can be
tested against a stub without spending a metered call.

## Config surface

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_REVIEW_GATE` | *(unset)* | `off` disables the gate |
| `CLAUDE_REVIEW_MODEL` | `opus` | reviewer model |
| `CLAUDE_REVIEW_EFFORT` | `medium` | reasoning effort |
| `CLAUDE_GATE_BIN` | *(unset)* | override the `claude` binary (testing) |

Implementer is deliberately **not** an env var — env vars are sticky, which is the
pathology Decision 2 rejects twice.

`templates/afk-config.example.md` gate priority becomes
`codex > claude > kimi > glm` and gains an optional `implementer:` line.

## Invariants

| Invariant | Enforced by | Pinned by |
|---|---|---|
| The reviewer cannot write, anywhere, by any means | `--tools "Read,Grep,Glob"` — no Bash, no Write, no Edit | real-boundary test: tmp repo, real CLI, forced write attempts incl. `git diff --output=<file>`; tree hash byte-identical. Self-skips when the CLI is absent |
| A gate never reviews a resolved Claude implementer | implementer resolution, `claude-gate.mjs` | skips on `--implementer claude`, on config `implementer: claude`, on `CLAUDECODE=1`, and on an unrecognized value; runs on `--implementer codex` even with `CLAUDECODE=1` |
| Config can only tighten the guard | resolution order | test: config `implementer: codex` + `CLAUDECODE=1` → still skips |
| A failed review is never reported as success | `is_error` parsing, not exit code | test: `is_error` envelope → SKIPPED/ERROR, never a review |
| Every skip is distinct and exits 0 | `emitSkip`, `protocol.mjs` | test per skip reason, all 4 gates |
| Marker block always emitted, stable per gate | `protocol.mjs`, label param | test per gate, incl. kimi's failure path (Decision 8) |
| Base resolves to the remote ref when it exists | `resolveBase`, `git.mjs` | test: real repo, stale local `main` + fresh `origin/main` → asserted range, per gate |
| Shipped runtime changes force a version bump | `requiresBump` covers `lib/` | test in `check-version-bump.test.mjs` |
| Every gate is a listed surface | plugin manifests | test: afk SKILL.md + README + config template name the gate |

## Test plan

1. **Characterization tests first**, against the unmigrated files, pinning only
   the **preserve** rows of Decision 8: opt-out spellings, exact marker strings,
   exit codes, codex's lock (via its `--selftest-lock` hook). Push this commit
   **alone** so CI runs it green on the unmigrated tree, and link that run in the
   PR body — squash-merge destroys the intermediate commit, so without this the
   "green before" claim is unverifiable by any reviewer and indistinguishable
   from tests retrofitted to pass the new code.
2. **A `--print-args` dry-run hook per gate** (codex's `--selftest-lock` is the
   precedent). Revision 2's tests pinned only early-exit paths — the disabled skip
   returns before `detectBase` runs, and the CLI-absent skip returns before the
   resolved argv is ever printed — so a regression in `detectBase` or the target
   selector could not have failed any of them. The hook makes the extracted
   surface observable: `origin/HEAD` present; absent + `main`; absent + `master`;
   neither; `--base` last with no value; `--commit` and `--uncommitted` together;
   codex's unknown-flag passthrough.
3. **Extract and migrate**, with step 1 green unchanged and step 2's base-ref
   assertions rewritten to the Decision 7 behavior.
4. **Add claude-gate**: skip matrix against a `CLAUDE_GATE_BIN` stub, the
   `is_error` branches, and the real-boundary read-only test.

`lib/gate/` gets unit tests per module, with `detectBase`/`resolveBase` exercised
against real temporary repos rather than stubs. `scripts/glm-gate.test.mjs:31`
asserts the priority string `codex > kimi > glm` and must be updated with the
template.

## Risks

- **`CLAUDECODE` is a Claude Code implementation detail** used only as the default
  source. If renamed, the guard fails open to `afk`'s prose rule; `--implementer`
  is unaffected. Pinned by a test.
- **The guard is a driver proxy, not a model check** — the named fail-open in
  Decision 2.
- **Decision 7 changes what codex and kimi review.** That is the point, but it is a
  behavior change to two working gates, shipped on the strength of an argument
  plus a test rather than field evidence.
- **`--tools` is the whole read-only boundary.** If a future CLI version loads a
  writing tool by default despite `--tools`, the property breaks silently. The
  real-boundary test is what would catch it; it self-skips when the CLI is
  absent, so it must not be the only thing keeping CI honest.

---

## Appendix: refuted claims

Recorded because each was believed and wrong. The design is only as good as the
attempts to break it — and the read-only claim was broken twice, on the first
attempt each time.

**Revision 1**

1. *"Read-only is enforced by the harness with `Bash(git *)`."* False — the
   reviewer ran `git checkout --` and the tree was mutated.
2. *"`lint-skills.mjs` errors on any directory under `skills/` without a
   SKILL.md."* False — it does not recurse; `skills/afk-agent-relay/lib/` ships
   today. The root-`lib/` conclusion survived on a different reason.
3. *"Existing tests keep the migration honest."* False — codex and kimi had none.
4. *"An unavailable model emits SKIPPED."* Unimplementable as stated; exit code is
   0 on error.

**Revision 2**

5. *"The verb allowlist makes the gate read-only; an unanticipated verb fails
   closed."* False, and worse than (1) — `git diff --output=<reviewed file>` was
   permitted and destroyed unrecoverable uncommitted work. Unanticipated *flags on
   allowed verbs* fail **open**. Drove Decision 6.
6. *"Config `implementer:` is per-run, so it declares rather than disables."*
   False — per-repo, gitignored, written once, and it outranked the live signal:
   the sticky env var re-created one layer down.
7. *"The extraction is behavior-preserving."* False — glm promotes the base ref,
   codex and kimi do not. Drove Decisions 7 and 8.
8. *"Characterization tests mitigate the migration risk."* Not as written — they
   pinned early-exit paths, not the code being extracted. Drove step 2.
9. *"The Bash prefix matcher can be escaped with `;`, `&&`, `$( )`, or `>`."* My
   own hypothesis, **refuted** — all four were denied. The matcher parses; it is a
   sound shell-injection barrier. It simply cannot see flags, which is why
   Decision 6 removes Bash rather than constraining it.
