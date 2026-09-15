import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createReviewFixture } from '../../scripts/gate-test-env.mjs';
import { canonicalBytes, digestBytes, publishImmutable } from '../gate/review-receipt.mjs';
import { appendDirectionRecord, readDirectionState, resolveDirectionPolicy } from './state.mjs';
import { LIMITS } from './schema.mjs';

function fixture(t, { knowledge = 'known', limit = 4 } = {}) {
  const f = createReviewFixture(); t.after(f.cleanup); f.cwd = realpathSync(f.cwd);
  const run = join(f.cwd, '.afk', 'runs', 'test-run'); mkdirSync(run, { recursive: true });
  writeFileSync(join(f.cwd, '.git', 'info', 'exclude'), '.afk/\n');
  const ledger = 'run-id: test-run\nstate: active\nscope: 109\nheartbeat: 2026-01-01T00:00:00Z\n\n## Review\nconsumed: 1\n';
  writeFileSync(join(run, 'ledger.md'), ledger);
  const raw = 'Authorized direction scope.\nNo previous direction calls.\nPreserve behavior.\n';
  writeFileSync(join(run, 'source.md'), raw);
  const proof = { path: 'source.md', digest: digestBytes(raw) };
  const source = { id: 'request', kind: 'operator', origin: 'retained operator request', evidence: proof };
  const clause = id => ({ id, text: 'Preserve behavior.', sources: [{ sourceId: source.id, startLine: 3, endLine: 3 }] });
  const baseline = { version: 1, revision: 1, previousDigest: null,
    change: { kind: 'extraction', reason: 'Faithful extraction.', evidence: [], authorization: null },
    sources: [source], outcomes: [clause('O1')], acceptance: [clause('A1')], invariants: [], nonGoals: [],
    priorities: [], allowedChanges: [], publicationLimits: [], assumptions: [], facts: [] };
  const policy = { version: 1, revision: 1, previousDigest: null, mode: 'required', maxAuditAttempts: limit,
    sources: { mode: { kind: 'operator', source }, maxAuditAttempts: { kind: 'operator', source } }, amendment: null };
  const where = { cwd: f.cwd, runId: 'test-run', issueId: '109' };
  let operation = 0;
  const read = () => readDirectionState(where);
  const request = (op, payload, expectedHead = read().head || { sequence: 0, digest: null }) => ({ version: 1,
    runId: where.runId, issueId: where.issueId, operationId: `op-${++operation}`, expectedHead, operation: op, payload });
  const append = (op, payload) => appendDirectionRecord({ cwd: f.cwd, request: request(op, payload) });
  const init = () => append('initialize', { baseline, policy, authorization: source,
    accounting: { knowledge, priorAttempts: [], reason: 'Retained pre-initialization history.', evidence: [proof] } });
  const reservePayload = (id, phase = 'endpoint') => ({ attemptId: id, binding: { phase,
    baselineDigest: read().baselineDigest, policyDigest: read().policyDigest, targetDigest: 'a'.repeat(64), packet: proof } });
  const reserve = (id, phase) => append('reserve', reservePayload(id, phase));
  return { ...f, ...where, run, ledger, proof, source, baseline, policy, read, request, append, init, reserve, reservePayload,
    directory: join(run, 'issues', '109', 'direction') };
}

test('absent state is off without writes; initialization reserves no calls', t => {
  const f = fixture(t); assert.equal(f.read().status, 'off');
  assert.deepEqual(readdirSync(f.run).sort(), ['ledger.md', 'source.md']);
  assert.equal(f.init().status, 'published');
  assert.equal(f.read().accounting.charged, 0); assert.equal(f.read().canReserve, true);
  assert.equal(readFileSync(join(f.run, 'ledger.md'), 'utf8'), f.ledger);
});

