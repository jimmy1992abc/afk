# Mixed-Model Driver and Snapshot Review Improvements

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Review iteration, batching and reopening are superseded by
[Bounded review iteration](2026-09-07-bounded-review-iteration.md).

- **Issue:** #73
- **Status:** Frozen contract

## Problem

A driver and a separate implementation model do not necessarily share the same
filesystem authority. The executor can legitimately finish a code change while
being unable to write linked-worktree Git metadata. The current skills do not
define that handoff, and they do not distinguish a test that exercised the
product from one stopped by the executor's environment.

Snapshot-backed reviewers also use one inherited 400000-byte / 8192-token
default despite different reasoning behavior. A tool-less reviewer then has a
large input, little answer headroom, and no unchanged dependency context. These
conditions increase empty completions and unsupported findings.

## Frozen issue contract

1. A restricted executor may hand a dirty linked worktree back to its driver.
   The executor records the diff and command results. An authorized driver owns
   the commit only after inspecting that diff and rerunning the declared checks
   outside the restricted environment. The handoff grants no new push, PR, or
   merge authority.
2. `ENVIRONMENT-BLOCKED` is distinct from RED and green. It requires evidence
   that the execution environment denied a prerequisite before the assertion or
   contract behavior ran. The unchanged command must be rerun in an environment
   authorized for the required path or resource. That rerun alone supplies the
   RED or green classification.
3. A plan describes the complete execution surface of generated artifacts:
   generated outputs, the generators and commands that produce them, required
   inputs/configuration, and expected side effects. Read, execute, and write
   access stay distinct; listing a participant does not authorize modifying it.
4. DeepSeek and GLM default to 160000 input bytes and 65536 output tokens. MiMo,
   Claude, and Agent Relay defaults do not change. Environment overrides retain
   their existing precedence.
5. An empty DeepSeek or GLM completion remains a nonzero `ERROR`. Its bounded
   message identifies one adjusted retry as eligible under the existing
   transient-retry rule and names the family's context/output knobs. A blind
   retry with unchanged inputs is not prescribed.
6. GLM remains pinned to 5.3. A returned model outside the requested versioned
   lineage remains a visible nonzero `ERROR`, because attribution failed rather
   than the reviewer becoming unavailable. The message names the model and base
   URL configuration knobs as the repair surface without trusting the verdict.
7. A snapshot may add unchanged tracked files only when an exact path token in
   the approved patch or changed-file contents resolves to a tracked blob at the
   selected revision. Relative tokens resolve from their changed file. No
   extension guessing, package resolution, language parsing, filesystem escape,
   untracked dependency inclusion, or symlink following is permitted.
8. Supplemental referenced files are considered before full changed-file
   contents after the bounded diff. Secret exclusions, per-file limits,
   redaction, selected-revision reads, and the final byte ceiling still apply.
   The snapshot records included references and bounded, redacted paths omitted
   by the byte budget. Other unreadable supplemental references produce a
   distinct note.
9. The snapshot reviewer instruction treats an absent path as missing evidence:
   it may request verification, but it must not assert that file's contents or
   assign structural severity solely from its name.
10. Stable finding IDs continue across rounds. Evidence and material progress,
    not an absolute round count, decide convergence. The existing consecutive
    no-progress checkpoint and `OUTSTANDING` exit remain the bounded stop path;
    an unresolved P1 cannot be discharged by reaching a counter.
11. Every shipped skill or script change bumps the plugin version and preserves
    generated-manifest consistency.

## Approach

### Driver/executor handoff

Add one driver-owned handoff clause to `afk` and matching executor guidance to
`afk-implementation-pilot`. The executor first attempts the normal in-worktree
workflow. If Git metadata is outside its write authority, it stops attempting
commit work, reports the dirty-tree identity and exact checks, and returns
control. The driver does not trust executor-reported green: it inspects the
actual diff and repeats the declared commands before creating the commit.

The test classification uses observed causality, not string matching. A path-
denied message alone is insufficient if assertions also ran or the product was
responsible for selecting the forbidden path. The driver rerun resolves the
classification without editing between attempts.

### Planning closure

Add an `Execution surface` section to the plan shape. It distinguishes files
that may be changed from tools and inputs that must only be read or executed.
For a generated artifact, the row is incomplete until the production command,
generator, inputs, output, and predictable side effects are accounted for.

