import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { createReviewFixture } from '../../scripts/gate-test-env.mjs';
import { describeReviewTarget, loadReviewContext } from './review-context.mjs';
import { parseTarget } from './target.mjs';
import {
  canonicalBytes, digestBytes, publishImmutable, beginReviewReceipt,
  checkReviewReceipts, profileParts, observeConfiguration,
} from './review-receipt.mjs';

const fixture = createReviewFixture();
after(fixture.cleanup);
const { cwd } = fixture;
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
mkdirSync(join(cwd, '.afk', 'runs', 'fixture-run'), { recursive: true });
writeFileSync(join(cwd, '.git', 'info', 'exclude'), '.afk/\n');
const profile = { source: 'flags', roles: [
  { preferred: 'claude', reviewer: 'claude', model: 'claude-opus-5', effort: 'medium' },
  { preferred: 'kimi', reviewer: 'kimi', model: null, effort: null },
] };
let counter = 0;
const selector = ['--commit', fixture.commit];
const target = parseTarget(selector, { cwd });
function request(roleIndex = 0, overrides = {}) {
  return { version: 1, runId: 'fixture-run', issue: '97', attemptId: `attempt-${++counter}`,
    roleIndex, profile: structuredClone(profile), ...overrides };
}
function begin(value = request(), options = {}) {
  const path = join(cwd, '.afk', `${value.attemptId}.json`);
  writeFileSync(path, JSON.stringify(value));
  return beginReviewReceipt({ family: value.profile.roles[value.roleIndex].reviewer,
    argv: [...selector, '--review-receipt', path], cwd, ...options });
}
function complete(value = request(), { verdict = 'APPROVE', kind = 'review', context,
  model, ...options } = {}) {
  const receipt = begin(value, options);
  receipt.capture({ selection: value.profile.roles[value.roleIndex].reviewer === 'kimi'
    ? { model: null, effort: null } : value.profile.roles[value.roleIndex] });
  receipt.capture({ target, context: context || loadReviewContext({ argv: selector, target, cwd }) });
  if (model) receipt.capture({ model });
  else if (receipt.family === 'claude') receipt.capture({ model: {
    observed: ['claude-opus-5'], verification: 'verified', reason: null,
  } });
  receipt.capture({ execution: { exitCode: 0, signal: null, completion: null } });
  receipt.prepare({ kind, verdict, reason: kind === 'review' ? null : 'fixture outcome', text: kind === 'review' ? `Fixture result.\n${verdict || 'No explicit verdict.'}` : null });
  receipt.commit();
  return receipt;
}
function candidate(overrides = {}) {
  return { version: 1, runId: 'fixture-run', issue: '97', profile: structuredClone(profile),
    target: { kind: 'commit', commit: fixture.commit },
    contexts: [{ phase: 'initial', path: null }, { phase: 'initial', path: null }], ...overrides };
}
function check(paths, value = candidate()) {
  return checkReviewReceipts({ candidate: value, receiptPaths: paths.map((item) => item.path || item), cwd });
}

test('canonical bytes preserve semantic ordering, exact Unicode, and reject unsupported values', () => {
  assert.equal(canonicalBytes({ z: [1, '界\uFEFF'], a: { y: true, x: null } }),
    canonicalBytes({ a: { x: null, y: true }, z: [1, '界\uFEFF'] }));
  assert.match(canonicalBytes({ text: '\uFEFF' }), /\uFEFF/);
  assert.equal(canonicalBytes({ 2: 'second', 10: 'tenth' }), '{"10":"tenth","2":"second"}\n');
  assert.notEqual(digestBytes(canonicalBytes(['a', 'b'])), digestBytes(canonicalBytes(['b', 'a'])));
  for (const value of [undefined, NaN, Infinity, 1.5, { x: undefined }, new Date(), Array(1)]) {
    assert.throws(() => canonicalBytes(value));
  }
});

