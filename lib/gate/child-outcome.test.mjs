import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyChildOutcome } from './child-outcome.mjs';

test('only status zero without error or signal is clean', () => {
  assert.equal(classifyChildOutcome({ status: 0, signal: null }), null);
});

test('launch error outranks signal and status and sanitizes its code', () => {
  assert.deepEqual(
    classifyChildOutcome({
      error: { code: 'EACCES' }, signal: 'SIGTERM', status: 9,
    }),
    { kind: 'launch_error', code: 'EACCES' },
  );
  assert.deepEqual(
    classifyChildOutcome({ error: { code: 'HOSTILE_SECRET_CODE' }, status: 0 }),
    { kind: 'launch_error', code: 'UNKNOWN' },
  );
});

test('signal outranks status and sanitizes its name', () => {
  assert.deepEqual(
    classifyChildOutcome({ signal: 'SIGKILL', status: 7 }),
    { kind: 'signal', signal: 'SIGKILL' },
  );
  assert.deepEqual(
    classifyChildOutcome({ signal: 'SIGHOSTILESECRET', status: 7 }),
    { kind: 'signal', signal: 'UNKNOWN' },
  );
});

test('unavailable and nonzero statuses are distinct', () => {
  assert.deepEqual(classifyChildOutcome({ status: null }), { kind: 'status_unavailable' });
  assert.deepEqual(classifyChildOutcome({ status: 3 }), { kind: 'nonzero', status: 3 });
  assert.deepEqual(classifyChildOutcome({ status: -1 }), { kind: 'nonzero', status: -1 });
});
