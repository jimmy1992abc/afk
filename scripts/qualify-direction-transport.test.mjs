import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, after } from 'node:test';
import { copyDirectionTestRuntime, spawnGate } from './gate-test-env.mjs';
import { canonicalBytes, digestBytes } from '../lib/gate/review-receipt.mjs';
import { contentDigest } from '../lib/direction/schema.mjs';

// Synthetic qualification must not depend on the repository's retained live profile.
const isolated=await copyDirectionTestRuntime({after},{qualification:'pending'});
const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
for(const path of ['scripts/qualify-direction-transport.mjs',...['setup.mjs','requirements.md','artifact.mjs','check.txt','expected.json'].map(name=>`scripts/fixtures/direction-transport/${name}`)]){
  mkdirSync(dirname(join(isolated.directory,path)),{recursive:true});copyFileSync(join(sourceRoot,path),join(isolated.directory,path));
}
const load=path=>import(pathToFileURL(join(isolated.directory,path)));
const {prepare,probe,budgetRequest,inspectPrepared,inspectQualification}=await load('scripts/qualify-direction-transport.mjs');
const {completeResult,FIXTURE_ROOT}=await load('scripts/fixtures/direction-transport/setup.mjs');
const {readDirectionState,appendDirectionRecord}=await load('lib/direction/state.mjs');
const {LIMITS,checkAudit,validateModelResult,terminalRequest,qualificationEvidence,readJson,validateQualification}=isolated.audit;
const {recordExchange,fixedExchange}=await load('lib/direction/transport.mjs');

function fixture(t, { budgetAmendmentPath, physicalCallId = 'physical-final-call' } = {}) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'afk-direction-final-'))); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const prepared = join(temp, 'prepared'); const metadata = prepare({ fixtureRoot: FIXTURE_ROOT, out: prepared, budgetAmendmentPath });
  const { input } = inspectPrepared(prepared); return { prepared, metadata, input, budget: budgetRequest(prepared, physicalCallId) };
}
function envelope(packet, mutate = () => {}) {
  const value = { model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(completeResult(packet)) } }] };
  mutate(value); return value;
}
const response = value => new Response(JSON.stringify(value), { status: 200 });
const env = { DEEPSEEK_API_KEY: 'fixture-key' };
async function success(f) {
  return probe({ prepared: f.prepared, budget: f.budget, env,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); assert.equal(body.messages.length, 2); assert.equal(Object.hasOwn(body, 'tools'), false);
      assert.equal(body.tool_choice, 'none'); assert.equal(body.thinking.type, 'disabled'); assert.equal(options.redirect, 'error');
      assert.equal(options.body, f.input.request); return response(envelope(f.input.packet));
    } });
}

test('final qualification traverses actual packet, wire, COMPLETE result and terminal with one physical-call cross-reference', async t => {
  const { audit } = await copyDirectionTestRuntime(t, { qualification: 'pending' });
  const f = fixture(t); assert.equal(readDirectionState(f.metadata).accounting.charged, 0);
  const observed = await success(f); assert.equal(observed.classification, 'CANDIDATE-PASS'); assert.equal(observed.requests, 1);
  assert.equal(observed.physicalCallId, f.budget.physicalCallId); assert.equal(observed.qualification, 'NOT_QUALIFIED_BY_HELPER');
  assert.equal(observed.actualInvocation, 'DRIVER_JUDGMENT_REQUIRED');
  assert.equal(readDirectionState(f.metadata).accounting.charged, 1); assert.equal(readDirectionState(f.metadata).accounting.reserved, 0);
  assert.equal(inspectQualification(f.prepared).status, 'ARTIFACT_CANDIDATE_PASS');
  const checked = audit.checkAudit({ ...f.metadata, stage: 'endpoint', endpointId: f.input.packet.endpoint.id });
  assert.equal(checked.protocolValid, true); assert.equal(checked.outcome, 'COMPLETE'); assert.equal(checked.directionSatisfied, false);
  assert.deepEqual(checked.reasons, ['qualification_pending']);
  await assert.rejects(probe({ prepared: f.prepared, budget: f.budget, env, fetchImpl: async () => assert.fail('repeat dispatch') }));
});