test('four calls include missing terminals, retries and repairs without replenishment', t => {
  const f = fixture(t); f.init();
  for (const [id, phase] of [['initial', 'initial'], ['endpoint', 'endpoint'], ['repair1', 'endpoint'], ['retry', 'endpoint']]) {
    assert.equal(f.reserve(id, phase).status, 'published');
  }
  assert.deepEqual(f.read().accounting, { knowledge: 'known', charged: 4, reserved: 4, remaining: 0 });
  assert.equal(f.reserve('fifth').status, 'refused');
  assert.equal(f.append('terminal', { terminal: { attemptId: 'initial', kind: 'unavailable', dispatch: 'not-started', exitCode: null,
    reason: 'Availability failed after reservation.', evidence: [f.proof], result: null } }).status, 'published');
  assert.equal(f.read().accounting.charged, 4); assert.equal(f.read().accounting.reserved, 3);
});

test('exact operation replay never publishes another reservation or returns fresh eligibility', t => {
  const f = fixture(t); f.init(); const req = f.request('reserve', f.reservePayload('attempt'));
  const first = appendDirectionRecord({ cwd: f.cwd, request: req }); assert.equal(first.status, 'published');
  const again = appendDirectionRecord({ cwd: f.cwd, request: req });
  assert.equal(again.status, 'already_recorded'); assert.equal(again.state.canReserve, false);
  const conflict = structuredClone(req); conflict.payload.attemptId = 'different';
  assert.equal(appendDirectionRecord({ cwd: f.cwd, request: conflict }).status, 'refused');
  assert.equal(f.read().accounting.charged, 1);
});

test('stale policy/head request cannot publish or be silently retried', t => {
  const f = fixture(t); f.init(); const req = f.request('reserve', f.reservePayload('stale'));
  const p = { ...f.policy, revision: 2, previousDigest: f.read().policyDigest, maxAuditAttempts: 0,
    amendment: { reason: 'Operator lowers the limit.', authorization: f.source } };
  assert.equal(f.append('policy', { policy: p }).status, 'published');
  const before = readdirSync(f.directory);
  assert.equal(appendDirectionRecord({ cwd: f.cwd, request: req }).status, 'refused');
  assert.deepEqual(readdirSync(f.directory), before); assert.equal(f.read().canReserve, false);
});

test('unknown accounting remains unavailable until evidence-backed reconciliation, never by a larger limit', t => {
  const f = fixture(t, { knowledge: 'unknown' }); f.init(); assert.equal(f.reserve('unknown').status, 'refused');
  const p = { ...f.policy, revision: 2, previousDigest: f.read().policyDigest, maxAuditAttempts: 8,
    amendment: { reason: 'A higher bound does not resolve history.', authorization: f.source } };
  assert.equal(f.append('policy', { policy: p }).status, 'published'); assert.equal(f.read().accounting.remaining, null);
  assert.equal(f.append('reconcile', { accounting: { knowledge: 'known', priorAttempts: [{ id: 'old', evidence: [f.proof] }],
    reason: 'Retained history reconciled.', evidence: [f.proof] } }).status, 'published');
  assert.equal(f.read().accounting.charged, 1);
  assert.equal(f.append('reconcile', { accounting: { knowledge: 'known', priorAttempts: [], reason: 'Remove the call.', evidence: [f.proof] } }).status, 'refused');
});

test('lowered, off and re-enabled limits preserve charged calls and pending terminals', t => {
  const f = fixture(t); f.init(); f.reserve('one'); f.reserve('two');
  for (const [mode, limit] of [['required', 1], ['off', 8], ['required', 8]]) {
    const old = f.read().policy;
    const p = { ...old, revision: old.revision + 1, previousDigest: f.read().policyDigest, mode, maxAuditAttempts: limit,
      amendment: { reason: 'Explicit operator amendment.', authorization: f.source } };
    assert.equal(f.append('policy', { policy: p }).status, 'published');
    assert.equal(f.read().accounting.charged, 2);
    assert.equal(f.read().canReserve, mode !== 'off' && limit > 2);
  }
});

