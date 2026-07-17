// The transport-invariant half of a gate's review brief: role, what counts as a
// finding, the output shape.
//
// The context clause is NOT here. Telling a model to "use git and read
// surrounding files" is right for a reviewer holding read tools and actively
// harmful for one holding only a snapshot — it invites a fabricated "I checked
// X and found Y" from a gate whose entire job is reporting what it verified.
// Each gate passes its own.

const ROLE = 'You are an independent senior software reviewer running the last structural gate before a pull request merges. This is a read-only review.';

const FOCUS = 'Focus on structural issues: architecture/design, correctness bugs, security loopholes, missed edge cases, concurrency/data-integrity, breaking changes, fail-direction. Ignore pure nitpicks unless they cause a real defect.';

const FORMAT = 'For each finding output: a severity tag [P1]=blocker / [P2] / [minor], the file:line, the problem, and a concrete fix.';

const VERDICT = 'Finish with a one-line overall verdict: APPROVE / APPROVE WITH COMMENTS / REQUEST CHANGES. If nothing structural is wrong, say so plainly.';

const OUTPUT = 'Output only the review.';

// `context` is the gate's own clause describing what the reviewer has been given
// and what it may do to learn more.
export function buildReviewPrompt({ scope, context }) {
  return [
    ROLE,
    `Review ${scope}.`,
    context,
    FOCUS,
    FORMAT,
    VERDICT,
    OUTPUT,
  ].filter(Boolean).join('\n');
}