for (const kind of ['outcome', 'findings', 'coverage', 'malformed']) {
  test(`D111-1 ${kind} substitution rejected at result, endpoint and qualification consumers`, async t => {
    const f = fixture(t); await success(f);
    const original = readJson(f.input.directory, 'result.json'); const wire = readJson(f.input.directory, 'response.json');
    const terminalPath = join(f.metadata.cwd, '.afk', 'runs', f.metadata.runId,
      readDirectionState(f.metadata).attempts[0].terminal.path);
    const terminalRecord = JSON.parse(readFileSync(terminalPath, 'utf8'));
    const payload = completeResult(f.input.packet); const retained = structuredClone(payload);
    if (kind === 'outcome') retained.outcome = 'NEEDS-DECISION';
    if (kind === 'findings') { retained.outcome = 'CORRECT-COURSE'; retained.findings = [{ id: 'F1', requirementIds: ['O1'],
      evidence: [payload.coverage[0].source], explanation: 'A correction is needed.', recommendedAction: 'Recheck source coverage.' }]; }
    if (kind === 'coverage') retained.coverage[0].explanation = 'Another valid explanation.';
    validateModelResult(payload, f.input.packet); if (kind !== 'malformed') validateModelResult(retained, f.input.packet);
    wire.envelope.choices[0].message.content = kind === 'malformed' ? '{' : canonicalBytes(retained);
    original.observation.response.digest = contentDigest(wire);
    writeFileSync(join(f.input.directory, 'response.json'), canonicalBytes(wire));
    writeFileSync(join(f.input.directory, 'result.json'), canonicalBytes(original));
    terminalRecord.payload.terminal.result.digest = contentDigest(original);
    writeFileSync(terminalPath, canonicalBytes(terminalRecord));
    assert.equal(readDirectionState(f.metadata).status, 'valid');
    for (const stage of ['result', 'endpoint']) {
      const checked = checkAudit({ ...f.metadata, stage, endpointId: f.input.packet.endpoint.id });
      assert.equal(checked.protocolValid, false); assert.equal(checked.outcome, null); assert.equal(checked.directionSatisfied, false);
      assert.equal(checked.status, 'invalid'); assert.match(checked.reasons[0], /response_payload_mismatch|invalid_result_json/);
    }
    assert.throws(() => qualificationEvidence(f.metadata), /response_payload_mismatch|invalid_result_json/);
    assert.throws(() => inspectQualification(f.prepared), /response_payload_mismatch|invalid_result_json/);
  });
}

for (const [name, mutate, reason] of [
  ['identity', x => x.model = 'different', 'identity_mismatch'],
  ['missing identity', x => delete x.model, 'identity_mismatch'],
  ['length', x => x.choices[0].finish_reason = 'length', 'incomplete_finish'],
  ['tools', x => x.choices[0].message.tool_calls = [], 'unexpected_tool_call'],
  ['function', x => x.choices[0].message.function_call = {}, 'unexpected_tool_call'],
  ['delta function', x => x.choices[0].delta = { function_call: { name: 'unexpected', arguments: '{}' } }, 'unexpected_tool_call'],
  ['delta tools', x => x.choices[0].delta = { tool_calls: [] }, 'unexpected_tool_call'],
  ['extra choice', x => x.choices.push(x.choices[0]), 'invalid_choices'],
  ['empty', x => x.choices[0].message.content = '', 'empty'],
  ['malformed', x => x.choices[0].message.content = '{', 'invalid_result_json'],
  ['binding', x => { const p = JSON.parse(x.choices[0].message.content); p.targetDigest = 'a'.repeat(64); x.choices[0].message.content = JSON.stringify(p); }, 'result_binding'],
]) {
  test(`fixed exchange retains ${name} refusal and no semantic approval`, async t => {
    const f = fixture(t); const observed = await fixedExchange({ packet: f.input.packet, request: f.input.request, env,
      fetchImpl: async () => response(envelope(f.input.packet, mutate)) });
    assert.equal(observed.observation.reason, reason); assert.equal(observed.payload, null); assert.equal(observed.response.extraction, 'invalid');
    if (['tools', 'function', 'delta function', 'delta tools'].includes(name)) assert.equal(observed.observation.toolCallsPresent, true);
    assert.equal(observed.observation.usage.input, null);
  });
}