test('missing/duplicate/completed lifecycle headers refuse writes without touching history', t => {
  const f = fixture(t);
  for (const header of ['state: active\n', 'run-id: test-run\nstate: active\nstate: complete\n', 'run-id: test-run\nstate: complete\n']) {
    writeFileSync(join(f.run, 'ledger.md'), header); assert.equal(f.init().status, 'refused');
    assert.equal(readFileSync(join(f.run, 'ledger.md'), 'utf8'), header);
  }
});

test('orphan stages survive partial initialization; corrupt sequence is not skipped', t => {
  const f = fixture(t); mkdirSync(f.directory, { recursive: true });
  writeFileSync(join(f.directory, '.stage-orphan'), 'incomplete');
  assert.equal(f.read().status, 'unavailable'); assert.equal(f.init().status, 'published');
  assert.ok(f.read().reasons.some(x => /orphan/.test(x)));
  assert.equal(readFileSync(join(f.directory, '.stage-orphan'), 'utf8'), 'incomplete');
  writeFileSync(join(f.directory, '000003.json'), '{}\n');
  assert.equal(f.read().canReserve, false); assert.equal(f.reserve('bad').status, 'refused');
});

test('confined sources reject exclusions, symlinks, invalid UTF-8 and wrong digests', t => {
  const f = fixture(t);
  writeFileSync(join(f.run, 'bad.md'), Buffer.from([0xff]));
  const req = () => f.request('initialize', { baseline: f.baseline, policy: f.policy, authorization: f.source,
    accounting: { knowledge: 'known', priorAttempts: [], reason: 'Source required.', evidence: [f.proof] } });
  for (const path of ['../outside', '.env', 'bad.md']) {
    const r = req(); r.payload.authorization = { ...f.source, evidence: { ...f.proof, path } };
    assert.equal(appendDirectionRecord({ cwd: f.cwd, request: r }).status, 'refused');
  }
  if (process.platform !== 'win32') {
    symlinkSync(join(f.run, 'source.md'), join(f.run, 'link.md'));
    const r = req(); r.payload.authorization = { ...f.source, evidence: { ...f.proof, path: 'link.md' } };
    assert.equal(appendDirectionRecord({ cwd: f.cwd, request: r }).status, 'refused');
  }
  f.init(); writeFileSync(join(f.run, 'source.md'), 'changed'); assert.equal(f.read().canReserve, false);
});

test('publication failures and lost replies preserve charge after a completed link', t => {
  const f = fixture(t); f.init(); const req = f.request('reserve', f.reservePayload('interrupted'));
  const before = readFileSync(join(f.directory, '000001.json'));
  const failed = appendDirectionRecord({ cwd: f.cwd, request: req, publish: () => { throw new Error('unsupported_link'); } });
  assert.equal(failed.status, 'refused'); assert.equal(f.read().accounting.charged, 0);
  const lost = appendDirectionRecord({ cwd: f.cwd, request: req, publish: (path, bytes) => { publishImmutable(path, bytes); throw new Error('reply_lost'); } });
  assert.equal(lost.status, 'publication_unknown'); assert.equal(f.read().accounting.charged, 1);
  assert.deepEqual(readFileSync(join(f.directory, '000001.json')), before);
});

test('policy resolver distinguishes built-in, config and explicit operator sources', t => {
  const f = fixture(t); const args = { cwd: f.cwd, runId: f.runId, overrides: {}, configSource: null };
  assert.equal(resolveDirectionPolicy(args).mode, 'off');
  assert.equal(resolveDirectionPolicy(args).maxAuditAttempts, null);
  const config = '## direction\nmode: shadow\nmax-audit-attempts: 2\n';
  writeFileSync(join(f.cwd, '.afk', 'config.md'), config); writeFileSync(join(f.run, 'config.md'), config);
  const configSource = { id: 'config', kind: 'config', origin: 'retained config', evidence: { path: 'config.md', digest: digestBytes(config) } };
  const p = resolveDirectionPolicy({ ...args, configSource }); assert.equal(p.mode, 'shadow'); assert.equal(p.maxAuditAttempts, 2);
  assert.equal(p.sources.mode.kind, 'config');
  const override = resolveDirectionPolicy({ ...args, configSource, overrides: { maxAuditAttempts: { value: 0, source: f.source } } });
  assert.equal(override.maxAuditAttempts, 0); assert.equal(override.sources.maxAuditAttempts.kind, 'operator');
  writeFileSync(join(f.cwd, '.afk', 'config.md'), '## direction\nmode: misspelled\n');
  assert.throws(() => resolveDirectionPolicy({ ...args, configSource }));
});

