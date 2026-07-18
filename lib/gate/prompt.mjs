// A gate's review brief. Two modes share only their transport-invariant parts;
// everything a mode is *for* — role, lenses, severity meaning, locator, verdict
// vocabulary — is per-mode.
//
// The context clause is NOT here. Telling a model to "use git and read
// surrounding files" is right for a reviewer holding read tools and actively
// harmful for one holding only a snapshot — it invites a fabricated "I checked
// X and found Y" from a gate whose entire job is reporting what it verified.
// Each gate passes its own.

// ── genuinely shared, verbatim, across both modes ────────────────────────────
const READONLY_POSTURE = 'This is a read-only review.';
const OUTPUT = 'Output only the review.';

// ── diff mode (buildReviewPrompt): a code review of a diff ───────────────────
const ROLE = `You are an independent senior software reviewer running the last structural gate before a pull request merges. ${READONLY_POSTURE}`;

const FOCUS = 'Focus on structural issues: architecture/design, correctness bugs, security loopholes, missed edge cases, concurrency/data-integrity, breaking changes, fail-direction. Ignore pure nitpicks unless they cause a real defect.';

const FORMAT = 'For each finding output: a severity tag [P1]=blocker / [P2] / [minor], the file:line, the problem, and a concrete fix.';

const VERDICT = 'Finish with a one-line overall verdict: APPROVE / APPROVE WITH COMMENTS / REQUEST CHANGES. If nothing structural is wrong, say so plainly.';

// ── design mode (buildDesignReviewPrompt): a review of the reasoning ─────────
// This mode exists to add the one thing a same-model debate structurally
// cannot: a less-correlated search for omissions and wrong framing. So the
// lenses hunt what is missing or unsupported, and the locator is a section or a
// quoted claim — a design doc has no line numbers to cite.
const DESIGN_ROLE = `You are an independent senior software architect reviewing a design document before any code is written. ${READONLY_POSTURE}`;

const DESIGN_FOCUS = 'Hunt what the design got wrong or left out, not code-level bugs: unstated assumptions the document never checks; contradictions with itself or a constraint it accepted; gaps where a decision is claimed but never specified, an invariant is asserted with nothing enforcing it, or a mechanism is credited with something it cannot do; unconsidered alternatives — a simpler approach never weighed, or a rejection that does not hold up; evidence — claims stated as fact that were never verified; and consequences — what breaks elsewhere if this ships as written.';

const DESIGN_FORMAT = 'For each finding output: a severity tag [P1]=the design is wrong or rests on an unverified load-bearing claim / [P2]=a real weakness the design survives, the section heading or exact quoted claim it concerns (a design doc has no line numbers to cite), the problem, and a concrete fix.';

const DESIGN_VERDICT = 'Finish with a one-line overall verdict: SOUND / SOUND WITH CONCERNS / RETHINK. If nothing structural is wrong, say so plainly.';

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

// The design-mode brief: same shape and the same shared posture/output pair,
// but every per-mode clause replaced.
export function buildDesignReviewPrompt({ scope, context }) {
  return [
    DESIGN_ROLE,
    `Review ${scope}.`,
    context,
    DESIGN_FOCUS,
    DESIGN_FORMAT,
    DESIGN_VERDICT,
    OUTPUT,
  ].filter(Boolean).join('\n');
}
