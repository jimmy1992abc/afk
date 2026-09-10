# Explicit terminal review verdicts

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

## Frozen contract

Issue82 requires format validation when a reviewer owes an explicit verdict.
Incidental words, quoted examples and refusals without a valid verdict must not
be emitted as accepted reviews. The mode determines vocabulary, and ambiguous
conflicting decisions are refused. Existing snapshot providers and Claude/Kimi
require-verdict consumers share this boundary. Codex native review output keeps
its documented nonempty-body contract from issue28. No review-quality claim or
workflow enforcement claim follows from syntax alone.

## Syntax and interpretation

The final nonempty line must be an exact uppercase token from the selected
mode: diff uses APPROVE, APPROVE WITH COMMENTS, REQUEST CHANGES; design uses
SOUND, SOUND WITH CONCERNS, RETHINK. Reuse the existing exported vocabularies.
Accepted decoration is plain TOKEN, **TOKEN**, Verdict: TOKEN,
Verdict: **TOKEN**, or **Verdict: TOKEN**. Up to three leading spaces, trailing whitespace and the known
Kimi transport bullet (• followed by whitespace) are ignored. Four leading
spaces or tab indentation marks a code example and cannot supply a verdict. Trailing prose,
punctuation, headings, blockquotes and inline-code forms are unsupported.
The shared prompt will request this exact terminal-line syntax.

Fenced code examples (backtick or tilde fences) and blockquoted lines cannot
supply a verdict. A final closing fence or trailing prose is not a verdict.
Distinct standalone recognized verdicts outside fences/quotes make the answer
ambiguous and refuse it, even when the final line is valid. Repeated identical
verdict lines may pass because they express one decision. Recognize both
vocabularies for conflict detection but accept the terminal decision only from
the chosen mode; unknown modes fail as configuration error, never default to
diff. Literal incidental words inside ordinary sentences do not count.

Use a small shared pure parser/validator in lib/gate/protocol.mjs, not a second
provider framework. Preserve the existing guarded error path if the imported
vocabulary is unusable. emitVerifiedReview accepts a mode option with diff as
its compatibility default; explicit callers pass target.kind===design as design
and otherwise diff. requireVerdictfalse remains unaffected.

## Caller behavior and causal boundary

Claude and Kimi pass the target mode to emitVerifiedReview and retain their
existing transport/error/transcript diagnoses. The snapshot lifecycle replaces
its final emitReview with emitVerifiedReview(requireVerdicttrue, mode), after
existing finish-reason and model-identity checks and credential redaction.
Coverage notes stay inside the accepted block and cannot supply a verdict.
An empty/invalid/wrong-mode/conflicting result emits nonzero ERROR without
printing the rejected model answer as an accepted review. Existing marker
sanitization, skip behavior and provider failures stay intact.

Touch lib/gate/protocol.mjs and tests, shared prompt and its tests, Claude/Kimi
calls, shared HTTP lifecycle and fixture tests, the relevant gate output-format
documentation and this design. Bump0.8.14 and sync manifests. No new dependency,
provider, service, permission or model selection change.

## Verification and risks

Tests first reproduce incidental APPROVE, refusal, vocabulary example and
wrong-mode SOUND acceptance. Exercise every documented decoration and both
negative verdicts; reject fenced/quoted examples, trailing comments and multiple
different standalone decisions. Preserve native Codex non-verdict output with a
compatibility regression. Synthetic HTTP responses with valid model identity and
stop finish-reason but invalid verdict must yield ERROR/nonzero, omit rejected
body and preserve existing independent identity/finish/marker/credential tests.
No paid provider calls are unit tests.

Run affected shared protocol/gate and HTTP tests, tracked-file provenance and
static/version checks, initial internal review, then the sole Kimi K3 role.
Use this worktree's wrapper for that real gate because the deliberately changed
terminal protocol must be exercised; a malformed model answer remains an honest
ERROR, not silent fallback. Final native suite and CI identify the same reviewed
SHA. Leave the stacked PR open for owner review. Two cumulative fix cycles apply.

The stricter grammar intentionally rejects previously accepted informal answers;
the changed prompt and explicit documented forms make that compatibility cost
reviewable. Syntax cannot detect a fabricated review ending in a valid token,
or prove that its reasoning supports its verdict. This is level2 output-format
validation when invoked; the driver's workflow and owner merge gate remain
level3 doctrine/external repository controls respectively.

## Accepted implementation finding

I82-001 reproduced an indented Markdown code example supplying a false verdict
after trim-first normalization. Cycle1 rejects code indentation before parsing
a terminal decision, preserving the two-space Kimi transport form. Explicit
space/tab regression failures preceded the correction; allowance consumed1/2.

## Focused repair review context

The initial Kimi review of commit
6c014a4f0be708712e51269c0475ec010a48d1ba returned REQUEST CHANGES. Its sole
P1 finding F1 reproduced 26 HTTP/GLM tests failing before provider requests
because their repository-HEAD snapshot exceeded the default 160000-byte budget.
This matches accepted I82-002. The parser and mode-specific call sites passed
that review. F2, a stale alternation comment, is minor and deferred without edits.
The complete initial report is preserved in PR #91. Internal finding I82-001
(indented code accepted as a verdict) was already fixed and reviewed in the
initial commit.

The second and final cumulative repair cycle isolates existing HTTP/GLM transport
assertions in a shared small disposable Git repository, retaining default budget
assertions and explicit custom-repository cases. Three GLM success fixtures now
end with the required terminal token. No production code or budget changes in
this repair. Review the exact delta from the initial commit to HEAD, closure of
F1/I82-002, and relevant fixture/grammar regressions. The prior minor does not
reopen without new evidence; the cumulative repair allowance is exhausted.
