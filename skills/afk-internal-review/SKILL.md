---
name: afk-internal-review
description: Part of the afk pipeline. The deep internal production-readiness review of a PR, run BEFORE the independent external gate. Emits APPROVE / APPROVE-WITH-COMMENTS / BLOCK as a concise, agent-actionable handoff; the full report is produced only once internal review and the external gate are both clean. Triggers include "/afk-internal-review", "internal review PR N", "review before merge".
---

# afk-internal-review

The final **internal** review before merge — a rigorous, high-stakes read whose
job is to protect production. It runs **before** the independent external gate:
internal review first, external gate last. Use the strongest available reasoning
model; if the session runs a lighter one, flag it before proceeding. If no PR or
branch is given, ask for one.

This review is not the last gate, so its routine output is a **cheap, structured
handoff** the fixing agent and the external gate can act on — not a long report.
The long report is written only at the very end (see Output).

## 1 — Gather context

Collect every signal before forming an opinion: PR metadata and linked
issue/spec; the full diff; commit history; CI status; the surrounding code of
changed functions (not only the diff lines); existing tests and coverage; new
dependencies; config, migrations, and flags; recent related merges.

**CI hard gate:** if a required check is failing or pending, do not do a deep
review — send the branch back to get CI green first, unless the operator asks to
review-with-caveat (then note that the review predates green CI).

## 2 — Deep review

Evaluate every dimension; do not skip one because it seems unlikely:

- **Correctness** — meets the spec and acceptance criteria; logic, edge cases,
  error handling.
- **Security & privacy** — injection, authz on new actions, secrets, sensitive
  data in logs or responses, input validation at boundaries.
- **Backward compatibility** — breaking changes to public contracts; safe
  rollback; reversible, live-safe migrations.
- **Data integrity** — correct transformations, atomic writes, race/TOCTOU,
  validation before persistence.
- **Performance** — N+1s, missing indexes, unbounded loops, cache invalidation.
- **Concurrency & reliability** — thread/async safety, idempotency, timeouts.
- **Observability** — appropriate logging and error surfacing.
- **Test coverage** — new behaviour, edge cases, and failure paths tested;
  deterministic; meaningful (not passing by accident).
- **Architecture** — aligned with existing patterns; the simplest correct
  solution; no needless coupling or tech debt.
- **Engineering rules** — no silent skip/exit; no duplicated helper or constant;
  superseded code overwritten, not layered; position-touching paths fail closed;
  plus any invariant in `.afk/config.md`.
- **Release risk** — coordinated deploy needs, migration ordering, blast radius,
  rollback.

## 3 — Targeted verification (conditional)

Trust the deterministic CI for what it covers; do not re-run the full suite. Run
a **targeted** test only when a specific concern from step 2 warrants a live
check (an untested logic path, a data/security concern, a new integration). If a
concern needs no live check, say so.

## Output

### Interim (every round until clean) — a concise handoff

A terse, structured block, optimized for the fixing agent and the external gate —
no prose essay, no full checklist dump:

```text
decision: APPROVE | APPROVE-WITH-COMMENTS | BLOCK
blockers:
  - file:line — problem — suggested fix
suggestions:
  - file:line — improvement
verify: targeted tests run and results, or "none needed"
```

Hand this back to be fixed; re-review after fixes. Never emit APPROVE while a
blocker is open.

### Final report — only when internal review AND the external gate are both clean

Once this review has no open blockers **and** the configured external gate has
returned clean, write the full human report: summary, decision and rationale,
everything reviewed, residual risk, and the production-readiness checklist.

- **Auto-merge policy** (`merge-when-green` / `merge-to-unblock` in
  `.afk/config.md`): write the final report into the run's own directory, as
  `.afk/runs/<run-id>/PR#<n>-<title>.md` — a report belongs to the run that
  produced it, so it is never written to a path another run also owns. Take
  `<run-id>` from the run you are executing under; invoked outside a run,
  allocate `.afk/runs/<YYYY-MM-DD>-pr<n>/` the same collision-safe way the `afk`
  skill allocates a run directory (create failing if it exists, retry the next
  suffix), so two standalone reviews of one PR on one date do not land in a
  shared directory. Give it a `ledger.md` header too — `run-id`, `scope` (the PR
  you reviewed), `state`, `heartbeat` — and set `state: complete` when the review
  ends: `afk` reads a ledgerless directory as a run mid-claim and would wait on
  yours forever. Resolve `.afk/` against the main working tree (the first
  `worktree` line of `git worktree list --porcelain`), never the current
  directory, so a review from a linked worktree still writes to the run's one
  directory. The filename leads with `PR#<n>-<title>`;
  sanitize the title for the filesystem (illegal characters and whitespace
  collapsed to `-`, case preserved, length-capped) and add a numeric suffix only
  to avoid clobbering an existing file.
- **Interactive** (`leave-open`): present the report in the session, and also
  save it when the config opts in.

## Hard rules

- Never approve with an open blocker; a blocker is anything that risks data loss,
  a security breach, an outage, silent corruption, or a breaking change.
- Never merge, push, or deploy — the review ends at the verdict.
- Always cite `file:line`; always read surrounding context, not only the diff.
- Spec compliance is a first-class check: passing tests but not doing what the
  issue asks is a blocker.
- You are not the last gate — an external gate runs after your verdict. Note the
  handoff ("next: external gate") so the operator knows the pass is not final.
