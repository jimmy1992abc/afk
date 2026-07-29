// Unit tests for the recorded-pluginRoot decision.
//
// The refresh case runs against real directory trees, not path strings: the
// defect it exists for is a root that resolves a helper file which the newer
// install has and the older one does not, and only a real tree shows that.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from 'node:test';

import { parseVersionedCacheRoot, resolvePluginRootUpdate } from './plugin-root.mjs';

const CLI = fileURLToPath(new URL('./plugin-root.mjs', import.meta.url));

// A host's install layout: <cache>/plugins/cache/<marketplace>/<plugin>/<version>.
function installCache(base, version, skills) {
  const root = join(base, 'plugins', 'cache', 'afk', 'afk-skills', version);
  for (const skill of skills) {
    mkdirSync(join(root, 'skills', skill), { recursive: true });
    writeFileSync(join(root, 'skills', skill, 'SKILL.md'), `# ${skill}\n`, 'utf8');
  }
  return root;
}

test('parseVersionedCacheRoot recognises a host install path and nothing else', () => {
  const parsed = parseVersionedCacheRoot('/opt/agent/.claude/plugins/cache/afk/afk-skills/0.2.3');
  assert.equal(parsed.version, '0.2.3');
  assert.equal(parsed.base, '/opt/agent/.claude/plugins/cache/afk/afk-skills');

  // Windows separators are the same install, written the other way.
  const win = parseVersionedCacheRoot('D:\\agent\\.claude\\plugins\\cache\\afk\\afk-skills\\0.2.3');
  assert.equal(win.version, '0.2.3');

  // A developer's checkout is not a versioned cache, whatever it is named.
  assert.equal(parseVersionedCacheRoot('/opt/agent/src/afk'), null);
  assert.equal(parseVersionedCacheRoot('/opt/agent/src/afk/1.0.0'), null);
  assert.equal(parseVersionedCacheRoot(''), null);
});

test('an absent pluginRoot is recorded', () => {
  const d = resolvePluginRootUpdate('', '/some/resolved/root');
  assert.equal(d.action, 'record');
  assert.equal(d.root, '/some/resolved/root');
});

test('an unchanged pluginRoot is kept', () => {
  const d = resolvePluginRootUpdate('/a/b', '/a/b');
  assert.equal(d.action, 'keep');
  assert.equal(d.root, '/a/b');
});

test('a superseded install root is refreshed, and the old one really is broken', () => {
  // The reported regression: v0.2.1 predates afk-claude-review, so a driver
  // that resolves the new skill's helper through the recorded root finds
  // nothing there — while the resolved install has it.
  const base = mkdtempSync(join(tmpdir(), 'plugin-root-'));
  try {
    const old = installCache(base, '0.2.1', ['afk', 'afk-codex-review']);
    const current = installCache(base, '0.2.10', ['afk', 'afk-codex-review', 'afk-claude-review']);

    assert.equal(existsSync(join(old, 'skills', 'afk-claude-review')), false,
      'precondition: the old install cannot resolve the newer skill');
    assert.equal(existsSync(join(current, 'skills', 'afk-claude-review')), true);

    const d = resolvePluginRootUpdate(old, current);
    assert.equal(d.action, 'refresh');
    assert.equal(d.root, current);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a custom root is preserved against any resolved install', () => {
  // Idempotence means a value a developer set by hand survives; it does not
  // mean a version-keyed cache path outlives its install.
  const d = resolvePluginRootUpdate('/opt/agent/src/afk', '/opt/agent/.claude/plugins/cache/afk/afk-skills/0.2.10');
  assert.equal(d.action, 'keep');
  assert.equal(d.root, '/opt/agent/src/afk');
});

test('a different plugin or marketplace is never silently adopted', () => {
  const other = '/opt/agent/.claude/plugins/cache/other-market/afk-skills/0.2.1';
  const mine = '/opt/agent/.claude/plugins/cache/afk/afk-skills/0.2.10';
  assert.equal(resolvePluginRootUpdate(other, mine).action, 'keep');

  const otherPlugin = '/opt/agent/.claude/plugins/cache/afk/some-other-plugin/0.2.1';
  assert.equal(resolvePluginRootUpdate(otherPlugin, mine).action, 'keep');
});

test('the decision reads paths only — no directory needs to exist', () => {
  // Absence is not the signal: a checkout can be on an unmounted drive for an
  // evening, and discarding a deliberate value on that would be worse than a
  // stale one. The version key is the signal, and it is in the path.
  const d = resolvePluginRootUpdate(
    '/nowhere/.claude/plugins/cache/afk/afk-skills/0.2.1',
    '/nowhere/.claude/plugins/cache/afk/afk-skills/0.2.10',
  );
  assert.equal(d.action, 'refresh');
});

test('a resolved root that is empty leaves the recorded value alone', () => {
  // Nothing to move to: overwriting with '' would strip a working config.
  const d = resolvePluginRootUpdate('/a/b', '');
  assert.equal(d.action, 'keep');
  assert.equal(d.root, '/a/b');
});

test('the CLI prints the decision as JSON so afk-init need not re-derive it', () => {
  const r = spawnSync(process.execPath, [
    CLI,
    '--configured', '/opt/agent/.claude/plugins/cache/afk/afk-skills/0.2.1',
    '--resolved', '/opt/agent/.claude/plugins/cache/afk/afk-skills/0.2.10',
  ], { encoding: 'utf8' });

  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.action, 'refresh');
  assert.equal(parsed.root, '/opt/agent/.claude/plugins/cache/afk/afk-skills/0.2.10');
  assert.ok(parsed.reason, 'a decision states why');
});

test('the CLI refuses to guess when --resolved is missing', () => {
  const r = spawnSync(process.execPath, [CLI, '--configured', '/a/b'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--resolved/);
});
