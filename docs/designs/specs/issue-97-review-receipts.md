# Canonical review receipts

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

## Spec review and frozen issue contract

Issue #97 needs retained, reproducible evidence for a review's effective inputs
and outcome. A saved hash without its canonical input bytes cannot establish
what was compared. The existing notice hash and resume headers serve other
purposes and remain unchanged.

This change adds an opt-in receipt to the existing gate helpers, one shared
canonical serializer, and an explicitly invoked read-only consistency checker.
It depends on #96's target descriptor and delivered context digest. It does not
add a runner, scheduler, gate selector, database, or second context transport.

The frozen acceptance criteria are:

1. Versioned schemas distinguish driver claims from helper observations and
   document their validity, canonicalization, and trust boundaries.
2. Equivalent effective inputs have identical retained canonical bytes and
   SHA-256 digests. Role order, reviewer assignment, effective model or effort,
   reviewed revision or merge base, artifact bytes, and context changes remain
   distinguishable.
3. Requested and observed model identities stay separate. Missing observations
   remain explicitly unknown; a driver's requested model is not confirmation.
4. Review, failure, skip, preview, and incomplete attempts stay distinguishable.
   Neither process success nor absence of a terminal artifact means approval.
5. Started and terminal artifacts are immutable. Interrupted publication and
   collisions preserve previously published bytes; retries use new attempt IDs.
6. The checker compares an explicit candidate and required role receipt set,
   detects absent, stale, conflicting, noncanonical, or damaged evidence, and
   emits an inspectable result without writing repository or run state.
7. Legacy runs without receipts remain unknown. No reconstruction from prose,
   automatic paid backfill, or inferred approval is permitted.
8. Tests cover equivalence and meaningful changes, interrupted writes, absent
   evidence, outcome distinctions, and recovery in another process.
9. Artifacts stay in the consuming run by default, contain no credentials, and
   are never automatically published to a forge or plugin repository.

These are level 2 artifact checks when a helper is invoked. The operator and
driver still control whether helpers run, which candidate they supply, and
whether they respect results. Files are unsigned and editable by that same
principal. Receipts neither prove a model ran nor enforce level 3 workflow,
reviewer independence, cycle budgets, semantic finding closure, or merge policy.
The ledger remains the authority for those decisions and rationales.

## Invocation and ownership

Every bundled gate accepts one optional `--review-receipt <request.json>` flag,
including its equals spelling. The flag is consumed before native CLI dispatch.
No flag preserves existing output, exit behavior, and absence of receipt writes.
Malformed, repeated, or unavailable receipt input fails before a provider call.
The caller supplies the run and attempt explicitly because linked worktrees can
share several active runs. No current-run inference or run allocation is added.

The request is a strict version 1 object with these fields:

| Field | Meaning |
| --- | --- |
| `version` | Integer `1` |
| `runId` | Existing consuming run directory name |
| `issue` | Sanitized issue identifier string, or `null` for a standalone scope |
| `attemptId` | Unique filesystem-safe identifier within this run |
| `roleIndex` | Zero-based position in the complete ordered profile |
| `profile` | Driver-resolved profile defined below |

The main worktree is resolved through the existing Git helper. Request input is
confined to the current worktree or the main worktree's `.afk`, using the existing
file-boundary reader. Output is exactly
`.afk/runs/<runId>/receipts/<attemptId>/` under the main worktree. The run must
already exist and `.afk` must be ignored. Identifiers contain only ASCII letters,
digits, period, underscore, and hyphen, start with an alphanumeric character,
and have at most 100 characters; `.` and `..` cannot name directories. Symlinked
run/output ancestors and existing attempt directories are rejected. Request
source paths are locators and are not copied into receipts.

The profile is `{source, roles}`. `source` is `flags`, `config`, `legacy`, or
`built-in`; `roles` is a nonempty ordered array of
`{preferred, reviewer, model, effort}`. `preferred` retains the requested role,
trimmed and lowercased, as a nonempty sanitized string of at most 100 characters.
It may be unknown because existing selection permits an unknown preference to
use fallback. `reviewer` must be a canonical family supported by the gate helpers
and retains the actual assignment after driver selection or fallback.
`model` and `effort` are resolved expected request values or explicit `null`
where the driver cannot establish them. This accepts resolved roles, not raw
handoff tokens, and does not independently redo scheduling or fallback policy.
The selected role's reviewer must equal the invoked helper's family.

