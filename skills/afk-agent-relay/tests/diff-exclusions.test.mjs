import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { gatherContext } from '../lib/gather.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'relay-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (bin, args) => spawnSync(bin, args, { cwd: root, encoding: 'utf8' });
  const git = (...args) => { const r = run('git', args); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const write = (path, body) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.com');
  return { root, run, git, write, gather: () => gatherContext({ diff: 'HEAD' }, { run }) };
}

for (const dir of ['café', 'tab\there', 'line\nhere', 'quote"here']) {
  test(`real Git excludes sensitive content under ${JSON.stringify(dir)} with default redaction`, (t) => {
    const f = fixture(t);
    f.write(`${dir}/.env`, 'INTERNAL_NOTE=old_fixture\n'); f.write(`${dir}/safe.txt`, 'before\n');
    f.git('add', '.'); f.git('commit', '-qm', 'baseline');
    f.write(`${dir}/.env`, 'INTERNAL_NOTE=confidential_fixture\n'); f.write(`${dir}/safe.txt`, 'SAFE_EDIT_PRESERVED\n');
    const result = f.gather();
    assert.doesNotMatch(result.text, /old_fixture|confidential_fixture/);
    assert.match(result.text, /SAFE_EDIT_PRESERVED/);
    assert.ok(result.notes.some((note) => note.includes('excluded from diff')));
    assert.ok(result.notes.every((note) => !note.includes('\n') && !note.includes('\t')));
  });
}

for (const [kind, source, destination] of [
  ['rename', 'café/.env', 'public.txt'],
  ['rename', 'safe.txt', 'line\nhere/.env'],
  ['copy', 'quote"here/.env', 'copy.txt'],
]) {
  test(`${kind} excludes either sensitive endpoint`, (t) => {
    const f = fixture(t); f.write(source, 'INTERNAL_NOTE=confidential_fixture\n'.repeat(20));
    f.git('add', '.'); f.git('commit', '-qm', 'baseline');
    mkdirSync(dirname(join(f.root, destination)), { recursive: true });
    if (kind === 'copy') copyFileSync(join(f.root, source), join(f.root, destination));
    else renameSync(join(f.root, source), join(f.root, destination));
    f.git('add', '-A');
    const result = f.gather();
    assert.equal(result.text, '');
    assert.ok(result.notes.some((note) => note.includes('excluded from diff')));
    assert.doesNotMatch(JSON.stringify(result), /confidential_fixture/);
  });
}

test('safe rename and literal pathspec metacharacters remain reviewable', (t) => {
  const f = fixture(t); const path = ':(glob)*/café.txt';
  f.write(path, 'SAFE_BEFORE\n'); f.write('other.txt', 'OTHER_BEFORE\n');
  f.git('add', '.'); f.git('commit', '-qm', 'baseline');
  renameSync(join(f.root, path), join(f.root, 'renamed\t".txt')); f.git('add', '-A');
  f.write(path, 'SAFE_AFTER\n'); f.git('add', '--', `:(literal)${path}`);
  const result = f.gather();
  assert.match(result.text, /SAFE_BEFORE|SAFE_AFTER/);
  assert.doesNotMatch(result.text, /OTHER_BEFORE/);
});

test('unavailable or ambiguous inventory never requests a patch', () => {
  for (const result of [
    { status: 1, stdout: 'private body' },
    { status: 0, stdout: 'M\0ok.txt' },
    { status: 0, stdout: 'M\0ok.txt\0R100\0.env\0' },
    { status: 0, stdout: 'UNKNOWN\0.env\0' },
    { status: 0, stdout: 'R999\0.env\0safe.txt\0' },
    { status: 0, stdout: 'M\0ok.txt\0\0M\0.env\0' },
  ]) {
    let calls = 0;
    const run = (_bin, args) => { calls++; assert.ok(args.includes('--name-status')); return result; };
    const gathered = gatherContext({ diff: 'HEAD' }, { run });
    assert.equal(calls, 1); assert.equal(gathered.text, '');
    assert.match(gathered.notes.join(' '), result.status ? /inventory unavailable/ : /inventory ambiguous/);
    assert.doesNotMatch(JSON.stringify(gathered), /private body/);
  }
});

test('an empty allowlist makes no patch call and patch failure is distinct', () => {
  let calls = 0;
  const excluded = gatherContext({ diff: 'HEAD' }, { run: () => { calls++; return { status: 0, stdout: 'M\0.env\0' }; } });
  assert.equal(calls, 1); assert.equal(excluded.text, '');
  const failed = gatherContext({ diff: 'HEAD' }, { run: (_bin, args) => args.includes('--name-status') ? { status: 0, stdout: 'M\0safe.txt\0' } : { status: 1, stdout: 'private failed output' } });
  assert.equal(failed.text, ''); assert.match(failed.notes.join(' '), /approved patch unavailable/);
});


test('a modified safe rename accepts Git zero-padded similarity scores', (t) => {
  const f = fixture(t);
  const before = Array.from({ length: 100 }, (_, i) => `stable line ${i}`).join('\n') + '\n';
  f.write('before.txt', before); f.git('add', '.'); f.git('commit', '-qm', 'baseline');
  renameSync(join(f.root, 'before.txt'), join(f.root, 'after.txt'));
  f.write('after.txt', before.replace('stable line 50', 'VISIBLE_RENAME_EDIT'));
  f.git('add', '-A');
  const inventory = f.git('diff', '--name-status', '-z', '-M', '-C', '--find-copies-harder', 'HEAD');
  assert.match(inventory, /^R0\d\d\0/);
  assert.match(f.gather().text, /VISIBLE_RENAME_EDIT/);
});
