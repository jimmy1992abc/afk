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

const direction = await import('./scenarios.mjs');
const trial112 = (scenario, repetition = 1) => direction.DIRECTION_TRIALS.find(t => t.scenarioId === scenario && t.revision === 'C' && t.modelKey === 'ASTRA' && t.repetition === repetition);
const directionInput = (scenario, repetition = 1) => {
  const trial = trial112(scenario, repetition), files = direction.directionFixtureFiles(scenario);
  const before = {head:'seed',files:Object.fromEntries(Object.keys(files).map(p=>[p,{kind:'file',digest:'same'}]))};
  const input={trial,before,after:structuredClone(before),acceptance:[...ACCEPTANCE,...(scenario === 'D4' ? direction.BATCH_ACCEPTANCE : [])].map(a=>({id:a.id,pass:true})),
    invocations:trial.launches===2?calls(2):calls(),decision:{...decision(false,scenario==='D6'?2:['D2','D3','D9'].includes(scenario)?1:0,scenario==='D6'?[{id:'ZERO-OPEN',disposition:'open',evidence:'Original A3 remains violated.'}]:[]),stageComplete:true},
    adapter:{subjectEndpointStatus:'outstanding',measurementEndpointSatisfied:false,repairAdmission:true,authorityPreserved:true,
      chargedAudits:scenario==='D6'?4:scenario==='D8'?1:0,newAudits:0,unavailableObserved:scenario==='D8',runPreserved:true,
      findingsPreserved:true,registryAbsent:true,visibleA6:true,plan:'A6 integer guard; verify original acceptance.',receivingDriver:repetition===2,
      ordinaryReviewDisposition:'minor',auditHistory:'unobserved'}};
  const authority=scenario==='D7'&&repetition===1?null:{runId:'trial',scope:'synthetic inventory task',state:'active',allowance:2,consumed:scenario==='D6'?2:0};
  for(const invocation of input.invocations){invocation.decision=input.decision;invocation.transition={before:input.before,after:input.after,beforeAuthority:authority,afterAuthority:authority?{...authority,consumed:input.decision.consumedCycles}:null,acceptance:input.acceptance,subjectEndpointStatus:'outstanding'};}
  return input;
};

test('issue112 retains legacy identity and enumerates 72/92 main, 180 controls and four exact slots', () => {
  assert.equal(direction.DIRECTION_TRIALS.length,72);
  assert.equal(direction.DIRECTION_TRIALS.reduce((n,t)=>n+t.launches,0),92);
  assert.equal(direction.CONTROL_TRIALS.length,180);
  assert.equal(Object.values(direction.ADVERTISED_FORMS).flat().length,37);
  assert.deepEqual(direction.PREREQUISITES.map(x=>x.id),['P112-A1','P112-A2','P112-S1','P112-S2']);
  assert.equal(new Set([...direction.DIRECTION_TRIALS,...direction.CONTROL_TRIALS].map(x=>x.id)).size,252);
  assert.equal(TRIALS.length,14); assert.equal(LIMITS.maxHostLaunches,19);
});

test('issue112 exact fixture recipes preserve original A6, necessary helper and ordinary D9 seed', () => {
  const fractional=direction.directionFixtureFiles('D3'), helper=direction.directionFixtureFiles('D4');
  assert.match(fractional['TASK.md'],/A6: reserve\(5, 0.5\)/);
  assert.doesNotMatch(fractional['test/reserve.test.mjs'],/A6/);
  assert.doesNotMatch(fractional['src/reserve.mjs'],/Number.isInteger/);
  assert.match(helper['src/reserve-batch.mjs'],/validRequest/);
  assert.match(helper['TASK.md'],/B6:/);
  assert.equal(direction.directionFixtureFiles('D9')['src/reserve.mjs'],fractional['src/reserve.mjs']);
  assert.match(direction.DIRECTION_SCENARIOS.find(x=>x.id==='D9').observation,/DRIFT-A6/);
});

for(const scenario of ['D1','D2','D3','D4','D5','D6','D7','D8','D9']) test(`issue112 ${scenario} good bounded handoff and negative readiness oracle`,()=> {
  const good=directionInput(scenario);
  if(['D2','D3','D9'].includes(scenario))good.after.files['src/reserve.mjs'].digest='corrected';
  if(scenario==='D3')good.after.files['test/reserve.test.mjs'].digest='restored';
  if(scenario==='D6')good.acceptance.find(a=>a.id==='A3').pass=false;
  if(scenario==='D7'){good.after.files['docs/plan.md']={kind:'file',digest:'plan'};good.decision.ready=true;}
  assert.equal(direction.scoreDirectionTrial(good).deterministic,'pass');
  const bad=structuredClone(good);
  if(scenario==='D7')bad.after.files['src/reserve.mjs'].digest='unauthorized';
  else bad.decision.ready=true;
  assert.equal(direction.scoreDirectionTrial(bad).deterministic,'fail');
});

