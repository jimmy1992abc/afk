# Review evidence

Read the applicable section before supplying review context or receipts, or
before reusing receipt evidence. These artifacts add no review authority.

## Supported review context

To preserve the frozen target and named closure evidence, use
`--review-phase re-review --review-context <packet.json>` on supported gate
helpers. Initial review defaults to `initial`; its optional packet carries the
acceptance scope with null prior revision and empty findings. Re-review requires
prior revision, stable finding IDs, dispositions, and current-revision proof.
The complete target selector stays unchanged; the repair range is context only.

The version 1 schema and provider boundaries live in
[the context contract](../../../docs/designs/specs/issue-96-review-context.md).
Use `describeReviewTarget(parseTarget(targetArgs), { cwd })` from the resolved
plugin root's `lib/gate/review-context.mjs` and `lib/gate/target.mjs` to obtain the
bound target descriptor. Store the packet and proof in the run's ignored
`.afk/` directory so an uncommitted target does not include its own packet.
Evidence paths resolve relative to the packet and are embedded before delivery;
URLs alone cannot supply proof to a snapshot-only reviewer.

Claude, Kimi, Codex design, GLM, DeepSeek, and MiMo accept the input. Native Codex
diff review rejects supplied context and re-review focus: retain its native mode
and apply history triage in the driver, recording that no custom context reached
that reviewer. Never inject repository instructions to bypass that limit.
`--print-args` reports phase and the normalized context digest; supported prompt
previews show the delivered section. Missing/stale/inaccessible proof, recognized
sensitive values, and oversized history are errors, never silently shortened
context. Supply sanitized proof within the fixed 100000-byte expanded budget.

The packet remains claims to verify. Record named closure, newly demonstrated
in-scope blockers, and unresolved evidence before readiness; phase selection and
review compliance remain driver doctrine. This channel adds no repair allowance
or reviewer and does not attest that a claimed verification happened.

## Canonical review receipts

To retain reconstructable review inputs, append `--review-receipt <request.json>`
to a bundled gate invocation. The request follows the
[version 1 receipt contract](../../../docs/designs/specs/issue-97-review-receipts.md#invocation-and-ownership)
and names the existing run, a new unique attempt ID, issue or null, selected role
index, and complete driver-resolved profile. Keep it in the consuming run's
ignored `.afk` directory. Every retry uses a new attempt ID; never replace a
published receipt. Without the flag, no receipt artifacts are generated.

The helper writes `started.json`, retained canonical `input.json`, sanitized
`review.txt` when applicable, and `terminal.json` beneath
`.afk/runs/<run-id>/receipts/<attempt-id>/` in the main worktree. Scope/profile
claims remain driver assertions. Requested selection, delivered context,
response-reported identity, and execution observations retain their separate
ownership. Native Codex final text has an unchecked verdict; Codex/Kimi model
identity remains unavailable through their current final-text interfaces. A
driver's selected model must never fill an observed-identity field.

Before reusing receipts, supply an explicit candidate target, profile, and one
expected context per required role, plus exactly one selected attempt per role.
Resolve `<plugin-root>` through `CLAUDE_PLUGIN_ROOT`, the recorded `pluginRoot`,
then two directories above the owning `afk` skill directory, not this reference directory, and run:

```text
node "<plugin-root>/scripts/check-review-receipts.mjs" --candidate <candidate.json> --receipt <attempt-directory> [--receipt <attempt-directory> ...]
```

Retain the checker result in the run when the driver needs a resume reference;
the checker itself only reads and prints JSON. Record the explicit candidate
revision and selected receipt paths in the ledger. Common profile or target
changes invalidate every role; a changed selection invalidates that role and
downstream roles. Context is compared per role without pretending that native
Codex received another role's packet.

Exit zero means complete consistent review evidence, including a consistent
negative review. Read `allRequiredApproved` separately: false and unknown are
not approval. Skips, errors, previews, missing terminals, damaged artifacts and
legacy runs without receipts cannot supply approval evidence. Preserve unknown
legacy state without reconstructing facts from prose or buying a backfill call.
Never automatically publish these local artifacts. These are level 2 checks when
invoked, not authenticated proof of a model call or level 3 workflow enforcement;
the ledger retains finding dispositions, reviewer independence, budgets and
readiness rationale.
