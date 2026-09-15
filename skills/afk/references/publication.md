# Publication and completion

Read before resolving CI mode, publishing, assessing readiness or ending a run.
Use [review convergence](review-convergence.md) for findings, allowance and
revision invalidation, and [continuity](continuity.md) for retained run evidence.

When retained direction policy enables endpoint auditing, read
[direction audits](direction-audit.md) before completion. Apply its mode-specific
direction condition alongside the existing checks, authority and chosen endpoint.

After final is clean, run the full native suite once on the same commit. A test
failure or content fix restarts ordered roles; a green suite with unchanged
stamps permits the local endpoint when `off`. Otherwise mark the PR Ready for
review to trigger CI, then read remote checks before declaring AFK merge-ready.
Forge Ready for review (GitHub) does not mean AFK merge-ready. While CI is pending,
keep that distinction in the ledger and report; do not toggle Draft/Ready to
retry checks. A subsequent content fix follows the existing repair allowance
and invalidates affected review stamps; CI must cover the new revision.

Open new PRs as Draft. Do not wait for intentionally deferred CI while the PR is Draft.
Ready for review is a forge state, not a merge-ready verdict.
Never reuse Draft-stage skipped checks as passing CI evidence. Start the expected-CI
wait after the latest Ready transition. Return to Draft before pushing review-driven repairs
or CI-failure fixes, then revalidate before promotion.

## Remote checks

Resolve `## checks` → `remote-ci` in `.afk/config.md`:
`expected` (default), `detect`, `absent`, or `off`.

`off` skips remote check reads, polling, and dispatch. Complete implementation,
local checks, internal review and the configured external roles against the local
branch. To avoid triggering CI, do not automatically push, open a PR, mark it ready, or merge;
leave any existing PR as found. Explicit publication instructions may authorize
those remote actions, but first explain that they can trigger repository CI.
Do not bypass forge requirements. After clean current-revision reviews and the
full local suite, record `LOCAL-COMPLETE`, the branch/commit and `CI: not run by
AFK (remote-ci: off)`; this is a successful queue endpoint, not `OUTSTANDING` or a
reason to wait. An all-local-complete queue sets run `state: complete`. This mode
does not disable repository workflows or cancel existing runs; external review
models still run. Do not close a tracked issue merely because its branch is
local-complete. Re-enabling CI resumes from the retained revision and evidence,
then performs the normal publication/check stage without resetting repair cycles.
If the local run is already complete, create a new run referencing that evidence
and its consumed allowance; never reopen or overwrite a completed ledger.

For an existing non-Draft PR, use its latest current-revision run without toggling
Draft state. For enabled modes, after the Ready transition or existing non-Draft
publication, ask the forge which checks it required of the
final revision and record its answer as given; where a forge draws no
required/advisory distinction, every check it reports is required here. Classify
by what the answer names, never by how the lookup exited — a status code is a
forge's own vocabulary, and a reading nobody took resolves nothing:

- the answer names at least one required check and every one of them passed,
  and any validation deferred during Draft has actually succeeded → **resolved**;
- it names one that did not pass, whether it ended without passing or has not
  ended → **unresolved**: fix a failure now, else
  re-read until the answer changes or the window below closes, then leave AFK merge readiness
  unresolved with `OUTSTANDING`, take up other queued work, and re-read on a
  later tick;
- it names no required check, or gives no answer at all — no adapter for that
  host, a CLI failure, a rate limit — → **unresolved** (these are two different
  facts: one is the forge's answer, the other is that the run never got one, and
  neither is ever recorded as the other) until `## checks` →
  `remote-ci` in `.afk/config.md` settles it: `absent` settles it at once,
  `detect` once the window closes, `expected` (default) never; blank or absent
  is `expected`, as every key here resolves, while a non-empty value outside these four is a config error — report it and read it as `expected`, since a
  misspelling must not settle a reading by accident. Unsettled, it takes the
  same exit as a failing check: `OUTSTANDING`, other queued work, and a re-read
  on a later tick.

For validation deferred during Draft, inspect the run triggered by the Ready
transition (or a later run for the current revision), including when the forge treats it as advisory.
Require the validation job's actual completed `success`, not a Draft-stage `skipped` result,
a `neutral` conclusion, an unrelated successful job, or an aggregate green badge.
Bind the run ID and head revision (and test merge revision where applicable) to
the candidate; an older run on the same head before the transition is insufficient.
An expected validation run that has not appeared or executed is unresolved, not
an empty reading that `absent` or `detect` can settle. An executed validation
failure takes the same repair path as a failed required check. Use the same bounded wait
and `OUTSTANDING` exit above. Optional jobs outside that validation requirement
may retain their forge-defined skip semantics.

Record with the answer which of those it was, and stamp the reading's first
attempt against that revision's commit — the window is 30 minutes of wall clock
from that stamp, so a resumed tick can tell a spent window from a fresh one, and
a new commit starts its own. For `detect`, `expected`, and `absent`, the mode governs only an empty or unanswered reading
and adds no requirement of its own; the deferred validation rule above still applies.
What counts as required is the forge's answer, read as above. This is the one step that may leave AFK merge readiness unresolved over
a check: a check read earlier never ends an issue's waterfall.

A required check is one of the few control points outside this agent's authority
(workflow doctrine). Where none constrained a
revision, the ordered roles and the local suite are all this run applied, and
both are evaluation the driver performs on itself. Anything else holding the
merge — branch protection, a host hook, the owner's review — sits outside this
run and is not read here.

## Merge bar

`off` grants local completion only, never automatic merge authority.
An open admitted P1, an `UNTRIAGED` or `Contested` finding, an
unresolved check reading ([Remote checks](#remote-checks)), or an unmet frozen-contract item
bars merge. A deferred
structural P2 does not block the role stamp or ready state, but it bars auto-merge
until the operator explicitly owns the risk at the merge boundary. Deferred
minor and out-of-scope findings do not bar auto-merge. A P1 cannot be accepted; only the
operator may abandon or replan work that cannot resolve one. This bar reads the
PR-gate record only; design-stage findings have their own section.

## End-of-run report

Every branch/PR with its state (merged / open-awaiting-review / awaiting-CI /
LOCAL-COMPLETE), the effective CI mode and any explicit off-mode publication, every notable decision,
each external-gate outcome (including any `SKIPPED`), every revision whose
reading named no required check or never answered — which of the two it was, and
that the ordered roles and the local suite were then the whole of what this run
applied to it —
deferred/remaining items,
and anything blocking. In the operator's preferred language.
