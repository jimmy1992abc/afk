import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { mainWorktree } from '../lib/gate/git.mjs';
import { buildContext, collectResumable, parseLedger, staleMsOf } from '../lib/resume/detect.mjs';
import { resolvePluginRootUpdate } from '../lib/plugin-root.mjs';
import { hasConfigKeyInSection, readConfigSectionValue, readConfigValue } from '../lib/config.mjs';
import { latestVersion, localVersion, resolveUpdateNotice, updateNotice } from './update-check.mjs';
import { lintSkills } from './lint-skills.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = new Date('2026-07-18T12:00:00Z');
function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'afk-remainder-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function repo(root) {
  git(root, 'init', '-q', '-b', 'main');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'init');
}
function manifest(root, version, name = 'afk') {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name, homepage: 'https://github.com/example/afk', plugins: [{ name: 'afk-skills', version }],
  }));
}

test('mainWorktree skips the bare entry and agrees from both linked trees', (t) => {
  const root = scratch(t);
  const bare = join(root, 'bare.git');
  git(root, 'init', '--bare', '-q', '-b', 'main', bare);
  const first = join(root, 'first');
  const second = join(root, 'second');
  git(bare, 'worktree', 'add', '-b', 'main', first);
  git(first, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'init');
  git(bare, 'worktree', 'add', '-b', 'second', second, 'main');
  assert.equal(mainWorktree({ cwd: first }), first);
  assert.equal(mainWorktree({ cwd: second }), first);
});

test('heartbeat fields preserve spaces and reject date rollover or absent timezone', () => {
  const value = '2026-07-18 12:00:00Z';
  assert.equal(parseLedger(`heartbeat: ${value}\nstate: active`).heartbeat, value);
  assert.equal(parseLedger('heartbeat: \nstate: active').heartbeat, '');
  assert.equal(staleMsOf(value, NOW), 0);
  assert.equal(staleMsOf('2026-07-18T21:00:00+09:00', NOW), 0);
  assert.equal(staleMsOf('2026-07-18T03:00:00-09:00', NOW), 0);
  for (const bad of ['2026-07-18', '2026-07-18T12:00:00', '2026-02-30T00:00:00Z',
    '2026-07-18T24:00:00Z', '2026-07-18T12:00:00+25:00', '2026-13-01T00:00:00Z']) {
    assert.equal(staleMsOf(bad, NOW), null, bad);
  }
});

test('unknown heartbeat is visible without an ownership or auto-drive claim', (t) => {
  const root = scratch(t);
  const dir = join(root, '.afk', 'runs', 'unknown');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'ledger.md');
  writeFileSync(path, 'run-id: unknown\nstate: active\nheartbeat: garbage\n');
  const runs = collectResumable(join(root, '.afk', 'runs'), { root, now: NOW });
  assert.equal(runs[0].ledgerPath, path);
  assert.equal(runs[0].relPath, '.afk/runs/unknown/ledger.md');
  const context = buildContext(runs, { mode: 'auto' });
  assert.ok(context.includes(path));
  assert.match(context, /unknown/i);
  assert.doesNotMatch(context, /resume this run autonomously|not being driven by a live tick/i);
  assert.match(context, /notify-only|surfacing only/i);
});

