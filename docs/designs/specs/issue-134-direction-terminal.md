# Direction result limits and terminal dispatch evidence

## Frozen contract

Issue #134 closes two failures in retained direction audits: a permitted result
larger than the general evidence limit cannot be read or terminalized, and a
zero-request refusal writes a not-started witness that readers reinterpret as
started. One result-size limit must govern publication, result loading and
terminal state reference inspection. Terminalization must retain the writer's
actual dispatch observation, preserve immutable artifacts and charged-attempt
accounting, and keep version-1 retained records readable.

No live provider call, qualification campaign, provider/default change or new
accounting policy is authorized. Existing direction qualification remains
separate and pending/stale where its profile no longer matches. Do not weaken
ordinary evidence limits to admit larger audit results.

## Implementation

Add a dedicated audit-result byte limit to the existing shared direction schema
limits, retaining the current writer ceiling of 262144 bytes. Pass it explicitly
to result publication and loading. Identify terminal result references separately
from ordinary opaque/source evidence during state inspection and apply the same
limit there. Keep source/record limits and the HTTP wire-response limit unchanged.
This prevents an artifact accepted by publication from making its own terminal
record unreadable.

Reuse the existing terminal witness rather than add another persisted dispatch
field or schema version. The writer already records started/not-started from
its actual request count. On result loading, read the witness, extract its
strict dispatch enum, then compare the entire witness against canonical output
for the bound audit and validated observation. Return this checked dispatch to
terminalRequest instead of deriving it from an error reason. A completed result
must say started; a not-started witness cannot accompany an HTTP response or
status. Invalid or contradictory witnesses remain explicit errors.

The witness is local, unsigned helper evidence (level 2 when checked), not proof
that an external model ran. Existing review/dispatch scheduling remains driver
doctrine. The result/observation schemas stay at version 1 and no retained file
is rewritten. A terminal closes a reservation without refunding its charge.

D134-1 corrects the assumption that the current-profile loader can terminalize
retained audits after upgrade: these runtime edits change its fingerprint. Use
the existing historical load path specifically in terminalRequest. Preserve
retained packet/request/preparation validation, reservation binding, validated
result/witness, current-state CAS and immutable evidence. Dispatch and endpoint
qualification continue requiring the current profile; terminalization never
redispatches or qualifies an endpoint.

## Validation and release

Tests first through preparation, reservation, injected transport, terminal request,
append and state reread: a valid result between 100000 and 131072 wire bytes must
remain usable; a request containing the synthetic configured credential must
perform zero fetches and terminalize as not-started; no-key and dispatched
failure paths retain their distinct observed dispatch. Verify result-limit
refusal and unchanged ordinary-evidence limits, malformed/contradictory witness
refusal, accounting after terminalization, and immutable original bytes.
Prepare and reserve under an earlier runtime, retain the exchange, then
terminalize using the repaired runtime. Assert unchanged artifact bytes, one
charge and a closed reservation; legacy redispatch/current qualification and
tampered request/binding must remain refused. This pins D134-1.
All provider transport is mocked or local fixture data.

Run direction-specific suites, repository checks and final full tests.
Owner review and configured external roles remain the merge boundary. Bump the canonical
marketplace version to 1.2.0 and regenerate host mirrors. The only allowed writes
are shared direction limits/audit/state/transport code, their regression tests,
this design and generated release metadata. No new consuming configuration or
migration is required. Leave the reviewed PR open.
