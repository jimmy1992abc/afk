# Bounded external review gates

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

## Problem

Kimi now has a review timeout, but Claude and Codex still use unbounded child
processes and GLM still uses an unbounded HTTP request. Their availability
probes are unbounded as well. Any one of those calls can wedge the ordered gate
sequence forever.

## Decision

Keep timeout parsing in `lib/gate/env.mjs`, beside the existing strict numeric
environment parser, and make all four gates use one policy:

- Claude, Codex, and GLM reviews default to 15 minutes; Kimi defaults to 30
  minutes because its agentic review commonly progresses for longer.
- `AFK_REVIEW_TIMEOUT_MS` overrides the shared default.
- `<FAMILY>_REVIEW_TIMEOUT_MS` overrides one gate.
- Invalid, zero, negative, decimal, and suffixed values retain a bounded limit
  and emit a warning.
- CLI availability/authentication probes use the smaller of the review timeout
  and 30 seconds.
- A timed-out review emits a non-zero `ERROR`, never a partial verdict. It
  follows the existing transient-error retry and fallback rule.
- A timed-out availability probe emits `SKIPPED` because that provider could not
  establish local availability.
- CLI timeouts use `SIGKILL`; a cooperative `SIGTERM` does not provide a hard
  bound when the reviewed CLI is already wedged.

Gate-specific override wins over shared override, which wins over the default.
The policy and timeout-result detection have one implementation so providers
cannot drift.

On Windows, CLI shims require a shell. The gate process remains bounded, but the
platform may leave a shim grandchild running after the shell is terminated; the
operator may need to stop that orphaned CLI process separately.

## Files

- `lib/gate/env.mjs` and `lib/gate/gate.test.mjs`: shared policy and unit tests.
- Claude, Codex, Kimi, and GLM gate helpers: bounded process or fetch calls.
- Gate integration tests: local sleeping processes or a local HTTP response
  whose body never completes; no model calls.
- README and gate skills: documented variables and outcome semantics.

## Verification

Run the targeted timeout tests first, then every repository check and the full
Node suite. Confirm the tracked tree contains no former-owner name or repository
URL before merge.