The profile, scope, and role position are driver claims. A non-null expected
model or effort is compared with the helper's resolved request when that
observation is available. A disagreement is an error before provider dispatch.
Unknown CLI-managed selection remains unknown even when the driver names a
model. Existing Claude/Codex selection and aliases are resolved only by
`resolveReviewSelection`; HTTP uses the shared lifecycle's effective values.
Kimi has no helper-owned model selection and retains null requested identity.

## Canonical effective inputs

The shared serializer emits UTF-8 JSON with recursively sorted object keys,
preserved array order, no insignificant whitespace, and one terminal newline.
Only null, booleans, strings, safe integers, arrays, and plain objects are
accepted. Undefined values, non-finite numbers, unsupported types, and unknown
schema fields fail. Strings retain their Unicode code points without NFC or
punctuation normalization. Stored JSON must exactly equal reserialization;
otherwise the checker reports noncanonical evidence. SHA-256 covers these exact
bytes, including the newline.

The canonical input object is:

```text
{version, scope: {runId, issue}, roleIndex, profile, selections, configuration,
 target, context: {phase, digest}, requested: {model, effort}}
```

The canonical `profile` is the common projection `{source, preferences}`, where
`preferences` contains the complete ordered list of normalized preferred roles.
`selections` contains `{reviewer, model, effort}` for positions zero through this
receipt's `roleIndex`, inclusive. Both are derived from the retained request;
neither is a second selector. The full request remains in `started.json`, but
later roles' selection values do not enter an earlier role's input digest or
candidate equality check. A changed role list or relevant configuration stales
every role. A changed model, effort, or actual assignment stales that role and
downstream roles through the selection prefix. This preserves existing selection
lifetime while retaining what the driver claimed about the entire sequence at
attempt start. A changed later selection never rewrites an earlier start record.

`target` is the existing #96 descriptor: kind and full reviewed commit, merge
base for a branch, and artifact digest/path where the target kind requires it.
Raw ref spelling and absolute source paths are not identity inputs. `context`
uses the phase and digest returned by #96 for the context actually delivered;
initial absence is an explicit null digest. `requested` contains helper-resolved
values, with null preserving unavailable knowledge. Selection sources are
observations outside this digest because equivalent flag/environment resolution
must not change semantic identity. Timestamps, attempt ID, reviewer response,
and observed model identity are likewise outside the input digest.

`configuration` is a strict observation of the main worktree's `external gate`
section, not a hash of the entire personal config. An additive reader in
`lib/config.mjs` reuses its existing line/section parsing, preserves absent
versus present, and reports unreadable input as an error. It canonicalizes the
first occurrence of each case-insensitive key, strips inline comments and
surrounding whitespace as the existing reader does, and sorts keys. Blank
values remain present. Nonempty non-field lines are retained in order so a
change to unrecognized meaningful section text cannot disappear. For a
flag-derived profile only `gates` is excluded; other fields remain identity
inputs. For other sources the whole normalized section is retained. Ordered
family-list values in `gates` and `priority` normalize separator whitespace and
case, matching their existing case-insensitive semantics; unknown preferences
remain values rather than becoming a different role. Other values preserve
spelling. Missing section and missing file share the
documented absent-section sentinel. An unreadable file never becomes absent.
This defines a comparison encoding, not a second configuration resolver.

The helper captures target, HEAD, and configuration before dispatch and again
before terminal preparation. HEAD drift, descriptor drift, or configuration
drift prevents a valid review terminal. Base-tip information and dirty state are
retained as factual context; the existing driver remains responsible for its
clean-worktree doctrine. The delivered context digest is not replaced with a
later reading of a changed packet. The checker independently reloads candidate
context through #96, so changed evidence cannot reuse an old digest unnoticed.

## Immutable artifacts and outcomes

Each attempt contains these fixed artifacts:

| Artifact | Producer and authority |
| --- | --- |
| `started.json` | Helper start time, helper family, request claims, version, attempt ID |
| `input.json` | Complete canonical effective inputs, when enough inputs were resolved |
| `review.txt` | Credential-sanitized final review text, only for a review result |
| `terminal.json` | Terminal outcome and references/digests binding the other artifacts |