for (const name of ['dispatch.json', 'response.json', 'result.json', 'terminal-witness.txt']) {
  test(`every future output conflict (${name}) refuses before fetch and preserves bytes`, async t => {
    const f = fixture(t); writeFileSync(join(f.input.directory, name), 'original'); let calls = 0;
    await assert.rejects(probe({ prepared: f.prepared, budget: f.budget, env, fetchImpl: async () => { calls++; } }));
    assert.equal(calls, 0); assert.equal(readFileSync(join(f.input.directory, name), 'utf8'), 'original');
    assert.equal(readDirectionState(f.metadata).accounting.charged, 0);
  });
}

test('exclusive record arbitration allows one mocked dispatch from the same charged reservation', async t => {
  const f = fixture(t); const request = readJson(f.input.directory, 'reserve-request.json');
  assert.equal(appendDirectionRecord({ cwd: f.metadata.cwd, request }).status, 'published'); let calls = 0;
  const options = { ...f.metadata, env, fetchImpl: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return response(envelope(f.input.packet)); } };
  const settled = await Promise.allSettled([recordExchange(options), recordExchange(options)]);
  assert.equal(calls, 1); assert.equal(settled.filter(x => x.status === 'fulfilled').length, 1);
});

test('a stalled response body is cancelled by the bounded HTTP abort', async t => {
  const f = fixture(t); let cancelled = false;
  const observed = await fixedExchange({ packet: f.input.packet, request: f.input.request, env, httpTimeoutMs: 20,
    fetchImpl: async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } })) });
  assert.equal(observed.observation.classification, 'timeout'); assert.equal(cancelled, true); assert.equal(observed.payload, null);
});

test('response overflow is cancelled before parsing and never truncated into approval', async t => {
  const f = fixture(t); let cancelled = false;
  const observed = await fixedExchange({ packet: f.input.packet, request: f.input.request, env,
    fetchImpl: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(LIMITS.responseBytes + 1)); }, cancel() { cancelled = true; } })) });
  assert.equal(observed.observation.reason, 'response_limit'); assert.equal(cancelled, true); assert.equal(observed.response, null);
});

test('injectable redirect assertion retains its local classification', async t => {
  const f = fixture(t);
  const observed = await fixedExchange({ packet: f.input.packet, request: f.input.request, env,
    fetchImpl: async () => ({ status: 200, ok: true, redirected: true, url: 'https://other.invalid' }) });
  assert.equal(observed.observation.reason, 'unexpected_redirect'); assert.equal(observed.observation.classification, 'invalid');
});

test('missing credentials records a strict witness and consumed unavailable attempt without fetch', async t => {
  const f = fixture(t); let calls = 0;
  const result = await probe({ prepared: f.prepared, budget: f.budget, env: {}, fetchImpl: async () => { calls++; } });
  assert.equal(calls, 0); assert.equal(result.classification, 'INVALID');
  const state = readDirectionState(f.metadata); assert.equal(state.accounting.charged, 1);
  assert.equal(state.attempts[0].terminal.value.kind, 'unavailable'); assert.equal(state.attempts[0].terminal.value.result, null);
  const witness = readFileSync(join(f.input.directory, 'terminal-witness.txt'), 'utf8');
  assert.doesNotMatch(witness, /[a-f0-9]{64}/); assert.match(witness, /dispatch: not-started/);
});

