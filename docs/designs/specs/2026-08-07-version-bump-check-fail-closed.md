# Version-bump check: ship `templates/`, fail closed on an unreadable base

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#20 (from the #19 audit, items 1–2). Mechanical scope;
brief design per the scaling rule.

## Frozen issue contract

Acceptance criteria:

1. A changed path under `templates/` requires a version bump. The templates ship
   with the plugin (`source: "./"`) and `afk-init` consumes them at runtime, so
   an unbumped template change is invisible to installed hosts — the exact
   invariant this check exists to protect.
2. Only "manifest absent at the base ref" skips the check (true first-PR case,
   including a stacked PR whose base predates the manifest). Every other base
   read failure — unresolvable ref, `git show` failure, unparseable JSON,
   missing `plugins` array — exits nonzero with a distinct reason.
3. A parsed version that does not match `/^\d+\.\d+\.\d+$/` (base or head) is an
   error, never a pass. `semverGt(head, undefined)` must be unreachable from the
   CLI, and a corrupted base version must not coerce to `0.0.0` and "pass"
   (`Number.parseInt` NaN → 0 in the comparator makes any head look greater).
4. A rename out of a shipped directory is a shipped change: `getChangedPaths`
   diffs with `--no-renames`, so `git mv templates/x docs/x` surfaces the
   `templates/x` deletion instead of vanishing behind rename detection
   (verified: default rename detection lists only the new name).

Engineering invariants: dependency-free Node ESM; no silent skips (every skip
prints a distinct reason); fail toward less exposure; no locale-dependent
parsing of git stderr (classification uses exit codes and `git ls-tree` output
shape only).

Allowed behavior change: CI newly fails on corrupted-base scenarios that
previously passed silently — that is the point.

Non-goals: the semver comparator and `validate.yml` stay as they are. `docs/`,
`README.md`, and other shipped-but-not-runtime-consumed files stay outside
`SHIPPED_DIRS` — they ride in the install but no skill reads them at runtime,
so a stale copy has no behavioral effect; recording that boundary here is the
decision. (R1 corrected the original "diff logic stays as-is" non-goal: rename
detection was a fail-open hole in the exact surface this issue closes.)

## Design

- `SHIPPED_DIRS` gains `'templates/'`.
- `readVersionAtRef` is replaced by a classified read:
  1. `git rev-parse --verify --quiet <ref>^{commit}` — failure ⇒ error
     ("cannot resolve base ref"), never a skip.
  2. `git ls-tree --name-only <ref> -- .claude-plugin/marketplace.json` —
     empty output ⇒ `{ kind: 'absent' }` (the only skip path).
  3. `git show <ref>:.claude-plugin/marketplace.json` + `JSON.parse` + shape
     check (`plugins[0].version` matches `/^\d+\.\d+\.\d+$/`) — any failure ⇒
     error with a distinct reason naming the failing step.
- The classified read is exported as `readBaseVersion(repoRoot, ref)` →
  `{ kind: 'version', version }` | `{ kind: 'absent' }`, throwing a classified
  error otherwise — the test seam for every failure class.
- `evaluate` keeps `null` = "absent at base" semantics and additionally rejects
  a `headVersion` failing the shape rule when a bump is required, with a
  distinct reason.
- `getChangedPaths` adds `--no-renames`.
- The CLI wraps the whole flow in a catch-all: classified errors → stderr +
  exit 1 with their distinct reason; any other throw (e.g. an unreadable or
  unparseable working-tree manifest in `readWorkingVersion`) → stderr + exit 1
  as `version check failed: <message>` — fail-closed either way, never a bare
  stack trace. The absent case keeps the existing "first PR" skip wording plus
  the ref it checked.
- Mechanics pinned for Windows: `execFileSync('git', [...])` with no shell
  (`^{commit}` is a cmd.exe metacharacter under a shell), and the `ls-tree`
  emptiness test trims `\r?\n` first.

CI safety: `validate.yml` checks out with `fetch-depth: 0` and passes
`--base origin/<base_ref>`, so the ref always resolves there; the error paths
fire only where today's code silently skips or dies with an unclassified stack
trace.

## Test plan

Pure-function cases: `templates/` requires a bump; head-version shape rejection
sits after the `requiresBump` early-return (a deleted working manifest with no
shipped change still skips). Integration cases against tmpdir fixture repos:
absent manifest at base (skip), empty-tree base commit (skip), non-JSON
manifest at base (error), missing `plugins` shape (error), non-semver version
string (error), unresolvable ref (error), unparseable working-tree manifest
(error, distinct reason), rename-out-of-shipped-dir requires a bump.

## Debate record

- R1 (critic, same-model subagent): F1–F4, F10 verified the git-plumbing claims
  and test compatibility (supported, no change). F5 rename fail-open (P2,
  supported) → fixed by `--no-renames`, contract corrected. F8 no test seam
  (P2, supported) → fixed by exporting `readBaseVersion` + integration tests.
  F6 non-semver coercion (minor, supported) → fixed by the shape rule. F7 spec
  overstatement (minor, supported) → reworded. F9 Windows conditionals (minor,
  unverified on this host) → pinned in mechanics, exposure is local-dev only.
- R2: F5/F7/F8/F9 resolved by name. Not clean: F6's design-step parenthetical
  still carried the old "non-empty string" rule (contract-vs-design
  contradiction) → fixed to the shape regex; N1 (a pre-written round record —
  a record authored ahead of the debate it records has no evidentiary value)
  → this record is now written only after each verdict; N2 (head-read throw
  had no assigned reason class) → CLI catch-all with `version check failed:`
  reason + test-plan case.
- R3: F6/N1/N2 resolved by name, no new findings — clean round.
  Implementation starts here.