`started.json` is published before model selection, guard, and target errors can
exit the gate. Invalid request or output setup cannot have a trustworthy attempt
identity and instead emits an ordinary explicit gate error without a receipt.
An early error or skip can have no `input.json`; null input is never interpreted
as a complete review. A killed process may leave only started or staged files.
No terminal means `incomplete`, even if a review was already printed.

`terminal.json` contains version, attempt ID, started digest, terminal time,
duration in milliseconds, input reference/digest or null, outcome, model
observation, target/configuration before-and-after observations, execution
observation, final-review reference/digest or null, and transcript availability.
References are fixed same-directory basenames, never arbitrary URLs or paths.
The exact canonical input bytes are retained in `input.json`; reconstruction
from a human report is unnecessary.

Outcomes are `{kind, verdict, reason}`. `kind` is `review`, `error`, `skipped`, or
`preview`; only `review` may contain a verdict recognized by the existing
mode-specific terminal-verdict parser. `reason` is a bounded sanitized message
for non-review outcomes, otherwise null. The parser exposes its existing
decision to the observer rather than introducing another verdict regex.
Native Codex diff text does not currently require a terminal verdict, so its
receipt has a null verdict with explicit unavailable-verdict status. Exit zero,
free-form praise, or a filename cannot fill that value. Design `PASS` and diff
approval values keep their existing meanings; negative verdicts remain valid
completed reviews without becoming approval.

The model observation is `{requested, observed, verification, reason}`:
requested records the helper's actual request separately from the profile claim;
observed is an array of response-reported model IDs or null; verification is
`verified`, `mismatch`, or `unavailable`. Claude uses its existing usage-envelope
verification; HTTP uses its existing response model comparison. Native Codex
and Kimi cannot verify identity through the current final-text interface and
report unavailable. Auxiliary Claude usage identities remain observations, not
additional role assignments. A mismatch follows the existing error path.

HTTP gates add an optional fifth field, `fingerprint`: the response
`system_fingerprint`, or null when the response has none. It records the
provider backend as evidence and is never compared. Receipts without the field
remain valid.

Execution records the helper-observed child exit code/signal or provider
completion state when available, otherwise explicit null values. It does not
claim the wrapper's future exit was observed. Raw CLI transcripts remain where
the existing helper put them and are reported as unavailable to this receipt;
HTTP does not fabricate a raw transcript. The saved final review has a distinct
`final-review` kind and cannot masquerade as a full execution transcript.

## Publication ordering and failures

The controller is passed to `createProtocol` as an optional observer. No global
exit hook, process replacement, or separate wrapper parses gate stdout. Each
CLI and the shared HTTP lifecycle initializes it before meaningful early exits;
GLM's early protocol error shares that same initialization. Preview exits emit a
preview terminal and never claim a review. Existing final-output behavior stays
unchanged when receipts are absent.

For a terminal event, the observer first validates current observations, stages
and verifies the canonical input/review/result bytes, then the protocol emits
its existing marker block through the existing synchronous stdout writer. Only
after that writer returns does the controller publish `terminal.json`. If the
output writer fails, no terminal approval is published. If terminal publication
fails after output, the helper emits a distinct receipt-publication error and
exits nonzero; the attempt remains incomplete. That failure path bypasses the
observer to prevent recursion and places an error block after any review block.

Files are staged with exclusive creation in the owned attempt directory, closed,
read back and verified, then published using a same-directory hard link that
fails if the destination exists. Temporary files are removed only after verified
publication or reported unsuccessful staging. No ordinary overwriting rename
or delete-before-replace is used. Unsupported filesystems fail closed before a
usable terminal is published. This promises atomic visibility and no replacement
on supported filesystems, not power-loss durability or protection from a hostile
process that controls the same filesystem. Retries allocate new attempt IDs;
the checker takes the operator's explicit attempt choices and does not guess
which competing attempt supersedes another.

Metadata and request files are bounded at 100,000 UTF-8 bytes, using the existing
shared byte helper. Final review storage obeys the existing bounded gate output
plus credential redaction. Free text uses the shared secret detector/redactor;
structured digests are validated as hashes and exempt from entropy heuristics,
but configured exact credentials are rejected in every metadata field. No raw
environment, API key, complete personal config, or provider envelope is stored.

