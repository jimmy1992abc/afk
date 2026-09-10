// The skip-vs-error direction of an upstream review failure is decided once,
// in lib/gate/failure.mjs. SKIP means "this reviewer is unavailable — the next
// family takes its place"; ERROR means "the round is unclean". Two gates
// answering that question differently for one condition is the defect class
// this table exists to kill (issue #25: 429 was ERROR for deepseek/mimo and
// SKIP for claude, both directions test-pinned with confident comments).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { failureDirection, httpFailureCode } from '../lib/gate/failure.mjs';

test('http statuses map to their classified codes', () => {
  assert.equal(httpFailureCode(401), 'auth');
  assert.equal(httpFailureCode(403), 'auth');
  assert.equal(httpFailureCode(404), 'model_unavailable');
  assert.equal(httpFailureCode(429), 'rate_limit');
  assert.equal(httpFailureCode(500), 'upstream');
  assert.equal(httpFailureCode(502), 'upstream');
  assert.equal(httpFailureCode(418), 'http_error');
});

test('unavailability skips; an unclean round errors — one direction per class', () => {
  // A rate-limited or out-of-credit reviewer is UNAVAILABLE (selection rule):
  // erroring would block the PR on a quota blip instead of falling back.
  for (const code of ['auth', 'rate_limit', 'model_unavailable', 'no_key']) {
    assert.equal(failureDirection(code), 'skip', code);
  }
  for (const code of ['upstream', 'http_error', 'transport', 'bad_json', 'empty', 'timeout', 'no_model']) {
    assert.equal(failureDirection(code), 'error', code);
  }
});

test('an unknown code fails closed to error', () => {
  // A skip hands the review to another family and hides the failure; a code
  // nobody classified must not do that silently.
  assert.equal(failureDirection('someday_new_code'), 'error');
  assert.equal(failureDirection(''), 'error');
  assert.equal(failureDirection(undefined), 'error');
});

test('prototype-named codes are unknown codes, not inherited lookups', () => {
  // A bare index would resolve these to inherited values — a truthy
  // non-direction that a future consumer could read as availability.
  for (const code of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(failureDirection(code), 'error', code);
  }
});

test('the driver doctrine no longer scopes quota/model-unavailable to Claude', () => {
  const afkSkill = readFileSync(new URL('../skills/afk/SKILL.md', import.meta.url), 'utf8');
  assert.doesNotMatch(afkSkill, /Claude-only/);
  assert.match(afkSkill, /quota\/rate-limit\/model-unavailable/);
});
