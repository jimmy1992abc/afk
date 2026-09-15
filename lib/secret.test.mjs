import test from 'node:test';
import assert from 'node:assert/strict';
import { redactCredential, redactSecrets } from './secret.mjs';

test('a digitless slash-separated word run is prose, not a base64 secret', () => {
  const prose = '- Integrity/concurrency/reliability/performance: pure constant-time function;';
  assert.equal(redactSecrets(prose).count, 0);
  assert.equal(redactCredential(prose, '').count, 0);
});

test('a digitless base64 run with plus or padding is still redacted', () => {
  assert.equal(redactSecrets('key AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMn+PQRS=').count, 1);
  assert.equal(redactSecrets('key AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOPQRS').count, 0);
});

test('a slash-separated path with digits is prose, not a base64 secret', () => {
  const path = 'frozen contract in .afk/runs/trial/issues/synthetic/direction/000003.json';
  assert.equal(redactSecrets(path).count, 0);
  assert.equal(redactSecrets('key Qm9ndXNTZWNyZXQx/Qm9ndXNTZWNyZXQx/Qm9ndXNTZWNyZXQx/Qm9ndXM=').count, 1);
  // A padless base64 secret can carry three slashes and no plus; without path context it stays redacted.
  assert.equal(redactSecrets('signingKey = "AAAAAAAAAAAAAAA1/AAAAAAAAAAAAAAA1/AAAAAAAAAAAAAAA1/AAAAAAAAAAAA1"').count, 1);
  assert.equal(redactSecrets('see ./afk/runs/trial/issues/synthetic/direction/000003 for the record').count, 0);
  assert.equal(redactSecrets('see afk/runs/trial/issues/synthetic/direction/000003.json for the record').count, 0);
});

test('a hex run labelled as a digest on its line is documentation, an unlabelled run is redacted', () => {
  const hex = 'f'.repeat(32) + '1'.repeat(32);
  assert.equal(redactSecrets('  Baseline digest: `' + hex + '`.').count, 0);
  assert.equal(redactSecrets('SHA-256 ' + hex + ' of the repair diff').count, 0);
  assert.equal(redactSecrets('checksum=' + hex).count, 0);
  assert.equal(redactSecrets('key ' + hex).count, 1);
  assert.equal(redactSecrets(hex + ' digest').count, 1);
  assert.equal(redactSecrets('secret: ' + hex + '\nBaseline digest: ' + hex).count, 1);
  assert.equal(redactSecrets('- Baseline digest:\n  `' + hex + '`\n- Policy digest:\n  `' + hex + '`.').count, 0);
  assert.equal(redactSecrets('Policy digest:\n\n' + hex).count, 0);
  assert.equal(redactSecrets('Policy digest:\nsome other text\n' + hex).count, 1);
  assert.equal(redactSecrets(hex + '\n' + hex).count, 2);
  const key = 'b'.repeat(64);
  assert.equal(redactSecrets('{"digest":"' + hex + '","signingKey":"' + key + '"}').text, '{"digest":"' + hex + '","signingKey":"[REDACTED]"}');
  assert.equal(redactSecrets('checksum ' + hex + ' and hash ' + key).count, 0);
});

test('base64-shaped runs with digits and long hex runs stay redacted', () => {
  const base64 = 'key ' + 'Qm9ndXNTZWNyZXQx'.repeat(3) + '==';
  assert.equal(redactSecrets(base64).count, 1);
  assert.equal(redactSecrets('sha ' + 'a'.repeat(32) + '1'.repeat(32)).count, 1);
});
