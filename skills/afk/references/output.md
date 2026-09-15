# Stage output

Read before returning a stage result or summarizing execution evidence. Use
[continuity](continuity.md) before a handoff, yield or resume involving run state.
Stage entry points own their bounded result; [publication](publication.md) owns
the full run's completion conditions.

## Handoff view

Return a concise derived view of the existing ledger and retained evidence,
not a second independently maintained ledger. The driver checkpoints the source
records; a child returns its result and evidence locations to that driver.

| Item | Include from authoritative sources |
| --- | --- |
| Run and issue | Supplied identity and shared run directory; standalone work with no run says so. Never infer identity from recency or allocate a run merely for a summary. |
| Baseline | Approved request and frozen issue contract locators, known revisions and open assumptions; distinguish requirement sources from Git base. |
| Target | Actual worktree/branch, HEAD/base where applicable, artifact or diff identity and dirty-tree status. |
| Stage and coverage | Bounded result, completed/pending criteria and proof references. |
| Findings | Stable finding IDs, dispositions and retained verification/history. |
| Allowance | Effective limit/source, consumed and reserved repair cycles and existing attempt records. Unknown consumption is not zero. |
| Authority | Effective scope, publication and merge limits with source instructions, CI mode and role profile. |
| Evidence and next action | Complete evidence locators, limitations and the next authorized step or named unavailable prerequisite. |

Reload sources rather than editing a saved view as state. Do not invent missing
baseline digests or audit accounting for legacy runs. Before reading structured
direction fields, read [direction state (#109)](direction-state.md); derive this
view from its canonical records without independently writable copies. Narrative
repair-cycle accounting remains under its existing owner.

For enabled audit evidence, read [direction audits](direction-audit.md). Derive
phase/endpoint, active and target digests, attempt, observed identity, transport
and protocol validity, outcome, currentness and direction satisfaction from the
retained artifacts. Name pending qualification and semantic evaluation separately;
never infer workflow readiness from a helper exit code.

## Command and review evidence

The caller retains complete available stdout and stderr in the run's ignored
directory before summarizing. Bind each result to its command, working directory,
target identity, relevant non-secret execution restrictions, exit status,
terminal condition, failure details and complete log locators. Distinguish
unfinished execution, timeout, error, skip and completed results; unknown status
stays unknown. Do not record secrets as execution context.

Preserve original evidence before replacing a summary. Missing, inaccessible or
truncated logs and stale reviews remain explicit limitations, never successful
checks. For standalone work without a run, retain available evidence at an
authorized local location and return its locator; existing run-owned report
rules still apply when saving such a report.

A summary does not replace a required review packet, receipt or full log. Read
[review evidence](review-evidence.md) before supplying or reusing those artifacts.
Keep failure details visible even when the conversation receives only a short
result. Missing proof does not authorize a fabricated receipt or a paid backfill
call. These are level 3 workflow instructions, not automatic evidence capture.
