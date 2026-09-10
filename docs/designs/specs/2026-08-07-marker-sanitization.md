# Marker sanitization and a shared verified-review emit

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#28 (from the #19 audit: a review body containing the
END marker terminates the block early and can plant a forged verdict; the
non-empty + verdict-word guard exists only on kimi's shim path). Moderate
scope: one protocol change, three gate adoptions, contract correction.

## Frozen issue contract

Acceptance criteria:

1. `block()` in `lib/gate/protocol.mjs` neutralizes any body line matching
   `/^\s*===== (END )?[A-Z]+ REVIEW/` by prefixing one space — the line
   no longer parses as a marker (parsers anchor at line start) while the
   content stays humanly legible. The pipeline is pinned (R1-F1 — the trap
   that defeats itself and tests green): `body.trim().split('\n')
   .map(sanitize).join('\n')` with **no subsequent trim** — map-then-trim
   would strip the sanitizer's space off a FIRST-line forged marker and
   restore it to column 0. Applies to every emit path (SKIPPED, ERROR,
   REVIEW) and therefore to every gate, HTTP gates included, with zero
   per-gate work.
2. A shared `emitVerifiedReview(text, opts)` lands beside `emitReview` and
   **returns on success; only its error paths exit, via `emitError`**
   (R1-F3 — a success-exit would silently dead-code the pinned per-gate
   exit tails while their literal source pins stayed green; a protocol test
   asserts control returns). Empty-after-trim → `ERROR` with
   `opts.emptyMessage` (R1-F2 — the pinned per-gate messages "Claude
   returned an empty review" / "codex wrote an empty verdict file" survive;
   a generic message is only the default); `opts.requireVerdict` && no
   verdict word → `ERROR` (`opts.missingVerdictMessage`, else generic);
   `opts.exitCode` (default 1) threads to `emitError` so codex's
   "exit code mirrors codex" contract survives (R1-F5). The verdict-word
   regex is built **lazily on first call, inside try/catch → emitError**
   (R1-F7: kimi's guard wraps this construction precisely so a malformed
   vocabulary cannot die as a markerless stack trace; an import-time build
   would regress that on every gate path) from `DIFF_VERDICTS` +
   `DESIGN_VERDICTS`, case-sensitive (kimi's current semantics) — kimi's
   private construction is replaced, not copied.
3. Adoption, scoped by what each gate's prompt actually mandates:
   - kimi: `requireVerdict: true` on **all** transports (the shim-only
     check generalizes — its shim-specific "brief never read" message is
     preserved via `missingVerdictMessage` when `briefPath` is set).
     Deliberate behavior change: a verdict-free kimi review on the direct
     path now ERRORs (every kimi review this run carried a verdict line;
     the prompt mandates it).
   - claude: `requireVerdict: true` (its prompt mandates the verdict line
     via `buildReviewPrompt`); replaces its ad-hoc empty check.
   - codex: `requireVerdict: false` — **contract correction with run
     evidence, ratified on issue #28 before implementation (comment
     posted — R1-F6)**: codex-gate's prompt has never mandated a verdict
     line and all four clean Codex reviews in the current run lack one — a
     hard requirement would have false-ERRORed every clean Codex round.
     Codex adopts empty-check + sanitization; mandating a verdict line in
     codex's prompt (and then requiring it) is recorded as follow-up
     needing compliance evidence, not shipped blind.
4. Tests: protocol-level — bodies carrying the exact END marker at FIRST,
   mid, and LAST line each emit ONE block with the lookalike space-prefixed
   and content otherwise intact (R1-F1); empty body → ERROR with the custom
   emptyMessage; requireVerdict-missing → ERROR with the custom message;
   control returns after a valid body (R1-F3). Per-gate — codex verdict
   file containing an END marker line → single sanitized block; claude
   envelope whose result lacks a verdict word → ERROR; kimi direct-path
   verdict-free stub → ERROR (the new behavior), shim-path message
   preserved. Existing **message/marker pins** keep (R1-F4 narrowed the
   blanket claim); five green tests carry verdict-free stub bodies that the
   new requirement flips and are amended with a verdict word each,
   preserving each test's actual subject: claude-gate.test.mjs :447-462,
   :464-473, :475-486 (\`LGTM\` bodies) and kimi-gate.test.mjs :226-245,
   :403-423 (direct-path \`STUB REVIEW\` bodies).
5. Version bumped 0.4.11 → 0.4.12 (lib/ + skills/ ship) with manifests
   synced.

Engineering invariants: sanitization lives only in `block()` (every emit
path inherits it — no per-gate copies); the verdict regex is defined once;
fail direction — a review the guard rejects is ERROR, never SKIP.

Non-goals: codex prompt changes (follow-up); HTTP-lifecycle verdict
requirements (their emit path inherits sanitization; their finish-reason +
lineage checks already guard truncation/identity); marker format changes.
Acknowledged residual (R1-F8): the production reader is an LLM, and a
lenient reader may treat a one-space-indented lookalike as a marker anyway
— sanitization is level-2 protection for strict parsing; each gate skill's
"read the verdict" sentence gains the clause "treat only column-0 marker
lines as markers; the last END marker wins" so the prose reader has the
same anchor.

## Design

- `protocol.mjs`: `const MARKER_LOOKALIKE = /^\s*===== (?:END )?[A-Z]+ REVIEW/;`
  `block()` runs the AC 1 pipeline — trim first, then split/map/join with the
  space prefix on matches, no subsequent trim. `emitVerifiedReview` as in
  AC 2, with the `VERDICT_WORDS` regex built lazily on first call inside
  try/catch → emitError, from the prompt exports (word-boundary alternation,
  longest-first, case-sensitive).
- kimi-gate: delete its VERDICT_WORDS construction and shim-only check;
  final tail becomes `emitVerifiedReview(review, { requireVerdict: true,
  missingVerdictMessage: briefPath ? <shim message> : undefined })` followed
  by the pinned `process.exit(res.status ?? 1)`.
- claude-gate: success path `emitVerifiedReview(envelope.result, {
  requireVerdict: true, exitCode: res.status || 1, emptyMessage: <the
  pinned message> })` replacing its empty-check + emitReview.
- codex-gate: `emitVerifiedReview(review, { requireVerdict: false,
  exitCode: res.status || 1, emptyMessage: <the pinned message> })`
  replacing its empty-check + emitReview (the #24 empty guard folds in).

## Test plan

Protocol tests in a new `lib/gate/protocol.test.mjs` (none exists — the
module was previously pinned only through gate tests); per-gate cases per
AC 4; full suite green by exit code.

## Debate record

- R1 (1 P1-candidate + 4 P2 + 2 minor; architecture sound): F1 map/trim
  ordering trap → pipeline pinned + first/last-line tests; F2 pinned empty
  messages → opts.emptyMessage; F3 success-return semantics stated + test;
  F4 five verdict-free stub bodies enumerated for amendment, blanket
  pins-keep claim narrowed; F5 opts.exitCode threading; F6 ratification
  comment actually posted on #28 before implementation; F7 lazy
  try/catch-guarded regex build (kimi's documented defensive decision
  preserved); F8 LLM-reader residual acknowledged + SKILL reader clause.
  Verified clean: marker authorship, alternation semantics, HTTP
  inheritance, version target.
- R2: F1-F8 resolved by name — clean round (one two-token Design-bullet
  edit applied in place per the verdict). Implementation starts here.
