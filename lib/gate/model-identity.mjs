// Which model actually answered a gate, as opposed to which one it asked for.
//
// A gate that only validates its own argv cannot notice a host that resolved an
// alias to an older generation, which is the failure this module exists for.

const asId = (value) => (typeof value === 'string' ? value.trim() : '');

// An alias carries no generation, so the host may resolve it elsewhere at any
// time; a full ID names one. Segment order is deliberately not pinned — both
// `claude-opus-4-8` and `claude-3-5-sonnet-20241022` have shipped, and refusing
// a legitimate future ID would leave an operator with no valid value to set.
export function isPinnedModelId(value) {
  const id = asId(value);
  return /^claude-/i.test(id) && /\d/.test(id);
}

export function isVersionedModelId(value) {
  return /\d/.test(asId(value));
}

export function sameVersionedModelLineage(reported, requested) {
  const actual = asId(reported).toLowerCase();
  const expected = asId(requested).toLowerCase();
  if (!isVersionedModelId(expected) || !actual) return false;
  if (actual === expected) return true;
  if (!actual.startsWith(`${expected}-`)) return false;
  return /^\d[\d.-]*$/.test(actual.slice(expected.length + 1));
}

// Same lineage: equal, or one extends the other at a segment boundary. That
// makes a dated snapshot and its family identity interchangeable in either
// direction, while `claude-opus-50` stays a different model from
// `claude-opus-5`, and any other generation stays a mismatch.
export function sameModelLineage(a, b) {
  const x = asId(a).toLowerCase();
  const y = asId(b).toLowerCase();
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y}-`) || y.startsWith(`${x}-`);
}

// A correct run bills auxiliary models alongside the reviewer, so presence of
// the requested lineage is the claim — never sole occupancy.
export function verifyReviewerIdentity(modelUsage, requested) {
  const usable = modelUsage && typeof modelUsage === 'object' && !Array.isArray(modelUsage);
  const observed = usable ? Object.keys(modelUsage) : [];

  // No evidence of which model ran is not evidence that the right one did.
  if (!observed.length) return { ok: false, reason: 'unverifiable', observed };

  const matched = observed.find((key) => sameModelLineage(key, requested));
  return matched
    ? { ok: true, matched, observed }
    : { ok: false, reason: 'mismatch', observed };
}