## Read-only consistency checker and resume

The checker is invoked explicitly:

```text
node scripts/check-review-receipts.mjs --candidate candidate.json --receipt <attempt-directory> [--receipt <attempt-directory> ...]
```

The candidate is `{version, runId, issue, profile, target, contexts}`. `target`
contains one existing selector: `{kind: branch, base}`, `{kind: commit, commit}`,
`{kind: design, path}`, or `{kind: uncommitted}`. `contexts` contains exactly one
`{phase, path}` entry per role, indexed in profile order, with null path for
initial absence. Candidate input is confined like request input. The checker
resolves the common target with #96 and loads each role's candidate context using
the #96 loader with that role's actual capability, then strictly reads current
profile configuration. Native Codex diff can therefore retain initial/null
context while a supported later role retains its own non-null re-review digest.
Different context across roles is valid; each receipt must match its own expected
phase and digest. Unsupported native context is still rejected, never omitted
or represented as delivered.
No provider is invoked. Every profile role is required; the receipt list must
contain exactly one explicitly chosen attempt for each role index.

The checker validates schema, canonical bytes, all referenced digests, fixed
reference names, role/scope equality, the common profile projection and each
role's selection prefix, target and configuration equality, that role's context
phase/digest, expected requested model/effort where observable, and
before/after stability. A model assertion that cannot be observed is reported
as unknown rather than silently verified. Missing or malformed started/terminal
or review evidence, duplicate role claims, non-review required outcomes, or
candidate conflicts exit nonzero with per-attempt reasons. Temporary files do
not repair absent evidence. An absent legacy receipt is reported as
`unknown-legacy-or-missing`, never reconstructed.

The JSON result names the candidate descriptor, profile digest, checked receipt
paths relative to the consuming run, input digests, each role's consistency,
outcome, verdict, model verification, and issues. `reviewsComplete` and
`allRequiredApproved` are separate from `consistent`. A valid negative review
can be consistent and complete while approval is false. An unchecked native
verdict yields unknown approval. Unknown model identity remains visible without
inventing a new mandatory identity policy or altering current gate eligibility.
Exit zero means complete consistent review evidence, not merge permission.

Resume documentation instructs the driver to name the candidate and last chosen
receipt paths in the ledger, invoke this checker, and retain its result. It does
not change the header-only resume detector or introduce automatic reconstruction,
state mutation, paid review, or ledger writes. Legacy operation without the flag
continues with explicitly unavailable machine-readable evidence.

## Files and execution surface

| Path | Change and reason |
| --- | --- |
| `lib/gate/review-receipt.mjs` | Shared serializer, schemas, attempt lifecycle, and receipt checking |
| `lib/config.mjs` | Add strict section observation while preserving legacy readers |
| `lib/gate/protocol.mjs` | Optional typed outcome observer and reuse of parsed verdict |
| `lib/gate/openai-snapshot-gate.mjs` | Observe common HTTP selection, target, response, and terminal lifecycle |
| `scripts/claude-gate.mjs`, `scripts/codex-gate.mjs`, `scripts/kimi-gate.mjs` | Opt-in lifecycle and existing factual observations |
| `scripts/glm-gate.mjs` | Cover early invalid protocol through the shared controller |
| `scripts/check-review-receipts.mjs` | Explicit read-only checker CLI |
| Corresponding receipt/config/protocol/gate tests | Contract and integration proof |
| `skills/afk/SKILL.md` and gate skill documentation | Opt-in invocation, truthful interpretation, and resume reference |
| Plugin manifests and `package.json` | Version 0.9.3 install cache key through the existing sync script |

The design and implementation may write only this topic branch and issue-specific
run evidence. Runtime gate invocation above generates only the named consuming
attempt artifacts. The checker reads candidate, Git, config, context, and saved
receipts and writes its result to stdout. The driver may explicitly redirect
that output into its run; the checker never does so itself. Tests generate
disposable Git repositories and stub provider/CLI processes. Manifest production
uses `node scripts/sync-marketplace.mjs` after updating the marketplace version.
No command in this design publishes run artifacts or invokes a paid reviewer
as an acceptance prerequisite.

## Assumptions and risks