test('checker rejects contradictory execution, verdict, and identity claims', () => {
  const a = complete();
  for (const mutate of [
    (terminal) => { terminal.execution.exitCode = 1; },
    (terminal) => { terminal.execution.signal = 'SIGTERM'; },
    (terminal) => { terminal.outcome.verdict = 'REQUEST CHANGES'; },
    (terminal) => { terminal.model.verification = 'verified'; },
    (terminal) => { terminal.model.reason = ['not a reason']; },
    (terminal) => { terminal.observations.selectionSources = { unsupported: true }; },
    (terminal) => { terminal.transcript.reason = null; },
  ]) {
    const b = complete(request(1));
    const path = join(b.path, 'terminal.json');
    const terminal = JSON.parse(readFileSync(path, 'utf8'));
    mutate(terminal); writeFileSync(path, canonicalBytes(terminal));
    assert.equal(check([a, b]).consistent, false);
  }
  const claude = complete();
  const terminalPath = join(claude.path, 'terminal.json');
  const terminal = JSON.parse(readFileSync(terminalPath, 'utf8'));
  terminal.model = { ...terminal.model, observed: null, verification: 'unavailable', reason: 'unavailable' };
  writeFileSync(terminalPath, canonicalBytes(terminal));
  assert.equal(check([claude, complete(request(1))]).consistent, false);
});

test('D2 profile parts preserve downstream-only selection invalidation', () => {
  const changed = structuredClone(profile);
  changed.roles[1].model = 'kimi-code/k3';
  assert.deepEqual(profileParts(profile, 0), profileParts(changed, 0));
  assert.notDeepEqual(profileParts(profile, 1), profileParts(changed, 1));
  changed.roles[0].effort = 'high';
  assert.notDeepEqual(profileParts(profile, 0), profileParts(changed, 0));
  changed.roles[1].preferred = 'glm';
  assert.notDeepEqual(profileParts(profile, 0).profile, profileParts(changed, 0).profile);
});

test('D3 configuration equivalence retains non-overridden fields and rejects invalid gates', () => {
  const path = join(cwd, '.afk', 'config.md');
  writeFileSync(path, '## external gate\nGATES: CODEX > KIMI # comment\npriority: CODEX>CLAUDE\n');
  const first = observeConfiguration({ cwd, source: 'config' });
  writeFileSync(path, '## external gate\npriority: codex > claude\ngates: codex>kimi\n');
  assert.deepEqual(observeConfiguration({ cwd, source: 'config' }), first);
  const flags = observeConfiguration({ cwd, source: 'flags' });
  writeFileSync(path, '## external gate\ngates: claude\npriority: codex>claude\n');
  assert.deepEqual(observeConfiguration({ cwd, source: 'flags' }), flags);
  writeFileSync(path, '## external gate\ngates: claude\npriority: kimi\n');
  assert.notDeepEqual(observeConfiguration({ cwd, source: 'flags' }), flags);
  writeFileSync(path, '## external gate\ngates: \n');
  assert.throws(() => observeConfiguration({ cwd, source: 'flags' }), /gates/);
  writeFileSync(path, '## external gate\ngates: codex > > kimi\n');
  assert.throws(() => observeConfiguration({ cwd, source: 'flags' }), /gates/);
  writeFileSync(path, '');
});

test('D4 unknown preferred role is retained but unsupported actual reviewer is rejected', () => {
  const value = structuredClone(profile);
  value.roles[0].preferred = ' Unavailable-Family ';
  assert.equal(profileParts(value, 0).profile.preferences[0], 'unavailable-family');
  value.roles[0].reviewer = 'unavailable-family';
  assert.throws(() => profileParts(value, 0), /reviewer/);
});

test('immutable publication preserves prior bytes and does not publish interrupted staging', () => {
  const path = join(cwd, '.afk', 'immutable.json');
  publishImmutable(path, 'original\n');
  assert.throws(() => publishImmutable(path, 'replacement\n'));
  assert.equal(readFileSync(path, 'utf8'), 'original\n');
  const interrupted = join(cwd, '.afk', 'interrupted.json');
  assert.throws(() => publishImmutable(interrupted, 'complete\n', {
    linkImpl: () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); },
  }));
  assert.ok(!readdirSync(join(cwd, '.afk')).includes('interrupted.json'));
});

test('retained input is reproducible across attempts, with distinct immutable starts', () => {
  const a = complete(); const b = complete();
  assert.notEqual(a.path, b.path);
  assert.equal(readFileSync(join(a.path, 'input.json'), 'utf8'), readFileSync(join(b.path, 'input.json'), 'utf8'));
  assert.throws(() => begin(a.request), /exist|collision/);
  const terminal = readFileSync(join(a.path, 'terminal.json'), 'utf8');
  assert.throws(() => a.commit(), /terminal|published/);
  assert.equal(readFileSync(join(a.path, 'terminal.json'), 'utf8'), terminal);
});

