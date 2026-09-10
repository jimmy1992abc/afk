# Supported review history context

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

## Spec review and frozen contract

Issue #96 requires explicit, bounded delivery of the frozen acceptance scope and
prior findings to reviewers that accept custom context. The delivery boundary
must distinguish initial review from closure without narrowing the original target.

Acceptance:

- A shared `--review-context <json>` input reaches Claude stdin, Kimi native and
  brief-file transports, Codex design stdin, and every HTTP snapshot request.
- `--review-phase initial|re-review` defaults to initial. Initial review without a
  packet remains supported and comprehensive. Re-review requires a packet with
  prior revision, stable findings, dispositions, and accessible evidence.
- The packet is bound to the selected target and current revision. Missing,
  malformed, mismatched, inaccessible, sensitive, and oversized inputs fail with
  a distinct error before provider invocation; history is never truncated.
- Native Codex diff review rejects context/re-review explicitly, retaining its
  selected mode and the driver's documented history/triage limitation.
- Unicode, quotes, shell metacharacters, the original target, and complete proof
  survive supported transports. A bounded real re-review verifies a named finding;
  its provider, revision, supplied packet, and outcome remain in the run record.

The causal boundary is context loading/validation, prompt delivery, gate docs,
and tests. Existing independence, snapshot exclusions, initial coverage, newly
proven in-scope blockers, verdict checks, and issue-wide repair allowance remain.
There is no new reviewer, orchestration runtime, database, repair budget, receipt
writer, repository instruction injection, or unrelated gate fix. Validation is
level 2 when invoked; evidence truth and reviewer understanding are level 1;
phase selection, closure, independence scheduling, and readiness are level 3.

## Context contract

Version 1 is JSON with exactly these top-level fields:

- `version`: integer 1.
- `target`: the descriptor returned by exported `describeReviewTarget(target)`.
  It includes `kind`, full `revision`, and for branch reviews `baseRevision`
  (the merge base). Design and uncommitted targets additionally carry
  `artifactDigest`: SHA-256 of the design bytes, or the full tracked diff and
  sorted untracked path/content pairs. Design targets also carry the repo-relative
  `path`. The selected CLI target remains the complete review target.
- `acceptance`: nonempty frozen scope and relevant invariants as text.
- `priorRevision`: null for initial review; a full local commit ID for re-review.
- `findings`: empty for initial review; a nonempty array for re-review, each with
  unique nonempty `id`, `disposition` (`open`, `fixed`, `refuted`, `deferred`,
  `suppressed`, or `contested`), nonempty `claim`, and nonempty `evidence` array.
- Each evidence entry has a `revision` equal to `target.revision`, and exactly
  one nonempty `text` or `path`. Text embeds proof or its verified reasoning;
  path names a local UTF-8 file relative to the context artifact's directory.
  Paths are resolved and their full text embedded for every provider, so no
  snapshot-only reviewer is asked to retrieve an inaccessible reference.

The previous revision must resolve locally and be an ancestor of the current
revision. A branch's merge base must also be an ancestor of the prior revision.
The current and prior revision may coincide for a refutation or an unchanged
artifact. The helper identifies the repair delta as `priorRevision..revision`,
plus the bound working artifact when applicable; it never replaces the complete
CLI target with that range. Revision equality validates the caller's binding,
not the truth of an evidence claim or its claimed execution. Remote URLs may be
textual background but are not a supported evidence-path retrieval channel.

The helper returns normalized expanded context, a SHA-256 digest of its JSON
bytes, and a prompt section. Evidence paths become `{revision, path, text}` in
that section. Field ordering is fixed by construction; finding/evidence array
order remains meaningful. This digest describes delivered history, not a receipt
or an attestation. Issue #97 may consume it without changing this contract.

## Boundary and failure direction

Context and evidence files must be regular files inside the current worktree or
its main worktree's `.afk/` directory. Use `mainWorktree`, `readConfinedUtf8File`,
`isExcluded`, `redactCredential`/`redactSecrets`, and `byteLength`; do not duplicate
file identity or secret-pattern logic. Reject secret-bearing paths, symlinks,
ancestor escapes, binary/NUL content, unreadable files, and unknown schema fields.
All context/proof text is checked by the shared redactor; any recognized sensitive
value causes a generic error without printing it. HTTP callers additionally pass
the configured credential for exact matching on every field, including structured
commit/digest fields. Structured commit/digest fields receive exact credential
matching and format validation separately from heuristic secret matching, because
valid digests resemble the redactor's entropy patterns. Users must supply sanitized proof: redacting required evidence in place
could silently remove what closure needs.

One fixed 100000-byte context budget bounds the source packet, each evidence read,
and the final expanded JSON/prompt section. Check opened file size before reading
and actual UTF-8 bytes afterward; never truncate. This independent cap applies to
all transports. HTTP snapshots retain their existing target budget and additionally
reject when the full payload plus context exceeds that budget, rather than making
space by dropping target material. HTTP context is appended after the existing
target redaction in both preview and actual request construction: running the
heuristic redactor over the composed context would replace legitimate SHA-256
digests and violate the delivered identity. CLI target budgets remain unchanged.

