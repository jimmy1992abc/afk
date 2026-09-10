# Audit remainder reconciliation

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

## Contract

Issue #41 mixes shipped fixes, reproducible local defects, and operator or
platform prerequisites. This revision fixes the independently verifiable
remainder without claiming to close the whole issue. It depends on #44 and
increments the plugin from 0.8.7 to 0.8.8.

## Changes

- `lib/gate/git.mjs`: select the first non-bare worktree record. Keep ordinary
  and linked layouts unchanged; align live skill and repository instructions.
- `lib/resume/detect.mjs`: read a complete heartbeat field without crossing
  lines; require a full timestamp with explicit timezone. Missing, malformed,
  impossible or implausibly future dates remain visible as unknown ownership,
  never an automatic-resume directive. Keep `relPath` for compatibility and
  add an absolute `ledgerPath` for linked-worktree context.
- `hooks/afk-resume-detect.mjs`: load local dependencies inside its guarded
  async entry point. A missing dependency is an observable benign skip, exits
  zero, and emits no invalid context. Keep startup/resume and opt-out behavior.
- `lib/plugin-root.mjs`: refresh a missing recognized afk-skills versioned
  cache root to a verified live afk plugin root, even across installation
  styles. Preserve arbitrary custom paths and other plugin/marketplace roots;
  retain the existing same-install version-refresh rule.
- `scripts/update-check.mjs` and shared `lib/version.mjs`: accept only canonical numeric major.minor.patch
  releases with safe integer components at local, remote and cache boundaries.
  No prerelease comparison is introduced. The CLI uses the consuming main
  worktree's existing `.afk/update-check.json` cache; it never creates `.afk`.
  Invalid versions produce no notice, and failed fetches keep the daily cache.
- `templates/afk-config.example.md`: blank command fields, a parseable
  invariants heading, and a blank pluginRoot field prevent executable
  placeholders and allow the bootstrap to fill real values.
- `scripts/lint-skills.mjs`: descriptions must lead with the exact namespaced
  trigger and identify the afk pipeline. Update every shipped description and
  tests without expanding the YAML subset.
- `.github/workflows/validate.yml`: pass the base ref through an environment
  variable and verify a pinned gitleaks archive SHA-256 before extraction.
- `scripts/scan-provenance.mjs`: scope the claim to private IPv4 and prevent
  inherited repository-selection Git variables from redirecting enumeration.
- `lib/gate/env.mjs`: remove the unused abortAfter export and its orphan test.
  Narrow the sync workflow's JSON recovery comment to the files it parses.
- `skills/afk/SKILL.md`: track all content-author families on the current
  revision; driver fixes add rather than replace an author. Exclude all such
  families from external roles. Explicit implementer declarations are required
  outside Claude; CLAUDECODE detects only a Claude host. The single-family
  helper guard does not mechanically validate the full author set; this is
  driver doctrine, not an enforcement claim.

## Verification

Regression tests precede implementation: real bare-plus-worktree discovery;
space-separated, timezone-free and impossible heartbeat values; unknown-age
notify-only behavior; linked-worktree absolute ledger paths; missing hook
dependency; recognized missing cache migration and custom-root preservation;
malicious version strings through local/remote/cache paths; CLI/hook cache
sharing; real starter-template parser roundtrip; description-lead rejection;
and provenance enumeration under a redirected Git environment. Existing gate,
hook, init and lint suites provide compatibility coverage. Verify gitleaks
against the official release checksum, test checksum ordering in the workflow,
and run all local checks after independent Kimi K3 review.

The allowlist comprises the files above, their existing tests, the consolidated
`scripts/audit-remainder.test.mjs` regression suite, all live skill
descriptions/worktree-resolution instructions, AGENTS.md, the design, and
version manifests. `scripts/sync-marketplace.mjs` is the manifest generator.
No new dependencies or runtime are introduced.

## Residual work and evidence

- Owner policy and its mechanical workflow fixes await the operator choice
  required by the issue. Existing admin-author exemption does not distinguish
  a human from an agent using the owner's account.
- GLM live identity verification requires a configured credential; no usable
  credential was found. Never infer live identity from a fixture.
- Windows descendant teardown requires a live Windows process-tree test.
  Killing a shell PID after spawnSync times out cannot prove descendant cleanup;
  no unverified taskkill patch is shipped from a non-Windows machine.
- Codex mandatory verdict syntax remains deferred until a native targeted
  review demonstrates the requested output contract. Existing nonzero/signal
  checks stay unchanged.
- Relay byte accounting, signal regression coverage, redaction-count semantics,
  Actions activation and version-race documentation already shipped. Preserve
  them and record the evidence on #41 rather than duplicating their fixes.

No Azure policy interpretation, credentials, account setup, branch-protection
mutation or merge-policy change belongs to this revision.
