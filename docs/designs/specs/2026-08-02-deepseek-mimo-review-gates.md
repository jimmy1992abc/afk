# DeepSeek and MiMo Optional Review Gates

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Status: design version 3, adversarial review clean
Issue: AlvinShenSSW/afk#8
Date: 2026-08-02

## Frozen issue contract

The change adds two opt-in external reviewer families without changing the
built-in PR role sequence or fallback pool:

- `deepseek`, defaulting to `deepseek-v4-pro` at
  `https://api.deepseek.com`;
- `mimo`, defaulting to `mimo-v2.5-pro` at the Token Plan base
  `https://token-plan-cn.xiaomimimo.com/v1`.

Both gates call provider REST APIs directly. Kilo Code remains an operator-side
way to use those providers, not a dependency or credential source for AFK.

The implementation must preserve these invariants:

1. The built-in `gates: codex > kimi` and
   `priority: codex > claude > kimi > glm` remain byte-for-byte unchanged.
2. Explicit `gates:` and `priority:` profiles may name `deepseek` or `mimo`.
3. A provider cannot review work produced by its own family, and one provider
   family cannot occupy two roles in a sequence.
4. No live paid provider request runs in CI.
5. Credentials stay in environment variables or an ignored local `.env`; they
   never enter `.afk/config.md`, logs, marker blocks, repository content, or an
   external review payload.
6. Secret-bearing files and secret-shaped values are removed before any
   snapshot-backed HTTP request is assembled.
7. Every skip and error remains distinct, bounded, and machine-readable.
8. Each gate supports branch, commit, uncommitted, and design targets with the
   same target validation and output protocol as GLM.

Non-goals are changing the default role assignment, importing credentials from
VS Code, adding a Kilo Code runtime dependency, making live calls in tests,
merging the resulting PR, or claiming workflow doctrine is mechanically
enforced.

## Verified evidence

The DeepSeek documentation lists OpenAI and Anthropic compatibility,
`https://api.deepseek.com` as the OpenAI base, and `deepseek-v4-pro` as a model.
Its chat-completions schema uses `Authorization: Bearer`, `max_tokens`, and an
explicit `thinking` object. The design originally inherited the relay's
`max_completion_tokens` assumption; the API schema independently disproved it,
so the corrected field and its transport test prevent that assumption from
returning.

The MiMo documentation lists OpenAI and Anthropic compatibility. The Token Plan
table gives `https://token-plan-cn.xiaomimimo.com/v1`, a `tp-...` credential,
and a separate Anthropic base. The V2.5 OpenAI example uses
`mimo-v2.5-pro`, `max_completion_tokens`, and an `api-key` header. These facts
were read from the official pages on 2026-08-02; transport tests pin the request
shape so later documentation drift becomes an explicit maintenance decision.

The repository already has a dependency-free OpenAI-compatible provider
factory in `skills/afk-agent-relay/lib/openai_provider.mjs`, plus DeepSeek and
MiMo registry entries. It also has secret-file matching and redaction in
`skills/afk-agent-relay/lib/redact.mjs`. GLM independently assembles the same
kind of snapshot and currently bypasses both protections.

## Decision 1: one shared safe snapshot boundary

Move the reusable secret matching and redaction primitives to a root `lib/`
module, then make both agent-relay gathering and HTTP review snapshots depend on
that owner. Move diff-section filtering there as well because a rename from a
secret path to an ordinary path must be rejected using both sides of the diff.
Delete the former skill-local implementation rather than retaining a wrapper or
copy.

The shared redactor adds an explicit bounded rule for MiMo Token Plan's bare
`tp-...` credentials, alongside the existing `sk-...`, bearer, labeled-value,
AWS, private-key, and long-blob rules. The rule and a captured-request fixture
use an unlabeled realistic token because `API_KEY=...` would exercise only the
generic labeled-value rule and leave the provider-specific gap untested.

Add a gate snapshot module that owns all content prepared for tool-less HTTP
reviewers:

- parse and validate the selected target through `lib/gate/target.mjs`;
- reject a design path that itself matches a secret-file rule;
- derive changed entries, including both rename/copy sides, from NUL-delimited
  Git metadata rather than parsing human-formatted patch headers;
- generate patch text only for entries whose every path passed exclusion, using
  literal path arguments rather than filtering a combined patch afterward;
- omit excluded paths from the changed-file list and never read their contents;
- replace the raw git stat with a summary derived only from included files, so
  an excluded path does not leak through a second representation;
- redact the filtered diff, design text, and included file contents;
- enforce one byte budget across the resulting snapshot;
- return the prompts and non-secret metadata to the transport layer.

Snapshot contents come from the selected artifact, not whichever bytes happen
to be in the current worktree:

| Target | Patch | Full tracked contents | Filesystem reads |
|---|---|---|---|
| branch | merge-base to `HEAD` | Git blobs at `HEAD` | none |
| commit | selected commit delta | Git blobs at the selected commit | none |
| uncommitted | `HEAD` to current worktree/index state | regular worktree files | untracked and modified files only |
| design | none | none | the explicitly selected regular file |

