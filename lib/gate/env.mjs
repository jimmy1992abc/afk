// One definition of the opt-out vocabulary, shared by every gate's
// <NAME>_REVIEW_GATE variable.

const OFF_VALUES = new Set(['off', '0', 'false', 'no', 'disabled']);

// Only an exact opt-out spelling disables a gate: an unrecognised value leaves
// the gate enabled, so a typo cannot silently drop the review.
export function isGateDisabled(varName, env = process.env) {
  return OFF_VALUES.has((env[varName] || '').trim().toLowerCase());
}