### Family-specific budgets and retry diagnostics

Allow the shared lifecycle to receive explicit `maxContextDefault` and
`maxOutputDefault` values. DeepSeek and GLM supply 160000 and 65536; MiMo omits
them and retains the shared 400000 and 8192 defaults. Both DeepSeek and GLM
provider configurations supply a family-specific empty-completion hint.
Anthropic-protocol GLM gains the same optional hint support as the OpenAI
provider.

`--print-args` exposes the resolved context and output budgets so an operator can
verify overrides without spending a call. Identity mismatch remains an error
and gains a bounded remediation sentence naming only configuration keys.

### Conservative referenced-file enrichment

Collect tracked blob paths from the selected revision. Extract bounded path
tokens from the approved patch and from changed-file contents. A token is
eligible only when normalization yields an exact member of the tracked set;
relative tokens additionally require a known changed-file source directory.
Changed paths and excluded paths are removed. Candidate count and scanned bytes
are bounded by shared constants.

Load eligible candidates through the existing selected-revision tracked-blob
reader, redact them, and render them under a separate unchanged-reference
heading before full changed-file contents. A candidate too large, binary,
unreadable, or beyond the candidate bound is reported distinctly. A candidate
whose rendered block cannot fit is recorded in
`budgetOmittedReferencedPaths`; later smaller candidates may still fit.

The lifecycle prepends a bounded `SNAPSHOT_NOTE` to the accepted review when
references were included or budget-omitted. Redaction and a displayed-path cap
apply before those paths leave the process.

## Files to change

| Path | Change | Reason |
|---|---|---|
| `skills/afk/SKILL.md` | Driver handoff, environment classification, stable-ID disposition | Define orchestration behavior |
| `skills/afk-implementation-pilot/SKILL.md` | Restricted-executor handoff and test classification | Define executor output |
| `skills/afk-spec-planner/SKILL.md` | Execution-surface plan section | Close generated-artifact dependencies |
| `lib/gate/openai-snapshot-gate.mjs` | Per-family defaults, diagnostics, coverage note | Share lifecycle without forcing one budget |
| `lib/gate/snapshot.mjs` | Conservative referenced-file enrichment | Give tool-less reviewers verified local context |
| `lib/http/anthropic-provider.mjs` | Optional empty-completion hint | Keep GLM protocol parity |
| `skills/afk-deepseek-review/*` | Defaults, hint, documentation | Tune DeepSeek behavior |
| `skills/afk-glm-review/*` | Defaults, hint, documentation | Tune GLM behavior |
| `scripts/*.test.mjs`, `lib/**/*.test.mjs` | Regression coverage | Pin observable behavior |
| plugin manifests and `package.json` | Version 0.8.5 | Refresh install cache |

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Path extraction over-collects prose tokens | Wasted context | Exact tracked-path membership, bounded candidates, no guessing |
| Supplemental context displaces changed contents | Lower direct coverage | Keep the diff first; cap references; report omissions |
| A referenced path is sensitive | Exposure | Reuse path exclusions, selected-revision reads, and redaction |
| Larger output limit increases cost | Higher metered usage | Smaller default input and unchanged operator overrides |
| Environment failures are waved away | Real bug missed | Require causal evidence and an unchanged authorized rerun |
| Driver commit expands authority | Unintended remote mutation | Commit only; push/PR/merge remain separately authorized |

## Test plan

- Prose contract tests pin the executor handoff, authorized rerun, execution
  surface, stable IDs, and absence of a fixed round exit.
- Shared lifecycle tests assert DeepSeek/GLM defaults, MiMo compatibility,
  `--print-args` diagnostics, empty-completion hints, and identity remediation.
- Provider tests assert Anthropic empty-hint parity.
- Snapshot tests cover exact repository paths, relative paths, non-tracked and
  no-extension-guessing rejection, selected-revision reads, exclusions, candidate
  bounds, reference priority, multibyte byte ceilings, and bounded omission
  notes.
- Run manifest sync, skill lint, link lint, Markdown lint, provenance scan, and
  the full Node test suite.

## Out of scope

- A trusted runtime, sandbox configuration, or automatic privilege escalation.
- A clone manager or automatic choice between clone and linked worktree.
- Language-specific dependency resolution, extension guessing, or a repository
  index service.
- Changes to role ordering, Kimi transport, or the evidence-based convergence
  doctrine.
