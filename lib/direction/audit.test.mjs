import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createReviewFixture, copyDirectionTestRuntime } from '../../scripts/gate-test-env.mjs';
import { initializeFixture, completeResult } from '../../scripts/fixtures/direction-transport/setup.mjs';
import { canonicalBytes, digestBytes } from '../gate/review-receipt.mjs';
import { appendDirectionRecord, readDirectionState } from './state.mjs';
import { prepareAudit, checkAudit, observeTarget, validatePacket, validateModelResult,
  extractModelResult, validateDerivation, requestBody, profileFingerprint, validateQualification, RUNTIME_FILES, terminalRequest, loadPrepared, LIMITS as AUDIT_LIMITS, SYSTEM } from './audit.mjs';
import { contentDigest, LIMITS as STATE_LIMITS } from './schema.mjs';
import { recordExchange, fixedExchange } from './transport.mjs';

function fixture(t, artifact = 'export const combine = (a, b) => a + b;\n') {
  const f = createReviewFixture(); t.after(f.cleanup);
  writeFileSync(join(f.cwd, 'artifact.mjs'), artifact);
  execFileSync('git', ['add', 'artifact.mjs'], { cwd: f.cwd });
  execFileSync('git', ['commit', '-qm', 'Add fixture'], { cwd: f.cwd });
  return { ...f, ...initializeFixture({ cwd: f.cwd }) };
}
function prepared(t) {
  const f = fixture(t); const p = prepareAudit({ ...f, input: f.input });
  assert.equal(p.status, 'prepared');
  const packet = JSON.parse(readFileSync(join(p.directory, 'packet.json'), 'utf8'));
  return { ...f, ...p, packet };
}

test('preparation captures actual Git blobs and consumes no call', t => {
  const f = prepared(t); validatePacket(f.packet);
  assert.equal(readDirectionState(f).accounting.charged, 0);
  const artifact = f.packet.evidence.find(x => x.kind === 'artifact');
  assert.equal(artifact.origin.kind, 'target-blob');
  assert.equal(artifact.origin.revision, f.packet.target.currentHead);
  assert.equal(digestBytes(artifact.content), artifact.reference.digest);
  assert.equal(readFileSync(join(f.directory, 'request.json'), 'utf8'), JSON.stringify(requestBody(f.packet)));
  assert.throws(() => prepareAudit({ ...f, input: f.input }), /output_exists/);
});

test('branch and commit require clean actual HEAD; dirty targets explicitly select uncommitted', t => {
  const f = fixture(t); const old = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: f.cwd, encoding: 'utf8' }).trim();
  assert.throws(() => observeTarget({ kind: 'commit', commit: old }, f.cwd), /target_head_mismatch/);
  writeFileSync(join(f.cwd, 'artifact.mjs'), 'export const combine = (a, b) => a - b;\n');
  assert.throws(() => prepareAudit({ ...f, input: f.input }), /dirty_target_use_uncommitted/);
  assert.throws(() => observeTarget({ kind: 'branch', base: old }, f.cwd), /dirty_target_use_uncommitted/);
  assert.notEqual(observeTarget({ kind: 'uncommitted' }, f.cwd).working, null);
});

test('own reservation may consume last slot; profile pending stays explicit', async t => {
  const { audit } = await copyDirectionTestRuntime(t, { qualification: 'pending' });
  const f = prepared(t);
  const reserve = JSON.parse(readFileSync(join(f.directory, 'reserve-request.json'), 'utf8'));
  assert.equal(appendDirectionRecord({ cwd: f.cwd, request: reserve }).status, 'published');
  assert.equal(readDirectionState(f).accounting.remaining, 0);
  const check = audit.checkAudit({ ...f, auditId: f.input.auditId, stage: 'pre-dispatch' });
  assert.equal(check.current, true);
  assert.deepEqual(check.reasons, ['qualification_pending']);
  writeFileSync(join(f.cwd, 'artifact.mjs'), 'changed\n');
  assert.equal(audit.checkAudit({ ...f, auditId: f.input.auditId, stage: 'pre-dispatch' }).status, 'stale');
});

test('D111-1 deterministic extraction preserves typed hashes and is idempotent', t => {
  const f = prepared(t); const result = completeResult(f.packet);
  validateModelResult(result, f.packet);
  const extracted = extractModelResult(JSON.stringify(result), f.packet);
  assert.deepEqual(extracted, result);
  assert.deepEqual(extractModelResult(canonicalBytes(extracted), f.packet), result);
  assert.equal(extracted.packetDigest.length, 64);
});

for (const change of ['outcome', 'findings', 'coverage', 'malformed']) {
  test(`D111-1 rejects ${change} response/payload substitution`, t => {
    const f = prepared(t); const payload = completeResult(f.packet); const responseResult = structuredClone(payload);
    if (change === 'outcome') responseResult.outcome = 'NEEDS-DECISION';
    if (change === 'findings') {
      responseResult.outcome = 'CORRECT-COURSE';
      responseResult.findings = [{ id: 'F1', requirementIds: ['O1'], evidence: [payload.coverage[0].source],
        explanation: 'The candidate needs correction.', recommendedAction: 'Recheck the requirement.' }];
    }
    if (change === 'coverage') responseResult.coverage[0].explanation = 'A different source-grounded explanation.';
    validateModelResult(payload, f.packet);
    if (change !== 'malformed') validateModelResult(responseResult, f.packet);
    const response = { extraction: 'model-result', envelope: { choices: [{ message: {
      content: change === 'malformed' ? '{' : canonicalBytes(responseResult) } }] } };
    assert.throws(() => validateDerivation(response, payload, f.packet));
  });
}

