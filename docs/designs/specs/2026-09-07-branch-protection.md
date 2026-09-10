# Branch protection drift verification

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

## Frozen contract

Issue79 requires active main-branch PR protection, required checks/gate statuses,
strict up-to-date checking, no bypass, conversation resolution, linear history,
no force push or deletion, and squash-only merging. Native approval count stays
zero; admin-author exemption and identity policy remain out of scope in issue41.
The verifier must distinguish compliant, drift and unverifiable API state.
No destructive push, real review submission or unreviewed merge tests controls.

## Source approach

Replace sync-marketplace direct-main writes with read-only manifest verification.
Existing local generation plus topic PR remains the repair route; no bot PR
framework or broad bypass. Add a dependency-free read-only audit command with
injected API boundary for tests. Read repo merge settings, effective main rules,
and source ruleset details to verify active enforcement and no bypass actors.
Fail with unverifiable on missing/invalid API input; drift on verified absent or
incorrect settings. Preserve API failure distinctions and bounded command calls.

Write docs as desired controls plus dated observations, limitations and the audit
command. Owner review is doctrine; gate implements current admin-author exemption
and is not proof a human reviewed the PR. Settings enforce only while configured.

## Live transition after source review

Prepare exact settings payload first. Disable legacy sync workflow using Actions
API, read disabled_manually, then apply active main ruleset with empty bypass
actors and repository squash-only settings. Re-read every changed setting with
read-only verifier. Under leave-open, keep workflow disabled until owner merges
the reviewed read-only workflow; report this external lifecycle item. Never
assume draft PR source is active. Root coordinates mutations and receipts.

## Tests and outputs

Test initial missing protection, disabled/evaluate ruleset, missing required
checks, permissive bypass, wrong merge methods, strict/PR/resolution/history
controls, compliant fixture, invalid/failed API reads, and unchanged admin policy.
Run source sync/lints/version checks, sole KimiK3, final native suite and CI.
Version0.8.11; topicPR on preceding reviewed dependency branch. Live receipts stay
in this run directory; repository content contains no personal information.

## Verified external evidence

GitHub rules API documents effective-branch rules as active only, ruleset detail
bypass actors/enforcement, required statuses and PR parameters. Actions API
documents PUT workflow disable. Parent read-only audit confirmed no rulesets,
all merge methods enabled, administration permission, and GitHub Actions check
app15368. One workflow query timed out and is unverifiable, not a state receipt.
Sources: [rules API](https://docs.github.com/en/rest/repos/rules) and
[workflows API](https://docs.github.com/en/rest/actions/workflows).

## Execution surface

| Artifact | Access and reason |
|---|---|
| `scripts/audit-branch-protection.mjs`, adjacent test | Write a read-only audit and hermetic API fixtures |
| `.github/workflows/sync-marketplace.yml` | Replace direct-push repair with consistency checking |
| `docs/branch-protection.md`, this design | Explain desired state, observed state, limitations and transition |
| `.claude-plugin/marketplace.json`, generated manifests | Bump0.8.11 for bundled audit; run existing sync generator |
| GitHub repository, main rules, source rulesets, workflow state | Read to verify; only driver-coordinated settings mutations described above |

Run `node scripts/sync-marketplace.mjs` with marketplace identity/version and
skill frontmatter to regenerate manifests/package version. Audit uses explicit
GET requests only, with bounded `gh` subprocess calls and injectable JSON reader;
production command `node scripts/audit-branch-protection.mjs OWNER/REPO` prints
COMPLIANT (exit0), DRIFT (exit1) or UNVERIFIABLE (exit2). It never applies settings.

Read effective branch rules with pagination, then detail for each source ruleset.
Require an applicable repository-owned active ruleset with an explicitly empty
bypass list and all desired controls. A missing bypass field is unverifiable;
an explicit nonempty bypass is drift. Effective rules establish applicability;
unknown source metadata cannot become a compliant answer. This intentionally
verifies the documented repository ruleset, not a generalized organization-rule
composition system. Extra inherited restrictions do not weaken a compliant
repository ruleset. Repo merge flags must be squash=true, merge/rebase=false.

The settings payload uses `refs/heads/main`, enforcement `active`, no exclusions
or bypass actors, `pull_request` with zero approvals, stale dismissal and review
thread resolution, `required_status_checks` with strict mode and `checks`/`gate`
from GitHub Actions, `required_linear_history`, `non_fast_forward`, and `deletion`.
No admin identity rule is changed. No workflow or source path receives a bypass.

## Risks and lifecycle

The read-only workflow deliberately stops automatic drift repair: authors run
sync locally and submit a reviewed PR, which is compatible with required checks.
If API application partially fails, report each observed setting and retain the
legacy workflow's disabled state until safe recovery; never claim all controls
are active from a successful mutation alone. Existing admin-author behavior
continues to pass gate but is not evidence of a human approval. Re-enabling the
workflow is only safe after the reviewed read-only source reaches main; the
leave-open handoff keeps that action pending and visible.
