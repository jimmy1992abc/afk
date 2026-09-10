# Draft-first CI lifecycle

## Contract

Keep implementation and review repair batches in Draft. Promote after internal
review, configured external roles, and the final local suite pass on the current
commit. Promotion triggers CI; merge readiness still requires the resulting
checks and owner approval. Missing CI during intentional Draft deferral does not
delay local review or consume the expected-CI waiting window.

The integration remains version 1.0.0, which has not been published. No live
workflow dispatch, PR transition, remote protection change, or upstream message
is part of this correction.

## Invariants and timeline

| Invariant | Control | Verification |
| --- | --- | --- |
| Draft events do not execute validation or approval jobs | Workflow job conditions, applied by GitHub | Draft CI workflow guards and actionlint |
| Promotion triggers both jobs without another commit | `ready_for_review` event subscriptions | Draft CI workflow event tests |
| Ready PR commits remain checked | `synchronize` subscription | Draft CI workflow event tests |
| Main and manual validation remain available | Validation event condition | Draft CI workflow guards |
| Review finishes before promotion; CI precedes merge readiness | Driver and satellite doctrine | Draft CI policy tests and remote-check rule tests |
| Draft skips and prior promotion results cannot satisfy current readiness | Driver's post-promotion reading | Draft CI policy tests |

The first four rows are external workflow configuration, validated locally but
not exercised on GitHub in this task. The last two are workflow doctrine; text
checks detect drift without proving host-agent compliance.

The CI clock starts with the first remote reading after the latest Ready
transition and is keyed to that revision and transition. Repairs return to
Draft before their batch is pushed; the final reviewed commit is promoted and
observed again. A running job may finish after a return to Draft; its outcome
is recorded rather than presented as a new promotion's validation.

## Tradeoff

This reduces repeated CI execution while review is still changing the patch.
CI-only failures are discovered later. Local checks remain necessary, and the
post-promotion CI run remains necessary before merge. GitHub can retain skipped
workflow entries for Draft activity, so the saving concerns executed jobs.

Use job conditions and an explicit promotion event; Draft status alone does not
disable Actions. Skipped jobs can be reported as successful, so the driver must
observe actual post-promotion runs instead of trusting the Draft-stage summary.
[GitHub job conditions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions),
[GitHub PR events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request).

The same lifecycle is recommended for the parallel project. Its maintainers
should retain their required checks and owner gate while applying Draft
conditions, promotion triggers, and the distinction between review and merge
readiness.