test('two linked-worktree processes compete for one exact next slot', async t => {
  const f = fixture(t); f.init();
  const other = join(f.cwd, 'linked');
  execFileSync('git', ['worktree', 'add', '--detach', other, f.commit], { cwd: f.cwd, stdio: 'pipe' });
  t.after(() => { try { execFileSync('git', ['worktree', 'remove', '--force', other], { cwd: f.cwd, stdio: 'pipe' }); } catch {} });
  const cli = resolve('scripts/direction-state.mjs');
  const reqA = f.request('reserve', f.reservePayload('a')); const reqB = f.request('reserve', f.reservePayload('b'), reqA.expectedHead);
  const children = [reqA, reqB].map((req, i) => {
    const path = join(f.run, `request-${i}.json`); writeFileSync(path, canonicalBytes(req));
    const child = spawn(process.execPath, [cli, 'apply', '--request', path], { cwd: i ? other : f.cwd });
    let out = ''; child.stdout.on('data', b => { out += b; }); return { child, output: () => out };
  });
  const results = await Promise.all(children.map(async ({ child, output }) => { const [exit] = await once(child, 'close'); return { exit, value: JSON.parse(output()) }; }));
  assert.deepEqual(results.map(x => x.exit).sort(), [0, 1], JSON.stringify(results));
  assert.equal(results.filter(x => x.value.status === 'published').length, 1);
  assert.equal(f.read().accounting.charged, 1);
  assert.equal(readFileSync(join(f.run, 'ledger.md'), 'utf8'), f.ledger);
});

test('baseline changes stale old bindings and expected reads without restoring calls', t => {
  const f = fixture(t); f.init(); f.reserve('initial', 'initial'); const prior = f.read();
  const b = structuredClone(f.baseline); b.revision = 2; b.previousDigest = prior.baselineDigest;
  b.change = { kind: 'clarification', reason: 'Repository evidence confirms a fact.', evidence: [f.proof], authorization: null };
  b.facts = [{ id: 'F1', text: 'Verified technical fact.', sources: b.outcomes[0].sources }];
  assert.equal(f.append('baseline', { baseline: b }).status, 'published');
  assert.equal(f.read().accounting.charged, 1);
  const old = f.reservePayload('stale'); old.binding.baselineDigest = prior.baselineDigest;
  assert.equal(f.append('reserve', old).status, 'refused');
  const checked = readDirectionState({ cwd: f.cwd, runId: f.runId, issueId: f.issueId,
    expected: { head: prior.head, baselineDigest: prior.baselineDigest, policyDigest: prior.policyDigest } });
  assert.equal(checked.status, 'stale'); assert.equal(checked.canReserve, false);
});

test('terminal outcomes never refund a slot and inconsistent results are refused', t => {
  const f = fixture(t, { limit: 10 }); f.init();
  for (const kind of ['result', 'error', 'timeout', 'unavailable', 'malformed', 'interrupted']) {
    f.reserve(kind);
    const value = { attemptId: kind, kind, dispatch: kind === 'interrupted' ? 'unknown' : 'started', exitCode: kind === 'result' ? 0 : null,
      reason: 'Retained execution observation.', evidence: [f.proof], result: kind === 'result' ? f.proof : null };
    assert.equal(f.append('terminal', { terminal: value }).status, 'published');
    assert.equal(f.append('terminal', { terminal: value }).status, 'refused');
  }
  assert.equal(f.read().accounting.charged, 6); assert.equal(f.read().accounting.reserved, 0);
  f.reserve('contradiction');
  assert.equal(f.append('terminal', { terminal: { attemptId: 'contradiction', kind: 'result', dispatch: 'not-started', exitCode: 1,
    reason: 'This result cannot be success.', evidence: [f.proof], result: f.proof } }).status, 'refused');
});

