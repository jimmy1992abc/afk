import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { checkLinks } from './check-links.mjs';

let root;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'check-links-'));
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
      assert.deepEqual(checkLinks(emptyRoot), []);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});
