// The skip-vs-error direction of an upstream review failure, decided once.
//
// SKIP — the reviewer is UNAVAILABLE and the next family takes its place:
// auth failures, quota/rate limits (blocking a PR on a quota blip is the
// defect this table was built to kill — issue #25), a configured model the
// account cannot use, a missing key. ERROR — the round is unclean and says
// nothing about availability: upstream faults, malformed bodies, empty
// completions, transport failures, timeouts.
//
// An unknown code fails toward ERROR: a skip hands the review to another
// family and hides the failure, so only a class somebody deliberately put on
// the skip side may skip.

const DIRECTIONS = Object.freeze({
  auth: 'skip',
  rate_limit: 'skip',
  model_unavailable: 'skip',
  no_key: 'skip',
  upstream: 'error',
  http_error: 'error',
  transport: 'error',
  bad_json: 'error',
  empty: 'error',
  timeout: 'error',
  no_model: 'error',
});

export function httpFailureCode(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_unavailable';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'upstream';
  return 'http_error';
}

export function failureDirection(code) {
  // Own-property lookup: a bare index would resolve prototype names
  // ('constructor', 'toString') to inherited values, breaking the
  // unknown-code contract with a truthy non-direction.
  return typeof code === 'string' && Object.hasOwn(DIRECTIONS, code)
    ? DIRECTIONS[code]
    : 'error';
}
