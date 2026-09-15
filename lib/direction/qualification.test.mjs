import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { profileFingerprint, validateQualification } from './audit.mjs';

test('bundled qualification describes the current runtime without granting stale approval', () => {
  const record = JSON.parse(readFileSync(new URL('./qualification.json', import.meta.url), 'utf8'));
  assert.equal(record.profileDigest, profileFingerprint().digest);
  if (record.status === 'pending') {
    assert.equal(record.proof, null);
    assert.throws(() => validateQualification(), { code: 'qualification_pending' });
  } else {
    assert.equal(record.status, 'qualified');
    assert.doesNotThrow(() => validateQualification());
  }
});