test('read checks do not create files and require source lines plus bounded canonical bytes', t => {
  const f = fixture(t);
  f.baseline.outcomes[0].sources[0].endLine = 99; assert.equal(f.init().status, 'refused');
  f.baseline.outcomes[0].sources[0].endLine = 3; f.init();
  const before = readdirSync(f.directory); f.read(); assert.deepEqual(readdirSync(f.directory), before);
  const path = join(f.directory, '000001.json'); const original = readFileSync(path);
  writeFileSync(path, `${original.toString().trimEnd().slice(0, -1)},"version":1}\n`);
  assert.equal(f.read().status, 'invalid'); writeFileSync(path, original);
  writeFileSync(join(f.run, 'source.md'), 'x'.repeat(LIMITS.evidenceBytes + 1));
  assert.equal(f.read().canReserve, false);
});

test('a competing append at the final boundary leaves the stale operation unpublished', t => {
  const f = fixture(t); f.init(); const request = f.request('reserve', f.reservePayload('loser'));
  const result = appendDirectionRecord({ cwd: f.cwd, request, beforePublish: () => {
    assert.equal(f.reserve('winner').status, 'published');
  } });
  assert.equal(result.status, 'refused'); assert.ok(result.reasons.includes('stale_head'));
  assert.deepEqual(f.read().attempts.map(x => x.id), ['winner']);
});

test('completed runs and missing required records remain read-only history', t => {
  const f = fixture(t); f.init(); f.reserve('old');
  writeFileSync(join(f.run, 'ledger.md'), f.ledger.replace('state: active', 'state: complete'));
  const before = readdirSync(f.directory); assert.equal(f.read().accounting.charged, 1); assert.equal(f.read().canReserve, false);
  assert.equal(f.reserve('new').status, 'refused'); assert.deepEqual(readdirSync(f.directory), before);
  writeFileSync(join(f.run, 'ledger.md'), f.ledger); rmSync(join(f.directory, '000001.json'));
  assert.equal(f.read().canReserve, false); assert.equal(f.reserve('missing').status, 'refused');
});

test('secret-shaped sources and symlinked sequence ancestors are unavailable', t => {
  const f = fixture(t); writeFileSync(join(f.run, 'source.md'), 'sk-' + 'a'.repeat(24));
  assert.equal(f.init().status, 'refused');
  if (process.platform === 'win32') return;
  const target = join(f.run, 'target'); mkdirSync(target);
  symlinkSync(target, join(f.run, 'issues'));
  assert.equal(f.init().status, 'refused'); assert.deepEqual(readdirSync(target), []);
});

test('policy defaults, blank fields, malformed bounds and source mismatch are distinct', t => {
  const f = fixture(t); const args = { cwd: f.cwd, runId: f.runId, overrides: {}, configSource: null };
  const path = join(f.cwd, '.afk', 'config.md');
  writeFileSync(path, '## direction\nmode: \nmax-audit-attempts: # omitted\n');
  assert.equal(resolveDirectionPolicy(args).sources.mode.kind, 'built-in');
  for (const value of ['-1', '1.5', 'unknown', '9007199254740992']) {
    writeFileSync(path, `## direction\nmax-audit-attempts: ${value}\n`); assert.throws(() => resolveDirectionPolicy(args));
  }
  writeFileSync(path, '## direction\nmode: required\n'); assert.throws(() => resolveDirectionPolicy(args));
  const source = { id: 'wrong', kind: 'config', origin: 'Wrong snapshot.', evidence: f.proof };
  assert.throws(() => resolveDirectionPolicy({ ...args, configSource: source }));
});