test('coverage is complete, source-grounded and cannot borrow a typed exemption', t => {
  const f = prepared(t); const good = completeResult(f.packet);
  for (const mutate of [x => x.coverage.pop(), x => x.coverage[0].source.quote = 'invented',
    x => x.coverage[0].artifacts = [], x => x.nextAction = 'a'.repeat(64),
    x => x.coverage[0].source.startLine = 1, x => x.extra = 'a'.repeat(64)]) {
    const bad = structuredClone(good); mutate(bad); assert.throws(() => validateModelResult(bad, f.packet));
  }
  const badPacket = structuredClone(f.packet); badPacket.evidence[0].content += 'a'.repeat(64);
  assert.throws(() => validatePacket(badPacket));
});

test('off reads no unnecessary input and pending qualification cannot attest a live call', t => {
  const f = createReviewFixture(); t.after(f.cleanup);
  const check = checkAudit({ cwd: f.cwd, runId: 'missing', issueId: '111', auditId: 'unused', stage: 'endpoint', endpointId: 'publish' });
  assert.equal(check.directionSatisfied, false);
  assert.throws(() => validateQualification({ version: 1, status: 'pending', profileDigest: profileFingerprint().digest, proof: null }), /qualification_pending/);
});

test('the explicit production fingerprint closes local imports and survives an oracle-free support copy', t => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const seen = new Set(); const pending = ['lib/direction/audit.mjs', 'lib/direction/transport.mjs', 'scripts/check-direction-audit.mjs', 'scripts/direction-state.mjs'];
  while (pending.length) {
    const path = pending.pop(); if (seen.has(path)) continue; seen.add(path);
    const content = readFileSync(join(root, path), 'utf8');
    for (const match of content.matchAll(/(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      pending.push(resolve(root, dirname(path), match[1]).slice(root.length + 1));
    }
  }
  assert.deepEqual([...seen].sort(), [...RUNTIME_FILES]);
  assert.equal(RUNTIME_FILES.some(p => /qualify-|fixtures|evaluations/.test(p)), false);
  const copy = realpathSync(mkdtempSync(join(tmpdir(), 'afk-production-only-'))); t.after(() => rmSync(copy, { recursive: true, force: true }));
  for (const path of [...RUNTIME_FILES, 'lib/direction/qualification.json']) {
    mkdirSync(dirname(join(copy, path)), { recursive: true }); copyFileSync(join(root, path), join(copy, path));
  }
  const script = "const { profileFingerprint } = await import('./lib/direction/audit.mjs'); process.stdout.write(profileFingerprint().digest);";
  const observed = () => execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: copy, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(observed(), profileFingerprint().digest);
  writeFileSync(join(copy, 'lib/direction/transport.mjs'), readFileSync(join(copy, 'lib/direction/transport.mjs'), 'utf8') + '\n');
  assert.notEqual(observed(), profileFingerprint().digest);
});

for (const [name, mutate] of [
  ['extra field', x => x.extra = true], ['version', x => x.version = 2], ['missing source', x => x.evidence.shift()],
  ['unknown author', x => x.authors[0].family = 'unknown'], ['same author', x => x.authors[0].family = 'DeepSeek'],
  ['duplicate evidence', x => x.evidence.push(x.evidence[0])], ['untriaged disposition', x => x.history.dispositions.push({
    auditId: 'old', findingId: 'F1', disposition: 'fixed', reason: 'Already fixed.', evidence: [] })],
]) {
  test(`packet rejects ${name}`, t => { const f = prepared(t); const bad = structuredClone(f.packet); mutate(bad); assert.throws(() => validatePacket(bad)); });
}

test('free-text result redaction remains idempotent while authoritative source secrets refuse', t => {
  const f = prepared(t); const result = completeResult(f.packet); result.nextAction = `Report token ${'b'.repeat(64)} safely.`;
  const cleaned = extractModelResult(JSON.stringify(result), f.packet);
  assert.notEqual(cleaned.nextAction, result.nextAction); assert.equal(cleaned.packetDigest, result.packetDigest);
  assert.deepEqual(extractModelResult(canonicalBytes(cleaned), f.packet), cleaned);
});

test('retained required policy survives absent sequence and explicit source role rejects opaque packet bytes', t => {
  const f = prepared(t); const reserve = JSON.parse(readFileSync(join(f.directory, 'reserve-request.json'), 'utf8'));
  appendDirectionRecord({ cwd: f.cwd, request: reserve });
  rmSync(join(f.run, 'issues', f.issueId, 'direction'), { recursive: true });
  const checked = checkAudit({ ...f, auditId: f.input.auditId, stage: 'endpoint', endpointId: f.packet.endpoint.id });
  assert.equal(checked.mode, 'required'); assert.equal(checked.status, 'stale'); assert.equal(checked.directionSatisfied, false);
});

for (const [name, bytes] of [['secret', Buffer.from('a'.repeat(64))], ['binary', Buffer.from([0])], ['invalid UTF-8', Buffer.from([0xc3, 0x28])], ['overflow', Buffer.alloc(100001, 120)]]) {
  test(`captured committed ${name} bytes refuse preparation`, t => {
    const f = fixture(t); writeFileSync(join(f.cwd, 'artifact.mjs'), bytes);
    execFileSync('git', ['add', 'artifact.mjs'], { cwd: f.cwd }); execFileSync('git', ['commit', '-qm', 'Change fixture'], { cwd: f.cwd });
    f.input.target = { kind: 'commit', commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.cwd, encoding: 'utf8' }).trim() };
    f.input.evidence.find(e => e.kind === 'check').targetDigest = contentDigest(observeTarget(f.input.target, f.cwd));
    assert.throws(() => prepareAudit({ ...f, input: f.input }));
  });
}

