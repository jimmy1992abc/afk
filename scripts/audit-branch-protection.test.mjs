import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { auditBranchProtection, readGitHubJson } from './audit-branch-protection.mjs';

function fixture() {
  const rules = [
    { type: 'pull_request', parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: true, required_review_thread_resolution: true, require_code_owner_review: false, require_last_push_approval: false, allowed_merge_methods: ['squash'] } },
    { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'checks', integration_id: 15368 }, { context: 'gate', integration_id: 15368 }] } },
    ...['required_linear_history', 'non_fast_forward', 'deletion'].map((type) => ({ type })),
  ];
  const values = {
    'repos/example/project': { allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false },
    'repos/example/project/branches/main': { protected: true },
    'repos/example/project/rules/branches/main': [rules.map((rule) => ({ ...rule, ruleset_id: 7, ruleset_source_type: 'Repository' }))],
    'repos/example/project/rulesets/7': { id: 7, target: 'branch', enforcement: 'active', bypass_actors: [], rules },
  };
  const calls = [];
  const read = (endpoint, options) => { calls.push([endpoint, options]); return structuredClone(values[endpoint]); };
  return { values, calls, read, detail: values['repos/example/project/rulesets/7'], settings: values['repos/example/project'] };
}

test('a complete active ruleset and squash-only settings are compliant', () => {
  const f = fixture();
  const result = auditBranchProtection('example/project', { read: f.read });
  assert.equal(result.status, 'COMPLIANT');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(f.calls[2], ['repos/example/project/rules/branches/main', { paginate: true }]);
});

test('missing protection and wrong merge methods are drift', () => {
  const f = fixture();
  f.values['repos/example/project/branches/main'].protected = false;
  f.values['repos/example/project/rules/branches/main'] = [[]];
  f.settings.allow_merge_commit = true;
  f.settings.allow_rebase_merge = true;
  const result = auditBranchProtection('example/project', { read: f.read });
  assert.equal(result.status, 'DRIFT');
  assert.equal(result.exitCode, 1);
  assert.match(result.reasons.join(' '), /unprotected/);
  assert.match(result.reasons.join(' '), /squash-only/);
});

for (const [name, alter] of [
  ['disabled ruleset', (f) => { f.detail.enforcement = 'disabled'; }],
  ['evaluate ruleset', (f) => { f.detail.enforcement = 'evaluate'; }],
  ['bypass actors', (f) => { f.detail.bypass_actors = [{ actor_type: 'RepositoryRole', actor_id: 5 }]; }],
  ['missing gate', (f) => { f.detail.rules[1].parameters.required_status_checks.pop(); }],
  ['wrong check source', (f) => { f.detail.rules[1].parameters.required_status_checks[0].integration_id = 1; }],
  ['non-strict checks', (f) => { f.detail.rules[1].parameters.strict_required_status_checks_policy = false; }],
  ['missing PR rule', (f) => { f.detail.rules.shift(); }],
  ['unresolved threads', (f) => { f.detail.rules[0].parameters.required_review_thread_resolution = false; }],
  ['stale approvals', (f) => { f.detail.rules[0].parameters.dismiss_stale_reviews_on_push = false; }],
  ['changed approval policy', (f) => { f.detail.rules[0].parameters.required_approving_review_count = 1; }],
  ['missing force-push protection', (f) => { f.detail.rules = f.detail.rules.filter((r) => r.type !== 'non_fast_forward'); }],
  ['missing deletion protection', (f) => { f.detail.rules = f.detail.rules.filter((r) => r.type !== 'deletion'); }],
  ['missing linear history', (f) => { f.detail.rules = f.detail.rules.filter((r) => r.type !== 'required_linear_history'); }],
]) {
  test(`${name} is drift`, () => {
    const f = fixture(); alter(f);
    assert.equal(auditBranchProtection('example/project', { read: f.read }).status, 'DRIFT');
  });
}

test('a later page contributes the applicable ruleset', () => {
  const f = fixture();
  f.values['repos/example/project/rules/branches/main'].unshift([]);
  assert.equal(auditBranchProtection('example/project', { read: f.read }).status, 'COMPLIANT');
});

test('API failure and incomplete shapes are unverifiable, never compliant', () => {
  for (const alter of [
    (f) => { delete f.detail.bypass_actors; },
    (f) => { delete f.settings.allow_merge_commit; },
    (f) => { f.values['repos/example/project/rules/branches/main'] = {}; },
    (f) => { f.detail.id = 8; },
  ]) {
    const f = fixture(); alter(f);
    assert.equal(auditBranchProtection('example/project', { read: f.read }).status, 'UNVERIFIABLE');
  }
  const failed = auditBranchProtection('example/project', { read: () => { throw new Error('private response'); } });
  assert.equal(failed.exitCode, 2);
  assert.doesNotMatch(JSON.stringify(failed), /private response/);
});

test('invalid repository input makes no API calls', () => {
  const f = fixture();
  assert.equal(auditBranchProtection('--evil', { read: f.read }).exitCode, 2);
  assert.equal(f.calls.length, 0);
});

test('sync workflow verifies drift without credentials or Git writes', () => {
  const workflow = readFileSync(new URL('../.github/workflows/sync-marketplace.yml', import.meta.url), 'utf8');
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node scripts\/sync-marketplace\.mjs --check/);
  assert.doesNotMatch(workflow, /git (push|commit|add)|contents: write/);
});


test('the production API boundary uses explicit bounded GET and preserves pagination failures', () => {
  const run = (bin, args, options) => {
    assert.equal(bin, 'gh');
    assert.deepEqual(args, ['api', '--method', 'GET', 'repos/example/project/rules/branches/main', '--paginate', '--slurp']);
    assert.ok(options.timeout > 0 && options.timeout <= 30000);
    return { status: 0, stdout: '[[]]' };
  };
  assert.deepEqual(readGitHubJson('repos/example/project/rules/branches/main', { paginate: true, run }), [[]]);
  for (const failed of [{ status: 1, stdout: '[[]]' }, { status: null, error: { code: 'ETIMEDOUT' } }, { status: 0, stdout: 'incomplete JSON' }]) {
    assert.throws(() => readGitHubJson('repos/example/project', { run: () => failed }));
  }
});
