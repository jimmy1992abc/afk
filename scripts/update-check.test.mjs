import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  isBehind,
  latestVersion,
  localVersion,
  repoFromHomepage,
  resolveRepo,
  updateNotice,
} from './update-check.mjs';

const PLACEHOLDER_REPO = 'acme/widgets';

function writeMarketplace(root, manifest) {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify(manifest),
    'utf8',
  );
}

describe('isBehind', () => {
  test('true when patch is behind', () => {
    assert.equal(isBehind('1.2.3', '1.2.4'), true);
  });

  test('true when minor is behind', () => {
    assert.equal(isBehind('1.2.9', '1.3.0'), true);
  });

  test('true when major is behind', () => {
    assert.equal(isBehind('1.9.9', '2.0.0'), true);
  });

  test('false when equal', () => {
    assert.equal(isBehind('1.2.3', '1.2.3'), false);
  });

  test('false when ahead', () => {
    assert.equal(isBehind('2.0.0', '1.9.9'), false);
  });

  test('non-numeric parts count as 0', () => {
    assert.equal(isBehind('1.2.x', '1.2.1'), true);
  });
});

describe('updateNotice', () => {
  test('a one-line notice when behind', () => {
    assert.equal(
      updateNotice('0.1.0', '0.2.0'),
      'afk: installed v0.1.0, latest v0.2.0 — update to get the newer skills.',
    );
  });

  test('null when equal', () => {
    assert.equal(updateNotice('0.1.0', '0.1.0'), null);
  });

  test('null when ahead', () => {
    assert.equal(updateNotice('0.2.0', '0.1.0'), null);
  });
});

describe('localVersion', () => {
  let root;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'update-check-local-'));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('reads plugins[0].version from marketplace.json', () => {
    writeMarketplace(root, { plugins: [{ version: '1.4.0' }] });
    assert.equal(localVersion(root), '1.4.0');
  });

  test('null when the manifest is missing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'update-check-missing-'));
    try {
      assert.equal(localVersion(empty), null);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('null when the manifest is unparseable', () => {
    writeMarketplace(root, { plugins: [{ version: '1.4.0' }] });
    writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), '{ not json', 'utf8');
    assert.equal(localVersion(root), null);
  });
});

describe('repoFromHomepage', () => {
  test('a normal github URL', () => {
    assert.equal(repoFromHomepage(`https://github.com/${PLACEHOLDER_REPO}`), PLACEHOLDER_REPO);
  });

  test('tolerates a trailing slash', () => {
    assert.equal(repoFromHomepage(`https://github.com/${PLACEHOLDER_REPO}/`), PLACEHOLDER_REPO);
  });

  test('tolerates a .git suffix', () => {
    assert.equal(repoFromHomepage(`https://github.com/${PLACEHOLDER_REPO}.git`), PLACEHOLDER_REPO);
  });

  test('null for a non-github URL', () => {
    assert.equal(repoFromHomepage('https://example.com/acme/widgets'), null);
  });

  test('null for garbage input', () => {
    assert.equal(repoFromHomepage('not-a-url'), null);
    assert.equal(repoFromHomepage(undefined), null);
  });
});

describe('resolveRepo', () => {
  let root;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'update-check-resolve-'));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('env wins over homepage', () => {
    writeMarketplace(root, { homepage: 'https://github.com/other/repo', plugins: [{ version: '0.1.0' }] });
    assert.equal(resolveRepo(root, { AFK_UPDATE_REPO: ` ${PLACEHOLDER_REPO} ` }), PLACEHOLDER_REPO);
  });

  test('homepage used when env absent', () => {
    writeMarketplace(root, {
      homepage: `https://github.com/${PLACEHOLDER_REPO}`,
      plugins: [{ version: '0.1.0' }],
    });
    assert.equal(resolveRepo(root, {}), PLACEHOLDER_REPO);
  });

  test('metadata.homepage used when top-level homepage absent', () => {
    writeMarketplace(root, {
      metadata: { homepage: `https://github.com/${PLACEHOLDER_REPO}` },
      plugins: [{ version: '0.1.0' }],
    });
    assert.equal(resolveRepo(root, {}), PLACEHOLDER_REPO);
  });

  test('null when neither env nor homepage is present', () => {
    writeMarketplace(root, { plugins: [{ version: '0.1.0' }] });
    assert.equal(resolveRepo(root, {}), null);
  });
});

describe('latestVersion', () => {
  test('resolves plugins[0].version from a stubbed fetch', async () => {
    const body = JSON.stringify({ plugins: [{ version: '2.3.4' }] });
    const stubFetch = async () => ({ ok: true, text: async () => body });
    assert.equal(await latestVersion(PLACEHOLDER_REPO, stubFetch), '2.3.4');
  });

  test('rejects on a non-ok response', async () => {
    const stubFetch = async () => ({ ok: false, status: 404 });
    await assert.rejects(() => latestVersion(PLACEHOLDER_REPO, stubFetch));
  });
});
