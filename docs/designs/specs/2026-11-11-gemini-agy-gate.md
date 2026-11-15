# Gemini review gate over the Antigravity CLI (issue #145)

## Spec review

`afk-gemini-review` (#143, v1.4.0) calls Google's OpenAI-compatible REST API
and needs `GEMINI_REVIEW_API_KEY`. Operators who use Gemini through an
Antigravity sign-in have no such key, so the gate always skips. This change
replaces the transport with the signed-in Antigravity CLI (`agy`), modelled on
`afk-claude-review`: a pre-injected diff on stdin, a JSON result envelope, and
an identity check. The opt-in selection rules from #143 are unchanged.

## Frozen issue contract

1. `skills/afk-gemini-review/gemini-gate.mjs` drives `agy` with the existing
   CLI-gate parts: receipt protocol, `guardFor`, `parseTarget` /
   `validateTarget` / `collectDiff` / `readDesign`, prompt builders,
   `loadReviewContext`, `gateWorkDir`, `resolveCliBin` / `spawnCli`, and
   `classifyChildOutcome`. It adds no new spawn wrapper or HTTP client. It
   supports the same targets, markers, `--print-args` / `--print-prompt`,
   review context and receipts.
2. Model: `GEMINI_REVIEW_MODEL`, default `gemini-4-argon-high`. Only a
   versioned `gemini-*` ID matching `^gemini-[A-Za-z0-9._-]*\d[A-Za-z0-9._-]*$`
   is accepted. Anything else (`claude-*`, `gpt-*`,
   an unversioned or malformed name) is an `ERROR` before any spawn. The
   effort is part of the model ID; the receipt records `effort: null`.
3. Identity: the run must report its model in the stream-json `init` event,
   equal (case-insensitively) to the requested ID. A missing or different
   identity is an `ERROR`. The verdict is discarded. Only the first `init`
   event counts. The prompt forbids subagents and swarms. Every
   `step_update` must have a `step_type` in the allowlist `user_input`,
   `agent_response`, `tool`; any other step type (observed: `subagent` for
   `invoke_subagent`), a missing step type, or a `tool` step whose
   `tool_name` contains `agent`, `swarm` or `team` makes the run an `ERROR`.
   A delegated worker may run on any model `agy` offers, including Claude, so
   its contribution cannot be attributed to the verified session model. The
   allowlist fails visible on shapes nobody has observed.
4. Completion: a verdict is accepted only from a `result` event with
   `status: "SUCCESS"` and no `finished_reason`, with exit 0 and no spawn
   error. Order of classification, mirroring claude-gate: (0) `ENOENT`, an
   unresolved binary, or a Windows shell "not recognized" message with empty
   stdout → `SKIPPED` (missing binary); `UNSAFE_SHELL_ARG` → `ERROR`;
   (a) spawn timeout, signal, or another launch error other than `EPIPE` →
   `ERROR`; (b) a `result` event with `status: "ERROR"`
   whose error text matches an unavailability class (item 7) → `SKIPPED`,
   regardless of exit code, the same way claude-gate reads its error
   envelope before the exit code; (c) anything else that is not a clean
   success, including a nonzero exit, a missing `result`, any
   `finished_reason`, and `EPIPE`, → `ERROR`. `EPIPE` (the CLI exited before
   reading a large stdin) can therefore only become a skip through (b), never
   a verdict. `finished_reason: "print_timeout"` and exit 3 are reported as
   timeouts. The receipt records `completion: null` and the exit code. The
   receipt checker (`lib/gate/review-receipt.mjs`) accepts exit 0 as
   completion for `gemini`, as it does for the other CLI families.
5. Transport: `--input-format stream-json --output-format stream-json`, one
   NDJSON line `{"event":"user","message":{"content":<prompt>}}` on stdin.
   No prompt bytes go on argv.
6. Read-only boundary: argv always carries `--mode plan` and `--sandbox`. The
   prompt forbids modifying files and creating plans or artifacts. The
   boundary is documented as mode-, sandbox- and prompt-enforced, not enforced
   by construction.
7. Availability: missing binary, a sign-in failure, a model the account does
   not offer (the message points to `agy models`), a rate limit,
   `GEMINI_REVIEW_GATE=off`, or a Gemini implementer → `SKIPPED`. Unknown
   failures → `ERROR`.
8. Bounds: `GEMINI_REVIEW_TIMEOUT_MS` / `AFK_REVIEW_TIMEOUT_MS` (shared 15 min
   default) becomes `--print-timeout <seconds>s`, rounded up with a 1 s minimum
   (`0s` would mean "no bound"), plus a 60 s spawn-timeout backstop. `GEMINI_REVIEW_MAX_CTX_BYTES` (default 400000) bounds the diff; an
   oversized diff is an `ERROR`, never truncated.
9. Controls: keep `GEMINI_REVIEW_GATE`, `GEMINI_REVIEW_MODEL`,
   `GEMINI_REVIEW_MAX_CTX_BYTES`, `GEMINI_REVIEW_TIMEOUT_MS`; add
   `GEMINI_GATE_BIN` (default `agy`). Remove `GEMINI_REVIEW_API_KEY`, the
   `GEMINI_API_KEY` fallback, `GEMINI_REVIEW_BASE_URL`,
   `GEMINI_REVIEW_MAX_OUTPUT_TOKENS`, `GEMINI_REVIEW_REASONING_EFFORT` and
   `GEMINI_REVIEW_EXCLUDE_GLOBS`. The shared snapshot gate's `reasoningEffort`
   descriptor, used only by the REST gate, is removed by restoring
   `lib/gate/openai-snapshot-gate.mjs` to its pre-#144 content.
10. The gate never reads, copies or logs `~/.gemini/` credential files.
11. `gemini` stays a receipt family and an explicit `gates:` / `priority:` /
    role-flag family. Built-in defaults are unchanged.
12. Tests use a stub `agy` through `GEMINI_GATE_BIN`; CI makes no live call. A
    live smoke review runs locally before merge and is recorded in the PR.
13. Version 1.4.0 → 1.4.1 (operator instruction), manifests synced.

Non-goals: keeping the REST transport, `agy acp` / `--remote-agent`, reaching
non-Gemini models through `agy`, changing default role profiles, rewriting the
spec for #143.

## Contract corrections from repository and CLI evidence

Issue #145 was written before these probes; this contract corrects it:

- **No `--disable-slash-commands`.** Combined with `--mode plan`, `agy` warns
  `--mode plan has no effect while slash command expansion is disabled`. Plan
  mode is implemented as a slash command, so the flag would remove the main
  read-only control. Plan mode is kept; the flag is dropped.
- **Unknown model → `SKIPPED`, not `ERROR`.** `lib/gate/failure.mjs` and the
  external-review doctrine classify "configured model unavailable" as
  unavailability (`model_unavailable` → skip), the same as Claude's HTTP 404. A
  non-`gemini-*` ID is still refused as `ERROR` before spawn, because that is
  operator error and an independence hazard, not unavailability.
- **No `--settings` tool deny-list.** Neither `--help`, the changelog nor the
  binary's strings show a settings key that removes tools. The issue allowed
  this outcome; the boundary is documented as mode-enforced.
- **`agy` is often not on `PATH`.** The installer puts it at `~/.gemini/bin/agy`;
  `agy install` adds that to `PATH`. On the operator's machine it is not on
  `PATH`. The gate keeps the Claude/Kimi convention (bare name through `PATH`,
  explicit `GEMINI_GATE_BIN` override). The skip message names both remedies.
  No home-directory fallback is added.

## Observed CLI behaviour (agy 1.5.5, macOS arm64, 2026-11-11)

All probes ran in scratch directories, or in a disposable clone for the review
probe.

| Probe | Result |
| --- | --- |
| `--print` followed by `--model` | exit 2: `--print took "--model" as its prompt` |
| `--print=-` with stdin | `-` taken as the literal prompt |
| stdin `{"event":"user","message":"…"}` | `cannot unmarshal string into … StreamInputUserMessage` |
| stdin `{"event":"user","message":{"text":…}}` | `stream input "user" message has no content` |
| stdin `{"event":"user","message":{"content":…}}` | works; events `init`, `step_update`…, `result` |
| `init` event | `{"model":"gemini-4-argon-low","cwd":…,"tools":[…],"permission_mode":"request-review"}` |
| `result` event | `{"status":"SUCCESS","response":"…","usage":{…}}`; `finished_reason` absent on success |
| plan mode + sandbox, asked to create/append/`touch` | no workspace change; one `write_file` to `~/.gemini/antigravity-cli/brain/<id>/implementation_plan.md` |
| `--mode plan --disable-slash-commands` | warning: plan mode has no effect |
| `--model gemini-9-nonexistent` | exit 1, no `init`; `result.status: "ERROR"`, `result.error`: `… is not recognized as a known model …` |
| `HOME=<empty dir>` (signed out) | exit 1, no `init`; `result.status: "ERROR"`, `result.error`: `authentication failed or timed out`; stderr `authentication required` |
| research prompt asking for list/grep/find/read and a subagent | `read_file` step ran; the search/list tools were auto-denied (headless cannot grant `command` permission); delegation surfaced as `step_type: "subagent"`, `tool_name: "invoke_subagent"`; result `SUCCESS` with an empty response |
| task-style prompt in plan mode | the agent wrote only a plan artifact and asked for approval; it executed nothing |
| real review prompt (commit 07c06e3, `gemini-4-argon-high`, disposable clone) | exit 0; 8 × `read_file`; response ends `Verdict: APPROVE`; `git status` clean |

## Assumptions (unverified)

- **A1 Rate limits.** How `agy` reports quota exhaustion was not observed.
  The gate treats a `result.error` matching `429`, `rate limit`, `quota` or
  `resource exhausted` as a rate-limit skip. Anything else is an `ERROR`, so a
  wrong guess fails toward a visible error, never a silent clean. The
  changelog says `agy` itself retries 429/5xx (honouring `Retry-After`), so
  quota exhaustion will often surface as a `print_timeout` `ERROR` after the
  full bound and take the role's one transient retry, rather than a skip.
- **A2 Windows.** The install layout and `.exe`/shim shape on Windows are
  unverified. `resolveCliBin` / `spawnCli` already handle both shapes, and
  stdin carries the prompt, so no argv-length limit applies.
- **A3 Subagents.** Per the changelog, subagents and swarm workers carry their
  own model (any model in the picker) and may get their own repository copy.
  The prompt forbids them and the gate refuses a run whose stream shows one
  (item 3). Tool calls made by the session model itself are not otherwise
  restricted.
- **A4 Side artifacts.** Plan mode may write plan artifacts and conversation
  history under `~/.gemini/antigravity-cli/`, outside the repository. They are
  not cleaned up; this is documented.
- **A5 Workspace instructions.** `agy` may load the repository's `GEMINI.md`
  (this repo's points to `AGENTS.md`), `.agents/plugins/` and the user's global
  `~/.gemini/GEMINI.md`, as Kimi may load its own. Claude's `--safe-mode` has
  no known equivalent; `--disable-slash-commands` would disable plan mode.
- **A6 Data handling.** The REST gate sent a bounded snapshot that excluded
  secret-bearing paths and redacted secret shapes. This gate, like Claude and
  Kimi, sends the raw diff, and `agy` keeps the conversation (diff included)
  under `~/.gemini/antigravity-cli/`; there is no known equivalent of Claude's
  `--no-session-persistence`. `GEMINI_REVIEW_EXCLUDE_GLOBS` goes away with the
  snapshot. SKILL.md states this.

## Approach

Rewrite `gemini-gate.mjs` as a CLI gate shaped like `claude-gate.mjs`: build
the prompt from the diff or design document, spawn `agy` with the prompt on
stdin, parse NDJSON stdout, check identity and completion, and emit through
`emitVerifiedReview` with `requireVerdict`.

The working-tree drift caution and the untracked-files notice are shared with
`claude-gate.mjs` by moving them into `lib/gate/diff-context.mjs`. Claude's
prompt stays byte-identical, checked by comparing `--print-prompt` before and
after. Each gate keeps its own tool clause.

Alternatives rejected:

- **Brief-on-disk (Kimi shim style).** It works, but it adds a temp file the
  agent must be trusted to read in full, and a review that skipped the brief
  could still end in a verdict word. Stdin stream-json carries the prompt as
  the actual user turn.
- **Keep REST as a second mode.** Excluded by the issue.
- **Default mode instead of plan mode.** It would leave only the prompt as the
  read-only control; plan mode is verified to block workspace writes.

## Files to change

| Path | Change | Reason |
| --- | --- | --- |
| `skills/afk-gemini-review/gemini-gate.mjs` | rewrite | agy transport |
| `skills/afk-gemini-review/SKILL.md` | rewrite setup/semantics | new transport |
| `lib/gate/diff-context.mjs` | add | shared drift/untracked notes |
| `skills/afk-claude-review/claude-gate.mjs` | use the shared notes | no duplicated helper |
| `lib/gate/openai-snapshot-gate.mjs` | restore pre-#144 | drop the unused effort descriptor |
| `lib/gate/review-receipt.mjs` | add `gemini` to the exit-code completion families | a CLI receipt has no HTTP `stop` (D1) |
| `scripts/gemini-gate.test.mjs` | add | stub-agy behaviour tests |
| `scripts/{design-gate,external-gate-profile,gate-finding-rules,loop-rules,instruction-routing,glm-gate}.test.mjs` | keep passing | they assert phrases in the gemini SKILL.md / registry; the rewrite keeps those phrases |
| `scripts/http-gates.test.mjs` | restore pre-#144 | gemini is no longer an HTTP gate |
| `scripts/optional-http-gates.test.mjs`, `scripts/review-context-gates.test.mjs`, `scripts/review-receipt-gates.test.mjs`, `lib/gate/gate.test.mjs`, `scripts/gate-test-env.mjs` | edit | move gemini from HTTP to CLI expectations; scrub `GEMINI_GATE_` |
| `README.md`, `templates/afk-config.example.md`, `skills/afk/references/{external-review,design-review,review-evidence,review-convergence}.md` | edit | describe the agy transport; design-review moves gemini from "by construction" to the Kimi-style caveat |
| `package.json`, `plugin.json` → `npm run sync` | bump 1.4.1 | operator instruction |

## Execution surface

Writes: the files above. Executed: `node --test`, the lint commands from
`.afk/config.md`, `npm run sync` (writes `.claude-plugin/marketplace.json`,
`.codex-plugin/plugin.json` and `.github/plugin/marketplace.json` from
`package.json` / `plugin.json`). The live smoke runs `agy` against this
repository through the new gate; plan mode is expected to leave the worktree
unchanged, and `git status`, `git worktree list` and `git branch` are checked
before and after.

## Risk assessment

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Plan mode answers with a plan instead of a review | low (probe answered correctly) | review `ERROR` | prompt forbids plans; `requireVerdict` discards non-verdicts |
| Agent writes despite plan mode | low | repository mutation | plan mode + sandbox verified; documented as not by construction |
| CLI output format drifts | medium | `ERROR` | parser fails closed on a missing init/result |
| Rate-limit text guessed wrong (A1) | medium | `ERROR` instead of skip | fails visible, never clean |

## Test plan

A stub `agy` (a Node script behind a shell wrapper, selected via
`GEMINI_GATE_BIN`) records argv and stdin, then prints scripted NDJSON. Cases:

- success → verdict between markers, exit 0;
- argv is exactly `--input-format stream-json --output-format stream-json
  --model <id> --mode plan --sandbox --print-timeout <n>s` (no `-p`/`--print`,
  no empty-valued argument, no `--disable-slash-commands`, no prompt bytes);
- stdin is one `{"event":"user","message":{"content":…}}` line holding the
  prompt;
- identity mismatch, and a missing `init` → `ERROR`;
- `finished_reason` (`print_timeout`, `error`) → `ERROR`; exit 3 → `ERROR`;
- `GEMINI_REVIEW_TIMEOUT_MS=1` → `--print-timeout 1s`;
- `result.error` for auth and unknown model → `SKIPPED`;
- a review without a verdict → `ERROR`;
- a stream with a `subagent` step, an unknown step type, or an agent/swarm
  tool name → `ERROR`; denied read-tool steps do not fail the run;
- an early-exiting stub with a >64 KB prompt (EPIPE) reporting an auth error →
  `SKIPPED`, and reporting success → `ERROR`;
- a gemini receipt from a clean run passes `checkReviewReceipts`;
- `claude-*` / `gpt-*` / unversioned model → `ERROR` with no spawn;
- disabled, missing binary, Gemini implementer → `SKIPPED`;
- oversized diff → `ERROR`.

Receipt, review-context and routing tests move gemini into the CLI-gate
groups. A Claude `--print-prompt` comparison confirms the shared-notes
refactor changed no bytes. Live smoke: `node skills/afk-gemini-review/gemini-gate.mjs --base main --implementer claude`
with `GEMINI_GATE_BIN=~/.gemini/bin/agy`.

## Debate

Round 1 (independent critic, same model family as the author):

- D1 P1 supported: `checkReviewReceipts` accepts exit 0 as completion only for
  claude/codex/kimi (`lib/gate/review-receipt.mjs:443-445`); a clean Gemini CLI
  receipt would fail. Revised: contract item 4, Files table, test plan.
- D2 P2 supported: subagents/swarm workers carry their own model (changelog).
  Revised: item 3, A3, test plan.
- D3 refuted: `permission_mode` is `request-review` with and without
  `--mode plan` (probe 2026-11-11), so it cannot prove plan mode took effect.
- D4 supported: classification order and `EPIPE` stated in item 4.
- D5 recorded: the corrections rest on probe and repository evidence, which may
  correct the contract; skip message points to `agy models`; A5 made concrete.
  Reported to the operator in the PR.
- D6 supported: A6 added. D7: exact argv pinned in the test plan. D8: A1
  extended. D9: timeout rounding and model pattern added to items 8 and 2.
- D10: consumer tests and design-review wording noted in the Files table.

Round 2 (same critic, revalidating by name): D1, D6–D9 resolved; D3 refuted
accepted. Open items and new findings:

- D2/N2 supported (P2): the substring rule was a guess. A probe now observed
  delegation as `step_type: "subagent"`; item 3 now uses a step-type
  allowlist, which fails visible on unobserved shapes. The live smoke checks
  worktrees and branches (D2).
- N1 supported (P2): the missing-binary skip must precede the launch-error
  rule; item 4 step (0) added, mirroring claude-gate.
- N3 refuted: both failure probes reported `result.status: "ERROR"` (now in the
  table).
- N4 minor, deferred: a REST-era (v1.4.0) gemini receipt would fail the CLI
  completion rule. It fails closed, and none exists in this repository's runs.
- D5 recorded: the `--disable-slash-commands` acceptance criterion is corrected
  by the observed plan-mode warning. This is repository/CLI evidence, which may
  correct the contract; it is reported to the operator.
- D10 resolved: consumer tests listed in the Files table.

Round 3 (same critic): N1, N2 and D2 resolved. New:

- R1 refuted: the recorded stream of the real review probe (commit 07c06e3)
  has only `init` / `step_update` / `result` events and `user_input` /
  `agent_response` / `tool` steps (1 / 37 / 8); the write probe has the same
  set. The test replays that shape.
- R2 minor, deferred: an unknown top-level event type is not refused.
- R3 minor, deferred as a design change: the gate's own tool clause says the
  reviewer may read files by path, that search and list tools may be
  unavailable, and that the diff and untracked list are authoritative.

The round needed no revision, which ends the debate.
