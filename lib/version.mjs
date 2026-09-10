// Untrusted version strings can reach session context and cache-path decisions.
export function isReleaseVersion(value) {
  if (typeof value !== 'string' || value !== value.trim()
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return false;
  return value.split('.').every((part) => Number.isSafeInteger(Number(part)));
}
