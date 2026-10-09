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

// Explicit provider exceptions preserve usable model selection without floating aliases.
export const UNVERSIONED_MODEL_FAMILIES = Object.freeze(['deepseek']);

const FLOATING_ALIAS = /(?:^|[-_.])(?:latest|default|auto)$/i;

// An allow-listed family may name one exact provider model without a digit,
// but never its bare family name or an alias that says it floats.
export function isAcceptedModelId(family, value) {
  const id = asId(value);
  if (isVersionedModelId(id)) return true;
  if (!UNVERSIONED_MODEL_FAMILIES.includes(family)) return false;
  return /^[a-z][a-z0-9._-]*$/i.test(id) && id.toLowerCase() !== family && !FLOATING_ALIAS.test(id);
}

export function sameReportedModelLineage(family, reported, requested) {
  const actual = asId(reported).toLowerCase();
  const expected = asId(requested).toLowerCase();
  if (!isAcceptedModelId(family, expected) || !actual) return false;
  if (actual === expected) return true;
  if (!actual.startsWith(`${expected}-`)) return false;
  return /^\d[\d.-]*$/.test(actual.slice(expected.length + 1));
}

// Restrict snapshot equivalence to avoid accepting a different minor version.
export function sameModelLineage(a, b) {
  const x = asId(a).toLowerCase();
  const y = asId(b).toLowerCase();
  if (!x || !y) return false;
  const undated = (id) => id.replace(/-\d{8}$/, '');
  return x === y || x === undated(y) || y === undated(x);
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