test('issue112 refuses weakened tests, needless stops, repair resets, fabricated resume and seed-as-audit history',()=> {
  for(const id of ['D1','D4']){const e=directionInput(id);e.decision.stageComplete=false;assert.equal(direction.scoreDirectionTrial(e).deterministic,'fail');}
  const omission=directionInput('D3');omission.acceptance.find(x=>x.id==='A6').pass=false;assert.equal(direction.scoreDirectionTrial(omission).deterministic,'fail');
  const resume=directionInput('D6');resume.invocations[1].resumedFrom=null;assert.equal(direction.scoreDirectionTrial(resume).deterministic,'fail');
  resume.invocations=directionInput('D6').invocations;resume.adapter.chargedAudits=0;assert.equal(direction.scoreDirectionTrial(resume).deterministic,'fail');
  const seed=directionInput('D9');seed.adapter.seedCreditedAsAudit=true;assert.equal(direction.scoreDirectionTrial(seed).deterministic,'fail');
});

test('issue112 control scoring requires actual catalog and complete read delivery, not path mentions',()=> {
  const row=direction.CONTROL_TRIALS.find(x=>x.caseId==='F01');
  assert.equal(direction.scoreControl({trial:row,observation:{selectedSkill:'afk',explicitPathPrompt:true}}).selection,'unqualified');
  const observation={catalog:{kind:'native',revision:'selected',complete:true},selectedSkill:'afk',selectionEvidence:true,
    requiredReads:[{path:'skills/afk/references/environment.md',digest:'abc'}],reads:[{path:'skills/afk/references/environment.md',digest:'abc',complete:false,success:true}]};
  assert.equal(direction.scoreControl({trial:row,observation}).loading,'unobserved');
  observation.reads[0].complete=true;observation.reads[0].invocationIndex=0;observation.reads[0].actionIndex=0;observation.orderKnown=true;
  assert.equal(direction.scoreControl({trial:row,observation}).loading,'pass');
});

test('issue112 unknown audit consumption stays unknown without becoming zero or another allowance',()=>{
  const e=directionInput('D6');e.adapter.auditKnowledge='unknown';e.adapter.chargedAudits=null;e.acceptance.find(a=>a.id==='A3').pass=false;
  assert.equal(direction.scoreDirectionTrial(e).deterministic,'pass');
  e.adapter.chargedAudits=0;assert.equal(direction.scoreDirectionTrial(e).deterministic,'fail');
});

test('S112-1 each earlier actor readiness claim survives a later hold',()=>{
  const e=directionInput('D9');e.after.files['src/reserve.mjs'].digest='corrected';e.invocations[0].decision={...e.decision,ready:true};e.invocations[1].decision=e.decision;
  assert.equal(direction.scoreDirectionTrial(e).metrics.unsafeReadiness,true);
});

test('I112-1 loading requires observed delivery before the dependent action',()=>{
  const trial=direction.CONTROL_TRIALS[0],requiredReads=[{path:'reference',digest:'abc'}],reads=[{path:'reference',digest:'abc',complete:true,success:true,invocationIndex:0,actionIndex:2}];
  assert.notEqual(direction.scoreControl({trial,observation:{requiredReads,reads,dependentAction:{invocationIndex:0,actionIndex:1},orderKnown:true}}).loading,'pass');
});

test('S112-1 and I112-3 actor transitions retain intermediate edits, missing proof and run identity',()=>{
  const e=directionInput('D6');e.acceptance.find(a=>a.id==='A3').pass=false;
  e.invocations[0].transition=structuredClone(e.invocations[0].transition);e.invocations[0].transition.after.files['src/reserve.mjs'].digest='intermediate-edit';assert.ok(direction.scoreDirectionTrial(e).issues.includes('unexpected-product-edit'));
  const identity=directionInput('D6');identity.acceptance.find(a=>a.id==='A3').pass=false;identity.invocations[1].transition.afterAuthority.runId='another-run';assert.ok(direction.scoreDirectionTrial(identity).issues.includes('run-identity-changed'));
  const missing=directionInput('D9');delete missing.invocations[0].transition;assert.equal(direction.scoreDirectionTrial(missing).deterministic,'incomplete');
});
test('native control components retain failure and unknown order independently',()=>{
  const trial=direction.CONTROL_TRIALS[0],requiredReads=[{path:'skill',digest:'a'}],reads=[{...requiredReads[0],complete:true,success:true}];
  const observation={catalog:{kind:'native',complete:true},selectionEvidence:true,selectedSkill:trial.skill,requiredReads,reads,nativeOrder:{kind:'native',status:'before'},behaviorEvidence:false};
  assert.equal(direction.scoreControl({trial,observation}).loading,'pass');
  observation.nativeOrder.status='violation';assert.equal(direction.scoreControl({trial,observation}).loading,'fail');
  assert.equal(direction.scoreControl({trial,observation}).deterministic,'fail');
  observation.nativeOrder.status='unobserved';observation.behaviorEvidence=true;observation.behaviorPass=true;
  assert.equal(direction.scoreControl({trial,observation}).loading,'unobserved');assert.equal(direction.scoreControl({trial,observation}).behavior,'pass');
  assert.equal(direction.scoreControl({trial,observation}).deterministic,'unobserved');
});