test('opaque packet and result digests are usable while output contains only their references', t => {
  const f = fixture(t); f.init();
  const raw = canonicalBytes({ version: 1, baselineDigest: f.read().baselineDigest, targetDigest: 'a'.repeat(64),
    privateObservation: 'opaque-content-not-in-state-output' });
  writeFileSync(join(f.run, 'packet.json'), raw); const ref = { path: 'packet.json', digest: digestBytes(raw) };
  const payload = f.reservePayload('opaque'); payload.binding.packet = ref;
  const reservation = f.append('reserve', payload); assert.equal(reservation.status, 'published', JSON.stringify(reservation));
  const terminal = f.append('terminal', { terminal: { attemptId: 'opaque', kind: 'result', dispatch: 'started', exitCode: 0,
    reason: 'The consumer owns result validation.', evidence: [f.proof], result: ref } });
  assert.equal(terminal.status, 'published', JSON.stringify(terminal));
  const state = f.read(); assert.equal(state.status, 'valid'); assert.equal(state.accounting.charged, 1);
  assert.deepEqual(state.attempts[0].binding.packet, ref); assert.deepEqual(state.attempts[0].terminal.value.result, ref);
  assert.doesNotMatch(canonicalBytes({ reservation, terminal, state }), /opaque-content-not-in-state-output/);
});

test('an opaque cache hit cannot bypass strict terminal evidence for the same reference', t => {
  const f = fixture(t); f.init();
  const raw = canonicalBytes({ baselineDigest: 'a'.repeat(64), retainedValue: 'sk-' + 'b'.repeat(24) });
  writeFileSync(join(f.run, 'mixed.json'), raw); const ref = { path: 'mixed.json', digest: digestBytes(raw) };
  const payload = f.reservePayload('mixed'); payload.binding.packet = ref;
  assert.equal(f.append('reserve', payload).status, 'published');
  const value = f.append('terminal', { terminal: { attemptId: 'mixed', kind: 'result', dispatch: 'started', exitCode: 0,
    reason: 'Strict evidence must still be checked.', evidence: [ref], result: ref } });
  assert.equal(value.status, 'refused'); assert.ok(value.reasons.includes('sensitive_source'));
  assert.equal(f.read().accounting.charged, 1); assert.equal(f.read().accounting.reserved, 1);
});

test('strict-before-opaque references stay strict and genuine source secrets are refused', t => {
  const f = fixture(t); f.init();
  const raw = canonicalBytes({ baselineDigest: 'a'.repeat(64), retainedValue: 'sk-' + 'c'.repeat(24) });
  writeFileSync(join(f.run, 'strict-first.json'), raw); const ref = { path: 'strict-first.json', digest: digestBytes(raw) };
  f.reserve('strict-first');
  const value = f.append('terminal', { terminal: { attemptId: 'strict-first', kind: 'result', dispatch: 'started', exitCode: 0,
    reason: 'Evidence precedes opaque result in canonical field order.', evidence: [ref], result: ref } });
  assert.equal(value.status, 'refused'); assert.ok(value.reasons.includes('sensitive_source'));
  const baseline = structuredClone(f.baseline); baseline.revision = 2; baseline.previousDigest = f.read().baselineDigest;
  baseline.change = { kind: 'intent-change', reason: 'Source credentials cannot be relabeled as authority.', evidence: [], authorization: f.source };
  baseline.sources[0].evidence = ref;
  const changed = f.append('baseline', { baseline });
  assert.equal(changed.status, 'refused'); assert.ok(changed.reasons.includes('sensitive_source'));
});

