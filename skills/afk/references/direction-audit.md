# Direction audits

Read when a retained run policy enables direction auditing, before its stage or
signal checkpoint, and before using a direction result for an endpoint. Read
[direction state](direction-state.md) for baseline, policy and charged attempts;
[environment](environment.md) for the main-tree run and resolved plugin root.
Do not initialize or enable an audit merely because this reference exists.

## Modes and checkpoints

Off preserves the existing workflow and makes no audit call. Shadow uses the
same evidence and call bounds but adds no direction-only hold or readiness
condition. Required calls for an independent initial audit before implementation
and a current endpoint audit before the selected completion endpoint. At resume
and stage transitions, compare retained intent, actual target and next action.
Batch simultaneous concrete drift signals at the next tool boundary: changed
requirements or target scope, admitted omissions, conflicting next actions and
contested corrections. Elapsed time alone is not an audit trigger.

Required completion needs a valid, current, phase-endpoint COMPLETE for that same
endpoint and target. Initial or signal COMPLETE, any ON-TRACK, stale evidence,
missing identity or exhausted calls cannot satisfy it. Keep dependent completion
OUTSTANDING. Ordinary tests, reviews, CI, owner authority and standalone task
boundaries still apply under [publication](publication.md).

An unavailable or apparently absent sequence does not turn retained required
policy off. Compare retained packet bindings; only a validated sourced policy
amendment can disable an active policy. Parent state availability limitations
remain visible. Do not reconstruct missing consumption as zero.

## Prepare, reserve and dispatch

Use the exact typed APIs in [audit.mjs](../../../lib/direction/audit.mjs), which
validate packet/result fields without network access. Prepare canonical input
inside the current ignored run with the authorized endpoint/source, actual
artifact authors, target selector, evidence, full requirement coverage, separate
prior findings/dispositions and next action. Baseline and policy come from state.

Source references must match baseline snapshots. Artifact entries supply actual
repository-relative paths; the helper captures their selected Git blobs or
confined worktree bytes. Check entries are source-bound driver claims; hashes do
not authenticate that a command ran. Retain real command evidence separately.
Branch/commit candidates require a clean actual worktree and actual HEAD match.
An authorized dirty candidate explicitly selects uncommitted; never silently
change selectors or deliver old committed bytes for dirty work. A design target
includes its selected design artifact and retains its standalone endpoint.

```text
node "<plugin-root>/scripts/check-direction-audit.mjs" prepare --run-id <run> --issue <issue> --input <input.json>
node "<plugin-root>/scripts/direction-state.mjs" apply --request <reserve-request.json>
node "<plugin-root>/scripts/check-direction-audit.mjs" check --run-id <run> --issue <issue> --audit <id> --stage pre-dispatch
```

Preparation writes immutable packet, exact credential-free request, captured
evidence and reservation request under `issues/<issue>/audits/<id>/`. It spends
nothing. A freshly published reservation charges one existing state attempt
before availability or dispatch. Exact replay, publication-unknown, an existing
dispatch marker or a pending old reservation grants no fresh dispatch. The last
charged slot remains usable even though state now reports no remaining capacity.
Current accounting must still be known before dispatch. If reconciliation makes
history unknown after reservation, do not spend that slot until the accounting
is resolved; the existing charge remains retained.

The driver explicitly invokes the fixed manual transport once, supplying
`DEEPSEEK_API_KEY` only through the environment, never config or command arguments:

```bash
node --input-type=module - "$PLUGIN_ROOT" "$RUN_ID" "$ISSUE_ID" "$AUDIT_ID" <<'NODE'
const { dispatchAudit } = await import(`${process.argv[2]}/lib/direction/transport.mjs`);
const result = await dispatchAudit({ cwd: process.cwd(), runId: process.argv[3],
  issueId: process.argv[4], auditId: process.argv[5], env: process.env });
process.stdout.write(JSON.stringify(result) + '\n');
process.exitCode = result.exitCode;
NODE
```

Apply the profile's process deadline at invocation and retain stdout/stderr and
the observed terminal status. The checker neither schedules this command nor
loads credentials. Production dispatch requires the shipped qualified profile;
pending, stale or unavailable qualification leaves required work OUTSTANDING.
The actual auditor must differ from all artifact authors. Unknown authors are
unavailable, and no automatic provider fallback or additional PR role is added.

