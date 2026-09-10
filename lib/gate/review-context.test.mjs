import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, test } from 'node:test';
import { describeReviewTarget, loadReviewContext, MAX_REVIEW_CONTEXT_BYTES } from './review-context.mjs';
import { parseTarget } from './target.mjs';

const cwd = mkdtempSync(join(tmpdir(), 'review-context-'));
after(() => rmSync(cwd, { recursive: true, force: true }));
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main', '--template=');
git('config', 'user.name', 'Fixture');
git('config', 'user.email', 'fixture@example.com');
git('config', 'commit.gpgsign', 'false');
git('config', 'core.hooksPath', join(cwd, 'no-hooks'));
writeFileSync(join(cwd, '.gitignore'), '.afk/\n');
writeFileSync(join(cwd, 'code.txt'), 'old\n');
git('add', '.');
git('commit', '-qm', 'base');
const priorRevision = git('rev-parse', 'HEAD');
writeFileSync(join(cwd, 'code.txt'), 'fixed\n');
git('commit', '-qam', 'repair');
const revision = git('rev-parse', 'HEAD');
mkdirSync(join(cwd, '.afk'));
const path = join(cwd, '.afk', 'context.json');
const target = parseTarget(['--base', priorRevision], { cwd });
const proof = 'Verified 閉鎖 — "quoted" $& $` $\' $$\nfixture assertion passed';
function packet() {
  return {
    version: 1, target: describeReviewTarget(target, { cwd }),
    acceptance: 'Preserve complete review target and reject an absent proof.',
    priorRevision,
    findings: [{ id: 'F96-001', disposition: 'fixed', claim: 'An absent proof was accepted.', evidence: [{ revision, text: proof }] }],
  };
}
function load(value = packet(), { phase = 're-review', args, ...options } = {}) {
  writeFileSync(path, JSON.stringify(value));
  return loadReviewContext({ argv: args || ['--review-phase', phase, '--review-context', path], target, cwd, ...options });
}

test('complete history preserves exact proof, full target, named delta and stable digest', () => {
  const value = packet();
  const result = load(value);
  assert.equal(result.error, null);
  assert.deepEqual(result.context.target, value.target);
  assert.equal(result.context.findings[0].evidence[0].text, proof);
  assert.match(result.section, /F96-001/);
  assert.match(result.section, new RegExp(`${priorRevision}\\.\\.${revision}`));
  assert.match(result.section, /claims to verify/i);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.equal(load({ findings: value.findings, priorRevision, acceptance: value.acceptance, target: value.target, version: 1 }).digest, result.digest);
  value.findings[0].claim += ' Changed.';
  assert.notEqual(load(value).digest, result.digest);
});

test('initial mode permits no packet and carries explicit comprehensive scope', () => {
  const result = loadReviewContext({ argv: [], target, cwd });
  assert.equal(result.error, null);
  assert.equal(result.digest, null);
  assert.match(result.section, /initial/i);
  const value = packet(); value.priorRevision = null; value.findings = [];
  assert.equal(load(value, { phase: 'initial' }).error, null);
});

test('required history and malformed option combinations fail explicitly', () => {
  for (const args of [
    ['--review-phase', 're-review'], ['--review-context'],
    ['--review-phase', 'later'], ['--review-phase', 'initial', '--review-phase', 're-review'],
    ['--review-context=x', '--review-context', 'y'],
  ]) assert.match(loadReviewContext({ argv: args, target, cwd }).error, /review-context|review-phase/);
});