test('hook dependency failure is an observable benign skip', (t) => {
  const root = scratch(t);
  const hook = join(root, 'hook.mjs');
  copyFileSync(join(ROOT, 'hooks', 'afk-resume-detect.mjs'), hook);
  const r = spawnSync(process.execPath, [hook], { input: '{}', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /afk-resume-detect.*SKIPPED.*ERR_MODULE_NOT_FOUND/);
});

test('missing known cache refreshes only to a live matching plugin', (t) => {
  const root = scratch(t);
  const old = join(root, 'plugins', 'cache', 'afk', 'afk-skills', '0.1.0');
  const live = join(root, 'checkout');
  manifest(live, '0.8.8');
  mkdirSync(join(live, 'skills', 'afk'), { recursive: true });
  writeFileSync(join(live, 'skills', 'afk', 'SKILL.md'), '# afk');
  assert.equal(resolvePluginRootUpdate(old, live).action, 'refresh');
  for (const from of [join(root, 'custom'), old.replace('/afk/afk-skills/', '/other/afk-skills/'),
    old.replace('/afk-skills/', '/other-plugin/'), old.replace('/0.1.0', '/0.1.0junk')]) {
    assert.equal(resolvePluginRootUpdate(from, live).action, 'keep', from);
  }
  assert.equal(resolvePluginRootUpdate(old, join(root, 'absent')).action, 'keep');
  manifest(live, '0.8.8', 'other');
  assert.equal(resolvePluginRootUpdate(old, live).action, 'keep');
});

test('local remote and cached versions cannot inject unvalidated context', async (t) => {
  const root = scratch(t);
  const cache = join(root, 'update-check.json');
  for (const invalid of ['99.0.0\nINJECTED CONTENT', '99.0.0\n', '99.0.0\r', '99.0.0\u2028', '99.0.0\u2029',
    '99.0.x', '01.2.3', '9.0.0-beta', '9007199254740992.0.0', {}]) {
    assert.equal(updateNotice('0.1.0', invalid), null);
    manifest(root, invalid);
    assert.equal(localVersion(root), null);
    assert.equal(await latestVersion('example/afk', async () => ({
      ok: true, text: async () => JSON.stringify({ plugins: [{ version: invalid }] }),
    })), null);
    manifest(root, '0.1.0');
    writeFileSync(cache, JSON.stringify({ checkedAt: NOW.toISOString(), latest: invalid }));
    assert.equal(await resolveUpdateNotice({ pluginRoot: root, cachePath: cache, now: NOW,
      env: {}, fetchImpl: async () => { throw new Error('offline'); } }), null);
  }
});

test('update CLI reads the consuming main-worktree cache even from a linked cwd', (t) => {
  const root = scratch(t);
  repo(root);
  const linked = join(scratch(t), 'linked');
  git(root, 'worktree', 'add', '-b', 'linked', linked);
  const afk = join(root, '.afk');
  mkdirSync(afk);
  writeFileSync(join(afk, 'update-check.json'), JSON.stringify({ checkedAt: new Date().toISOString(), latest: '99.0.0' }));
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'update-check.mjs')], {
    cwd: linked, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, AFK_UPDATE_CHECK: 'on', AFK_UPDATE_REPO: 'invalid/no-such-repo' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /latest v99\.0\.0/);
  assert.equal(existsSync(join(linked, '.afk')), false);
});

test('the shipped starter template roundtrips blank commands root and invariants', (t) => {
  const root = scratch(t);
  const config = join(root, 'config.md');
  const text = readFileSync(join(ROOT, 'templates', 'afk-config.example.md'), 'utf8');
  writeFileSync(config, `${text}\nprobe: preserved\n`);
  for (const key of ['test', 'lint', 'build']) assert.equal(readConfigSectionValue(config, 'commands', key), '');
  assert.match(text, /^pluginRoot:[ \t]*$/m);
  assert.equal(readConfigValue(config, 'pluginRoot'), '');
  assert.equal(readConfigSectionValue(config, 'invariants', 'probe'), 'preserved');
  assert.equal(hasConfigKeyInSection(config, 'external gate', 'gates'), true);
});

test('description requires exact leading trigger and pipeline membership', (t) => {
  const root = scratch(t);
  const dir = join(root, 'afk-demo');
  mkdirSync(dir);
  const write = (description) => writeFileSync(join(dir, 'SKILL.md'), `---\nname: afk-demo\ndescription: ${JSON.stringify(description)}\n---\n`);
  for (const bad of ['Part of the afk pipeline. Runs afk-demo.', 'afk-demo-other: Part of the afk pipeline.', 'afk-demo: A long enough unrelated description.']) {
    write(bad);
    assert.ok(lintSkills(root).some((e) => /description must/.test(e)), bad);
  }
  write('afk-demo: Part of the afk pipeline. Runs a focused check.');
  assert.deepEqual(lintSkills(root), []);
});

test('validate verifies the pinned archive before extracting and carries base via env', () => {
  const source = readFileSync(join(ROOT, '.github', 'workflows', 'validate.yml'), 'utf8');
  assert.match(source, /GH_BASE_REF: \$\{\{ github\.base_ref \}\}/);
  assert.match(source, /--base "origin\/\$GH_BASE_REF"/);
  assert.match(source, /551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/);
  assert.ok(source.indexOf('sha256sum --check') > 0);
  assert.ok(source.indexOf('sha256sum --check') < source.indexOf('tar -xzf'));
});