test('qualification budget cannot reset prior consumption or claim a third slot', async t => {
  const f = fixture(t); let calls = 0;
  for (const mutation of [{ priorCalls: 0 }, { attemptOrdinal: 3 }, { priorElapsedMs: 0 }, { remainingMs: 300000 }]) {
    await assert.rejects(probe({ prepared: f.prepared, budget: { ...f.budget, ...mutation }, env, fetchImpl: async () => { calls++; } }), /qualification_budget/);
  }
  assert.equal(calls, 0);
});

test('terminal request remains independently repeatable without another dispatch', async t => {
  const f = fixture(t); const request = readJson(f.input.directory, 'reserve-request.json'); appendDirectionRecord({ cwd: f.metadata.cwd, request });
  await recordExchange({ ...f.metadata, env, fetchImpl: async () => response(envelope(f.input.packet)) });
  const a = terminalRequest({ ...f.metadata, operationId: 'terminal-first' });
  const b = terminalRequest({ ...f.metadata, operationId: 'terminal-rebuilt' });
  assert.deepEqual(a.payload, b.payload); assert.equal(readDirectionState(f.metadata).accounting.charged, 1);
});

test('S111-2 unknown accounting after reservation refuses dispatch but retains completed observations and terminals', async t => {
  const { audit } = await copyDirectionTestRuntime(t, { qualification: 'pending' });
  const f = fixture(t); const request = readJson(f.input.directory, 'reserve-request.json');
  assert.equal(appendDirectionRecord({ cwd: f.metadata.cwd, request }).status, 'published');
  const reserveState = readDirectionState(f.metadata);
  assert.equal(reserveState.accounting.remaining, 0);
  const accountingRequest = (knowledge, operationId) => ({ version: 1, runId: f.metadata.runId, issueId: f.metadata.issueId, operationId,
    expectedHead: readDirectionState(f.metadata).head, operation: 'reconcile', payload: { accounting: { knowledge, priorAttempts: [],
      reason: 'Retained accounting evidence changed.', evidence: [f.input.packet.baseline.sources[0].evidence] } } });
  assert.equal(appendDirectionRecord({ cwd: f.metadata.cwd, request: accountingRequest('unknown', 'unknown-before') }).status, 'published');
  let calls = 0;
  await assert.rejects(recordExchange({ ...f.metadata, env, fetchImpl: async () => { calls++; } }), /accounting_unknown/);
  assert.equal(calls, 0);
  const before = audit.checkAudit({ ...f.metadata, stage: 'pre-dispatch' }); assert.equal(before.status, 'unavailable');
  assert.deepEqual(before.reasons, ['accounting_unknown']);
  assert.equal(appendDirectionRecord({ cwd: f.metadata.cwd, request: accountingRequest('known', 'known-again') }).status, 'published');
  const completed = await recordExchange({ ...f.metadata, env, fetchImpl: async () => {
    calls++;
    assert.equal(appendDirectionRecord({ cwd: f.metadata.cwd, request: accountingRequest('unknown', 'unknown-during') }).status, 'published');
    return response(envelope(f.input.packet));
  } });
  assert.equal(calls, 1);
  assert.equal(completed.current, true);
  assert.equal(appendDirectionRecord({ cwd: f.metadata.cwd, request: terminalRequest({ ...f.metadata, operationId: 'terminal-after-unknown' }) }).status, 'published');
  for (const stage of ['result', 'endpoint']) {
    const checked = audit.checkAudit({ ...f.metadata, stage, endpointId: f.input.packet.endpoint.id });
    assert.equal(checked.protocolValid, true); assert.equal(checked.outcome, 'COMPLETE'); assert.equal(checked.current, true);
    assert.ok(checked.reasons.includes('accounting_unknown')); assert.ok(checked.reasons.includes('qualification_pending'));
  }
  assert.equal(readDirectionState(f.metadata).accounting.charged, 1);
});