test('explicit ignored worktree evidence is re-observed independently of Git dirty status', t => {
  const f = fixture(t); writeFileSync(join(f.cwd, '.git', 'info', 'exclude'), '.afk/\nignored.txt\n');
  writeFileSync(join(f.cwd, 'ignored.txt'), 'Authorized support evidence.\n'); f.input.target = { kind: 'uncommitted' };
  f.input.evidence.push({ id: 'support', kind: 'artifact', path: 'ignored.txt' });
  f.input.evidence.find(e => e.kind === 'check').targetDigest = contentDigest(observeTarget(f.input.target, f.cwd));
  const p = prepareAudit({ ...f, input: f.input }); appendDirectionRecord({ cwd: f.cwd, request: JSON.parse(readFileSync(join(p.directory, 'reserve-request.json'), 'utf8')) });
  writeFileSync(join(f.cwd, 'ignored.txt'), 'Changed support evidence.\n');
  const checked = checkAudit({ ...f, auditId: f.input.auditId, stage: 'pre-dispatch' }); assert.equal(checked.status, 'stale');
});

for (const path of ['../outside.txt', '.env', '/absolute.txt', 'nested/../file']) {
  test(`artifact origin refuses ${path}`, t => {
    const f = fixture(t); f.input.evidence[1].path = path; assert.throws(() => prepareAudit({ ...f, input: f.input }));
  });
}

test('symlink artifact and arbitrary snapshot claims are refused', t => {
  const f = fixture(t); symlinkSync('artifact.mjs', join(f.cwd, 'linked.mjs'));
  f.input.target = { kind: 'uncommitted' }; f.input.evidence[1].path = 'linked.mjs';
  assert.throws(() => prepareAudit({ ...f, input: f.input }));
  f.input.evidence[1] = { id: 'implementation', kind: 'artifact', reference: f.input.evidence[0].reference };
  assert.throws(() => prepareAudit({ ...f, input: f.input }));
});

test('semantic fixtures retain omission, justified support, scope preference and contested correction separately', () => {
  const cases = JSON.parse(readFileSync(new URL('../../scripts/fixtures/direction-semantic.json', import.meta.url), 'utf8'));
  assert.deepEqual(cases.map(x => x.id), ['omitted-requirement', 'supporting-file', 'reviewer-preference', 'contested-correction']);
  for (const item of cases) {
    assert.ok(item.source && item.artifact && item.reason); assert.ok(Array.isArray(item.history.findings));
    assert.ok(Array.isArray(item.history.dispositions)); assert.equal(Object.hasOwn(item, 'observedModelOutcome'), false);
  }
  assert.match(cases[0].artifact, /tests pass/); assert.equal(cases[1].expected, 'ON-TRACK');
  assert.equal(cases[3].history.dispositions[0].findingId, cases[3].history.findings[0].id);
  assert.equal(cases[3].history.dispositions[0].disposition, 'contested');
});

for (const phase of ['initial', 'signal', 'endpoint']) for (const outcome of ['ON-TRACK', 'CORRECT-COURSE', 'NEEDS-DECISION', 'COMPLETE']) {
  test(`${phase} ${outcome} cannot substitute for a qualified current endpoint COMPLETE`, async t => {
    const { audit } = await copyDirectionTestRuntime(t, { qualification: 'pending' });
    const f = fixture(t); f.input.phase = phase; const prepared = prepareAudit({ ...f, input: f.input });
    const packet = JSON.parse(readFileSync(join(prepared.directory, 'packet.json'), 'utf8')); const payload = completeResult(packet); payload.outcome = outcome;
    if (outcome === 'CORRECT-COURSE') payload.findings = [{ id: 'F1', requirementIds: ['O1'], evidence: [payload.coverage[0].source], explanation: 'The candidate needs correction.', recommendedAction: 'Recheck the requirement.' }];
    appendDirectionRecord({ cwd: f.cwd, request: JSON.parse(readFileSync(join(prepared.directory, 'reserve-request.json'), 'utf8')) });
    const where = { ...f, auditId: f.input.auditId };
    await recordExchange({ ...where, env: { DEEPSEEK_API_KEY: 'fixture-key' }, fetchImpl: async () => new Response(JSON.stringify({
      model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] })) });
    const terminal = appendDirectionRecord({ cwd: f.cwd, request: terminalRequest({ ...where, operationId: 'terminal' }) });
    assert.equal(terminal.status, 'published');
    const checked = audit.checkAudit({ ...where, stage: 'endpoint', endpointId: packet.endpoint.id });
    assert.equal(checked.protocolValid, true); assert.equal(checked.directionSatisfied, false);
    assert.deepEqual(checked.reasons, [phase === 'endpoint' && outcome === 'COMPLETE' ? 'qualification_pending' : 'endpoint_incomplete']);
  });
}

