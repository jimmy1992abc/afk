import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExcluded, redactCredential, redactSecrets } from '../../../lib/secret.mjs';

test('redacts an sk- API key', () => {
  const { text, count } = redactSecrets('key=sk-abcdef0123456789ABCDEF0123 end');
  assert.match(text, /\[REDACTED\]/);
  assert.ok(count >= 1);
  assert.doesNotMatch(text, /sk-abcdef/);
});

test('redacts a bare MiMo Token Plan credential', () => {
  const token = `tp-${'Ab3'.repeat(12)}`;
  const { text, count } = redactSecrets(`credential ${token} end`);
  assert.equal(count, 1);
  assert.doesNotMatch(text, /tp-/);
  assert.match(text, /\[REDACTED\]/);
});

test('redacts the exact configured credential even without a known shape', () => {
  const credential = 'provider-key-with-arbitrary-shape';
  const result = redactCredential(`before ${credential} after`, credential);
  assert.doesNotMatch(result.text, new RegExp(credential));
  assert.match(result.text, /\[REDACTED\]/);
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

// Provider token shapes (issue #23): prefix tokens, JWTs, and the token label.

test('redacts GitHub classic and server tokens at realistic length', () => {
  for (const prefix of ['ghp', 'ghs']) {
    const token = `${prefix}_${'A1b2C3d4'.repeat(5)}`.slice(0, 40);
    const { text } = redactSecrets(`push failed: ${token}`);
    assert.doesNotMatch(text, new RegExp(`${prefix}_A1b2`));
    assert.match(text, /\[REDACTED\]/);
  }
});

test('redacts a fine-grained github_pat_ token', () => {
  const token = `github_pat_${'A1b2C3d4E5'.repeat(9)}`.slice(0, 93);
  const { text } = redactSecrets(`auth ${token}`);
  assert.doesNotMatch(text, /github_pat_A1b2/);
});

test('redacts GitLab and Slack tokens', () => {
  // Fixtures are assembled at runtime so no token-shaped literal sits in this
  // file — push protection and gitleaks would (rightly) flag one.
  const glpat = `glpat-${'x1y2z3'.repeat(4)}`;
  const xoxb = ['xoxb', '1234567890', '1234567890123', 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7'].join('-');
  const { text } = redactSecrets(`a ${glpat} b ${xoxb}`);
  assert.doesNotMatch(text, /glpat-x1y2/);
  assert.doesNotMatch(text, /xoxb-1234/);
});

test('redacts a PAT embedded in a git remote URL', () => {
  const token = `ghp_${'Z9y8X7w6'.repeat(5)}`.slice(0, 40);
  const { text } = redactSecrets(`origin  https://${token}@github.com/o/r.git (push)`);
  assert.doesNotMatch(text, /ghp_Z9y8/);
  assert.match(text, /https:\/\/\[REDACTED\]@github\.com/);
});

test('redacts any credential in a URL userinfo, whatever its shape', () => {
  // Without this rule a userinfo credential is redacted only when it happens to
  // match some other rule, so its coverage tracks the token's alphabet rather
  // than the fact that it is a credential in a URL.
  const short = 'abc123def456ghi789';
  const { text } = redactSecrets(`https://user:${short}@dev.azure.com/o/p/_git/r`);
  assert.doesNotMatch(text, /abc123def456/);
  assert.match(text, /https:\/\/user:\[REDACTED\]@dev\.azure\.com/);
});

test('redacts a userinfo credential with no distinguishing alphabet', () => {
  // A classic Azure DevOps PAT is 52 base32 characters; the catch-all covers it
  // only via the digit guard, which an all-letter token slips.
  const noDigit = 'abcdefghijklmnopqrstuvwxyz'.repeat(2);
  const { text } = redactSecrets(`https://u:${noDigit}@dev.azure.com/o/p/_git/r`);
  assert.doesNotMatch(text, /abcdefghijklmnopqrstuvwxyzabc/);
});

test('redacts a userinfo password containing colons', () => {
  // Colons are legal inside a userinfo password; a capture that stops at the
  // first one leaves the whole credential in the payload.
  const url = `https://user:part1:part2${'@'}dev.azure.com/o/p/_git/r`;
  const { text } = redactSecrets(url);
  assert.doesNotMatch(text, /part1|part2/);
  assert.match(text, /https:\/\/user:\[REDACTED\]@dev\.azure\.com/);
});

test('redacts a userinfo password containing an at sign, wholly', () => {
  // Stopping at the first `@` rewrites the line so it reads as redacted while
  // the tail of the credential survives — worse than not matching at all.
  const { text } = redactSecrets('https://user:p@ss:word@example.com/r');
  assert.doesNotMatch(text, /ss:word/);
  assert.match(text, /https:\/\/user:\[REDACTED\]@example\.com/);
});

test('redacts a userinfo password with an empty user', () => {
  const url = `https://:justpassword${'@'}dev.azure.com/o/p/_git/r`;
  const { text } = redactSecrets(url);
  assert.doesNotMatch(text, /justpassword/);
});

test('keeps the host and user while redacting the userinfo credential', () => {
  // Redacting the whole userinfo would cost the reader which account and which
  // host a leaked remote points at, which is what makes the line worth keeping.
  const { text } = redactSecrets('origin  https://alice:s3cr3tvalue@example.com/o/r.git (push)');
  assert.match(text, /https:\/\/alice:\[REDACTED\]@example\.com/);
});

test('a rule that declines to replace does not report a redaction', () => {
  // The count is what a reader is shown in place of the payload, so a rule that
  // matches a candidate and returns it unchanged must not claim one.
  for (const untouched of [
    `ssh://git${'@'}github.com/org/repo.git`,
    'a deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef b',
  ]) {
    const { text, count } = redactSecrets(untouched);
    assert.equal(text, untouched);
    assert.equal(count, 0, untouched);
  }
});

test('an uppercase scheme redacts its userinfo too', () => {
  // URI schemes are case-insensitive, so a case-sensitive rule leaks exactly
  // the credential it was added to catch.
  const url = `HTTPS://user:secrettoken${'@'}example.com/path`;
  const { text } = redactSecrets(url);
  assert.doesNotMatch(text, /secrettoken/);
});

test('a URL with no credential is untouched', () => {
  const url = 'https://dev.azure.com/org/project/_git/repo';
  const { text, count } = redactSecrets(`clone ${url} now`);
  assert.equal(text, `clone ${url} now`);
  assert.equal(count, 0);
});

test('an Azure DevOps PAT stays redacted in every shape it travels in', () => {
  // Coverage today is incidental — it rests on a 52-char base32 PAT containing
  // a digit. Pinned so a future rule change cannot quietly remove it.
  const pat = '7fq3k2mzx5v6bnwl4hdcj8ry2tsp3gqa5vzm7kxn4bwc6hdj2tly';
  assert.equal(pat.length, 52);
  for (const shape of [
    `the value is ${pat} here`,
    `https://user:${pat}@dev.azure.com/org/proj/_git/repo`,
    `AZURE_DEVOPS_EXT_PAT=${pat}`,
  ]) {
    const { text } = redactSecrets(shape);
    assert.doesNotMatch(text, /7fq3k2mzx5v6/, `unredacted in: ${shape}`);
  }
});

test('redacts Authorization: token values, keeping the label', () => {
  const { text } = redactSecrets('Authorization: token ghs_A1b2C3d4E5f6G7h8I9j0A1b2C3d4E5f6G7h8');
  assert.match(text, /Authorization: (token \[REDACTED\]|\[REDACTED\])/);
  assert.doesNotMatch(text, /ghs_A1b2/);
});

test('keeps Bearer label while redacting its value (regression)', () => {
  const { text } = redactSecrets('Authorization: Bearer abcdefghijklmnop');
  assert.match(text, /Bearer \[REDACTED\]/);
});

test('redacts signed and unsigned JWTs with short segments', () => {
  const signed = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.c2ln-X_1';
  const unsigned = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJiIn0.';
  const { text } = redactSecrets(`a ${signed} b ${unsigned}`);
  assert.doesNotMatch(text, /eyJhbGci/);
});

test('redacts a padded base64url JWT (non-RFC encoders exist in the wild)', () => {
  const padded = 'eyJhbGciOiJIUzI1NiI=.eyJzdWIiOiJhMTIzNDU2Nzg5MA==.c2lnbmF0dXJlX2hlcmU=';
  const { text } = redactSecrets(`log: ${padded}`);
  assert.doesNotMatch(text, /eyJhbGci/);
  assert.doesNotMatch(text, /c2lnbmF0dXJl/);
});

test('redacts all five JWE segments — no ciphertext tail survives', () => {
  const jwe = 'eyJhbGciOiJSU0EtT0FFUCJ9.ZW5jcnlwdGVkX2tleV9mb28.aXZpdml2.c2lwaGVydGV4dF9oZXJlMTIzNDU2Nzg5MA.dGFnMTIz';
  const { text } = redactSecrets(`Authorization: ${jwe}`);
  assert.doesNotMatch(text, /c2lwaGVydGV4dF9oZXJl/);
  assert.doesNotMatch(text, /dGFnMTIz/);
  assert.match(text, /\[REDACTED\]/);
});

test('redacts underscore-adjacent tokens (lookbehind positives)', () => {
  const token = `ghp_${'Q1w2E3r4'.repeat(5)}`.slice(0, 40);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjIn0.sig';
  const { text } = redactSecrets(`_${token}_ and file_${jwt}`);
  assert.doesNotMatch(text, /ghp_Q1w2/);
  assert.doesNotMatch(text, /eyJhbGci/);
});

test('keeps ordinary prose near token-like words (negatives)', () => {
  const prose = 'The token authentication flow is documented; an xoxb-compatible client uses a glpat-compatible-token helper. ghp_abc is a placeholder.';
  const { text, count } = redactSecrets(prose);
  assert.equal(count, 0);
  assert.equal(text, prose);
});

test('keeps the sha512- label on lockfile integrity strings', () => {
  const { text } = redactSecrets('"integrity": "sha512-C4TEKtWLNGWLTAkKvtoRlbNkDccGVdDcpQwoUc4qbHnpt7EPFvLGpMbwrPTZY3zqEMdEhCFAyDW3AS7DhDzo7g=="');
  assert.match(text, /sha512-/);
});
