import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatherContext, filterDiffByExcludes, filterGrepByExcludes } from '../lib/gather.mjs';

const noRun = () => ({ status: 1, stdout: '', stderr: '', error: new Error('nope') });

test('excluded files are skipped with a loud note', () => {
  const g = gatherContext(
    { files: ['.env', 'app.py'] },
    { run: noRun, readFile: (p) => (p === 'app.py' ? 'print(1)' : 'SECRET=1') },
  );
  assert.ok(g.notes.some((n) => n.includes('excluded') && n.includes('.env')));
  assert.match(g.text, /print\(1\)/);
  assert.doesNotMatch(g.text, /SECRET=1/);
});

test('byte cap truncates and emits a loud note', () => {
  const big = 'x'.repeat(5000);
  const g = gatherContext(
    { files: ['a.py', 'b.py'] },
    { run: noRun, readFile: () => big, maxBytes: 1000 },
  );
  assert.ok(g.notes.some((n) => /truncated|dropped/.test(n)));
  assert.ok(g.bytes <= 1200);
});

test('redaction note when secrets present', () => {
  const g = gatherContext(
    { files: ['cfg.py'] },
    { run: noRun, readFile: () => 'token = "abcdef1234567890"' },
  );
  assert.ok(g.notes.some((n) => n.includes('redacted')));
  assert.doesNotMatch(g.text, /abcdef1234567890/);
});

test('git diff is gathered via the injected run', () => {
  const run = (cmd, args) => {
    if (cmd === 'git' && args[0] === 'diff') {
      return { status: 0, stdout: 'diff --git a/x.py b/x.py\n+DIFFBODY', stderr: '', error: null };
    }
    return { status: 0, stdout: 'main', stderr: '', error: null };
  };
  const g = gatherContext({ diff: 'main' }, { run, readFile: () => null });
  assert.match(g.text, /DIFFBODY/);
});

test('filterDiffByExcludes drops a secret file section, keeps the rest', () => {
  const diff = [
    'diff --git a/app.py b/app.py',
    '+print(1)',
    'diff --git a/.env b/.env',
    '+SECRET=abcdef1234',
    'diff --git a/lib.py b/lib.py',
    '+x=2',
  ].join('\n');
  const { text, dropped } = filterDiffByExcludes(diff);
  assert.deepEqual(dropped, ['.env']);
  assert.match(text, /app\.py/);
  assert.match(text, /lib\.py/);
  assert.doesNotMatch(text, /SECRET=abcdef1234/);
});

test('filterDiffByExcludes drops a secret renamed to a non-secret name (both sides)', () => {
  // rename .env -> config.txt: b/ path is innocuous, a/ path is the secret
  const diff = 'diff --git a/.env b/config.txt\nrename from .env\n+LEAKED=supersecretvalue';
  const { text, dropped } = filterDiffByExcludes(diff);
  assert.deepEqual(dropped, ['config.txt']);
  assert.doesNotMatch(text, /LEAKED=supersecretvalue/);
});

test('a secret file in the diff is excluded end-to-end', () => {
  const diff = 'diff --git a/.env b/.env\n+TOKEN=zzzthisissecret\ndiff --git a/ok.py b/ok.py\n+y=1';
  const run = (cmd, args) => {
    if (cmd === 'git' && args[0] === 'diff') return { status: 0, stdout: diff, stderr: '', error: null };
    return { status: 0, stdout: 'main', stderr: '', error: null };
  };
  const g = gatherContext({ diff: 'main' }, { run, readFile: () => null });
  assert.ok(g.notes.some((n) => n.includes('excluded from diff') && n.includes('.env')));
  assert.doesNotMatch(g.text, /TOKEN=zzzthisissecret/);
  assert.match(g.text, /ok\.py/);
});

test('filterGrepByExcludes drops hits from excluded files (incl. secret dirs)', () => {
  const out = ['.env:3:SECRET=abc', 'app.py:10:foo()', 'secrets/x.json:1:bar'].join('\n');
  const { text, dropped } = filterGrepByExcludes(out);
  assert.ok(dropped.includes('.env'));
  assert.ok(dropped.includes('secrets/x.json'));
  assert.match(text, /app\.py:10:foo/);
  assert.doesNotMatch(text, /SECRET=abc/);
});