test('matching artifact compatibility permits only the current endpoint and invalid proof fails closed', async t => {
  const f = fixture(t); await success(f); const evidence = qualificationEvidence(f.metadata);
  const record = { version: 1, status: 'qualified', profileDigest: evidence.profileDigest,
    proof: { profile: evidence.profile, request: evidence.request, response: evidence.response, result: evidence.result,
      review: { reportPath: 'report.md', reportDigest: digestBytes('Synthetic test proof, not an actual call.'),
        executionRevision: f.input.packet.target.currentHead, evidenceSetDigest: evidence.evidenceSetDigest } } };
  validateQualification(record);
  for (const mutate of [x => x.proof.profile.runtimeFiles.pop(), x => x.proof.request.messageRoles.push('user'),
    x => x.proof.request.toolsPresent = true, x => x.proof.response.envelope.model = 'other',
    x => x.proof.result.phase = 'initial', x => x.proof.result.outcome = 'ON-TRACK', x => x.proof.review.reportDigest = null]) {
    const invalid = structuredClone(record); mutate(invalid); assert.throws(() => validateQualification(invalid));
  }
  const { audit } = await copyDirectionTestRuntime(t, { qualification: record });
  const valid = audit.checkAudit({ ...f.metadata, stage: 'endpoint', endpointId: f.input.packet.endpoint.id });
  assert.equal(valid.directionSatisfied, true); assert.equal(valid.status, 'valid');
  assert.equal(audit.checkAudit({ ...f.metadata, stage: 'result' }).directionSatisfied, false);
  assert.equal(audit.checkAudit({ ...f.metadata, stage: 'endpoint', endpointId: 'different' }).directionSatisfied, false);
  const state = readDirectionState(f.metadata);
  assert.equal(appendDirectionRecord({ cwd: f.metadata.cwd, request: { version: 1, runId: f.metadata.runId, issueId: f.metadata.issueId,
    operationId: 'accounting-unknown', expectedHead: state.head, operation: 'reconcile', payload: { accounting: {
      knowledge: 'unknown', priorAttempts: [], reason: 'Retained history needs reconciliation.', evidence: [f.input.packet.baseline.sources[0].evidence] } } } }).status, 'published');
  const stillObserved = audit.checkAudit({ ...f.metadata, stage: 'endpoint', endpointId: f.input.packet.endpoint.id });
  assert.equal(stillObserved.directionSatisfied, true); assert.equal(stillObserved.protocolValid, true);
  assert.equal(stillObserved.outcome, 'COMPLETE'); assert.ok(stillObserved.reasons.includes('accounting_unknown'));
  writeFileSync(join(f.metadata.cwd, 'artifact.mjs'), 'Changed candidate.\n');
  assert.equal(audit.checkAudit({ ...f.metadata, stage: 'endpoint', endpointId: f.input.packet.endpoint.id }).status, 'stale');
});

test('failed extraction cannot support a separately valid payload', async t => {
  const f = fixture(t); await success(f); const value = readJson(f.input.directory, 'result.json');
  const wire = readJson(f.input.directory, 'response.json'); wire.extraction = 'invalid'; wire.envelope.choices[0].message.content = 'diagnostic';
  value.observation.response.digest = contentDigest(wire);
  const state = readDirectionState(f.metadata); const path = join(f.metadata.cwd, '.afk', 'runs', f.metadata.runId, state.attempts[0].terminal.path);
  const terminal = JSON.parse(readFileSync(path, 'utf8')); terminal.payload.terminal.result.digest = contentDigest(value);
  writeFileSync(join(f.input.directory, 'response.json'), canonicalBytes(wire)); writeFileSync(join(f.input.directory, 'result.json'), canonicalBytes(value));
  writeFileSync(path, canonicalBytes(terminal));
  for (const stage of ['result', 'endpoint']) assert.deepEqual(checkAudit({ ...f.metadata, stage, endpointId: f.input.packet.endpoint.id }).reasons, ['response_extraction_invalid']);
  assert.throws(() => inspectQualification(f.prepared), /response_extraction_invalid/);
});

