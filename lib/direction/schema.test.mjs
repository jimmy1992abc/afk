import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalBytes, digestBytes } from '../gate/review-receipt.mjs';
import { validateBaseline, validatePolicy, foldRecords, LIMITS } from './schema.mjs';

const evidence = { path: 'source.md', digest: 'a'.repeat(64) };
const source = { id: 'operator', kind: 'operator', origin: 'operator request', evidence };
const clause = (id) => ({ id, text: 'Preserve the requested behavior.', sources: [{ sourceId: 'operator', startLine: 1, endLine: 1 }] });
const baseline = () => ({ version: 1, revision: 1, previousDigest: null,
  change: { kind: 'extraction', reason: 'Extract the authorized scope.', evidence: [], authorization: null },
  sources: [source], outcomes: [clause('O1')], acceptance: [clause('A1')], invariants: [], nonGoals: [],
  priorities: [], allowedChanges: [], publicationLimits: [], assumptions: [], facts: [] });
const policy = () => ({ version: 1, revision: 1, previousDigest: null, mode: 'required', maxAuditAttempts: 4,
  sources: { mode: { kind: 'operator', source }, maxAuditAttempts: { kind: 'built-in', source: null } }, amendment: null });
const initialize = () => ({ version: 1, runId: 'run', issueId: '109', sequence: 1, previousDigest: null,
  operationId: 'init', recordedAt: '2026-01-01T00:00:00.000Z', operation: 'initialize',
  payload: { baseline: baseline(), policy: policy(), authorization: source,
    accounting: { knowledge: 'known', priorAttempts: [], reason: 'No prior direction calls in this run.', evidence: [evidence] } } });

test('baseline shapes reject extra fields, unknown versions, duplicate IDs and invalid anchors', () => {
  validateBaseline(baseline());
  for (const change of [b => { b.extra = 1; }, b => { b.version = 2; },
    b => { b.acceptance[0].id = 'O1'; }, b => { b.outcomes[0].sources[0].startLine = 0; },
    b => { b.outcomes[0].sources[0].sourceId = 'missing'; }, b => { b.sources[0].evidence.path = '../outside'; }]) {
    const b = structuredClone(baseline()); change(b); assert.throws(() => validateBaseline(b));
  }
});

test('policy requires valid bounds and source kinds', () => {
  validatePolicy(policy());
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '4', undefined, Infinity]) {
    assert.throws(() => validatePolicy({ ...policy(), maxAuditAttempts: value }));
  }
  validatePolicy({ ...policy(), maxAuditAttempts: 0, sources: { ...policy().sources, maxAuditAttempts: { kind: 'operator', source } } });
  assert.throws(() => validatePolicy({ ...policy(), mode: 'silent' }));
  const p = policy(); p.sources.mode.source = null; assert.throws(() => validatePolicy(p));
});

test('clarification preserves semantic clauses and product decisions while intent change needs authorization', () => {
  const first = initialize();
  first.payload.baseline.assumptions.push({ id: 'D1', text: 'An operator decision is pending.', kind: 'product-decision', status: 'open', sources: [] });
  const next = structuredClone(first.payload.baseline);
  next.revision = 2; next.previousDigest = digestBytes(canonicalBytes(first.payload.baseline));
  next.change = { kind: 'clarification', reason: 'Verify a fact.', evidence: [evidence], authorization: null };
  next.facts.push({ id: 'F1', text: 'A repository fact.', sources: clause('unused').sources });
  const record = { ...first, sequence: 2, previousDigest: digestBytes(canonicalBytes(first)), operationId: 'baseline', operation: 'baseline', payload: { baseline: next } };
  foldRecords([first, record]);
  const mutated = structuredClone(record); mutated.payload.baseline.assumptions[0].text = 'Different decision.';
  assert.throws(() => foldRecords([first, mutated]));
  mutated.payload.baseline.change.kind = 'intent-change';
  assert.throws(() => foldRecords([first, mutated]));
  mutated.payload.baseline.change.authorization = source;
  foldRecords([first, mutated]);
});

test('sequence version, identity, timestamp and previous digest are checked', () => {
  foldRecords([initialize()]);
  for (const change of [r => { r.sequence = 2; }, r => { r.previousDigest = 'b'.repeat(64); },
    r => { r.recordedAt = '2026-02-31T00:00:00.000Z'; }, r => { r.runId = '../run'; }]) {
    const r = initialize(); change(r); assert.throws(() => foldRecords([r]));
  }
  assert.ok(LIMITS.records > 4);
});


test('new uncapped built-in policy and legacy built-in four retain distinct meaning', () => {
  const legacy = initialize();
  assert.equal(foldRecords([legacy]).accounting.remaining, 4);
  const current = initialize(); current.payload.policy.maxAuditAttempts = null;
  const result = foldRecords([current]);
  assert.equal(result.policy.maxAuditAttempts, null);
  assert.equal(result.accounting.knowledge, 'known');
  assert.equal(result.accounting.remaining, null);
  assert.equal(result.canReserve, true);
  for (const value of [0, 3, 5]) assert.throws(() => validatePolicy({ ...policy(), maxAuditAttempts: value }));
});