test('off preserves the old path, shadow remains shadow on unavailability, and full oversized input refuses', async t => {
  const { audit } = await copyDirectionTestRuntime(t, { qualification: 'pending' });
  const f = fixture(t); const original = readDirectionState(f); const operator = f.input.endpoint.source;
  const policy = { ...original.policy, revision: 2, previousDigest: original.policyDigest, mode: 'shadow',
    amendment: { reason: 'Observe without direction-only holds.', authorization: operator } };
  assert.equal(appendDirectionRecord({ cwd: f.cwd, request: { version: 1, runId: f.runId, issueId: f.issueId,
    operationId: 'shadow', expectedHead: original.head, operation: 'policy', payload: { policy } } }).status, 'published');
  const prepared = prepareAudit({ ...f, input: f.input });
  appendDirectionRecord({ cwd: f.cwd, request: JSON.parse(readFileSync(join(prepared.directory, 'reserve-request.json'), 'utf8')) });
  const checked = audit.checkAudit({ ...f, auditId: f.input.auditId, stage: 'pre-dispatch' }); assert.equal(checked.mode, 'shadow');
  assert.equal(checked.status, 'unavailable');
  const state = readDirectionState(f); const off = { ...state.policy, revision: 3, previousDigest: state.policyDigest, mode: 'off',
    amendment: { reason: 'Disable sourced auditing.', authorization: operator } };
  assert.equal(appendDirectionRecord({ cwd: f.cwd, request: { version: 1, runId: f.runId, issueId: f.issueId,
    operationId: 'off', expectedHead: state.head, operation: 'policy', payload: { policy: off } } }).status, 'published');
  assert.equal(prepareAudit({ ...f, input: null }).status, 'off');
  assert.equal(checkAudit({ ...f, auditId: f.input.auditId, stage: 'endpoint', endpointId: 'local-completion' }).status, 'off');
  const large = fixture(t), phrase = 'Full supplied source context. ';
  large.input.nextAction = phrase.repeat(Math.ceil(AUDIT_LIMITS.packetBytes/Buffer.byteLength(phrase)));
  assert.throws(() => prepareAudit({ ...large, input: large.input }), /packet_limit/);
  assert.equal(readDirectionState(large).accounting.charged, 0);
});

async function historicalFixture(t, { oldProfile = false, legacyRequest = false, legacySettings = false, historicalId = 'implementation' } = {}) {
  const f = fixture(t); const state = readDirectionState(f);
  const policy = { ...state.policy, revision: 2, previousDigest: state.policyDigest, maxAuditAttempts: 3,
    amendment: { reason: 'Bound three synthetic observations.', authorization: f.input.endpoint.source } };
  assert.equal(appendDirectionRecord({ cwd: f.cwd, request: { version: 1, runId: f.runId, issueId: f.issueId,
    operationId: 'history-capacity', expectedHead: state.head, operation: 'policy', payload: { policy } } }).status, 'published');
  let prior = { prepareAudit, terminalRequest, recordExchange };
  if (oldProfile || legacyRequest || legacySettings) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const copy = realpathSync(mkdtempSync(join(tmpdir(), 'afk-old-profile-'))); t.after(() => rmSync(copy, { recursive: true, force: true }));
    for (const path of RUNTIME_FILES) { mkdirSync(dirname(join(copy, path)), { recursive: true }); copyFileSync(join(root, path), join(copy, path)); }
    const module = join(copy, 'lib/direction/audit.mjs');
    let source = readFileSync(module, 'utf8').replace('Audit the complete supplied direction packet', 'Review the complete supplied direction packet');
    if (legacyRequest) source = source.replace('content: requestContent(packet)', 'content: requestContent(packet, false)');
    if (legacySettings) source = source.replace("response_format: { type: 'json_object' }, temperature: 0, stream: false", "response_format: { type: 'json_object' }, stream: false");
    writeFileSync(module, source);
    prior = { ...await import(pathToFileURL(module)), ...await import(pathToFileURL(join(copy, 'lib/direction/transport.mjs'))) };
  }
  const commit = content => {
    writeFileSync(join(f.cwd, 'artifact.mjs'), content);
    execFileSync('git', ['add', 'artifact.mjs'], { cwd: f.cwd }); execFileSync('git', ['commit', '-qm', 'Synthetic history candidate'], { cwd: f.cwd });
    return { kind: 'commit', commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.cwd, encoding: 'utf8' }).trim() };
  };
  const firstInput = structuredClone(f.input); firstInput.auditId = 'prior-audit';
  firstInput.target = commit('export const combine = (a, b) => a - b;\n');
  firstInput.history = { audits: [], findings: [], dispositions: [] };
  firstInput.evidence.find(e => e.kind === 'artifact').id = historicalId;
  firstInput.coverage.forEach(row => row.evidenceIds = row.evidenceIds.map(id => id === 'implementation' ? historicalId : id));
  firstInput.evidence.find(e => e.kind === 'check').targetDigest = contentDigest(observeTarget(firstInput.target, f.cwd));
  const first = prior.prepareAudit({ ...f, input: firstInput }); const packet = JSON.parse(readFileSync(join(first.directory, 'packet.json'), 'utf8'));
  const finding = { id: 'F1', requirementIds: ['O1'], evidence: [{ evidenceId: historicalId, startLine: 1, endLine: 1,
    quote: 'export const combine = (a, b) => a - b;' }], explanation: 'The candidate subtracts the right operand.', recommendedAction: 'Return the sum.' };
  const result = completeResult(packet); result.outcome = 'CORRECT-COURSE'; result.findings = [finding];
  result.coverage.forEach(row => { row.status = 'gap'; row.explanation = 'The candidate subtracts instead of adding.'; });
  validateModelResult(result, packet);
  assert.equal(appendDirectionRecord({ cwd: f.cwd, request: JSON.parse(readFileSync(join(first.directory, 'reserve-request.json'), 'utf8')) }).status, 'published');
  const exchange = await prior.recordExchange({ ...f, auditId: firstInput.auditId, env: { DEEPSEEK_API_KEY: 'fixture-key' },
    fetchImpl: async () => new Response(JSON.stringify({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] })) });
  assert.equal(appendDirectionRecord({ cwd: f.cwd, request: prior.terminalRequest({ ...f, auditId: firstInput.auditId, operationId: 'prior-terminal' }) }).status, 'published');
  const input = structuredClone(f.input); input.auditId = 'corrected-audit';
  input.target = commit('export const combine = (a, b) => a + b;\n');
  input.evidence.find(e => e.kind === 'check').targetDigest = contentDigest(observeTarget(input.target, f.cwd));
  input.history = { audits: [{ auditId: firstInput.auditId, packet: first.packet, result: exchange.result }],
    findings: [{ auditId: firstInput.auditId, finding }], dispositions: [{ auditId: firstInput.auditId, findingId: finding.id,
      disposition: 'fixed', reason: 'The corrected candidate adds the operands.', evidence: [input.evidence.find(e => e.kind === 'check').reference] }] };
  return { ...f, input, first, priorPacket: packet, priorResult: result, finding, commit };
}

