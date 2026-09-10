import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as access from './git.mjs';
import { collectDiff } from './target.mjs';
import { buildSnapshot } from './snapshot.mjs';
import { gatherContext } from '../../skills/afk-agent-relay/lib/gather.mjs';

const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

function fixture(t, helper, kind) {
  const cwd = mkdtempSync(join(tmpdir(), 'raw-git-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const run = (bin, args) => spawnSync(bin, args, { cwd, encoding: 'utf8' });
  const git = (...args) => {
    const result = run('git', args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.com');
  writeFileSync(join(cwd, 'safe.txt'), 'RAW_BEFORE\n');
  if (helper === 'textconv') writeFileSync(join(cwd, '.gitattributes'), '*.txt diff=fixture\n');
  git('add', '.'); git('commit', '-m', 'baseline');
  const sentinel = join(cwd, '.git', 'helper-ran');
  const script = join(cwd, '.git', 'presentation.cjs');
  writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran'); process.stdout.write('PRESENTATION_REPLACEMENT\\n');`);
  git('config', helper === 'external' ? 'diff.external' : 'diff.fixture.textconv', `${quote(process.execPath)} ${quote(script)}`);
  if (kind !== 'uncommitted') git('checkout', '-b', 'feature');
  writeFileSync(join(cwd, 'safe.txt'), 'RAW_AFTER\n');
  if (kind !== 'uncommitted') { git('add', '.'); git('commit', '-m', 'change'); }
  const target = kind === 'commit' ? { kind, commit: git('rev-parse', 'HEAD') } : { kind, base: 'main' };
  target.label = kind;
  return { cwd, run, sentinel, target, relayBase: kind === 'uncommitted' ? 'HEAD' : 'main' };
}

for (const helper of ['external', 'textconv']) {
  for (const kind of ['branch', 'commit', 'uncommitted']) {
    for (const collector of ['diff', 'snapshot', 'relay']) {
      test(`${collector} keeps raw ${kind} content with configured ${helper}`, (t) => {
        const f = fixture(t, helper, kind);
        let text;
        if (collector === 'diff') {
          const result = collectDiff(f.target, { cwd: f.cwd });
          assert.equal(result.error, null);
          assert.deepEqual(result.changedFiles, ['safe.txt']);
          text = result.diff;
        } else if (collector === 'snapshot') {
          const result = buildSnapshot({ target: f.target, cwd: f.cwd });
          assert.equal(result.error, null);
          text = result.payload;
        } else {
          text = gatherContext({ diff: f.relayBase }, { run: f.run }).text;
        }
        assert.equal(existsSync(f.sentinel), false, 'configured helper must not execute');
        assert.match(text, /-RAW_BEFORE/);
        assert.match(text, /\+RAW_AFTER/);
        assert.doesNotMatch(text, /PRESENTATION_REPLACEMENT/);
      });
    }
  }
}

test('shared Git timeout bounds a stalled process and preserves failure semantics', () => {
  let calls = 0;
  const spawnImpl = (bin, args, options) => {
    calls++;
    assert.equal(bin, 'git');
    assert.deepEqual(args, ['status']);
    assert.equal(options.timeout, access.GIT_COMMAND_TIMEOUT_MS);
    assert.equal(options.timeout, 30000);
    assert.equal(options.killSignal, 'SIGKILL');
    return spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options, timeout: 50 });
  };
  const start = Date.now();
  const result = access.gitTry(['status'], { spawnImpl });
  assert.equal(calls, 1);
  assert.ok(Date.now() - start < 5000, 'stalled fixture must return promptly');
  assert.equal(result.ok, false);
  assert.match(result.err, /timed out/i);
});

test('probes and content distinguish spawn failures from successful empty output', () => {
  for (const failure of [
    { status: null, error: Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT' }) },
    { status: 0, error: Object.assign(new Error('fixture unavailable'), { code: 'ENOENT' }) },
    { status: null, signal: 'SIGTERM' },
    { status: 7 },
  ]) {
    const options = { spawnImpl: () => ({ stdout: '', stderr: '', ...failure }) };
    assert.equal(access.git(['status'], options), '');
    assert.equal(access.hasRef('HEAD', options), false);
    const result = access.gitTry(['status'], options);
    assert.equal(result.ok, false);
    assert.ok(result.err);
  }
  assert.deepEqual(access.gitTry(['status'], { spawnImpl: () => ({ status: 0, stdout: '', stderr: '' }) }), { ok: true, out: '', err: '' });
});
