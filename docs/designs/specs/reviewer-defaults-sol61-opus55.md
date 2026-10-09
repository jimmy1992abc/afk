# Codex and Claude review defaults

## Contract

AFK Codex review defaults to `gpt-6.1-sol` at `high` effort, and Claude review
defaults to `claude-opus-5-5` at `high` effort. The `sol` and `opus` aliases select
those IDs. Both diff and design review use the shared selection helper. Explicit
model/effort flags, environment values, raw Codex config precedence and opt-in
inheritance retain their existing behavior. Interactive CLI configuration, relay
selection and frozen behavioral-pilot model assignments are outside this change.

## Identity boundary

The existing Claude lineage predicate treats any segment suffix as a snapshot.
An executed check demonstrates that it accepts an Opus 5 response for an Opus 5.5
request. This would misattribute a review under the new default. Restrict this
existing predicate to exact identity or one eight-digit dated snapshot suffix,
in either direction. Distinct minor versions and distinct dated snapshots stay
distinct. Auxiliary model usage remains valid when the requested identity is
present.

The predicate is used by Claude response verification and Claude receipt checks;
both need the correction. REST reviewer identity uses a separate function and
is unchanged. Existing exact-match historical receipts remain readable; a receipt
claiming verification of a different minor version is rejected when checked.
These are helper-local artifact checks, not a guarantee that the driver invokes
an independent review. The shared identity module participates in direction's
runtime fingerprint; old transport qualification is not renewed by this change.

## Validation and release

Update default-dependent tests before implementation. Verify the default model
and effort in shared selection, emitted diff/design CLI arguments and review
receipts. Keep overrides distinct from defaults so their precedence remains
observable. Exercise the old-model refusal through both the Claude gate and
receipt checker, retaining dated-snapshot compatibility. Use stub providers for
regression tests; owner review and configured external roles apply before merge.

Prepare version 1.2.0, from the canonical marketplace and regenerate host
mirrors. No new consuming configuration or state migration is required. Current
environment overrides and per-run selections still take precedence over defaults.
