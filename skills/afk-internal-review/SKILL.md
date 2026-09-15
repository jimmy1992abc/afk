---
name: afk-internal-review
description: "afk-internal-review: Part of the afk pipeline. Review production readiness before the independent external roles; return an actionable verdict. Triggers include \"/afk-internal-review\", \"internal review PR N\", \"review before merge\"."
---

# afk-internal-review

Read [AFK environment](../afk/references/environment.md) before resolving
configuration, local state or bundled helper paths.
Before review or a review-driven edit, read and apply
[review convergence](../afk/references/review-convergence.md). Reuse only the same
installed revision already read and still in context; otherwise reread it.

The final **internal** review before merge — a rigorous, high-stakes read whose
job is to protect production. It runs **before** the ordered external roles:
internal review first, outer through any later configured roles afterward. Use the strongest available reasoning
model; if the session runs a lighter one, flag it before proceeding. If no PR or
branch is given, ask for one.

This review is not the last gate, so its routine output is a **cheap, structured
handoff** the fixing agent and ordered external roles can act on — not a long report.
The long report is written only at the very end (see Output).

## Stage boundary

Before returning a result, read [stage output](../afk/references/output.md);
before a run handoff or resume, read
[continuity](../afk/references/continuity.md). Standalone review ends at its
verdict. A nested review returns that verdict and evidence to the driver for
finding triage and the ordered external roles; it does not complete the run.
An outstanding result names unresolved findings or unavailable prerequisites.
The final-report conditions below remain separate from this stage's verdict.

## 1 — Gather context

Collect every signal before forming an opinion: PR metadata and linked
issue/spec and its frozen issue contract; the full diff; commit history; the
checks the forge reports for the revision; the surrounding code of
changed functions (not only the diff lines); existing tests and coverage; new
dependencies; config, migrations, and flags; recent related merges.

With `remote-ci: off`, omit the forge check read and review the local branch;
the driver owns the local completion endpoint. A Draft-stage skip does not
prevent review and supplies no CI approval.

**Checks before depth:** a failing required check means the diff will change —
send the branch back to fix it rather than reading it deeply, unless the
operator asks to review-with-caveat. A check still unfinished, none reported,
or no answer at all is not that: review now and note what the reading said.
Which readings permit ready is the driver's ([Remote checks](../afk/references/publication.md#remote-checks), read before
interpreting check evidence), never this review's.

## 2 — Deep review

For the initial review, evaluate every dimension. Subsequent review checks
accepted findings, the intervening diff, and affected regression paths. Broader
investigation requires specific evidence; new in-scope blockers remain reportable.
Apply [review convergence](../afk/references/review-convergence.md) for the issue-wide allowance; no extra
clean-only sweep is required.

Initial dimensions:

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

Trust the revision's passing checks for what they cover; do not re-run the full
suite. Run
a **targeted** test only when a specific concern from step 2 warrants a live
check (an untested logic path, a data/security concern, a new integration). If a
concern needs no live check, say so.

## Output

### Interim (every round until clean) — a concise handoff

A terse, structured block, optimized for the fixing agent and external roles —
no prose essay, no full checklist dump:

```text
decision: APPROVE | APPROVE-WITH-COMMENTS | BLOCK
blockers:
  - id — file:line — contract/invariant — reachable evidence — consequence — minimal causal fix
risks:
  - id — P2 — file:line — demonstrated structural risk — operator merge decision pending
suggestions:
  - file:line — improvement
verify: targeted tests run and results, or "none needed"
```

Hand this back to be fixed; re-review after fixes. Never emit APPROVE while a
blocker is open. A reported concern begins `UNTRIAGED`; admit it as a blocker only
after every blocker field above is demonstrated. Otherwise classify it P2,
minor, or out-of-scope without changing scope. Put a demonstrated structural P2
under risks so it cannot disappear into suggestions; minor and out-of-scope
items go under suggestions. Apply the [common minimal-fix boundary](../afk/references/review-convergence.md)
before any review-driven edit.

Complete validation included in the current cycle. Exhaustion leaves unresolved
repairs `OUTSTANDING` and does not authorize another automatic content pass.

### Final report — only when internal review AND all configured roles are clean

Once this review has no open blockers **and** all configured external roles have
returned clean on the same `HEAD` and merge-base, and the final full suite is
green, write the full human report: summary, decision and rationale, everything
reviewed, residual risk, and the production-readiness checklist.

- **Auto-merge policy** (`merge-when-green` / `merge-to-unblock` in
  `.afk/config.md`): write the final report into the run's own directory, as
  `.afk/runs/<run-id>/PR#<n>-<title>.md` — a report belongs to the run that
  produced it, so it is never written to a path another run also owns. Before saving a report, read [continuity](../afk/references/continuity.md)
  for the shared state location and collision-safe run claim. Use the current
  run's `<run-id>`; outside a run, claim `.afk/runs/<YYYY-MM-DD>-pr<n>/` with the
  same rules and a `ledger.md` header for the reviewed PR. Set `state: complete`
  when that standalone review ends. The filename leads with `PR#<n>-<title>`;
  sanitize the title for the filesystem (illegal characters and whitespace
  collapsed to `-`, case preserved, length-capped) and add a numeric suffix only
  to avoid clobbering an existing file.
- **Interactive** (`leave-open`): present the report in the session, and also
  save it when the config opts in.

## Hard rules

- Never approve with an open admitted P1. Admission requires a frozen-contract or
  invariant anchor, reachable trigger, demonstrated wrong consequence,
  pre-merge necessity, and minimal causal fix. Severity from a reviewer is a
  proposal, not an admission.
- Never present a structural P2 as auto-merge-safe. It may coexist with an
  approval stamp, but the operator owns that risk at the merge boundary.
- Never merge, push, or deploy — the review ends at the verdict.
- Always cite `file:line`; always read surrounding context, not only the diff.
- Spec compliance is a first-class check: passing tests but not doing what the
  issue asks is a blocker.
- Do not invent requirements, implement out-of-scope suggestions, or turn an
  architectural preference into a blocker.
- You are not the last gate — the ordered role sequence (outer through any
  later configured roles) runs after your verdict. Note the handoff ("next:
  external outer role") so the operator knows the pass is not final.