test('checker reports identity unknown separately and does not treat non-review attempts as approval', () => {
  const a = complete(); const b = complete(request(1));
  const result = check([a, b]);
  assert.equal(result.consistent, true, JSON.stringify(result));
  assert.equal(result.reviewsComplete, true);
  assert.equal(result.allRequiredApproved, true);
  assert.equal(result.roles[1].modelVerification, 'unavailable');
  for (const kind of ['error', 'skipped', 'preview']) {
    const other = complete(request(1), { kind, verdict: null });
    const checked = check([a, other]);
    assert.equal(checked.reviewsComplete, false);
    assert.equal(checked.allRequiredApproved, false);
  }
  const unknown = complete(request(1), { verdict: null });
  assert.equal(check([a, unknown]).allRequiredApproved, null);
  const negative = complete(request(1), { verdict: 'REQUEST CHANGES' });
  assert.equal(check([a, negative]).consistent, true);
  assert.equal(check([a, negative]).allRequiredApproved, false);
});

test('checker preserves earlier receipt on final selection change and rejects changed upstream selection', () => {
  const a = complete(); const b = complete(request(1));
  const changed = candidate(); changed.profile.roles[1].model = 'kimi-code/k3';
  let result = check([a, b], changed);
  assert.equal(result.roles[0].consistent, true);
  assert.equal(result.roles[1].consistent, false);
  changed.profile.roles[0].effort = 'high';
  result = check([a, b], changed);
  assert.equal(result.roles[0].consistent, false);
  assert.equal(result.roles[1].consistent, false);
});

test('D1 mixed native and supported context remains role-specific', () => {
  const mixed = structuredClone(profile);
  mixed.roles[0] = { preferred: 'codex', reviewer: 'codex', model: 'gpt-5.6-sol', effort: 'medium' };
  const packetPath = join(cwd, '.afk', 'mixed-context.json');
  writeFileSync(packetPath, JSON.stringify({ version: 1, target: describeReviewTarget(target, { cwd }),
    acceptance: 'Preserve named closure.', priorRevision: fixture.commit,
    findings: [{ id: 'F97-001', disposition: 'refuted', claim: 'Required evidence was absent.',
      evidence: [{ revision: fixture.commit, text: 'The fixture retains the complete proof.' }] }],
  }));
  const context = loadReviewContext({ cwd, target,
    argv: [...selector, '--review-phase', 're-review', '--review-context', packetPath] });
  assert.equal(context.error, null);
  const a = complete(request(0, { profile: mixed }), { verdict: null });
  const b = complete(request(1, { profile: mixed }), { context });
  const expected = candidate({ profile: mixed, contexts: [
    { phase: 'initial', path: null }, { phase: 're-review', path: packetPath },
  ] });
  assert.equal(check([a, b], expected).consistent, true);
  expected.contexts[1] = { phase: 'initial', path: null };
  assert.equal(check([a, b], expected).roles[1].consistent, false);
  expected.contexts[0] = { phase: 're-review', path: packetPath };
  assert.equal(check([a, b], expected).consistent, false);
});

test('start-only attempts, missing roles, noncanonical files, and altered review bytes fail closed', () => {
  const a = complete(); const incomplete = begin(request(1));
  assert.equal(check([a, incomplete]).reviewsComplete, false);
  assert.equal(check([a]).consistent, false);
  const b = complete(request(1));
  writeFileSync(join(b.path, 'review.txt'), 'Altered\nAPPROVE');
  assert.equal(check([a, b]).consistent, false);
  const c = complete(request(1));
  const terminalPath = join(c.path, 'terminal.json');
  writeFileSync(terminalPath, JSON.stringify(JSON.parse(readFileSync(terminalPath, 'utf8')), null, 2));
  assert.equal(check([a, c]).consistent, false);
});