for (const oldProfile of [false, true]) test(`R111-1 correction and contested continuation preserve original findings (${oldProfile ? 'retained old profile' : 'same profile'})`, async t => {
  const f = await historicalFixture(t, { oldProfile });
  const originalBytes = readFileSync(join(f.first.directory, 'result.json'));
  if (oldProfile) assert.notEqual(f.priorPacket.profileDigest, profileFingerprint().digest);
  for (const round of [1, 2]) {
    if (round === 2) {
      f.input.auditId = 'contested-audit'; f.input.target = f.commit('export const combine = (left, right) => left + right;\n');
      f.input.evidence.find(e => e.kind === 'check').targetDigest = contentDigest(observeTarget(f.input.target, f.cwd));
      f.input.history.dispositions[0] = { ...f.input.history.dispositions[0], disposition: 'contested', reason: 'Retained evidence requires reconsidering the closure.' };
    }
    const prepared = prepareAudit({ ...f, input: f.input }); const packet = JSON.parse(readFileSync(join(prepared.directory, 'packet.json'), 'utf8'));
    const bytes = Buffer.byteLength(readFileSync(join(prepared.directory, 'request.json')));
    t.diagnostic(`retained mock history: oldProfile=${oldProfile}, round=${round}, requestBytes=${bytes}, cap=16384`);
    assert.ok(bytes <= 16384);
    assert.deepEqual(packet.history.findings[0].finding, f.finding);
    assert.equal(packet.history.audits[0].targetDigest, f.priorPacket.targetDigest);
    assert.equal(packet.history.audits[0].baselineDigest, f.priorPacket.baselineDigest);
    assert.equal(Object.hasOwn(packet.history.audits[0], 'history'), false);
    assert.equal(packet.history.audits[0].evidence.find(e => e.kind === 'artifact').content, 'export const combine = (a, b) => a - b;\n');
    assert.equal(appendDirectionRecord({ cwd: f.cwd, request: JSON.parse(readFileSync(join(prepared.directory, 'reserve-request.json'), 'utf8')) }).status, 'published');
    const payload = completeResult(packet); if (round === 2) payload.outcome = 'NEEDS-DECISION';
    const where = { ...f, auditId: f.input.auditId };
    await recordExchange({ ...where, env: { DEEPSEEK_API_KEY: 'fixture-key' }, fetchImpl: async () => new Response(JSON.stringify({
      model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] })) });
    assert.equal(appendDirectionRecord({ cwd: f.cwd, request: terminalRequest({ ...where, operationId: `${f.input.auditId}-terminal` }) }).status, 'published');
    const checked = checkAudit({ ...where, stage: 'result' }); assert.equal(checked.protocolValid, true); assert.equal(checked.outcome, payload.outcome);
    assert.deepEqual(packet.history.dispositions, f.input.history.dispositions);
  }
  assert.deepEqual(readFileSync(join(f.first.directory, 'result.json')), originalBytes);
  assert.equal(readDirectionState(f).accounting.charged, 3);
});

for (const change of ['packet-reference', 'result-reference', 'quote', 'finding', 'snapshot', 'binding']) {
  test(`R111-1 refuses tampered historical ${change}`, async t => {
    const f = await historicalFixture(t);
    if (change === 'packet-reference') f.input.history.audits[0].packet.digest = 'a'.repeat(64);
    if (change === 'result-reference') f.input.history.audits[0].result.path = 'unrelated-result.json';
    if (change === 'quote') f.input.history.findings[0].finding.evidence[0].quote = 'export const combine = (a, b) => a + b;';
    if (change === 'finding') f.input.history.findings[0].finding.explanation = 'A rewritten finding.';
    if (change === 'snapshot') writeFileSync(join(f.run, f.priorPacket.evidence.find(e => e.kind === 'artifact').reference.path), 'Changed old snapshot.\n');
    if (change === 'binding') {
      const result = JSON.parse(readFileSync(join(f.first.directory, 'result.json'), 'utf8')); result.payload.targetDigest = 'b'.repeat(64);
      writeFileSync(join(f.first.directory, 'result.json'), canonicalBytes(result));
    }
    assert.throws(() => prepareAudit({ ...f, input: f.input }));
    const state = readDirectionState(f);
    if (change === 'binding') assert.notEqual(state.status, 'valid'); else assert.equal(state.accounting.charged, 1);
  });
}

test('R111-1 historical evidence cannot satisfy current coverage', async t => {
  const f = await historicalFixture(t, { historicalId: 'historical-implementation' }); const prepared = prepareAudit({ ...f, input: f.input });
  const packet = JSON.parse(readFileSync(join(prepared.directory, 'packet.json'), 'utf8')); const result = completeResult(packet);
  result.coverage[0].artifacts = [f.finding.evidence[0]];
  assert.throws(() => validateModelResult(result, packet), /unknown_evidence/);
});

