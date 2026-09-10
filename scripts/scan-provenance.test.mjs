import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { parseDenylistEnv, scanProvenance } from './scan-provenance.mjs';

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
  execFileSync('git', ['init', '-qb', 'main'], { cwd: root });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

// Staging suffices: `git ls-files` lists staged-but-uncommitted files, so no
// commits and no identity config. `-f` guards against a dev machine's global
// core.excludesFile silently vacating a fixture.
function writeFixture(name, content) {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  execFileSync('git', ['add', '-f', '--', name], { cwd: root });
  return path;
}

function writeUntracked(name, content) {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

describe('scanProvenance', () => {
  test('inherited Git repository selectors cannot redirect the scan', () => {
    writeFixture('selected-root.txt', `${fakeEmail}\n`);
    const other = mkdtempSync(join(tmpdir(), 'scan-provenance-other-'));
    execFileSync('git', ['init', '-q'], { cwd: other });
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
    try {
      process.env.GIT_DIR = join(other, '.git');
      process.env.GIT_WORK_TREE = other;
      process.env.GIT_INDEX_FILE = join(other, '.git', 'index');
      assert.ok(scanProvenance(root).some((f) => f.file.endsWith('selected-root.txt')));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(other, { recursive: true, force: true });
    }
  });

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

  // The old basename-prefix exemption was a tree-wide filename bypass of
  // every rule; only the scanner's own two exact paths are exempt now.
  test('a scan-provenance-named file elsewhere IS scanned', () => {
    writeFixture('skills/x/scan-provenance-notes.md', `${fakeEmail}\n`);
    const findings = scanProvenance(root);
    assert.ok(findings.some((f) => f.file.endsWith('scan-provenance-notes.md')));
  });

  test('exactly the scanner and its test are self-exempt', () => {
    writeFixture('scripts/scan-provenance.mjs', `${fakeEmail}\n`);
    writeFixture('scripts/scan-provenance.test.mjs', `${fakeEmail}\n`);
    const findings = scanProvenance(root);
    assert.ok(!findings.some((f) => f.file.includes(join('scripts', 'scan-provenance'))));
  });

  // The `.git` worktree-pointer test is gone: git refuses `.git` path
  // components, so tracked-file enumeration makes it structurally moot.

  test('an untracked file with a finding is not scanned', () => {
    writeUntracked('untracked-leak.txt', `${fakeEmail}\n`);
    const findings = scanProvenance(root);
    assert.ok(!findings.some((f) => f.file.endsWith('untracked-leak.txt')));
  });

  test('a tracked symlink is scanned as its link text', {
    skip: process.platform === 'win32' ? 'symlinkSync needs developer mode on Windows' : false,
  }, () => {
    const linkPath = join(root, 'leaky-link');
    symlinkSync(posixUsersPath, linkPath);
    execFileSync('git', ['add', '-f', '--', 'leaky-link'], { cwd: root });
    const findings = scanProvenance(root);
    assert.ok(findings.some((f) => f.file.endsWith('leaky-link') && f.rule === 'local-path'));
  });

  test('a directory that is not a git repo throws, never a silent empty scan', () => {
    const bare = mkdtempSync(join(tmpdir(), 'scan-provenance-norepo-'));
    try {
      assert.throws(() => scanProvenance(bare), /cannot enumerate tracked files/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test('parseDenylistEnv splits on commas and newlines, keeps #-prefixed terms', () => {
    assert.deepEqual(parseDenylistEnv('acme, beta-name\n#chan-secret\n \n'), ['acme', 'beta-name', '#chan-secret']);
    assert.deepEqual(parseDenylistEnv(undefined), []);
  });

  test('skips known binary extensions', () => {
    writeFixture('image.png', `${fakeEmail}\n`);
    const findings = scanProvenance(root);
    assert.ok(!findings.some((f) => f.file.endsWith('image.png')));
  });
});
