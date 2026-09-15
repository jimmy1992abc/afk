# Direction auditing rollout

Use direction auditing only for an explicitly selected run policy. The default is `off`.
The canonical contracts are [direction state](../skills/afk/references/direction-state.md) and
[direction audits](../skills/afk/references/direction-audit.md).

## Qualification status

This release ships a pending qualification record for its actual runtime fingerprint.
Dispatch and endpoint approval remain unavailable until an independently reviewed
real transport qualification matches that profile. Unit tests use explicit fixtures;
they do not qualify a live provider or prove agent behavior. No behavioral
improvement is claimed for this release.

## Mode semantics

- `off`: adds no direction audit call or direction-specific completion condition. Ordinary findings, tests, reviews, CI, publication limits and owner merge authority still apply.
- `shadow`: uses the same source, independence and call bounds while adding no direction-only hold or readiness condition. It does not bypass dispatch qualification or authorize extra calls.
- `required`: calls for an independent initial audit before implementation and a valid, current phase-`endpoint` `COMPLETE` for the selected endpoint and actual target before dependent completion. Initial/signal `COMPLETE`, `ON-TRACK`, stale or missing evidence cannot substitute. A previously charged last slot can still produce its valid result; exhaustion grants no next attempt.

A measurement-fixture `COMPLETE` is not approval of the original author's target or proof of semantic compliance. Source/hash checks constrain artifacts only when invoked; semantic judgment is level 1, helper-local artifact checks level 2, and truthful driver/owner execution level 3. AFK supplies no external reference monitor or guarantee of task alignment.

## Inspect before enabling or amending

Work from the consuming repository, resolve the installed plugin root through the canonical environment rules, and use the supplied run identity in the main working tree's ignored `.afk/runs/`. Do not allocate a new run merely to read a mode or avoid an exhausted allowance.

The following are command templates, not executed evidence. Replace each placeholder with an actual retained identity/path. Reads do not dispatch models:

```text
node "<plugin-root>/scripts/direction-state.mjs" check --run-id <run-id> --issue <issue-id>
node "<plugin-root>/scripts/direction-state.mjs" check --run-id <run-id> --issue <issue-id> --expected <expected.json>
node "<plugin-root>/scripts/check-direction-audit.mjs" check --run-id <run-id> --issue <issue-id> --audit <audit-id> --stage result
node "<plugin-root>/scripts/check-direction-audit.mjs" check --run-id <run-id> --issue <issue-id> --audit <audit-id> --stage endpoint --endpoint <endpoint-id>
```

`--expected` is optional and uses the schema's retained head/baseline/policy binding for an initialized state, not an unmodified whole CLI response. Its canonical JSON file must be inside the named run. Read status, reasons, mode, active digests, accounting and `canReserve`; exit zero alone is not permission to launch or complete work. An unavailable standalone audit check may report missing files/directories instead of literal `off`. Missing or corrupt state cannot discard a retained required policy.

Absent direction records remain off even when config changes. Explicit initialization is limited to an active run with source authorization, recoverable baseline and conservative prior direction accounting. Completed runs are history and are not reopened or migrated. An unknown prior consumption value cannot be replaced by zero or made known by raising a limit.

For an initialized policy, editing `.afk/config.md` does not amend it. Retain the operator's actual amendment source in the run, inspect the current head and construct the schema's canonical policy-successor request. The successor retains the previous digest, increments the revision and supplies explicit sourced operator authorization for the amendment. Preserve accurate sources for the resulting mode and limit. Request/source references are inspectable claims, not proof of the owner's identity or intent.

Only when that concrete amendment is authorized, apply its retained request:

```text
node "<plugin-root>/scripts/direction-state.mjs" apply --request <request.json>
```

The request must be canonical JSON inside its named run and use the exact expected head. `apply` publishes one exclusive sequence record and does not call a model. Verify the returned record and reread state. A stale head requires a deliberate reload/new request. Exact `already_recorded` replay provides no new dispatch opportunity. `publication_unknown` leaves a potentially published charge/record to reconcile; it is not permission to overwrite, refund or retry a call.

Technical replanning within authorized intent changes the plan, not the intent baseline. Evidence-backed clarification preserves semantic clauses and product decisions. An actual intent change needs a sourced operator-authorized baseline successor. Baseline or policy changes invalidate results bound to old digests.

## Consumption and rollback

Direction-call, content-repair and transport-qualification allowances have separate owners. New unspecified direction policies have no attempt cap. Explicit finite policies retain their sourced ceilings; a new default never resets or expands an existing run. Further calls still require a concrete question or corrective action under the canonical convergence rules. Preparation alone spends no direction slot. A published reservation remains charged across timeout, malformed output, attempted unavailability or missing/interrupted terminal. Reserved-without-terminal attempts are not counted twice. Lowering the limit, disabling or re-enabling the mode refunds nothing; zero or a limit below consumption permits no new reservation. Unknown accounting permits no new dispatch until reconciled from retained evidence.

A completed response is not erased merely because later accounting becomes unknown. Preserve it and its historical terminal; the driver must still resolve the separate allowance judgment and current endpoint eligibility. Do not treat missing output as proof that no call happened.

To roll back an active initialized run:

1. Retain its current ledger, findings/dispositions, source snapshots, full baseline/policy sequence, reservations, results, witnesses and available execution evidence. Record the actual rollback authority and affected run/issue.
2. Reload the current state and retained expected bindings. Construct and apply an explicitly authorized policy successor setting `off`, using the same canonical request procedure above. Do not delete records or edit old policy versions.
3. Verify the published successor and reread state. Preserve every consumed allowance and ordinary verified blocker. Missing evidence remains OUTSTANDING; disabling direction removes only its extra condition.
4. Before later re-enabling, use another sourced successor and recheck current target/baseline/policy/profile and actual qualification. Old results do not become current merely because the same mode is selected again.

Retain-off for future adoption is distinct from rolling back an already initialized run. If an owner selects an earlier release for a genuinely new scope, retain old evidence under its original protocol/profile/release attribution. Never reinterpret newer records through older code or relabel a continuation as a new run to reset its allowance.

Qualification eligibility is not code-byte equality: replacing a pending record with valid qualified metadata can change endpoint eligibility with the same runtime bytes. Validate the actual record and provenance for the current profile after a change. Mock qualification is not real compatibility. A pending/invalid record is enough to withhold promotion and continue ordinary authorized work under an off policy; it does not require an extra qualification experiment to justify retain-off.

## Continued improvement

Use recurring verified failures to propose targeted fixtures and reviewed changes with their existing finding and allowance history. Do not append generic global lessons or modify installed skills automatically. Current independent reviews, required checks and the normal owner merge process apply to the actual release diff; historical review approval is not a new release stamp.