test('R111-1 retained disposition proof must remain unchanged at current use', async t => {
  const f = await historicalFixture(t);
  const content = 'The corrected candidate adds the operands.\n';
  const reference = { path: 'disposition-proof.txt', digest: digestBytes(content) };
  writeFileSync(join(f.run, reference.path), content); f.input.history.dispositions[0].evidence = [reference];
  const prepared = prepareAudit({ ...f, input: f.input });
  assert.equal(appendDirectionRecord({ cwd: f.cwd, request: JSON.parse(readFileSync(join(prepared.directory, 'reserve-request.json'), 'utf8')) }).status, 'published');
  const where = { ...f, auditId: f.input.auditId, stage: 'pre-dispatch' };
  assert.equal(checkAudit(where).current, true);
  writeFileSync(join(f.run, reference.path), 'A changed disposition claim.\n');
  const checked = checkAudit(where); assert.equal(checked.current, false); assert.equal(checked.directionSatisfied, false);
  assert.ok(checked.reasons.includes('evidence_digest'));
});

test('R111-1 every current use reconstructs rather than trusts an altered historical projection', async t => {
  const f = await historicalFixture(t); const prepared = prepareAudit({ ...f, input: f.input });
  const packet = JSON.parse(readFileSync(join(prepared.directory, 'packet.json'), 'utf8'));
  packet.history.audits[0].baseline.outcomes[0].text = 'A substituted historical paraphrase.';
  packet.history.audits[0].baselineDigest = contentDigest(packet.history.audits[0].baseline);
  validatePacket(packet);
  const request = JSON.stringify(requestBody(packet));
  const metadata = JSON.parse(readFileSync(join(prepared.directory, 'preparation.json'), 'utf8'));
  metadata.packetDigest = contentDigest(packet); metadata.requestDigest = digestBytes(request);
  writeFileSync(join(prepared.directory, 'packet.json'), canonicalBytes(packet)); writeFileSync(join(prepared.directory, 'request.json'), request);
  writeFileSync(join(prepared.directory, 'preparation.json'), canonicalBytes(metadata));
  for (const stage of ['pre-dispatch', 'result', 'endpoint']) {
    const checked = checkAudit({ ...f, auditId: f.input.auditId, stage, endpointId: packet.endpoint.id });
    assert.equal(checked.directionSatisfied, false); assert.deepEqual(checked.reasons, ['history_projection_mismatch']);
  }
});


test('Q111-1 source singleton arrays fail strict extraction without coercion', t => {
  const f = prepared(t); const good = completeResult(f.packet); validateModelResult(good, f.packet);
  assert.deepEqual(extractModelResult(JSON.stringify(good), f.packet), good);
  const bad = structuredClone(good); bad.coverage.forEach(row => { row.source = [row.source]; });
  assert.throws(() => extractModelResult(JSON.stringify(bad), f.packet), /invalid_schema/);
});


test('issue113 escape-heavy UTF-8 packets retain full source through bounded wire serialization',t=>{
  const f=prepared(t),packet=structuredClone(f.packet);
  packet.nextAction=('Retain "quoted" text, a backslash \\ and café.\n').repeat(1300);
  validatePacket(packet);
  const raw=canonicalBytes(packet),request=JSON.stringify(requestBody(packet));
  assert.ok(Buffer.byteLength(request)>16384);
  assert.ok(Buffer.byteLength(request)<=AUDIT_LIMITS.requestBytes);
  assert.ok(Buffer.byteLength(request)<=202259);
  assert.deepEqual(JSON.parse(JSON.parse(request).messages[1].content).packet,packet);
  assert.ok(Buffer.byteLength(raw)<=STATE_LIMITS.recordBytes);
});

test('issue113 oversized complete packet refuses before publication or reservation',t=>{
  const f=fixture(t);f.input.nextAction='Preserve original source evidence and the scoped endpoint. '.repeat(Math.ceil(AUDIT_LIMITS.packetBytes/57)+1);
  assert.throws(()=>prepareAudit({...f,input:f.input}),/packet_limit/);
  assert.equal(readDirectionState(f).accounting.charged,0);
  assert.equal(existsSync(join(f.cwd,'.afk/runs',f.runId,'issues',f.issueId,'audits',f.input.auditId)),false);
});


test('issue113 transport carries the near-limit complete packet and refuses an oversized packet before fetch',async t=>{
  const f=prepared(t),packet=structuredClone(f.packet),phrase='A "quoted" café instruction with a backslash \\ .\n';
  let low=1,high=AUDIT_LIMITS.packetBytes;
  while(low<high){const n=Math.ceil((low+high)/2);packet.nextAction=phrase.repeat(n);
    if(Buffer.byteLength(canonicalBytes(packet))<=AUDIT_LIMITS.packetBytes)low=n;else high=n-1;}
  packet.nextAction=phrase.repeat(low);validatePacket(packet);
  const request=JSON.stringify(requestBody(packet));assert.ok(Buffer.byteLength(request)>16384);
  assert.ok(Buffer.byteLength(request)<=AUDIT_LIMITS.requestBytes);let calls=0;
  const result=await fixedExchange({packet,request,env:{DEEPSEEK_API_KEY:'fixture-key'},fetchImpl:async(url,options)=>{
    calls++;assert.equal(options.body,request);
    return new Response(JSON.stringify({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:JSON.stringify(completeResult(packet))}}],usage:{prompt_tokens:1,completion_tokens:1}}));
  }});
  assert.equal(result.observation.classification,'completed');assert.equal(calls,1);
  packet.nextAction+=phrase;
  await assert.rejects(fixedExchange({packet,request:JSON.stringify(requestBody(packet)),env:{DEEPSEEK_API_KEY:'fixture-key'},fetchImpl:async()=>{calls++;}}),/packet_limit/);
  assert.equal(calls,1);
});