test('receipt metadata rejects credentials, oversized fields, and symlink input without publishing', () => {
  const value = request(); value.issue = 'fixture-private-key';
  assert.throws(() => begin(value, { credential: 'fixture-private-key' }), /credential|sensitive/);
  value.issue = 'x'.repeat(100001);
  assert.throws(() => begin(value), /large|size|bound/);
  const link = join(cwd, '.afk', 'receipt-link.json');
  const source = join(cwd, '.afk', 'receipt-source.json');
  writeFileSync(source, JSON.stringify(request())); symlinkSync(source, link);
  assert.throws(() => beginReviewReceipt({ argv: ['--review-receipt', link], family: 'claude', cwd }), /symlink|unavailable/);
  const structured = begin(request(), { credential: fixture.commit });
  assert.match(structured.error, /credential/);
  structured.prepare({ kind: 'error', reason: 'sensitive observation rejected', verdict: null, text: null });
  structured.commit();
  for (const name of readdirSync(structured.path)) {
    assert.ok(!readFileSync(join(structured.path, name), 'utf8').includes(fixture.commit));
  }
});

test('S1 arbitrary configuration keys never exempt sensitive text from receipt screening', () => {
  const configPath = join(cwd, '.afk', 'config.md');
  try {
    for (const key of ['digest', 'startedDigest', 'revision', 'baseRevision', 'artifactDigest', 'head', 'baseTip']) {
      for (const secret of [`sk-${'x'.repeat(24)}`, 'a'.repeat(64)]) {
        writeFileSync(configPath, `## external gate\n${key}: ${secret}\n`);
        const receipt = begin();
        assert.match(receipt.error, /sensitive metadata/, key);
        receipt.prepare({ kind: 'error', reason: receipt.error, verdict: null, text: null });
        receipt.commit();
        assert.deepEqual(readdirSync(receipt.path).sort(), ['started.json', 'terminal.json']);
        for (const name of readdirSync(receipt.path)) {
          assert.ok(!readFileSync(join(receipt.path, name), 'utf8').includes(secret));
        }
        const result = check([receipt]);
        assert.equal(result.consistent, false);
        assert.ok(!JSON.stringify(result).includes(secret));
      }
    }
  } finally { writeFileSync(configPath, ''); }
});

test('S1 only valid hash values at schema locations bypass generic secret heuristics', () => {
  const designPath = join(cwd, '.afk', 'receipt-design.md');
  writeFileSync(designPath, '# Fixture contract\nPreserve complete artifact identity.\n');
  const args = ['--design', designPath];
  const design = parseTarget(args, { cwd });
  const descriptor = describeReviewTarget(design, { cwd });
  const receipt = begin(request(1));
  receipt.capture({ target: design, context: loadReviewContext({ argv: args, target: design, cwd }),
    execution: { exitCode: 0, signal: null, completion: null } });
  receipt.prepare({ kind: 'review', verdict: 'SOUND', text: 'SOUND', reason: null });
  receipt.commit();
  const input = JSON.parse(readFileSync(join(receipt.path, 'input.json'), 'utf8'));
  const terminal = JSON.parse(readFileSync(join(receipt.path, 'terminal.json'), 'utf8'));
  assert.deepEqual(input.target, descriptor);
  assert.equal(terminal.observations.before.target.artifactDigest, descriptor.artifactDigest);
  assert.equal(terminal.input.digest, digestBytes(canonicalBytes(input)));
  assert.equal(check([receipt], candidate({ target: { kind: 'design', path: designPath } })).roles[1].consistent, true);

  const invalid = begin();
  invalid.capture({ target, context: { phase: 'initial', digest: `sk-${'x'.repeat(24)}` } });
  assert.throws(() => invalid.prepare({ kind: 'preview', reason: 'fixture', verdict: null, text: null }), /hash|sensitive/);
  assert.deepEqual(readdirSync(invalid.path), ['started.json']);
});

test('S2 malformed retained input reports a generic category without echoing source bytes', () => {
  const a = complete();
  for (const [bytes, bind, expected] of [
    ['fixture-private-fragment!', true, 'receipt JSON is malformed'],
    ['fixture-private-fragment!', false, 'receipt artifact digest mismatch'],
    [JSON.stringify({ fixture: true }), true, 'noncanonical input bytes'],
  ]) {
    const b = complete(request(1));
    const terminalPath = join(b.path, 'terminal.json');
    const terminal = JSON.parse(readFileSync(terminalPath, 'utf8'));
    writeFileSync(join(b.path, 'input.json'), bytes);
    if (bind) terminal.input.digest = digestBytes(bytes);
    writeFileSync(terminalPath, canonicalBytes(terminal));
    const result = check([a, b]);
    assert.equal(result.consistent, false);
    assert.deepEqual(result.roles[1].issues, [expected]);
    assert.ok(!JSON.stringify(result).includes('fixture-pri'));
    if (expected === 'receipt JSON is malformed') {
      const candidatePath = join(cwd, '.afk', 'malformed-input-candidate.json');
      writeFileSync(candidatePath, JSON.stringify(candidate()));
      const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/check-review-receipts.mjs', import.meta.url)),
        '--candidate', candidatePath, '--receipt', a.path, '--receipt', b.path], { cwd, encoding: 'utf8' });
      assert.equal(cli.status, 1);
      assert.deepEqual(JSON.parse(cli.stdout).roles[1].issues, [expected]);
      assert.ok(!(cli.stdout + cli.stderr).includes('fixture-pri'));
    }
  }
});

