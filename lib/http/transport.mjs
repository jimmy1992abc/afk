// One transport skeleton keeps every HTTP provider's failure classification
// identical: abort/timeout, transport errors with credential-safe diagnostics,
// non-OK statuses through the shared direction table's code map, bad JSON.

import { httpFailureCode } from '../gate/failure.mjs';

export function providerError(code, message, relay = false) {
  const error = new Error(message);
  error.code = code;
  if (relay) error.relay = true;
  return error;
}

export function transportDetail(error, credential) {
  const safe = (value) => {
    const text = String(value ?? '');
    if (credential && text.includes(credential)) return '';
    return /^[A-Za-z0-9_.-]{1,40}$/.test(text) ? text : '';
  };
  return [safe(error?.name), safe(error?.cause?.code)].filter(Boolean).join('/');
}

export async function postClassifiedJson({
  name, url, headers, body, httpTimeoutMs, fail, fetchImpl, credential,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), httpTimeoutMs);
  let response;
  try {
    response = await (fetchImpl || globalThis.fetch)(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === 'AbortError') {
      throw fail('timeout', `${name} request timed out after ${httpTimeoutMs}ms`);
    }
    const detail = transportDetail(error, credential);
    throw fail('transport', `${name} transport error${detail ? ` (${detail})` : ''}`);
  }

  try {
    if (!response.ok) {
      throw fail(httpFailureCode(response.status), `${name} HTTP ${response.status}`);
    }
    let json;
    try {
      json = await response.json();
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw fail('timeout', `${name} request timed out after ${httpTimeoutMs}ms`);
      }
      throw fail('bad_json', `${name}: response was not valid JSON`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}
