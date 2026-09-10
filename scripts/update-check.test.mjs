import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  isBehind,
  latestVersion,
  localVersion,
  repoFromHomepage,
  resolveRepo,
  resolveUpdateNotice,
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

  test('invalid versions never produce an ordering claim', () => {
    assert.equal(isBehind('1.2.x', '1.2.1'), false);
  });
});

describe('updateNotice', () => {
  test('a one-line notice naming the host-controlled action', () => {
    const notice = updateNotice('0.1.0', '0.2.0');
    assert.match(notice, /installed v0\.1\.0, latest v0\.2\.0/);
    // An operator who cannot tell what to do next reads the notice twice and
    // acts on neither.
    assert.match(notice, /update the afk-skills plugin/i);
    assert.equal(notice.includes('\n'), false, 'one line');
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

  test('aborts on timeout so a stalled fetch never hangs', async () => {
    const hangingFetch = (_url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    await assert.rejects(() => latestVersion(PLACEHOLDER_REPO, hangingFetch, 10));
  });
});

describe('resolveUpdateNotice', () => {
  let root;
  let cacheDir;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'update-check-notice-'));
    cacheDir = mkdtempSync(join(tmpdir(), 'update-check-cache-'));
    writeMarketplace(root, {
      homepage: `https://github.com/${PLACEHOLDER_REPO}`,
      plugins: [{ version: '0.2.3' }],
    });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const cachePath = () => join(mkdtempSync(join(cacheDir, 'c-')), 'update-check.json');
  const fetchOf = (version, counter) => async () => {
    if (counter) counter.n += 1;
    return { ok: true, text: async () => JSON.stringify({ plugins: [{ version }] }) };
  };

  test('fetches, caches, and returns the notice when behind', async () => {
    const path = cachePath();
    const counter = { n: 0 };
    const notice = await resolveUpdateNotice({
      pluginRoot: root, cachePath: path, fetchImpl: fetchOf('0.2.11', counter),
    });
    assert.match(notice, /installed v0\.2\.3, latest v0\.2\.11/);
    assert.equal(counter.n, 1);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).latest, '0.2.11');
  });

  test('a fresh cache answers without touching the network', async () => {
    // A session start must not become a network round-trip.
    const path = cachePath();
    const counter = { n: 0 };
    await resolveUpdateNotice({ pluginRoot: root, cachePath: path, fetchImpl: fetchOf('0.2.11', counter) });
    const again = await resolveUpdateNotice({
      pluginRoot: root,
      cachePath: path,
      fetchImpl: () => { throw new Error('must not fetch'); },
    });
    assert.match(again, /latest v0\.2\.11/);
    assert.equal(counter.n, 1);
  });

  test('an expired cache is refetched', async () => {
    const path = cachePath();
    writeFileSync(path, JSON.stringify({
      checkedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      latest: '0.2.4',
    }), 'utf8');
    const notice = await resolveUpdateNotice({ pluginRoot: root, cachePath: path, fetchImpl: fetchOf('0.2.12') });
    assert.match(notice, /latest v0\.2\.12/);
  });

  test('null when the installed version is current', async () => {
    assert.equal(
      await resolveUpdateNotice({ pluginRoot: root, cachePath: cachePath(), fetchImpl: fetchOf('0.2.3') }),
      null,
    );
  });

  test('the opt-out silences it without a fetch', async () => {
    const notice = await resolveUpdateNotice({
      pluginRoot: root,
      cachePath: cachePath(),
      env: { AFK_UPDATE_CHECK: 'off' },
      fetchImpl: () => { throw new Error('must not fetch'); },
    });
    assert.equal(notice, null);
  });

  test('a failing network is silent, never an error', async () => {
    const notice = await resolveUpdateNotice({
      pluginRoot: root,
      cachePath: cachePath(),
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.equal(notice, null);
  });

  test('a failed attempt is cached, so an offline machine stops retrying', async () => {
    // Otherwise the host that can never reach GitHub is the one that pays the
    // fetch timeout at every single window it opens.
    const path = cachePath();
    await resolveUpdateNotice({
      pluginRoot: root,
      cachePath: path,
      fetchImpl: async () => { throw new Error('offline'); },
    });
    const recorded = JSON.parse(readFileSync(path, 'utf8'));
    assert.ok(recorded.checkedAt, 'the attempt itself is recorded');
    assert.equal(recorded.latest, null);

    const again = await resolveUpdateNotice({
      pluginRoot: root,
      cachePath: path,
      fetchImpl: () => { throw new Error('must not fetch'); },
    });
    assert.equal(again, null);
  });

  test('a recorded failure expires with the same TTL', async () => {
    const path = cachePath();
    writeFileSync(path, JSON.stringify({
      checkedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      latest: null,
    }), 'utf8');
    const notice = await resolveUpdateNotice({ pluginRoot: root, cachePath: path, fetchImpl: fetchOf('0.2.11') });
    assert.match(notice, /latest v0\.2\.11/);
  });

  test('a non-ok response is a failed attempt, not a silent success', async () => {
    const path = cachePath();
    const notice = await resolveUpdateNotice({
      pluginRoot: root,
      cachePath: path,
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    assert.equal(notice, null);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).latest, null);
  });

  test('an unwritable cache path costs a fetch, not the notice', async () => {
    // The cache is an optimisation; losing it must not lose the signal.
    const notice = await resolveUpdateNotice({
      pluginRoot: root,
      cachePath: join(tmpdir(), 'afk-no-such-dir-xyz', 'nested', 'update-check.json'),
      fetchImpl: fetchOf('0.2.11'),
    });
    assert.match(notice, /latest v0\.2\.11/);
  });

  test('a corrupt cache is refetched rather than trusted', async () => {
    const path = cachePath();
    writeFileSync(path, '{ not json', 'utf8');
    const notice = await resolveUpdateNotice({ pluginRoot: root, cachePath: path, fetchImpl: fetchOf('0.2.11') });
    assert.match(notice, /latest v0\.2\.11/);
  });

  test('silent when the plugin manifest cannot be read at all', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'update-check-noplugin-'));
    try {
      assert.equal(
        await resolveUpdateNotice({ pluginRoot: empty, cachePath: cachePath(), fetchImpl: fetchOf('9.9.9') }),
        null,
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
