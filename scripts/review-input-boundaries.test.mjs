import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { collectDiff, parseTarget } from '../lib/gate/target.mjs';
import { describeReviewTarget } from '../lib/gate/review-context.mjs';
import { resolveForge } from '../lib/forge.mjs';
import { gatherContext } from '../skills/afk-agent-relay/lib/gather.mjs';
import { gateTestEnv } from './gate-test-env.mjs';

const gate = fileURLToPath(new URL('../skills/afk-claude-review/claude-gate.mjs', import.meta.url));
const target = parseTarget(['--uncommitted']);
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-input-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q', '-b', 'main', '--template=');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.com');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', join(root, 'no-hooks'));
  writeFileSync(join(root, 'tracked.txt'), 'baseline\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  const nested = join(root, 'nested'); mkdirSync(nested);
  writeFileSync(join(root, 'root-new.txt'), 'root content\n');
  writeFileSync(join(nested, 'nested-new.txt'), 'nested content\n');
  return { root, nested };
}
function preview(cwd, flag) {
  return spawnSync(process.execPath, [gate, '--implementer', 'codex', '--uncommitted', flag], {
    cwd, encoding: 'utf8', timeout: 10000, env: gateTestEnv(),
  });
}

test('nested uncommitted collection and context digest cover the same complete repository', (t) => {
  const { root, nested } = fixture(t);
  const fromRoot = collectDiff(target, { cwd: root });
  const fromNested = collectDiff(target, { cwd: nested });
  assert.equal(fromNested.error, null);
  assert.deepEqual(fromNested.untracked, ['nested/nested-new.txt', 'root-new.txt']);
  assert.deepEqual(fromNested.changedFiles, fromRoot.changedFiles);
  const first = describeReviewTarget(target, { cwd: root });
  assert.deepEqual(describeReviewTarget(target, { cwd: nested }), first);
  writeFileSync(join(root, 'root-new.txt'), 'changed root content\n');
  const second = describeReviewTarget(target, { cwd: nested });
  assert.notEqual(second.artifactDigest, first.artifactDigest);
  assert.deepEqual(second, describeReviewTarget(target, { cwd: root }));
});

test('failed untracked enumeration is an error, never a clean empty inventory', (t) => {
  const { nested } = fixture(t);
  const result = collectDiff(target, { cwd: nested, spawnImpl: (bin, args, options) =>
    args[0] === 'ls-files' ? { status: 7, stdout: '', stderr: 'fixture inventory failure' }
      : spawnSync(bin, args, options) });
  assert.match(result.error || '', /untracked.*fixture inventory failure/);
  assert.deepEqual(result.untracked, []);
});

test('Claude nested preview includes root and nested new paths and the repository review directory', (t) => {
  const { root, nested } = fixture(t);
  const prompt = preview(nested, '--print-prompt');
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.match(prompt.stdout, /root-new\.txt/);
  assert.match(prompt.stdout, /nested\/nested-new\.txt/);
  const args = preview(nested, '--print-args');
  assert.equal(args.status, 0, args.stderr);
  assert.equal(JSON.parse(args.stdout).reviewCwd, root);
});

for (const [kind, entry] of [['explicit', './tools'], ['PATH', './tools'], ['PATH', '']]) {
  test(`Claude retains caller executable identity for ${kind} ${entry || 'empty entry'}`, {
    skip: process.platform === 'win32' ? 'fixture executables use POSIX shebangs' : false,
  }, (t) => {
    const { root, nested } = fixture(t);
    for (const [dir, selected] of [[root, 'wrong-root'], [nested, 'caller-selected']]) {
      if (entry) mkdirSync(join(dir, 'tools'));
      const bin = entry ? join(dir, 'tools', 'reviewer') : join(dir, 'reviewer');
      writeFileSync(bin, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({is_error:false,result:'SELECTED=${selected}\\nREVIEW_CWD='+process.cwd()+'\\nAPPROVE',modelUsage:{'claude-opus-5':{}}})));\n`);
      chmodSync(bin, 0o755);
    }
    const result = spawnSync(process.execPath, [gate, '--implementer', 'codex', '--uncommitted'], {
      cwd: nested, encoding: 'utf8', timeout: 10000,
      env: gateTestEnv({ CLAUDE_GATE_BIN: kind === 'explicit' ? './tools/reviewer' : 'reviewer',
        CLAUDE_REVIEW_MODEL: 'claude-opus-5', PATH: `${entry}:${process.env.PATH}` }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('SELECTED=caller-selected'), result.stdout);
    assert.ok(result.stdout.includes(`REVIEW_CWD=${root}\n`), result.stdout);
  });
}

for (const shape of ['directory', 'invalid UTF-8']) {
  test(`${shape} forge config cannot fall back or launch a tracker`, (t) => {
    const { root } = fixture(t);
    const configPath = join(root, 'config.md');
    if (shape === 'directory') mkdirSync(configPath);
    else writeFileSync(configPath, Buffer.from([0xff, 0xfe]));
    assert.throws(() => resolveForge({ configPath, remoteUrl: 'https://github.com/fixture/code.git' }), /configuration is unreadable/);
    const calls = [];
    assert.throws(() => gatherContext({ issue: ['42'] }, { configPath, repoRoot: root, run: (bin) => {
      calls.push(bin);
      return { status: 0, stdout: 'https://github.com/fixture/code.git', stderr: '' };
    } }), /configuration is unreadable/);
    assert.ok(calls.every((bin) => bin === 'git'), calls.join(','));
  });
}

test('missing forge config still uses explicit remote identity', (t) => {
  const { root } = fixture(t);
  assert.deepEqual(resolveForge({ configPath: join(root, 'missing.md'), remoteUrl: 'https://dev.azure.com/fixture/project/_git/code' }),
    { forge: 'azure-devops', source: 'remote', known: true });
});

test('first helper dispatch and receipt checks share upgrade reconciliation instructions', () => {
  const environment = readFileSync(new URL('../skills/afk/references/environment.md', import.meta.url), 'utf8');
  const evidence = readFileSync(new URL('../skills/afk/references/review-evidence.md', import.meta.url), 'utf8');
  assert.match(environment, /before the first bundled helper dispatch/i);
  assert.match(environment, /lib\/plugin-root\.mjs/);
  assert.match(environment, /custom roots/);
  assert.match(evidence, /environment\.md/);
  assert.doesNotMatch(evidence, /Resolve `<plugin-root>` through `CLAUDE_PLUGIN_ROOT`/);
});