test('S111-1 retained delta function evidence cannot pass result, endpoint or qualification acceptance', async t => {
  const f = fixture(t); await success(f);
  const result = readJson(f.input.directory, 'result.json'); const wire = readJson(f.input.directory, 'response.json');
  wire.envelope.choices[0].delta = { function_call: { name: 'unexpected', arguments: '{}' } };
  result.observation.toolCallsPresent = true; result.observation.response.digest = contentDigest(wire);
  const path = join(f.metadata.cwd, '.afk', 'runs', f.metadata.runId, readDirectionState(f.metadata).attempts[0].terminal.path);
  const terminal = JSON.parse(readFileSync(path, 'utf8')); terminal.payload.terminal.result.digest = contentDigest(result);
  writeFileSync(join(f.input.directory, 'response.json'), canonicalBytes(wire)); writeFileSync(join(f.input.directory, 'result.json'), canonicalBytes(result));
  writeFileSync(path, canonicalBytes(terminal));
  assert.equal(readDirectionState(f.metadata).status, 'valid');
  for (const stage of ['result', 'endpoint']) {
    const checked = checkAudit({ ...f.metadata, stage, endpointId: f.input.packet.endpoint.id });
    assert.equal(checked.directionSatisfied, false); assert.deepEqual(checked.reasons, ['transport_invalid']);
  }
  assert.throws(() => inspectQualification(f.prepared), /transport_invalid/);
});

function amendmentFixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'afk-budget-source-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sources = { 'authorization.txt': 'Synthetic authority allocates one additional attempt within the unchanged limits.\n',
    'history.txt': 'Synthetic retained accounting lists four attempted slots and two HTTP requests.\n' };
  for (const [path, bytes] of Object.entries(sources)) writeFileSync(join(directory, path), bytes);
  const reference = path => ({ path, digest: digestBytes(sources[path]) });
  const amendment = { version: 1, physicalCallId: 'amended-call', authorization: reference('authorization.txt'), history: reference('history.txt'),
    priorAttempts: 4, priorRequests: 2, priorElapsedMs: 2000, additionalAttempts: 1 };
  const path = join(directory, 'grant.json');
  const save = () => writeFileSync(path, canonicalBytes(amendment)); save();
  return { directory, path, amendment, save, options: { budgetAmendmentPath: path, physicalCallId: amendment.physicalCallId } };
}

test('Q111-1 singleton source arrays remain invalid through the actual qualifier and terminal', async t => {
  const f = fixture(t); const good = completeResult(f.input.packet); validateModelResult(good, f.input.packet);
  const bad = structuredClone(good); bad.coverage.forEach(row => { row.source = [row.source]; });
  assert.throws(() => validateModelResult(bad, f.input.packet), /invalid_schema/);
  const observed = await probe({ prepared: f.prepared, budget: f.budget, env,
    fetchImpl: async () => response(envelope(f.input.packet, x => { x.choices[0].message.content = JSON.stringify(bad); })) });
  assert.equal(observed.classification, 'INVALID'); assert.equal(observed.reason, 'invalid_schema'); assert.equal(observed.requests, 1);
  const result = readJson(f.input.directory, 'result.json'); const wire = readJson(f.input.directory, 'response.json');
  assert.equal(result.payload, null); assert.equal(result.observation.classification, 'invalid'); assert.equal(wire.extraction, 'invalid');
  assert.ok(JSON.parse(wire.envelope.choices[0].message.content).coverage.every(row => Array.isArray(row.source)));
  const state = readDirectionState(f.metadata); assert.equal(state.accounting.charged, 1); assert.equal(state.attempts[0].terminal.value.kind, 'malformed');
  assert.equal(checkAudit({ ...f.metadata, stage: 'endpoint', endpointId: f.input.packet.endpoint.id }).directionSatisfied, false);
  assert.throws(() => inspectQualification(f.prepared));
});