test('rejected target capture still permits a truthful error terminal', () => {
  const receipt = begin();
  assert.throws(() => receipt.capture({ target: parseTarget(['--commit', 'missing-fixture-revision'], { cwd }) }));
  receipt.prepare({ kind: 'error', reason: 'target is invalid', verdict: null, text: null });
  receipt.commit();
  const terminal = JSON.parse(readFileSync(join(receipt.path, 'terminal.json'), 'utf8'));
  assert.equal(terminal.outcome.kind, 'error');
  assert.equal(terminal.input, null);
});

test('target or configuration drift prevents a review terminal', () => {
  const receipt = begin();
  receipt.capture({ selection: profile.roles[0], target, context: loadReviewContext({ argv: selector, target, cwd }) });
  writeFileSync(join(cwd, '.afk', 'config.md'), '## external gate\npriority: kimi\n');
  assert.throws(() => receipt.prepare({ kind: 'review', verdict: 'APPROVE', text: 'APPROVE', reason: null }), /changed|drift/);
  assert.ok(!readdirSync(receipt.path).includes('terminal.json'));
  writeFileSync(join(cwd, '.afk', 'config.md'), '');
  const changedHead = begin();
  changedHead.capture({ selection: profile.roles[0], target, context: loadReviewContext({ argv: selector, target, cwd }) });
  const previousHead = git('rev-parse', 'HEAD');
  try {
    git('commit', '--allow-empty', '-m', 'concurrent fixture revision');
    assert.throws(() => changedHead.prepare({ kind: 'review', verdict: 'APPROVE', text: 'APPROVE', reason: null }), /changed|drift/);
    assert.ok(!readdirSync(changedHead.path).includes('terminal.json'));
  } finally { git('reset', '--hard', previousHead); }
});

test('fresh-process checker recovers explicit evidence without changing run files or Git state', () => {
  const a = complete(); const b = complete(request(1));
  const candidatePath = join(cwd, '.afk', 'candidate.json');
  writeFileSync(candidatePath, JSON.stringify(candidate()));
  const run = join(cwd, '.afk', 'runs', 'fixture-run');
  function snapshot(path) {
    return readdirSync(path).sort().flatMap((name) => {
      const entry = join(path, name);
      return lstatSync(entry).isDirectory() ? snapshot(entry) : [[entry, digestBytes(readFileSync(entry))]];
    });
  }
  const before = snapshot(run); const gitBefore = git('status', '--porcelain');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/check-review-receipts.mjs', import.meta.url)),
    '--candidate', candidatePath, '--receipt', a.path, '--receipt', b.path], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).allRequiredApproved, true);
  assert.deepEqual(snapshot(run), before);
  assert.equal(git('status', '--porcelain'), gitBefore);
});

test('abruptly killed shared helper leaves an inspectable incomplete attempt', async () => {
  const value = request(1);
  const requestPath = join(cwd, '.afk', `${value.attemptId}.json`);
  writeFileSync(requestPath, JSON.stringify(value));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { beginReviewReceipt } from ${JSON.stringify(new URL('./review-receipt.mjs', import.meta.url).href)};
    const receipt=beginReviewReceipt({family:'kimi',argv:['--review-receipt',${JSON.stringify(requestPath)}]});
    process.stdout.write(receipt.path+'\\n'); setInterval(()=>{},1000);
  `], { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  const closed = once(child, 'close');
  const [chunk] = await once(child.stdout, 'data');
  child.kill('SIGKILL'); await closed;
  const path = String(chunk).trim();
  assert.deepEqual(readdirSync(path), ['started.json']);
  const result = check([complete(), path]);
  assert.equal(result.reviewsComplete, false);
  assert.equal(result.allRequiredApproved, false);
});