Filesystem reads use `lstat`, reject every symlink, and require uncommitted paths
to resolve beneath the repository worktree before opening. Design input may be
outside the repository because it is explicit, but it must be a regular,
non-secret-path, non-symlink file. Tracked branch and commit snapshots use Git
blobs, so a tracked symlink contributes only its link blob and is excluded from
the full-contents block rather than followed. A deletion has no full content.

GLM moves to this builder. DeepSeek and MiMo use it from their first version.
This makes the request body the single mechanically testable exposure boundary;
filtering only `changedFiles` would leave tracked secret content in the diff,
while filtering only the diff would leave untracked secret files in the full
contents block.

The root `.gitignore` gains `.env`. The bootstrap ignore snippet also gains
`.env`, so a consuming repository initialized by AFK receives local protection
without a tracked edit. `.env.example` remains visible and trackable. Existing
tracked secret files cannot be made safe by an ignore rule, which is why payload
filtering remains mandatory.

## Decision 2: extract, then extend, the existing HTTP client

Move the OpenAI-compatible provider factory from the agent-relay skill into a
root `lib/http/` module and update agent-relay to import it. The factory remains
the only generic chat-completions client. It gains narrow provider hooks rather
than a second gate-specific implementation:

- a header factory, needed for MiMo Token Plan's `api-key` contract;
- a configurable token-parameter override variable, so relay-only environment
  settings cannot silently alter a review gate;
- status/code-only upstream errors: the shared client discards response bodies
  on non-success and never retains them in an error message;
- the response's reported model identity and `finish_reason` alongside final
  text and usage.

The DeepSeek relay registry retains bearer authentication and corrects its token
field to the official `max_tokens`. The MiMo relay registry adopts the official
V2.5 shape: `api-key` and `max_completion_tokens`. Existing provider tests
become the regression proof for both relay and review consumers.

The review configuration maps dedicated gate variables into provider inputs.
The key order is gate-specific first, then the existing development key:

- `DEEPSEEK_REVIEW_API_KEY`, then `DEV_DEEPSEEK_API_KEY`;
- `MIMO_REVIEW_API_KEY`, then `DEV_MIMO_API_KEY`.

The same names may be read from an ignored repository `.env`. No Kilo Code or
VS Code location is probed. Model, base URL, context budget, timeout, disable,
and DeepSeek thinking controls use the `<FAMILY>_REVIEW_*` namespace. The
default review output limit is 8192 tokens.

## Decision 3: one runner, two thin gate entry points

Add a shared OpenAI snapshot-gate runner under `lib/gate/`. It performs target
validation, the no-self-review guard, dry-run output, safe snapshot assembly,
credential resolution, the bounded provider request, response validation, and
the marker protocol. The two bundled entry points supply only family-specific
configuration and call the runner.

The runner distinguishes outcomes as follows:

- disabled, missing credential, authentication rejection, and no changes are
  `SKIPPED` with exit zero because they describe stable local unavailability or
  an inapplicable target;
- timeout, transport failure, rate limit, upstream failure, malformed JSON,
  empty final content, unsafe `finish_reason`, and model-identity mismatch are
  `ERROR` with non-zero exit because a started review did not yield a
  trustworthy verdict;
- only final message content becomes a verdict; reasoning content is never
  substituted for an empty final answer.

The response must report the requested model lineage and exactly
`finish_reason: "stop"`. Exact identity or a dated suffix satisfies the model
check; missing or different identity discards the verdict. A `length`,
`content_filter`, `tool_calls`, `insufficient_system_resource`, missing, or
unknown finish reason discards even nonempty content under a reason-specific
error. This extends the repository's existing model-identity principle to REST
gates and prevents a partial response from becoming a clean review.

The marker labels are `DEEPSEEK` and `MIMO`. Both entry points accept
`--base`, `--commit`, `--uncommitted`, `--design`, `--print-args`,
`--print-prompt`, and `--implementer`. Design targets use the design prompt and
must fail loudly when missing, unreadable, secret-bearing, or over budget.

GLM keeps its Anthropic/OpenAI transport because that contract differs, but it
uses the shared credential lookup and snapshot builder. Its existing marker and
outcome behavior otherwise remain unchanged. Its error paths also discard
upstream bodies so the same credential-echo invariant holds for every
snapshot-backed HTTP gate.

## Decision 4: optional families, unchanged defaults

Add `deepseek` and `mimo` to the recognized implementer-family map and every
documented list of valid explicit gate families. The AFK driver doctrine treats
them as snapshot-backed, tool-less REST reviewers with the same evidence limits
as GLM.

Neither name is appended to the built-in fallback pool. Availability therefore
cannot increase cost for a profile that did not opt in. A user enables one by
placing it in `gates:` or `priority:` or invoking its satellite skill directly.
For a DeepSeek or MiMo implementer under the unchanged default profile, Codex
outer and Kimi final remain eligible.

Each new `SKILL.md` states why the reviewer is snapshot-limited, how to resolve
the bundled helper, how the gate participates in ordered roles, how findings
close, and how to provide a review credential safely. Cross-references use
relative skill paths.

## Decision 5: tests define the provider and exposure contracts