test('schema, target and evidence revision failures remain distinguishable', () => {
  const cases = [
    ['missing acceptance', (p) => delete p.acceptance, /schema|acceptance/],
    ['unknown field', (p) => p.approve = true, /schema/],
    ['wrong current', (p) => p.target.revision = priorRevision, /target mismatch/],
    ['wrong base', (p) => p.target.baseRevision = revision, /target mismatch/],
    ['wrong kind', (p) => p.target.kind = 'commit', /target mismatch/],
    ['unknown prior', (p) => p.priorRevision = '1'.repeat(40), /prior revision/],
    ['prior is not ancestor', (p) => p.priorRevision = '2'.repeat(40), /prior revision/],
    ['missing prior', (p) => p.priorRevision = null, /prior revision/],
    ['missing findings', (p) => p.findings = [], /findings/],
    ['duplicate finding', (p) => p.findings.push(p.findings[0]), /duplicate finding/],
    ['missing proof', (p) => p.findings[0].evidence = [], /evidence/],
    ['stale proof', (p) => p.findings[0].evidence[0].revision = priorRevision, /evidence revision/],
    ['ambiguous proof', (p) => p.findings[0].evidence[0].path = 'proof.txt', /evidence/],
  ];
  for (const [name, change, expected] of cases) {
    const value = packet(); change(value);
    assert.match(load(value).error, expected, name);
  }
});

test('local proof is embedded and inaccessible proof fails before delivery', () => {
  writeFileSync(join(cwd, '.afk', 'proof.txt'), proof);
  const value = packet(); value.findings[0].evidence = [{ revision, path: 'proof.txt' }];
  assert.equal(load(value).context.findings[0].evidence[0].text, proof);
  value.findings[0].evidence[0].path = 'not-present.txt';
  assert.match(load(value).error, /evidence.*missing_file/);
  value.findings[0].evidence[0].path = 'https://example.com/proof';
  assert.match(load(value).error, /evidence/);
});

test('sensitive content and secret paths fail without echoing values', () => {
  const sensitive = 'ghp_' + 'a'.repeat(30);
  const value = packet(); value.findings[0].evidence[0].text = sensitive;
  const error = load(value).error;
  assert.match(error, /sensitive/); assert.ok(!error.includes(sensitive));
  writeFileSync(join(cwd, '.afk', '.env'), 'innocent text');
  value.findings[0].evidence = [{ revision, path: '.env' }];
  assert.match(load(value).error, /secret.*path|excluded_path/);
  assert.match(load(packet(), { credential: revision }).error, /credential|sensitive/);
});

test('packet, expanded evidence and Unicode byte overflow never truncate', () => {
  const value = packet(); value.acceptance = 'a'.repeat(MAX_REVIEW_CONTEXT_BYTES);
  assert.match(load(value).error, /too_large|budget/);
  const p = packet();
  writeFileSync(join(cwd, '.afk', 'large.txt'), '界'.repeat(Math.floor(MAX_REVIEW_CONTEXT_BYTES / 3)));
  p.findings[0].evidence = [{ revision, path: 'large.txt' }];
  const result = load(p);
  assert.match(result.error, /budget/); assert.equal(result.section, '');
});

test('binary and malformed UTF-8 proof have explicit failure outcomes', () => {
  const value = packet(); value.findings[0].evidence = [{ revision, path: 'bad.txt' }];
  writeFileSync(join(cwd, '.afk', 'bad.txt'), Buffer.from([0x61, 0x00]));
  assert.match(load(value).error, /binary/);
  writeFileSync(join(cwd, '.afk', 'bad.txt'), Buffer.from([0xc3, 0x28]));
  assert.match(load(value).error, /UTF-8/);
});

test('symlinks and outside references cannot carry proof', { skip: process.platform === 'win32' }, () => {
  symlinkSync(join(cwd, 'code.txt'), join(cwd, '.afk', 'linked.txt'));
  const value = packet(); value.findings[0].evidence = [{ revision, path: 'linked.txt' }];
  assert.match(load(value).error, /symlink/);
  const outsideProof = join(tmpdir(), 'outside-proof');
  value.findings[0].evidence[0].path = relative(dirname(path), outsideProof);
  writeFileSync(outsideProof, 'outside');
  try { assert.match(load(value).error, /outside_path/); }
  finally { rmSync(outsideProof); }
});