test('Q111-1 sourced amendment derives the real ordinal and preserves single dispatch', async t => {
  const grant = amendmentFixture(t); const f = fixture(t, grant.options);
  assert.equal(f.metadata.budget.priorCalls, 4); assert.equal(f.metadata.budget.priorRequests, 2);
  assert.equal(f.metadata.budget.remainingCalls, 1); assert.equal(f.budget.attemptOrdinal, 5);
  assert.equal(f.budget.remainingMs, LIMITS.totalMs - 2000); assert.equal(f.budget.processMs, LIMITS.processMs);
  assert.equal(f.budget.amendmentDigest, contentDigest(grant.amendment));
  assert.deepEqual(readJson(f.prepared, f.metadata.budgetAmendment.path), grant.amendment);
  rmSync(grant.directory, { recursive: true, force: true });
  assert.equal(inspectPrepared(f.prepared).metadata.budget.priorCalls, 4);
  const observed = await success(f); assert.equal(observed.classification, 'CANDIDATE-PASS'); assert.equal(observed.experimentAttempt, 5);
  assert.equal(observed.physicalCallId, 'amended-call'); assert.equal(observed.requests, 1);
  assert.equal(inspectQualification(f.prepared).status, 'ARTIFACT_CANDIDATE_PASS');
  const original = readFileSync(join(f.prepared, 'terminal.json')); let calls = 0;
  await assert.rejects(probe({ prepared: f.prepared, budget: f.budget, env, fetchImpl: async () => { calls++; } }));
  assert.equal(calls, 0); assert.deepEqual(readFileSync(join(f.prepared, 'terminal.json')), original);
});

test('Q111-1 an amended unavailable invocation consumes its slot without inventing HTTP', async t => {
  const grant = amendmentFixture(t); const f = fixture(t, grant.options);
  const observed = await probe({ prepared: f.prepared, budget: f.budget, env: {}, fetchImpl: async () => assert.fail('no credentials') });
  assert.equal(observed.experimentAttempt, 5); assert.equal(observed.requests, 0); assert.equal(observed.classification, 'INVALID');
  assert.equal(readDirectionState(f.metadata).accounting.charged, 1);
});

for (const [name, mutate] of [
  ['unknown attempts', x => x.priorAttempts = null], ['unknown time', x => x.priorElapsedMs = null],
  ['impossible requests', x => x.priorRequests = x.priorAttempts + 1], ['multiple added slots', x => x.additionalAttempts = 2],
  ['ordinal overflow', x => x.priorAttempts = Number.MAX_SAFE_INTEGER],
  ['exhausted time', x => x.priorElapsedMs = LIMITS.totalMs],
  ['insufficient positive time', x => x.priorElapsedMs = LIMITS.totalMs - LIMITS.processMs + 1],
  ['bad source digest', x => x.history.digest = 'a'.repeat(64)], ['outside source', x => x.history.path = '../outside.txt'],
]) {
  test(`Q111-1 amendment ${name} refuses before creating a fixture`, t => {
    const grant = amendmentFixture(t); mutate(grant.amendment); grant.save(); const out = join(grant.directory, 'prepared');
    assert.throws(() => prepare({ fixtureRoot: FIXTURE_ROOT, out, budgetAmendmentPath: grant.path })); assert.equal(existsSync(out), false);
  });
}

