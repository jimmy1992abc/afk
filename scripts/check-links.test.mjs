import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, copyFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';

import { checkLinks } from './check-links.mjs';

function git(root, ...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }); }
function init(root) { git(root, 'init', '-q', '-b', 'main', '--template='); }
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tracked-links-')));
  t.after(() => rmSync(root, { recursive: true, force: true })); init(root); return root;
}
let root;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'check-links-')));
  init(root);
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'target.md'), '# Target\n', 'utf8');

  writeFileSync(
    join(root, 'docs', 'page.md'),
    [
      '[broken](./missing.md)',
      '[ok relative](./target.md)',
      '[ok anchor-stripped](./target.md#section)',
      '[ok root-relative](/docs/target.md)',
      '[broken root-relative](/docs/nope.md)',
      '[external http](http://example.com/foo)',
      '[external https](https://example.com/foo)',
      '[external mailto](mailto:test@example.com)',
      '[pure anchor](#top)',
      '',
    ].join('\n'),
    'utf8',
  );
  git(root, 'add', '.');
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('checkLinks', () => {
  test('flags a broken relative link', () => {
    const broken = checkLinks(root);
    assert.ok(broken.some((b) => b.link === './missing.md'));
  });

  test('flags a broken root-relative link', () => {
    const broken = checkLinks(root);
    assert.ok(broken.some((b) => b.link === '/docs/nope.md'));
  });

  test('does not flag an existing relative link', () => {
    const broken = checkLinks(root);
    assert.ok(!broken.some((b) => b.link === './target.md'));
  });

  test('does not flag an existing link with an anchor fragment', () => {
    const broken = checkLinks(root);
    assert.ok(!broken.some((b) => b.link === './target.md#section'));
  });

  test('does not flag an existing root-relative link', () => {
    const broken = checkLinks(root);
    assert.ok(!broken.some((b) => b.link === '/docs/target.md'));
  });

  test('skips absolute URLs and mailto links', () => {
    const broken = checkLinks(root);
    assert.ok(!broken.some((b) => b.link.startsWith('http')));
    assert.ok(!broken.some((b) => b.link.startsWith('mailto:')));
  });

  test('skips pure anchor links', () => {
    const broken = checkLinks(root);
    assert.ok(!broken.some((b) => b.link === '#top'));
  });

  test('returns no findings when scanning a directory with no markdown', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'check-links-empty-'));
    try {
      init(emptyRoot);
      assert.deepEqual(checkLinks(emptyRoot), []);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});


test('tracked worktree bytes, unusual names and nested calls share the complete inventory', t => {
  const root = fixture(t); mkdirSync(join(root, 'docs'));
  const name = 'space and\nnewline.MD'; writeFileSync(join(root, name), '# Clean\n');
  writeFileSync(join(root, '.gitignore'), '.afk/\n');
  git(root, 'add', '.');
  mkdirSync(join(root, '.afk')); writeFileSync(join(root, '.afk', 'runtime.md'), '[ignored](./absent)');
  writeFileSync(join(root, 'scratch.md'), '[untracked](./absent)');
  assert.deepEqual(checkLinks(root), []);
  writeFileSync(join(root, name), '[tracked edit](./absent)');
  assert.deepEqual(checkLinks(join(root, 'docs')), [{ file: join(root, name), link: './absent' }]);
});

for (const mode of ['missing', 'invalid UTF-8', 'file symlink', 'parent symlink']) {
  test(`tracked source failure is explicit: ${mode}`, { skip: process.platform === 'win32' && mode.includes('symlink') ? 'symlink fixture requires POSIX privileges' : false }, t => {
    const root = fixture(t); mkdirSync(join(root, 'docs'));
    const file = join(root, 'docs', 'page.md'); writeFileSync(file, '# Page\n'); git(root, 'add', '.');
    if (mode === 'missing') rmSync(file);
    else if (mode === 'invalid UTF-8') writeFileSync(file, Buffer.from([0xff]));
    else if (mode === 'file symlink') { rmSync(file); symlinkSync('../target.txt', file); writeFileSync(join(root, 'target.txt'), '# Target'); }
    else { rmSync(join(root, 'docs'), { recursive: true }); mkdirSync(join(root, 'target')); writeFileSync(join(root, 'target', 'page.md'), '# Target'); symlinkSync('target', join(root, 'docs')); }
    assert.throws(() => checkLinks(root), /source.*(?:missing|unreadable|symlink)/);
  });
}

test('invalid repository inventory fails and CLI emits a distinct nonzero diagnostic', t => {
  const root = fixture(t);
  assert.throws(() => checkLinks(join(root, 'missing')), /inventory/);
  rmSync(join(root, '.git'), { recursive: true });
  assert.throws(() => checkLinks(root), /inventory/);
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'lib', 'gate'), { recursive: true });
  for (const path of ['scripts/check-links.mjs', 'lib/gate/file-boundary.mjs']) copyFileSync(new URL(`../${path}`, import.meta.url), join(root, path));
  const result = spawnSync(process.execPath, [join(root, 'scripts/check-links.mjs')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /check-links:.*inventory/);
});

test('linked worktrees read their tracked working tree without scanning ignored runtime state', t => {
  const root = fixture(t); const linked = join(root, 'linked');
  writeFileSync(join(root, 'page.md'), '# Page'); git(root, 'add', '.');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  git(root, 'worktree', 'add', '-qb', 'linked', linked);
  writeFileSync(join(linked, 'page.md'), '[broken](./absent)');
  assert.deepEqual(checkLinks(linked), [{ file: join(linked, 'page.md'), link: './absent' }]);
  assert.deepEqual(checkLinks(root), []);
});
