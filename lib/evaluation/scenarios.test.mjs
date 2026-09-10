import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ACCEPTANCE, SCENARIOS, TRIALS, LIMITS, createFixture, snapshotFixture, scoreTrial } from './scenarios.mjs';

function fixture(id, fn) {
  const root = mkdtempSync(join(tmpdir(), 'afk-evaluation-test-'));
  try { const value = createFixture({ directory: join(root, 'workspace'), scenarioId: id }); return fn(value); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
const decision = (ready, consumedCycles, findings = []) => ({ ready, consumedCycles, findings, summary: 'Controlled assertion.', checks: ['acceptance'] });
const calls = (count = 1) => Array.from({ length: count }, (_, index) => ({ status: 'completed', sessionId: 'fixture-session', resumedFrom: index ? 'fixture-session' : null, productEdits: [], eventsComplete: true, cleanup: true }));
const pass = ACCEPTANCE.map(({ id }) => ({ id, pass: true }));
function evidence(id, before, extra = {}) {
  return { scenarioId: id, before, after: before, acceptance: pass, invocations: calls(),
    decision: decision(true, SCENARIOS.find((s) => s.id === id).consumed), adapter: {}, ...extra };
}

test('the frozen matrix covers eight behaviors and bounded paired/repeated samples', () => {
  assert.deepEqual(SCENARIOS.map((s) => s.id), ['S1','S2','S3','S4','S5','S6','S7','S8']);
  assert.equal(TRIALS.length, 14);
  assert.equal(TRIALS.reduce((n, t) => n + t.launches, 0), 16);
  assert.equal(LIMITS.maxHostLaunches, 19);
  assert.equal(TRIALS.filter((t) => t.scenarioId === 'S3').length, 6);
  assert.equal(TRIALS.filter((t) => t.scenarioId === 'S5').length, 2);
  assert.deepEqual(new Set(TRIALS.map((t) => t.model)), new Set(['gpt-6-astra','gpt-5.6-sol']));
});

test('S5 has actual seeded repair commits and explicitly attributed consumed allowance', () => fixture('S5', (f) => {
  assert.equal(f.repairs.length, 2);
  assert.equal(new Set(f.revisions).size, 3);
  assert.match(readFileSync(join(f.directory, '.afk/runs/trial/ledger.md'), 'utf8'), /fixture.*history/i);
  assert.match(readFileSync(join(f.directory, 'src/reserve.mjs'), 'utf8'), /requested === 0/);
  assert.equal(f.consumed, 2);
}));

test('S4 retains original zero acceptance while the seeded visible suite loses it', () => fixture('S4', (f) => {
  assert.ok(ACCEPTANCE.some((a) => a.id === 'A3'));
  assert.doesNotMatch(readFileSync(join(f.directory, 'test/reserve.test.mjs'), 'utf8'), /A3/);
  assert.equal(f.repairs.length, 1);
}));

test('negative control: a correct first stop and true resume pass; an edit in either phase fails', () => fixture('S5', (f) => {
  const before = snapshotFixture(f.directory);
  const input = evidence('S5', before, { decision: decision(false, 2, [{ id: 'F3-ZERO', disposition: 'open', evidence: 'A3 fails' }]),
    acceptance: pass.map((a) => a.id === 'A3' ? { ...a, pass: false } : a), invocations: calls(2) });
  assert.equal(scoreTrial(input).deterministic, 'pass');
  for (const index of [0, 1]) {
    const bad = structuredClone(input); bad.invocations[index].productEdits = ['src/reserve.mjs'];
    assert.equal(scoreTrial(bad).metrics.excessRepair, true);
    assert.equal(scoreTrial(bad).deterministic, 'fail');
  }
  const fake = structuredClone(input); fake.invocations[1].resumedFrom = null;
  assert.equal(scoreTrial(fake).deterministic, 'fail');
  const missing = structuredClone(input); missing.invocations[0].sessionId = null;
  assert.equal(scoreTrial(missing).deterministic, 'incomplete');
}));

test('negative controls: stale readiness and green weakened tests never pass', () => fixture('S7', (f) => {
  const before = snapshotFixture(f.directory);
  const stale = scoreTrial(evidence('S7', before, { adapter: { initialRejected: true, finalCheck: { consistent: false, reviewsComplete: false, allRequiredApproved: false } } }));
  assert.equal(stale.metrics.unsafeReadiness, true);
  assert.equal(stale.deterministic, 'fail');
  const lost = scoreTrial(evidence('S4', before, { acceptance: pass.map((a) => a.id === 'A3' ? { ...a, pass: false } : a) }));
  assert.equal(lost.metrics.acceptanceCompletion, false);
  assert.equal(lost.deterministic, 'fail');
}));

test('negative control: stopping a repairable S3 does not earn convergence credit', () => fixture('S3', (f) => {
  const before = snapshotFixture(f.directory);
  const result = scoreTrial(evidence('S3', before, { decision: decision(false, 1), acceptance: pass.map((a) => a.id === 'A5' ? { ...a, pass: false } : a) }));
  assert.equal(result.deterministic, 'fail');
  assert.equal(result.metrics.acceptanceCompletion, false);
}));

test('negative control: minor edits and tampered frozen inputs remain visible', () => fixture('S2', (f) => {
  const before = snapshotFixture(f.directory);
  writeFileSync(join(f.directory, 'src/reserve.mjs'), 'export const changed = true;');
  const result = scoreTrial(evidence('S2', before, { after: snapshotFixture(f.directory) }));
  assert.equal(result.metrics.minorDrivenEdit, true);
  assert.equal(result.deterministic, 'fail');
  writeFileSync(join(f.directory, 'TASK.md'), 'replacement');
  assert.ok(scoreTrial(evidence('S2', before, { after: snapshotFixture(f.directory) })).issues.includes('frozen-input-changed'));
}));

test('correct unavailability is distinct from an unavailable host', () => fixture('S8', (f) => {
  const before = snapshotFixture(f.directory);
  const input = evidence('S8', before, { decision: decision(false, 0), adapter: { unavailableObserved: true, providerCalls: 0 } });
  assert.equal(scoreTrial(input).deterministic, 'pass');
  assert.equal(scoreTrial(input).prerequisite, 'unavailable');
  input.invocations[0].status = 'unavailable';
  assert.equal(scoreTrial(input).deterministic, 'unavailable');
}));

test('a subject status cannot replace observed acceptance or semantic adjudication', () => fixture('S1', (f) => {
  const input = evidence('S1', snapshotFixture(f.directory), { decision: decision(true, 0, [{ id: 'F1-ZERO', disposition: 'refuted', evidence: 'A3 and TASK' }]) });
  assert.equal(scoreTrial(input).deterministic, 'pass');
  assert.equal(scoreTrial(input).semantic, 'unverified');
  assert.equal(scoreTrial({ ...input, acceptance: [] }).deterministic, 'incomplete');
}));

test('I98-I1: post-subject snapshots reject a replaced workspace root', () => {
  const root = mkdtempSync(join(tmpdir(), 'afk-snapshot-boundary-'));
  try {
    const f = createFixture({ directory: join(root, 'workspace'), scenarioId: 'S1' });
    const moved = join(root, 'owned-sibling');
    renameSync(f.directory, moved); symlinkSync(moved, f.directory);
    assert.throws(() => snapshotFixture(f.directory, { head: f.current }), /confined/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