test('opaque references retain confinement, byte, UTF-8, NUL and digest validation', t => {
  const f = fixture(t); f.init();
  const cases = [
    { path: 'invalid-utf8.json', bytes: Buffer.from([0xff]) },
    { path: 'binary.json', bytes: Buffer.from('a\0b') },
    { path: 'large.json', bytes: Buffer.from('x'.repeat(LIMITS.auditPacketBytes + 1)) },
    { path: 'wrong-digest.json', bytes: Buffer.from('{}\n'), wrong: true },
  ];
  for (const [index, entry] of cases.entries()) {
    writeFileSync(join(f.run, entry.path), entry.bytes);
    const payload = f.reservePayload(`invalid-${index}`);
    payload.binding.packet = { path: entry.path, digest: entry.wrong ? 'f'.repeat(64) : digestBytes(entry.bytes) };
    assert.equal(f.append('reserve', payload).status, 'refused');
  }
  for (const path of ['../outside.json', '.env']) {
    const payload = f.reservePayload('confined'); payload.binding.packet = { path, digest: 'a'.repeat(64) };
    assert.equal(f.append('reserve', payload).status, 'refused');
  }
  if (process.platform !== 'win32') {
    symlinkSync(join(f.run, 'source.md'), join(f.run, 'opaque-link.json'));
    const payload = f.reservePayload('symlink'); payload.binding.packet = { path: 'opaque-link.json', digest: f.proof.digest };
    assert.equal(f.append('reserve', payload).status, 'refused');
  } else t.diagnostic('Opaque symlink case not exercised on Windows.');
  assert.equal(f.read().accounting.charged, 0);
});


test('uncapped policy records more than four attempts without losing accounting', t => {
  const f = fixture(t, { limit: null });
  assert.equal(f.init().status, 'published');
  for (let i = 0; i < 7; i++) assert.equal(f.append('reserve', f.reservePayload(`uncapped-${i}`)).status, 'published');
  assert.deepEqual(f.read().accounting, { knowledge: 'known', charged: 7, reserved: 7, remaining: null });
  assert.equal(f.read().canReserve, true);
  assert.ok(!f.read().reasons.includes('attempts_exhausted'));
});

test('uncapped policy does not erase unknown consumption or authorize a reservation', t => {
  const f = fixture(t, { limit: null, knowledge: 'unknown' });
  assert.equal(f.init().status, 'published');
  assert.equal(f.read().canReserve, false);
  assert.equal(f.read().accounting.remaining, null);
  assert.equal(f.append('reserve', f.reservePayload('unknown')).status, 'refused');
});

test('finite and uncapped amendments retain prior charges and original record bytes', t => {
  const f = fixture(t, { limit: 1 }); f.init();
  assert.equal(f.append('reserve', f.reservePayload('first')).status, 'published');
  const original = readFileSync(join(f.directory, '000001.json'));
  for (const limit of [null, 0, 1, null]) {
    const old = f.read().policy;
    const policy = { ...old, revision: old.revision + 1, previousDigest: f.read().policyDigest,
      maxAuditAttempts: limit, amendment: { reason: 'Authorized cap transition.', authorization: f.source } };
    assert.equal(f.append('policy', { policy }).status, 'published');
    assert.equal(f.read().accounting.charged, 1);
    assert.equal(f.read().accounting.reserved, 1);
    assert.equal(f.read().canReserve, limit === null);
    assert.deepEqual(readFileSync(join(f.directory, '000001.json')), original);
  }
});

test('a larger reserved packet does not widen result or source proof reads', t => {
  const f = fixture(t); f.init();
  const bytes = 'x'.repeat(LIMITS.evidenceBytes + 1);
  writeFileSync(join(f.run, 'large-packet.json'), bytes);
  const reference = { path: 'large-packet.json', digest: digestBytes(bytes) };
  const payload = f.reservePayload('large-packet'); payload.binding.packet = reference;
  assert.equal(f.append('reserve', payload).status, 'published');
  for (const asSource of [false, true]) {
    const terminal = { attemptId: 'large-packet', kind: 'result', dispatch: 'started', exitCode: 0,
      reason: 'Each proof retains its own validation boundary.', evidence: asSource ? [reference] : [f.proof], result: reference };
    const rejected = f.append('terminal', { terminal });
    assert.equal(rejected.status, 'refused'); assert.ok(rejected.reasons.includes('file_limit'));
  }
  assert.equal(f.read().accounting.charged, 1);
  assert.equal(f.read().accounting.reserved, 1);
});