for (const kind of ['missing authority', 'missing history', 'empty', 'secret', 'binary', 'UTF-8', 'overflow', 'symlink']) {
  test(`Q111-1 amendment source ${kind} refuses before fixture publication`, t => {
    const grant = amendmentFixture(t); const source = join(grant.directory, 'history.txt');
    if (kind === 'missing authority') rmSync(join(grant.directory, 'authorization.txt'));
    else if (kind === 'missing history') rmSync(source);
    else if (kind === 'symlink') { rmSync(source); symlinkSync('authorization.txt', source); }
    else {
      const bytes = { empty: '', secret: 'a'.repeat(64), binary: Buffer.from([0]), 'UTF-8': Buffer.from([0xc3, 0x28]), overflow: 'x'.repeat(LIMITS.requestBytes + 1) }[kind];
      writeFileSync(source, bytes); grant.amendment.history.digest = digestBytes(bytes); grant.save();
    }
    const out = join(grant.directory, 'prepared');
    assert.throws(() => prepare({ fixtureRoot: FIXTURE_ROOT, out, budgetAmendmentPath: grant.path })); assert.equal(existsSync(out), false);
  });
}

for (const change of ['authority', 'history', 'amendment', 'metadata', 'insufficient time', 'profile', 'harness']) {
  test(`Q111-1 retained amendment ${change} tamper refuses before fetch`, async t => {
    const grant = amendmentFixture(t); const f = fixture(t, grant.options); let calls = 0;
    const metadata = readJson(f.prepared, 'prepared.json');
    const retained = join(f.prepared, 'budget-amendment');
    if (change === 'authority') writeFileSync(join(retained, 'authorization.txt'), 'Changed authority.\n');
    if (change === 'history') writeFileSync(join(retained, 'history.txt'), 'Changed history.\n');
    if (change === 'amendment' || change === 'insufficient time') {
      const value = readJson(f.prepared, metadata.budgetAmendment.path);
      if (change === 'amendment') value.priorAttempts = 0; else value.priorElapsedMs = LIMITS.totalMs - LIMITS.processMs + 1;
      writeFileSync(join(f.prepared, metadata.budgetAmendment.path), canonicalBytes(value));
      if (change === 'insufficient time') { metadata.budgetAmendment.digest = contentDigest(value); writeFileSync(join(f.prepared, 'prepared.json'), canonicalBytes(metadata)); }
    }
    if (change === 'metadata') metadata.budget.priorCalls = 0;
    if (change === 'profile') metadata.profileDigest = 'a'.repeat(64);
    if (change === 'harness') metadata.harnessDigest = 'a'.repeat(64);
    if (['metadata', 'profile', 'harness'].includes(change)) writeFileSync(join(f.prepared, 'prepared.json'), canonicalBytes(metadata));
    await assert.rejects(probe({ prepared: f.prepared, budget: f.budget, env, fetchImpl: async () => { calls++; } }));
    assert.equal(calls, 0); assert.equal(readDirectionState(f.metadata).accounting.charged, 0);
  });
}

test('Q111-1 amended budget binds physical id and exact prepared digest before fetch', async t => {
  const grant = amendmentFixture(t); const f = fixture(t, grant.options); let calls = 0;
  assert.throws(() => budgetRequest(f.prepared, 'different-call'), /qualification_budget/);
  for (const mutation of [{ physicalCallId: 'different-call' }, { preparedDigest: 'a'.repeat(64) }, { amendmentDigest: 'b'.repeat(64) }, { priorRequests: 0 }]) {
    await assert.rejects(probe({ prepared: f.prepared, budget: { ...f.budget, ...mutation }, env, fetchImpl: async () => { calls++; } }));
  }
  assert.equal(calls, 0); assert.equal(readDirectionState(f.metadata).accounting.charged, 0);
});

test('Q111-1 prepare CLI accepts the sourced amendment without a provider call', t => {
  const grant = amendmentFixture(t); const out = join(grant.directory, 'prepared');
  const cli = fileURLToPath(new URL('./qualify-direction-transport.mjs', import.meta.url));
  const result = spawnGate([cli, 'prepare', '--fixture-root', FIXTURE_ROOT, '--out', out, '--budget-amendment', grant.path],
    { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).budget.priorCalls, 4);
  assert.equal(readDirectionState(inspectPrepared(out).metadata).accounting.charged, 0);
});