Malformed context options and unsupported Codex mode combinations surface before
availability/independence skips. On supported paths, load required context before
provider invocation and dry-run output. No provider call occurs on a validation
error. Gates expose `reviewContextDigest` and phase in existing `--print-args`
output; prompt previews contain the same section that is sent. Native Codex design
adds `--print-prompt` for inspection; native diff reports that custom context and
prompt preview are unavailable instead of forwarding unknown flags.

## Provider evidence and assumptions

A local parser-only probe of Codex CLI 0.153.4 on 2026-09-08 returned exit 2 for
both `review` and `exec review` with each of `--base`, `--commit`, and
`--uncommitted` plus a positional prompt. No model call occurred. Its targeted
review mode therefore remains an explicit exception; Codex design already uses
`exec -s read-only` with stdin and accepts this channel.

Claude's stdin, Kimi's direct argv and saved UTF-8 brief, and HTTP system/user
payload construction are visible in the existing implementation and covered by
hermetic emitted-request tests. Kimi's punctuation normalization must happen
before inserting context text, preserving proof byte-for-byte. A context-bearing
Kimi prompt that exceeds the native Windows argv capacity selects the existing
UTF-8 brief-file delivery before invocation, with a conservative shared threshold
below the 32767-character CreateProcessW limit. Native brief invocation remains
`shell: false`; only an actual/forced script shim uses the existing shell path.
The same threshold may select native brief delivery on other platforms, avoiding
platform-dependent context acceptance. Tool-capable
reviewers may still use their existing tools; injected history grants no authority.
No claim is made that a model will read, understand, or truthfully verify a packet.
The real acceptance trial observes one bounded case, not general compliance.

## Files and execution surface

| Paths | Operation | Reason |
|---|---|---|
| `lib/gate/review-context.mjs` and tests | add | Shared validated contract and target identity |
| `lib/gate/prompt.mjs` | edit | Explicit claims-only context instructions |
| CLI gate entrypoints and `lib/gate/openai-snapshot-gate.mjs` | edit | Supported transport and capability outcomes |
| Gate skill docs and `skills/afk/SKILL.md` | edit | Caller contract, supported modes, and driver limitation |
| `docs/designs/specs/issue-96-review-context.md` | add | Frozen acceptance and design |
| Gate integration tests | add/edit | Actual requests, rejection matrix, and regressions |
| `plugin.json` and generated manifests | edit/generate | Install cache version 0.9.2 |

Production invocation uses the resolved plugin root, then the gate entrypoint with
its unchanged target selector, `--review-phase`, and `--review-context`. The helper
reads Git metadata and confined files; it writes no artifact. Providers retain
existing transcript/brief outputs and read-only properties. `node
scripts/sync-marketplace.mjs` reads plugin/skill metadata and regenerates existing
agent manifests. Run-local review reports and the real-trial packet are untracked
in the main worktree's run directory. Root owns the shared run ledger.

## Test plan, risks, and handoff

Tests first: exercise valid initial/re-review packets; required history; duplicate
flags/IDs, unknown fields, target/revision/base/digest mismatch, unrelated or
missing prior commits; inaccessible proof; secret paths and values; symlink escape;
NUL; byte-budget overflow including Unicode expansion. Verify evidence and finding
IDs in actual stub Claude stdin, native Kimi argv, Kimi brief, Codex design stdin,
and HTTP request body, with target preservation and literal quoting. Required
regressions close I96-D1 by demonstrating a valid large Unicode context reaches
Kimi through a native brief with bounded argv, and I96-D2 by demonstrating HTTP
artifactDigest preservation while a configured credential in any context field
is rejected. Existing gate
suites cover independence, skips, abnormal exits, and verdict parsing.

Targeted suites and manifest, skill, link, and provenance checks run before the
internal handoff. The root performs ordered external roles, one final full suite,
remote checks, and the real named-closure acceptance trial. Leave the PR draft
until these complete; never merge. The main residual risks are caller-asserted
proof provenance, deliberate wrong phase selection, and reviewer noncompliance;
these remain visible level 1/3 limits, not runtime promises.

## Design review dispositions

I96-D1 refuted the assumption that the existing native argv transport could carry
all bounded context. The brief-selection decision above and its required large
Unicode transport regression prevent that consequence. I96-D2 refuted the
assumption that existing HTTP redaction could safely process a composed context.
The post-redaction composition decision and its digest/exact-credential tests
preserve the required identity without exposing the configured credential.

Recorded P2 limitations remain deferred: a packet inside an uncommitted target can
refer to its own digest (use ignored run storage); initial phase accepts no prior
findings; tracked binary diff text does not bind arbitrary binary working bytes.
These do not broaden this issue's frozen transport contract.

I96-S1 required a full-string shared secret scan for delivered evidence and target
path fields: component scans alone lose credential patterns that span separators.
URI-style paths are explicitly refused before reading. The source packet locator
is never delivered; its components and exact configured credential are checked
separately because ordinary absolute temporary prefixes can resemble high-entropy
values. Tests named `I96-S1` in `lib/gate/review-context.test.mjs` and
`scripts/review-context-gates.test.mjs` verify existing URI-shaped and labeled-value
proof paths, descriptor paths, and zero emitted HTTP requests on rejection.

I96-S2 required preserving leading U+FEFF in evidence files during strict UTF-8
decoding. Tests named `I96-S2` in those files assert complete proof equality and
its presence in the actual emitted HTTP context. These are delivery checks;
they make no claim about the truth of the supplied proof.