test('design and uncommitted descriptors bind artifact contents', () => {
  const designPath = join(cwd, '.afk', 'design.md');
  writeFileSync(designPath, 'first design\n');
  const design = parseTarget(['--design', designPath], { cwd });
  const first = describeReviewTarget(design, { cwd });
  writeFileSync(designPath, 'second design\n');
  assert.notEqual(describeReviewTarget(design, { cwd }).artifactDigest, first.artifactDigest);
  const pending = parseTarget(['--uncommitted'], { cwd });
  const initial = describeReviewTarget(pending, { cwd });
  writeFileSync(join(cwd, 'new — file.txt'), proof);
  assert.notEqual(describeReviewTarget(pending, { cwd }).artifactDigest, initial.artifactDigest);
  writeFileSync(join(cwd, 'code.txt'), Buffer.from([0, 1]));
  const binary = describeReviewTarget(pending, { cwd });
  writeFileSync(join(cwd, 'code.txt'), Buffer.from([0, 2]));
  assert.notEqual(describeReviewTarget(pending, { cwd }).artifactDigest, binary.artifactDigest);
  writeFileSync(join(cwd, 'code.txt'), 'fixed\n');
  rmSync(join(cwd, 'new — file.txt'));
});

test('a locally present but unrelated prior commit is rejected', () => {
  const value = packet();
  value.priorRevision = git('commit-tree', 'HEAD^{tree}', '-m', 'unrelated history');
  assert.match(load(value).error, /outside the selected revision history/);
});

test('linked worktrees share confined main-worktree run evidence', () => {
  const linked = join(cwd, '.afk', 'linked');
  git('worktree', 'add', '--detach', linked, revision);
  try {
    const value = packet();
    writeFileSync(path, JSON.stringify(value));
    const result = loadReviewContext({ argv: ['--review-phase', 're-review', '--review-context', path], target, cwd: linked });
    assert.equal(result.error, null);
    assert.equal(result.context.findings[0].id, 'F96-001');
    const outside = join(cwd, 'not-run-context.json');
    writeFileSync(outside, JSON.stringify(value));
    try {
      const rejected = loadReviewContext({ argv: ['--review-phase', 're-review', '--review-context', outside], target, cwd: linked });
      assert.match(rejected.error, /outside_path/);
    } finally { rmSync(outside); }
  } finally { git('worktree', 'remove', linked); }
});


test('I96-S1 refuses credential metadata across path components before delivery', () => {
  for (const evidencePath of ['https://reader:fixture-password@host/proof.txt', 'api_key=/fixture-value/proof.txt']) {
    if (process.platform !== 'win32' || !evidencePath.includes('://')) {
      mkdirSync(dirname(join(cwd, '.afk', evidencePath)), { recursive: true });
      writeFileSync(join(cwd, '.afk', evidencePath), 'proof');
    }
    const value = packet();
    value.findings[0].evidence = [{ revision, path: evidencePath }];
    const result = load(value);
    assert.match(result.error, /sensitive|URL/);
    assert.equal(result.section, '');
    assert.ok(!result.error.includes('fixture-password'));
  }
});

test('I96-S2 preserves an evidence file leading BOM as part of the exact proof', () => {
  const text = '\uFEFF' + proof;
  writeFileSync(join(cwd, '.afk', 'bom-proof.txt'), text);
  const value = packet(); value.findings[0].evidence = [{ revision, path: 'bom-proof.txt' }];
  const result = load(value);
  assert.equal(result.error, null);
  assert.equal(result.context.findings[0].evidence[0].text, text);
});


test('I96-S1 checks the complete delivered design descriptor path', () => {
  const designPath = join(cwd, '.afk', 'api_key=', 'fixture-value', 'design.md');
  mkdirSync(dirname(designPath), { recursive: true });
  writeFileSync(designPath, 'Design proof');
  const design = parseTarget(['--design', designPath], { cwd });
  const value = packet(); value.target = describeReviewTarget(design, { cwd });
  assert.match(load(value, { target: design }).error, /sensitive/);
});
