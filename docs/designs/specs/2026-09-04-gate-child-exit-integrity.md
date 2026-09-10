# Gate reviews require a completed child process

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#69.

## Frozen issue contract

Acceptance criteria:

1. Claude and Codex classify launch errors, signals, unavailable status, and
   unexpected nonzero review-child status before accepting any review text.
2. An abnormal review invocation emits exactly one gate-protocol `ERROR` block,
   exits nonzero, and never emits child-produced review text.
3. Error reasons distinguish launch, signal, unavailable-status, and nonzero
   exit classes without echoing stderr, stdout, exception messages, paths, or
   other attacker- or environment-controlled strings.
4. Claude may still classify a parseable `is_error` envelope as a documented
   unavailable `SKIPPED` outcome. A success-looking envelope from a nonzero
   child is always an `ERROR`.
5. Codex authentication preflight keeps documented timeout, missing-binary, and
   logged-out outcomes as `SKIPPED`. Other abnormal preflight outcomes and every
   abnormal review-child outcome are `ERROR`.
6. Tests cover nonzero plus valid Claude JSON, Claude signal termination,
   nonzero plus nonempty Codex final output, Codex signal termination, missing
   executables, generic launch failures at the shared classifier, and ordinary
   success for both gates.
7. Kimi's already fail-closed exit behavior, prompts, models, target selection,
   finding policy, and optional/unavailable semantics do not change.
8. The plugin version is bumped and generated manifests stay synchronized.

Engineering invariants: no review text from an incomplete child; every terminal
path is a parseable protocol block; shared classification has one definition;
diagnostics reveal only bounded enumerated process metadata.

Non-goals: changing reviewer prompts, models, finding severities, timeouts,
target selection, or converting documented optional/unavailable skips into
errors.

## Design

### Shared child-outcome classifier

Add a pure helper under `lib/gate/` that accepts a Node child-process result and
returns either `null` for the sole clean shape (`status === 0`, no `error`, no
`signal`) or one closed outcome:

- `launch_error`, carrying only an allowlisted process error code or `UNKNOWN`;
- `signal`, carrying only a `SIG[A-Z0-9]+` value or `UNKNOWN`;
- `status_unavailable` when status is not an integer; or
- `nonzero`, carrying the integer status.

Error and signal outrank status because Node can report a null status beside
the actual cause. The helper never copies an exception message or stream text.
Timeout detection remains first in each gate so its existing direction and
actionable fixed guidance are preserved. Gate-specific missing-binary and
unsafe-shell handling also remains ahead of the generic launch classification,
but unsafe-shell reasons become fixed and never copy the rejected argument or
`res.error.message`.

Unit tests pin precedence, the clean shape, every abnormal class, and
sanitization of hostile error codes and signal strings. Claude and Codex both
import this helper; Kimi keeps its proven ordering unchanged.

### Claude review child

After transcript capture and the existing timeout, unsafe-shell, and
missing-binary branches, classify the child result. A launch error, signal, or
unavailable status immediately emits a distinct `ERROR` block and cannot reach
JSON parsing. A nonzero status is held while stdout is parsed solely to preserve
the Claude CLI contract in which an `is_error` envelope can identify
authentication, unavailable model, or rate-limit skips. If parsing fails, or a
parseable envelope does not have `is_error: true`, the held nonzero outcome
emits `ERROR` before identity checks and before `emitVerifiedReview`.

Only literal `envelope.is_error === true` enters the error-envelope exception;
truthy strings or other values cannot turn a nonzero child into an unavailable
skip. A clean child likewise requires an explicit Boolean status before its
envelope can be treated as successful. For a parseable error envelope on a
nonzero child, only a recognized
skip-direction code may override the held outcome. Its skip message is fixed
and omits `envelope.result`. An error-direction envelope emits the held nonzero
classifier result instead of application-error detail. Thus no nonzero child
text reaches either an `ERROR` or `SKIPPED` body. Status-zero error envelopes
keep their existing failure-direction behavior, and a status-zero successful
envelope continues through identity, permission-denial reporting, verdict
validation, and protocol emission unchanged.

The abnormal diagnostics name `Claude`, the stable outcome class, and safe
enumerated code, signal, or integer status. They do not include stdout, stderr,
exception messages, child review text, or paths. The existing stderr notice may
tell the local operator where the transcript was retained; the protocol body
uses only fixed wording. Existing timeout messages enter the same path-free rule
because timeout is an abnormal child outcome.

The unsafe-shell special case preserves its error direction with a fixed
`argument cannot be represented safely by the required shell` reason. It never
copies the rejected ref, path, or exception message. Missing-binary availability
skips likewise use their existing fixed installation guidance.

### Codex preflight and review child

Classify authentication preflight after the existing timeout and missing-binary
branches. Explicit `not logged in` output remains a documented skip. A signal,
generic launch error, unavailable status, or nonzero result that does not
identify logged-out state becomes a protocol `ERROR`; a status-zero response
without the documented logged-in marker remains the existing unauthenticated
skip.

