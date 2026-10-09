import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/require-owner-approval.yml', import.meta.url), 'utf8');
const blocks = workflow.split('        run: |\n');
assert.equal(blocks.length, 2, 'test must execute the workflow approval step');
const script = blocks[1].split('\n').map((line) => line.slice(10)).join('\n');
const jq = spawnSync('/bin/sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout?.trim();
const posix = { skip: process.platform === 'win32' ? 'workflow executes Bash on Ubuntu'
  : !jq ? 'jq is required to execute the actual workflow filter' : false };

// Only the network boundary is faked; the workflow filter runs in the real jq interpreter.
const stub = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const fixture = JSON.parse(fs.readFileSync(process.env.REVIEW_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
const endpoint = args[1];
const query = args[args.indexOf('--jq') + 1];
const log = (entry) => fs.appendFileSync(process.env.REVIEW_LOG, JSON.stringify(entry) + '\n');
const fail = () => { process.stderr.write('unexpected API fixture request\n'); process.exit(88); };
if (args[0] !== 'api') fail();
if (endpoint === 'repos/fixture/repository/pulls/1') {
  if (query === '.user.login') process.stdout.write('author\n');
  else if (query === '.head.sha') process.stdout.write('current-head\n');
  else fail();
} else if (endpoint === 'repos/fixture/repository/pulls/1/reviews') {
  const pages = args.includes('--paginate') ? fixture.pages : fixture.pages.slice(0, 1);
  for (const [index, page] of pages.entries()) {
    log({ page: index + 1 });
    if (page?.error) { process.stderr.write('fixture page unavailable\n'); process.exit(42); }
    if (args.includes('--jq')) {
      const filtered = spawnSync(process.env.FIXTURE_JQ, ['-r', query], { input: JSON.stringify(page), encoding: 'utf8' });
      if (filtered.status !== 0) { process.stderr.write(filtered.stderr); process.exit(43); }
      process.stdout.write(filtered.stdout);
    }
  }
  if (args.includes('--slurp')) process.stdout.write(JSON.stringify(pages));
} else {
  const match = /^repos\/fixture\/repository\/collaborators\/([^/]+)\/permission$/.exec(endpoint);
  if (!match || query !== '.permission') fail();
  log({ permission: match[1] });
  process.stdout.write((fixture.permissions[match[1]] || 'write') + '\n');
}
`;

function run(t, pages, permissions = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'owner-review-pages-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  symlinkSync(process.execPath, join(cwd, 'node'));
  symlinkSync(jq, join(cwd, 'jq'));
  writeFileSync(join(cwd, 'gh'), stub, { mode: 0o755 });
  const fixture = join(cwd, 'fixture.json');
  const log = join(cwd, 'requests.jsonl');
  writeFileSync(fixture, JSON.stringify({ pages, permissions }));
  writeFileSync(log, '');
  const result = spawnSync('/bin/bash', ['-c', script], {
    cwd,
    env: { PATH: cwd, REPO: 'fixture/repository', PR: '1', REVIEW_FIXTURE: fixture, REVIEW_LOG: log, FIXTURE_JQ: jq },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.doesNotMatch(result.stderr, /unexpected API fixture request/);
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { ...result, calls };
}

const approval = (overrides = {}) => ({ state: 'APPROVED', commit_id: 'current-head', user: { login: 'reviewer' }, ...overrides });
const comments = Array.from({ length: 30 }, () => approval({ state: 'COMMENTED' }));

test('an administrator approval after the first 30 reviews satisfies the workflow', posix, (t) => {
  const result = run(t, [comments, [approval()]], { reviewer: 'admin' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.calls.filter((call) => call.page), [{ page: 1 }, { page: 2 }]);
  assert.ok(result.calls.findIndex((call) => call.page === 2) < result.calls.findIndex((call) => call.permission === 'reviewer'));
});

for (const [name, review, permission] of [
  ['older commit', approval({ commit_id: 'previous-head' }), 'admin'],
  ['non-admin reviewer', approval(), 'write'],
  ['dismissed approval', approval({ state: 'DISMISSED' }), 'admin'],
]) {
  test(`${name} on a later page remains insufficient`, posix, (t) => {
    const result = run(t, [comments, [review]], { reviewer: permission });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /needs an approving review/);
    assert.deepEqual(result.calls.filter((call) => call.page), [{ page: 1 }, { page: 2 }]);
  });
}

test('a failed later page cannot accept a qualifying partial result', posix, (t) => {
  const result = run(t, [[approval()], { error: true }], { reviewer: 'admin' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Could not fetch complete review history/);
  assert.ok(!result.calls.some((call) => call.permission === 'reviewer'));
});

test('the existing administrator-author exemption remains unchanged', posix, (t) => {
  const result = run(t, [{ error: true }], { author: 'admin' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!result.calls.some((call) => call.page));
});

for (const state of ['CHANGES_REQUESTED', 'DISMISSED']) {
  test(`a later ${state} replaces the same reviewer's earlier approval across pages`, posix, (t) => {
    const result = run(t, [[approval()], [approval({ state })]], { reviewer: 'admin' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /needs an approving review/);
    assert.ok(!result.calls.some((call) => call.permission === 'reviewer'));
  });
}

for (const state of ['COMMENTED', 'PENDING']) {
  test(`a later ${state} leaves the prior decisive approval effective`, posix, (t) => {
    const result = run(t, [[approval()], [approval({ state })]], { reviewer: 'admin' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

test('a current-head reapproval supersedes changes requested', posix, (t) => {
  const result = run(t, [[approval({ state: 'CHANGES_REQUESTED' })], [approval()]], { reviewer: 'admin' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('one reviewer revoking approval does not erase another administrator approval', posix, (t) => {
  const result = run(t, [[approval(), approval({ user: { login: 'second' } })],
    [approval({ state: 'CHANGES_REQUESTED' })]], { reviewer: 'admin', second: 'admin' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.calls.some((call) => call.permission === 'second'));
  assert.ok(!result.calls.some((call) => call.permission === 'reviewer'));
});

test('latest decision is selected before current-head filtering', posix, (t) => {
  const result = run(t, [[approval()], [approval({ state: 'CHANGES_REQUESTED', commit_id: 'previous-head' })]], { reviewer: 'admin' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
});

test('empty history cannot supply authorization', posix, (t) => {
  const result = run(t, [[]], { reviewer: 'admin' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /needs an approving review/);
});

test('malformed review history is a visible evaluation failure', posix, (t) => {
  const result = run(t, [[approval()], { unexpected: true }], { reviewer: 'admin' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Could not evaluate complete review history/);
  assert.ok(!result.calls.some((call) => call.permission === 'reviewer'));
});