The synchronous stdout boundary is verified in the existing protocol source.
The selected no-replace hard-link primitive has a local Node/filesystem probe;
cross-platform and filesystem failures require deterministic injected tests and
fail-closed behavior, not a portability guarantee. Provider identity availability
uses existing response parsing only; no additional native CLI identity interface
is assumed. SHA-256 is an integrity comparison, not an authenticated signature.

The main integration risk is early exits omitting receipt terminal state. Tests
exercise each helper family and distinguish intentional error/skip/preview from
an abrupt incomplete process. Config drift and concurrent target changes can
misbind evidence; before/after observation rejects them. Credential heuristics
can damage hash identity; structured validation and exact credential checks
preserve hashes while metadata is rejected or review prose is sanitized. A
malicious local principal can replace receipts after checks; the checker only
reports what its invocation read and does not claim stronger workflow authority.

## Test plan and handoff

The initial design review admitted four corrections in one batch:

- I97-D1: candidate context is per role, preserving honest native initial/null
  and supported re-review inputs in one complete receipt set. The mixed-capability
  fixture and per-role mismatch cases below are required closure evidence.
- I97-D2: common profile identity excludes role selections; each receipt binds
  only its own and upstream selection prefix. The final-only versus outer
  selection-change fixtures below establish the existing invalidation scope.
- I97-D3: documented case-insensitive family lists canonicalize case as well as
  separator whitespace. Upper/lowercase equivalent configuration fixtures must
  produce identical canonical bytes and digests.
- I97-D4: a bounded sanitized unknown preference is retained with a supported
  actual fallback reviewer. A valid unknown-preference fixture must be accepted;
  an unsupported actual reviewer must still be rejected.

Tests precede implementation. Unit vectors cover canonical object ordering,
stable Unicode, resolved aliases, config comments/spacing and flags-only gates
override, case-equivalent `gates`/`priority` family lists, a bounded unknown
preference with a supported actual fallback, unreadable versus absent
configuration, changed role order/fallback,
model/effort, revision/base/artifact/context, and attempt-independent input
digests. Integrity tests cover unknown fields, malformed canonical bytes, fixed
references, digest changes, missing artifacts, duplicate attempts and role claims,
symlink escape, credentials, size limits, and read-only checker recovery in a
fresh process.

Selection-lifetime fixtures change only a final role's model or effort and keep
the prior outer receipt valid while invalidating the final receipt. Changing an
outer selection invalidates both roles; changing the common preferred role list
or relevant configuration invalidates every role. Context fixtures combine an
honest native Codex initial/null receipt with a supported role's non-null
re-review context, accept that set, and reject a mismatch confined to either
role's expected context. These fixtures close the named design corrections
without requiring another model call.

Lifecycle tests cover exclusive start/terminal collisions, interrupted staging,
stdout failure, terminal publication failure, explicit skipped/error/preview,
valid positive and negative verdicts, missing verdict, requested/observed model
disagreement, unavailable native identity, and a killed start-only helper. Stubbed
integration covers Claude, Codex, Kimi, GLM, DeepSeek, and MiMo, including invalid
GLM protocol and a target/config change during dispatch. Existing no-opt-in
tests establish backward compatibility. No paid model call is needed for these
artifact contracts.

After adversarial design closure, run targeted tests and declared static checks,
including Markdown lint. Initial self-review and internal review cover the full
change; any admitted repair requires root-owned issue-cycle reservation before
editing and focused named closure afterward. External ordered roles and the final
full suite remain the driver's handoff. The draft PR depends on the #96 branch;
neither that branch nor main is modified, and no merge is authorized here.

## Implementation review dispositions

I97-S1 is corrected by limiting hash exemptions to exact schema paths with
validated commit or SHA-256 values. Arbitrary configuration fields always use
the shared sensitivity policy, including fields named `head` or `digest` and
values that look like hashes. Exact configured credentials remain rejected at
every location. The named S1 unit tests cover all previously exempt field names,
retained design and artifact identity, and invalid hash values. The six S1 gate
integration tests require a safe error terminal before any preview is delivered.

I97-S2 is corrected by parsing retained input through the same generic JSON
error boundary as request and terminal files. The named S2 test verifies both
the checker function and its process output omit malformed source bytes while
preserving distinct malformed-JSON, digest-mismatch, and noncanonical categories.
The existing disabled-target ordering assertion uses the consumed receipt
arguments and retains its error/design and before-skip checks.