The profile uses a fresh two-message stateless request with no tools or external
session history; relevant prior audit contexts remain inside the packet,
exact DeepSeek Flash alias and thinking disabled. Its full serialized request cap
is 1MiB, aggregate packet cap 256KiB, output cap 8192 tokens, response cap 128KiB and HTTP timeout 120 seconds;
the driver supplies a 150-second process watchdog. Oversized full intent/evidence
refuses with `profile_input_limit`. Do not truncate, compress, omit sources or
combine partial packets while claiming full coverage. A different mode, prompt,
profile or executed dependency needs matching qualification.

## Result and completion

Retain the sanitized response, distinct raw-byte hash, typed result, observed
provider identity/finish/usage and strict terminal witness. Unknown usage remains
unknown. Tools, incomplete finish, identity mismatch and malformed payloads are
invalid evidence. No output executes a tool or changes authority.
Unknown accounting discovered after a call does not erase its completed
observation or prevent historical terminal recording. Result/endpoint checks
retain protocol and outcome evidence and report `accounting_unknown`; the
direction condition does not replace the driver's separate allowance judgment.

```text
node "<plugin-root>/scripts/check-direction-audit.mjs" check --run-id <run> --issue <issue> --audit <id> --stage result
node "<plugin-root>/scripts/check-direction-audit.mjs" terminal-request --run-id <run> --issue <issue> --audit <id> --operation-id <operation>
node "<plugin-root>/scripts/direction-state.mjs" apply --request <retained-terminal-request.json>
node "<plugin-root>/scripts/check-direction-audit.mjs" check --run-id <run> --issue <issue> --audit <id> --stage endpoint --endpoint <endpoint>
```

Retain terminal-request stdout at a new run-local path before apply. A stale CAS
head permits rebuilding that request with a new operation ID, never another model
call. A valid stale result can be recorded historically but cannot satisfy the
current endpoint. Invalid/unavailable results use a null state result reference;
their strict plain-text witness supplies the terminal evidence. Missing output
alone proves neither an unused reservation nor an observed interruption.

Inspect all returned fields. Exit zero, valid transport and correct shape alone
are not a direction judgment. Result, endpoint and qualification checks re-extract
the retained response and compare its whole sanitized payload, including outcome,
findings and coverage. Free text/source bytes retain secret checks; only exact
typed binding fields receive digest treatment. Source quotes cover the actual
approved line span. A current endpoint COMPLETE is a direction condition only.

Keep model findings immutable and separate from driver dispositions. Use
[review convergence](review-convergence.md) to admit corrections and reserve the
existing shared repair allowance before edits. Findings do not authorize scope
expansion, destructive rollback or extra model calls. Intent changes require the
existing sourced baseline successor. An unset attempt cap does not remove
convergence checks or authorize repetitive calls without a new question or
corrective action; every reservation remains charged.

For prior findings, supply the original audit ID and retained packet/result
references in the preparation history. The helper verifies the recorded attempt,
terminal result and snapshots, then delivers one flat original context per audit.
Keep the original finding unchanged when the current artifact is corrected; put
the driver's decision and proof in its separate disposition. Historical quotes
are checked against their original evidence and cannot satisfy current coverage.
Retained historical profiles do not qualify a new dispatch profile.

## Evidence limits

Source-grounded judgment is level 1. Shape, hash, bounded I/O, response derivation
and current artifact eligibility are level 2 when invoked. Scheduling, truthful
author/provider provenance, actual-call qualification and completion are level 3
driver obligations. A fully consistent fabricated artifact set is not
distinguishable from a real call through hashes alone. Provider aliases do not
attest weights or cache erasure; zero HTTP tools do not isolate the author host.
Qualification proves its narrow source-delivery fixture, not semantic reliability.

Before adopting compatibility metadata, retain the actual request, sources,
response, result and driver-reviewed qualification provenance. Qualification
experiment accounting and production audit accounting have distinct owners;
cross-reference a shared physical call without resetting or double-counting
either allowance. Report-only publication must preserve every executed profile
byte. A helper does not grant another qualification call after an incompatible
change.
