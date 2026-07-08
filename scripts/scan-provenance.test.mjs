import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { scanProvenance } from './scan-provenance.mjs';

// Fixture secrets are assembled at runtime (never written as literals here)
// so this file itself stays clean under its own scanner.
const fakeEmail = `reporter@${'acme-widgets'}.${'test'}`;
const allowedExampleEmail = `ops@${'example'}.${'com'}`;
const anthropicNoreply = `noreply@${'anthropic'}.${'com'}`;
const ip10 = ['10', '1', '2', '3'].join('.');
const ip192 = ['192', '168', '1', '42'].join('.');
const ip172 = ['172', '20', '0', '5'].join('.');
const winPath = ['C:', 'Users', 'someuser', 'project'].join('\\');
const posixHomePath = ['', 'home', 'someuser', 'project'].join('/');
const posixUsersPath = ['', 'Users', 'someuser', 'project'].join('/');

let root;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'scan-provenance-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFixture(name, content) {
  const path = join(root, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

describe('scanProvenance', () => {
  test('flags a plausible email address', () => {
    writeFixture('email.txt', `contact ${fakeEmail} for access\n`);
    const findings = scanProvenance(root);
    assert.ok(findings.some((f) => f.rule === 'email' && f.match === fakeEmail));
  });

  test('does not flag example.com/.org/.net addresses', () => {
    writeFixture('allowed-email.txt', `contact ${allowedExampleEmail}\n`);
    const findings = scanProvenance(root);
    assert.ok(!findings.some((f) => f.rule === 'email' && f.match === allowedExampleEmail));
  });

  test('does not flag the anthropic noreply address', () => {
    writeFixture('noreply.txt', `Co-Authored-By: Someone <${anthropicNoreply}>\n`);
    const findings = scanProvenance(root);
    assert.ok(!findings.some((f) => f.rule === 'email' && f.match === anthropicNoreply));
  });

  test('flags RFC1918 private IPs (10.x, 192.168.x, 172.16-31.x)', () => {
    writeFixture('ips.txt', `${ip10}\n${ip192}\n${ip172}\n`);
    const findings = scanProvenance(root);
    const matches = findings.filter((f) => f.rule === 'private-ip').map((f) => f.match);
    assert.ok(matches.includes(ip10));
    assert.ok(matches.includes(ip192));
    assert.ok(matches.includes(ip172));
  });

  test('flags absolute Windows and POSIX user paths', () => {
    writeFixture('paths.txt', `${winPath}\n${posixHomePath}\n${posixUsersPath}\n`);
    const findings = scanProvenance(root);
    const matches = findings.filter((f) => f.rule === 'local-path').map((f) => f.match);
    assert.ok(matches.some((m) => m === winPath));
    assert.ok(matches.some((m) => m === posixHomePath));
    assert.ok(matches.some((m) => m === posixUsersPath));
  });

  test('flags denylist terms passed as extraTerms, case-insensitively', () => {
    writeFixture('denylist.txt', 'the Internal-Codename ships next quarter\n');
    const findings = scanProvenance(root, ['internal-codename']);
    assert.ok(findings.some((f) => f.rule === 'denylist' && f.match === 'Internal-Codename'));
  });

  test('clean input yields zero findings', () => {
    writeFixture('clean.txt', 'this file has no secrets, IPs, or paths in it\n');
    const findings = scanProvenance(root).filter((f) => f.file.endsWith('clean.txt'));
    assert.deepEqual(findings, []);
  });

  test('skips files whose basename starts with scan-provenance', () => {
    writeFixture('scan-provenance-fixture.md', `${fakeEmail}\n`);
    const findings = scanProvenance(root);
    assert.ok(!findings.some((f) => f.file.endsWith('scan-provenance-fixture.md')));
  });

  test('skips known binary extensions', () => {
    writeFixture('image.png', `${fakeEmail}\n`);
    const findings = scanProvenance(root);
    assert.ok(!findings.some((f) => f.file.endsWith('image.png')));
  });
});