Targeted RED tests land before implementation and cover:

1. DeepSeek URL, bearer header, model, thinking field, `max_tokens`, final-text
   extraction, finish reason, and reported identity.
2. MiMo Token Plan URL, `api-key` header, model,
   `max_completion_tokens`, final-text extraction, finish reason, and reported
   identity.
3. Disabled and missing-key skips; auth skip; timeout, rate-limit, malformed,
   empty, `length`, provider interruption/filter, and identity-mismatch errors.
4. Branch, commit, uncommitted, and design target parity through shared target
   tests and entry-point integration tests.
5. A tracked secret diff, untracked `.env`, secret-path rename/copy, Git-quoted
   path, untracked symlink to an out-of-repository secret, explicitly selected
   secret design, a bare realistic `tp-...` credential, and other secret-shaped
   values cannot enter the captured request body.
6. An old commit with a dirty worktree and a branch snapshot with unrelated
   worktree changes use the selected revision's Git blobs.
7. `deepseek` and `mimo` self-review refusal and recognition as distinct role
   families.
8. New skill discovery across manifests and documentation, with unchanged
   default gate and priority strings.
9. Agent-relay behavior after the shared client and secret modules move.
10. Auth, rate-limit, and upstream fixtures echo the active configured key and a
    `tp-...` token in their response bodies; neither stdout nor stderr contains
    either value for DeepSeek, MiMo, GLM, or the shared relay transport.

All remote behavior uses local HTTP fixtures or injected fetch functions. The
final suite is the repository's five documented checks.

## Files and causal reach

- `lib/http/openai-provider.mjs`: shared OpenAI-compatible transport.
- `lib/secret.mjs`: shared exclusion, diff filtering, and redaction.
- `lib/gate/credential.mjs`: named environment and ignored `.env` lookup.
- `lib/gate/snapshot.mjs`: the only snapshot exposure boundary.
- `lib/gate/openai-snapshot-gate.mjs`: shared REST gate lifecycle.
- `skills/afk-deepseek-review/`: DeepSeek skill and thin helper.
- `skills/afk-mimo-review/`: MiMo skill and thin helper.
- `skills/afk-glm-review/glm-gate.mjs`: consume the safe snapshot boundary.
- `skills/afk-agent-relay/lib/` and tests: consume relocated shared modules and
  correct MiMo V2.5 request shaping.
- `lib/gate/implementer.mjs`, AFK/gate skills, README, and tests: recognize the
  optional families without changing defaults.
- `.gitignore`, `templates/gitignore-snippet.txt`, and setup prose: protect and
  explain local credentials.
- plugin manifests and `package.json`: regenerated after a version bump from
  `0.2.16` to `0.2.17`.

No production dependency is added. No old helper is retained beside its moved
replacement. Every content-bearing consumer named above is covered by either a
targeted test or the repository-wide link, lint, provenance, manifest, and Node
test checks.

## Risks and safe direction

The main compatibility risk is changing the agent-relay transport while making
it reusable. Existing provider tests remain in place and grow request-header
assertions before the move. The GLM migration risks prompt drift, so its current
prompt and target integration tests must remain green and new tests compare the
safe builder's visible sections.

Secret redaction is defense in depth, not a proof that arbitrary sensitive data
can be recognized. The fail-safe controls are machine-readable path selection,
Git-blob reads for committed artifacts, regular-file and containment checks for
worktree reads, and rejection of symlinks. The gate still rejects a recognized
secret design path rather than relying on redaction.

Provider documentation can change. Defaults are overrideable, but a quiet model
or endpoint downgrade is not allowed: request shape and response identity fail
loudly when the pinned contract no longer holds.

## Design debate record

Design version 1 received five supported findings:

- D1 (P1) corrected DeepSeek's token field from the inherited
  `max_completion_tokens` assumption to the documented `max_tokens`; Decision 2
  and provider request tests pin the correction.
- D2 (P1) added non-following, contained filesystem reads and Git-blob sources;
  Decision 1 and the symlink captured-body test pin the boundary.
- D3 (P1) made a safe finish reason part of verdict validity; Decision 3 and
  response fixtures pin the behavior.
- D4 (P1) replaced raw patch-header parsing with NUL-delimited entry selection
  and literal per-entry patch generation; Decision 1 and quoted-path tests pin
  the behavior.
- D5 (P2) defined the content source for every target kind; Decision 1 and
  dirty-worktree divergence tests pin the selected revision.

D2-D5 were resolved by the version 2 revalidation. D1 remained open because the
issue still named the disproved field; issue #8 was amended to `max_tokens` on
2026-08-02, so that contract correction now awaits named revalidation.

Version 2 also received two supported P1 findings:

- D6 adds the provider-specific bare `tp-...` redaction rule and captured-body
  regression under Decision 1.
- D7 replaces vague error-body sanitization with a status/code-only contract
  and credential-echo stdout/stderr fixtures under Decisions 2 and 3.

The version 3 revalidation resolved D1, D6, and D7 by name, kept D2-D5 closed,
and found no new supported finding. The terminal round made no design revision,
so the design is clean for tests-first implementation.
