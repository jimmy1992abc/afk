# Relay exclusion before patch collection

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

## Frozen contract and scope

Issue80 requires sensitive-file exclusion to survive Git's quoted paths for
non-ASCII, tabs, newlines and quotes, including both rename/copy endpoints.
Safe unusual paths remain reviewable. Unknown inventory fails toward omission
with a distinct credential-safe diagnostic. Real Git regression tests must show
the private synthetic fixture absent with default redaction enabled.

The causal boundary is relay diff collection, its obsolete header filter,
shared literal path handling and their tests. Existing base-to-worktree semantics,
file/grep/log gathering, exclusion policy and default redaction remain. No new
secret-value scanner, framework or orchestration service. Snapshot completeness
and raw-diff execution/timeout policy are separate scoped issues.

## Approach and evidence

Collect `git diff --no-relative --name-status -z -M -C --find-copies-harder BASE --`
before reading any patch. Reuse `parseNameStatusZ` from the shared target helper,
but require valid statuses, nonempty paths, complete NUL termination and exact
round-trip reconstruction of the inventory before selecting paths. Its current
lenient parsing alone is insufficient; ambiguous input cannot become a partial
allowlist.

Apply existing `isExcluded` to both endpoints. If either endpoint is excluded,
omit that entry and report an escaped, redacted path note. If no paths remain,
never call an unrestricted diff. Read approved paths with literal top-level
pathspecs and `--no-renames`: detection already happened on the full inventory,
so narrowed collection must not discover a new excluded copy source. Safe
renames may render as deletion/addition; their content remains reviewable.

Move the existing literal-pathspec formatter from snapshot to the shared target
module and import it in both consumers, without copying its implementation.
Remove `filterDiffByExcludes` and its gather re-export once collection no longer
uses it. Repository search finds only gather and its tests as consumers; it is
an internal helper, not a documented plugin API. This removes the unsafe parser
instead of leaving a second exclusion boundary with incompatible semantics.

Git copy detection identifies similarity-based copies; this change accounts for
the source/destination pairs Git reports, not arbitrary undiscoverable provenance
of newly authored text. Value redaction remains supplementary. The inventory
and patch are separate reads of the existing worktree; this task does not add a
transactional snapshot runtime. Failures produce unavailable/ambiguous notes and
no patch from a failed inventory.

## Files and execution surface

| Artifact | Access and reason |
|---|---|
| `skills/afk-agent-relay/lib/gather.mjs` | Replace header filtering with approved path collection |
| `lib/secret.mjs` | Remove superseded internal header parser |
| `lib/gate/target.mjs`, `lib/gate/snapshot.mjs` | Share existing literal formatter |
| Relay gather tests and this design | Verify actual Git path boundaries and preserve other sources |
| `.claude-plugin/marketplace.json`, generated manifests | Bump0.8.12 and regenerate via existing sync helper |

Run `node scripts/sync-marketplace.mjs` using marketplace version/identity and
skill frontmatter to synchronize host manifests/package version. Tests write
only disposable synthetic repositories and inject command execution into gather;
no real private fixture is read or sent. Production still reads Git through its
existing injectable command boundary. No API writes or paid call is a unit test.

## Test plan and risk

Tests first reproduce default-redaction leakage through real Git with unusual
sensitive paths and verify safe unusual content remains. Exercise both rename
directions, excluded-source copies, literal metacharacters, empty allowlists,
failed/malformed inventory and patch failures. Existing file/grep/log tests must
remain green; snapshot tests check the formatter move has no behavior change.
Run static/version checks, one initial self/internal review, sole KimiK3, final
native suite and CI on the reviewed commit. Leave the stacked PR for owner review.

Principal risk is accepting a partial inventory or expanding pathspecs; complete
parse validation and literal selection address that boundary. Findings outside
this contract are recorded without adding unrelated implementation.

## Verification and repair disposition

Git2.50.1 on macOS produced C100 plus both source/destination paths for an
excluded-source copy; approved literal collection retained the safe edit only.
The initial implementation's status validator rejected zero-padded R0xx scores
from modified renames. I80-001 was admitted against safe-file reviewability:
a real Git regression produced a valid R0xx inventory but no safe patch. Cycle1
corrected only that score grammar and added the regression; the test and affected
relay/shared-formatter tests now pass. Out-of-range/malformed inventory remains
refused before patch collection. No new blocker or causal-boundary expansion
was introduced; consumed allowance is1/2.

## Focused final revision review context

The initial Kimi review approved commit
`4632e0030d0ce745309fd00c23680eb41dff4c6c` against the frozen base
`c04511bd8f2b1b26168bfa276fa7603da3bc9741`. Its only finding, K80-001,
was minor availability loss from extreme path counts exceeding argv limits;
it is deferred because failure omits the patch with a distinct diagnostic.
Its option-looking local base observation was explicitly pre-existing and is
deferred. No external P1 or P2 remained. I80-001 was already fixed and verified
on that revision.

The public PR89 body records the prior final review and all dispositions so
review evidence remains accessible without local run state. Read it with
`gh pr view 89 --json body` before claiming finding closure.
The exact intervening repair is
`git diff 4632e0030d0ce745309fd00c23680eb41dff4c6c HEAD --`.

I80-002 is a required-check failure: the new synthetic Git fixture used a domain
outside the provenance scanner's reserved fixture allowlist. Cycle2 changes only
that address to the allowed `example.com` domain and supplies this review context.
The scanner policy remains intact. Initial local provenance checking preceded
staging and therefore missed this new file; verification must scan it after
staging. Focus final review on that accepted finding, this intervening delta and
the real-Git fixture regressions, while preserving the full final-revision stamp.
The cumulative allowance is2/2; any newly demonstrated blocker stays outstanding.
