# Delegating a nested child stage

The driver reads this route before spawning a child stage. Delegation carries a
bounded task under the existing run and retained authority. It does not grant
the child the driver's publication or queue-completion role. These are level 3
workflow instructions, not a host permission mechanism.

## Prompt supplied by the driver

Carry all of the following into the child prompt:

- The existing run-id and resolved run directory. Supply them explicitly;
  never ask the child to claim a new run or infer one from recency.
- The verbatim bounded task and applicable frozen-contract/scope excerpt,
  including acceptance criteria, exclusions and target worktree or artifact.
- Required read routes: the selected stage's `SKILL.md`, consuming `AGENTS.md`,
  [environment](environment.md), [continuity](continuity.md),
  [stage output](output.md), and the stage's applicable reference routes.
- Evidence locators, known findings and dispositions, and relevant consumed or
  reserved allowances. Missing evidence stays explicit; no new allowance is
  inferred from delegation.
- A return-not-publish constraint: return the bounded result to the driver;
  do not claim/create run directories, write the driver's ledger, expand
  authority, mark queue completion, merge, push or publish. Carry any narrower
  task-specific restrictions, including whether commits are authorized.

Retained operator authority and repository constraints remain at their sources.
A copied excerpt or child verdict cannot amend them. Resolve an unavailable
prerequisite for dependent work without discarding independent authorized work.

## Child return and driver adoption

The child returns its bounded result, criteria coverage, actual artifact or diff
identity, complete evidence locators, and one concrete next action for the
driver. Apply [stage output](output.md) for command results, findings and
limitations. Name missing evidence and unfinished work explicitly. Use
`ENVIRONMENT-BLOCKED` only under
[restricted executor handoff](continuity.md#restricted-executor-handoff), with
the actual refusal and command output; neither absent proof nor a child verdict
is a successful check.

Before adopting a child's diff or verdict, the driver inspects the actual target,
checks it against the bounded task and frozen contract, and verifies the cited
evidence. A restricted executor may return an uncommitted diff; the driver owns
the independent inspection and authorized check rerun required by continuity
before committing. Do not infer publication authority from commit authority.
The driver checkpoints its own ledger and continues the next authorized stage;
a child's completed stage is not a completed queue.
