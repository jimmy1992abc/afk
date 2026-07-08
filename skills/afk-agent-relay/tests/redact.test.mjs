import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, isExcluded } from '../lib/redact.mjs';

test('redacts an sk- API key', () => {
  const { text, count } = redactSecrets('key=sk-abcdef0123456789ABCDEF0123 end');
  assert.match(text, /\[REDACTED\]/);
  assert.ok(count >= 1);
  assert.doesNotMatch(text, /sk-abcdef/);
});

test('redacts a PEM private key block', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIabcSECRET\n-----END PRIVATE KEY-----';
  const { text } = redactSecrets(pem);
  assert.match(text, /\[REDACTED PRIVATE KEY\]/);
  assert.doesNotMatch(text, /MIIabcSECRET/);
});

test('redacts key=value secrets but keeps the field name', () => {
  const { text } = redactSecrets('api_key = "supersecretvalue123"');
  assert.match(text, /api_key/);
  assert.match(text, /\[REDACTED\]/);
  assert.doesNotMatch(text, /supersecretvalue123/);
});

test('keeps a 40-char git SHA (no over-redaction)', () => {
  const sha = 'a'.repeat(40);
  const { text } = redactSecrets(`commit ${sha}`);
  assert.match(text, new RegExp(sha));
});

test('redacts a long standalone base64 token', () => {
  const tok = 'Tm90QVJlYWxTZWNyZXRCdXRMb29rc0xpa2VPbmVYWVphYmMxMjM0NQ==';
  const { text } = redactSecrets(`blob ${tok} end`);
  assert.doesNotMatch(text, new RegExp(tok.replace(/[+/=]/g, '\\$&')));
  assert.match(text, /\[REDACTED\]/);
});

test('isExcluded matches secret files by glob, not normal source', () => {
  assert.ok(isExcluded('.env'));
  assert.ok(isExcluded('.env.local'));
  assert.ok(isExcluded('config/server.pem'));
  assert.ok(isExcluded('deploy/id_rsa'));
  assert.ok(!isExcluded('src/app.py'));
});

test('isExcluded honors extra globs', () => {
  assert.ok(!isExcluded('notes/topsecret.txt'));
  assert.ok(isExcluded('notes/topsecret.txt', ['**/topsecret.*']));
});

test('isExcluded matches a secret DIRECTORY, not just basenames', () => {
  // name-shaped patterns match any path segment (dir or file)
  assert.ok(isExcluded('secrets/config.json'));
  assert.ok(isExcluded('app/credentials/token.txt'));
  assert.ok(isExcluded('deep/nested/.env'));
});
