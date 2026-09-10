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
const posix = { skip: process.platform === 'win32' ? 'workflow executes Bash on Ubuntu' : false };

// The injected boundary freezes the existing filter so pagination cannot mask a policy change.
const stub = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
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
  if (query !== '[.[] | select(.state=="APPROVED") | select(.commit_id==env.HEAD_SHA) | .user.login] | unique | .[]') fail();
  const pages = args.includes('--paginate') ? fixture.pages : fixture.pages.slice(0, 1);
  for (const [index, page] of pages.entries()) {
    log({ page: index + 1 });
    if (page.error) { process.stderr.write('fixture page unavailable\n'); process.exit(42); }
    const names = new Set(page.filter((review) => review.state === 'APPROVED' && review.commit_id === process.env.HEAD_SHA).map((review) => review.user.login));
    for (const name of names) process.stdout.write(name + '\n');
  }
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
  writeFileSync(join(cwd, 'gh'), stub, { mode: 0o755 });
  const fixture = join(cwd, 'fixture.json');
  const log = join(cwd, 'requests.jsonl');
  writeFileSync(fixture, JSON.stringify({ pages, permissions }));
  writeFileSync(log, '');
  const result = spawnSync('/bin/bash', ['-c', script], {
    cwd,
    env: { PATH: cwd, REPO: 'fixture/repository', PR: '1', REVIEW_FIXTURE: fixture, REVIEW_LOG: log },
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