test('numbered current evidence preserves blank lines and exact quote spans', t => {
  const f = prepared(t);
  const body = JSON.parse(requestBody(f.packet).messages[1].content);
  assert.deepEqual(body.packet, f.packet);
  assert.equal(body.evidenceLines.length, f.packet.evidence.length);
  for (const evidence of f.packet.evidence) {
    const indexed = body.evidenceLines.find(row => row.evidenceId === evidence.id);
    assert.deepEqual(indexed.lines, evidence.content.split('\n').map((text, i) => ({ line: i + 1, text })));
    assert.equal(indexed.lines.map(row => row.text).join('\n'), evidence.content);
  }
});

test('a multiline anchor starts on its first projection line; the retained brace-offset shape stays refused', t => {
  const f = fixture(t, '{\n  "phase": "new-evidence",\n  "decision": {\n    "ready": false\n  },\n  "model": null\n}\n');
  const p = prepareAudit({ ...f, input: f.input }); assert.equal(p.status, 'prepared');
  const packet = JSON.parse(readFileSync(join(p.directory, 'packet.json'), 'utf8'));
  const artifact = packet.evidence.find(x => x.kind === 'artifact'); const lines = artifact.content.split('\n');
  const good = completeResult(packet); validateModelResult(good, packet);
  const withArtifact = (startLine, endLine, quote) => {
    const result = structuredClone(good); result.coverage[0].artifacts = [{ evidenceId: artifact.id, startLine, endLine, quote }]; return result;
  };
  validateModelResult(withArtifact(2, 5, lines.slice(1, 5).join('\n')), packet);
  validateModelResult(withArtifact(2, 2, lines[1]), packet);
  // The retained live failure: the quote began with the enclosing brace on the line before startLine.
  assert.throws(() => validateModelResult(withArtifact(2, 5, lines.slice(0, 5).join('\n')), packet), /evidence_quote/);
  assert.throws(() => validateModelResult(withArtifact(1, 4, lines.slice(1, 5).join('\n')), packet), /evidence_quote/);
  assert.match(SYSTEM, /startLine equal to endLine/);
  assert.match(SYSTEM, /enclosing brace on the line before startLine/);
  assert.match(SYSTEM, /verbatim contiguous excerpt of at least 24 characters/);
  assert.match(SYSTEM, /typed packet.history fields are not anchors/);
  assert.match(SYSTEM, /CORRECT-COURSE requires at least one finding/);
  const inconsistent = structuredClone(good); inconsistent.outcome = 'CORRECT-COURSE';
  assert.throws(() => validateModelResult(inconsistent, packet), /outcome_findings/);
  // A short prefix does not demonstrate reading the line; a multiline span must stay whole.
  assert.throws(() => validateModelResult(withArtifact(2, 2, lines[1].slice(0, 8)), packet), /evidence_quote/);
  assert.throws(() => validateModelResult(withArtifact(2, 5, lines.slice(1, 5).join('\n').slice(0, 40)), packet), /evidence_quote/);
});

test('a single-line anchor accepts a verbatim excerpt of a long line and refuses altered or foreign text', t => {
  const long = 'Self-review: spec and correctness meet A1-A6; zero now takes the successful path; consumers enumerated by repository search; no API signature changes, supporting edits or new tests are necessary.';
  const f = fixture(t, `export const combine = (a, b) => a + b;\n// ${long}\n// short\n`);
  const p = prepareAudit({ ...f, input: f.input }); assert.equal(p.status, 'prepared');
  const packet = JSON.parse(readFileSync(join(p.directory, 'packet.json'), 'utf8'));
  const artifact = packet.evidence.find(x => x.kind === 'artifact'); const lines = artifact.content.split('\n');
  const good = completeResult(packet);
  const withArtifact = (startLine, endLine, quote) => {
    const result = structuredClone(good); result.coverage[0].artifacts = [{ evidenceId: artifact.id, startLine, endLine, quote }]; return result;
  };
  validateModelResult(withArtifact(2, 2, lines[1]), packet);
  validateModelResult(withArtifact(2, 2, 'consumers enumerated by repository search'), packet);
  validateModelResult(withArtifact(3, 3, '// short'), packet);
  assert.throws(() => validateModelResult(withArtifact(3, 3, 'short'), packet), /evidence_quote/);
  assert.throws(() => validateModelResult(withArtifact(1, 1, 'consumers enumerated by repository search'), packet), /evidence_quote/);
  assert.throws(() => validateModelResult(withArtifact(2, 2, 'consumers enumerated by repository search...'), packet), /evidence_quote/);
  assert.throws(() => validateModelResult(withArtifact(2, 2, 'consumers enumerated by search'), packet), /evidence_quote/);
  assert.throws(() => validateModelResult(withArtifact(1, 2, 'export const combine = (a, b) => a + b;\n// Self-review: spec'), packet), /evidence_quote/);
});