After the metered child returns, close the transcript and release the lock, then
retain the existing timeout and unsafe-shell handling. Every remaining abnormal
classifier result immediately emits `ERROR`. In particular, `nonzero` and
`signal` are checked before `existsSync(finalFile)`, so a complete-looking or
partial final file is discarded without reading it. A post-preflight `ENOENT`
is an error rather than an unavailable skip because the preflight already
proved the selected executable existed; disappearance between invocations is an
aborted review.

Every Codex abnormal review-child protocol reason is fixed and path-free,
including timeout, signal, generic launch error, unavailable status, and
nonzero exit. The stderr notice retains the local transcript location, while
the marker block never copies that location, exception text, or child streams.

Only a clean child may inspect the final-output file. A present nonempty file is
emitted through the existing protocol sanitizer and exits zero. A missing or
empty file stays an error. Lock release remains before every classification, so
no new terminal branch can strand the machine-wide lock.

### Protocol and Kimi parity

All new branches call `emitError`; none write an ad hoc stderr-only failure.
Therefore each abnormal path emits one parseable marker block and exits
nonzero. Missing executables discovered during availability/preflight remain
`SKIPPED`, matching the pipeline's documented fallback behavior. Kimi already
checks timeout, transport errors, signal, truncated output, and nonzero status
before review emission; its code is not changed, while cross-gate tests pin the
same observable rule: only a clean review child can produce a verdict.

## Test plan

`lib/gate/child-outcome.test.mjs` covers the clean result, error-over-signal
precedence, signal-over-status precedence, null status, positive and negative
nonzero integers, and sanitization of untrusted codes/signals.

The existing Windows unsafe-shell integration cases for Claude and Codex gain a
distinctive hostile ref component and require that neither it nor the exception
message appears in the protocol block. The fixed unsafe-shell category remains
visible.

`scripts/claude-gate.test.mjs` extends its stub to choose an exit code or
self-signal after writing output. A nonzero stub writes a fully valid successful
Claude envelope; a signal stub does the same. Both must exit nonzero with an
`ERROR` block and without the review body. A nonzero literal `is_error: true`
rate-limit envelope must remain a complete `SKIPPED` block, while a nonzero
`is_error: "false"` envelope must be an `ERROR` and omit its body. Existing
error-envelope skip tests, missing executable test, and successful-envelope
test remain green. Hostile `result` fixtures for nonzero 429 and 500 envelopes
must not appear in either protocol body; only the 429 result may skip. A
distinctive temporary-directory component must also be absent from abnormal
`ERROR` blocks.

`scripts/codex-gate.test.mjs` adds a stub whose preflight reports logged in and
whose review writes a nonempty final file before exiting nonzero or by signal.
Both must emit `ERROR`, exit nonzero, and omit the file body. A nonexistent
preflight binary, a timed-out preflight, and a nonzero preflight explicitly
reporting `Not logged in` must still produce complete `SKIPPED` blocks; the
logged-out fixture also proves the review child was never invoked. A contrasting
nonzero preflight without that marker must emit `ERROR`. Existing successful and
empty-output cases remain green.

A POSIX self-removing Codex stub succeeds during preflight, then disappears
before the review spawn. This post-preflight `ENOENT` must produce exactly one
complete `ERROR` block, exit nonzero, and omit exception text, paths, and any
final-file content. It contrasts with the preflight `ENOENT` skip. Codex
timeout/signal/nonzero cases run under a distinctive temporary-root component
and assert that component is absent from the protocol block.

## Design debate record

- F69-01 (P2, supported): the nonzero Claude unavailable exception lacked tests
  and strict Boolean semantics. The design now requires
  `envelope.is_error === true` and tests literal-error and truthy-string cases.
- F69-02 (P2, supported): Codex's normal nonzero logged-out preflight exception
  was not pinned. The plan now tests logged-out and timeout skips, proves no
  review launch, and contrasts an unexplained nonzero preflight error.
- F69-03 (P2, supported): abnormal diagnostics retained environment-derived
  transcript paths despite the frozen contract. The design now removes paths
  from every abnormal-child protocol reason and tests a distinctive temp root.
- F69-04 (P2, supported): a nonzero Claude error-direction envelope could still
  expose child detail and obscure the process failure. Only skip-direction
  envelopes now override the held nonzero outcome, and neither direction may
  copy child detail; hostile 429/500 fixtures pin both branches.
- F69-05 (P2, supported): unsafe-shell special cases copied attacker-controlled
  exception text before shared classification. Both gates now use one fixed,
  path-free unsafe-shell reason, with hostile-ref assertions in their existing
  Windows integration tests.
- F69-06 (P2, supported): path-free diagnostics were explicit only for Claude.
  The Codex section now applies the same rule to every abnormal review-child
  class, and its integration tests assert a distinctive temp root is absent.
- F69-07 (P2, supported): the original post-preflight Codex markerless launch
  error lacked an integration test. A self-removing POSIX stub now pins that
  `ENOENT` as a complete `ERROR`, contrasted with the preflight availability
  skip.

Run both targeted gate suites, the shared helper suite, all manifest/lint/link/
provenance checks, and the full `node --test` suite.