test('history prepared under earlier request settings remains readable without allowing legacy current dispatch', async t => {
  const f = await historicalFixture(t, { legacySettings: true });
  const where = { ...f, auditId: 'prior-audit' };
  const requestPath = join(f.first.directory, 'request.json');
  const originalRequest = readFileSync(requestPath);
  assert.equal(Object.hasOwn(JSON.parse(originalRequest), 'temperature'), false);
  loadPrepared(where, { historical: true });
  assert.throws(() => loadPrepared(where), /request_mismatch|prepared_binding/);
  const next = prepareAudit({ ...f, input: f.input });
  const packet = JSON.parse(readFileSync(join(next.directory, 'packet.json')));
  assert.deepEqual(packet.history.findings[0].finding, f.finding);
  assert.deepEqual(readFileSync(requestPath), originalRequest);
  const altered = JSON.parse(originalRequest); altered.temperature = 1;
  writeFileSync(requestPath, JSON.stringify(altered));
  assert.throws(() => loadPrepared(where, { historical: true }), /request_mismatch/);
});

test('legacy request history remains readable without allowing legacy current dispatch or tampering', async t => {
  const f = await historicalFixture(t, { legacyRequest: true });
  const where = { ...f, auditId: 'prior-audit' };
  const requestPath = join(f.first.directory, 'request.json');
  const originalRequest = readFileSync(requestPath);
  const originalResult = readFileSync(join(f.first.directory, 'result.json'));
  assert.equal(Object.hasOwn(JSON.parse(JSON.parse(originalRequest).messages[1].content), 'evidenceLines'), false);
  loadPrepared(where, { historical: true });
  assert.throws(() => loadPrepared(where), /request_mismatch|prepared_binding/);
  const next = prepareAudit({ ...f, input: f.input });
  const packet = JSON.parse(readFileSync(join(next.directory, 'packet.json')));
  assert.deepEqual(packet.history.findings[0].finding, f.finding);
  assert.deepEqual(readFileSync(requestPath), originalRequest);
  assert.deepEqual(readFileSync(join(f.first.directory, 'result.json')), originalResult);
  const altered = JSON.parse(originalRequest); altered.messages[1].content += ' ';
  writeFileSync(requestPath, JSON.stringify(altered));
  assert.throws(() => loadPrepared(where, { historical: true }), /request_mismatch/);
});

test('complete audit history above ordinary evidence size survives reservation and replay', async t => {
  const f = await historicalFixture(t);
  const context = 'Retained original check and finding evidence.\n'.repeat(1200);
  for (const suffix of ['left', 'right']) {
    const path = `context-${suffix}.txt`;
    writeFileSync(join(f.cwd, path), context);
    f.input.evidence.push({ id: `context-${suffix}`, kind: 'artifact', path });
    for (const coverage of f.input.coverage) coverage.evidenceIds.push(`context-${suffix}`);
  }
  execFileSync('git', ['add', 'context-left.txt', 'context-right.txt'], { cwd: f.cwd });
  execFileSync('git', ['commit', '-qm', 'Retain complete context'], { cwd: f.cwd });
  f.input.target = { kind: 'commit', commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.cwd, encoding: 'utf8' }).trim() };
  f.input.evidence.find(e => e.kind === 'check').targetDigest = contentDigest(observeTarget(f.input.target, f.cwd));
  const prepared = prepareAudit({ ...f, input: f.input });
  const where = { ...f, auditId: f.input.auditId };
  const retained = loadPrepared(where), packet = retained.packet;
  assert.ok(Buffer.byteLength(canonicalBytes(packet)) > STATE_LIMITS.evidenceBytes);
  assert.equal(packet.evidence.find(e => e.id === 'context-left').content, context);
  assert.equal(appendDirectionRecord({ cwd: f.cwd, request: JSON.parse(readFileSync(join(prepared.directory, 'reserve-request.json'))) }).status, 'published');
  const payload = completeResult(packet);
  const finding = { id: 'RETAIN-CHECK', requirementIds: ['A1'], evidence: [payload.coverage[1].source],
    explanation: 'Controlled unresolved verification question.', recommendedAction: 'Retain the original check evidence.' };
  payload.outcome = 'CORRECT-COURSE'; payload.findings = [finding];
  const exchanged = await recordExchange({ ...where, env: { DEEPSEEK_API_KEY: 'fixture-key' }, fetchImpl: async () => new Response(JSON.stringify({
    model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] })) });
  assert.equal(appendDirectionRecord({ cwd: f.cwd, request: terminalRequest({ ...where, operationId: 'large-terminal' }) }).status, 'published');
  assert.equal(readDirectionState(f).status, 'valid');
  assert.equal(readDirectionState(f).accounting.charged, 2);
  assert.equal(checkAudit({ ...where, stage: 'result' }).protocolValid, true);
  const next = structuredClone(f.input); next.auditId = 'large-history';
  next.history.audits.push({ auditId: f.input.auditId, packet: prepared.packet, result: exchanged.result });
  next.history.findings.push({ auditId: f.input.auditId, finding });
  next.history.dispositions.push({ auditId: f.input.auditId, findingId: finding.id, disposition: 'open', reason: 'Retain the controlled question.', evidence: [] });
  const later = prepareAudit({ ...f, input: next });
  assert.equal(loadPrepared({ ...f, auditId: next.auditId }).packet.history.audits.length, 2);
  assert.ok(Buffer.byteLength(readFileSync(join(later.directory, 'request.json'))) > 262144);
  writeFileSync(join(f.cwd, 'context-left.txt'), 'Evidence. '.repeat(STATE_LIMITS.evidenceBytes));
  next.auditId = 'oversized-source'; next.target = { kind: 'uncommitted' };
  next.evidence.find(e => e.kind === 'check').targetDigest = contentDigest(observeTarget(next.target, f.cwd));
  assert.throws(() => prepareAudit({ ...f, input: next }), /file_limit/);
  assert.equal(readDirectionState(f).accounting.charged, 2);
});
