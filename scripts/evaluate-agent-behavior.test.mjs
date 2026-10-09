import { EVALUATOR_RUNTIME_FILES } from '../lib/evaluation/runtime.mjs';
import { nativeWitnessSourcePaths } from '../lib/evaluation/native-witness.mjs';
import { digestBytes } from '../lib/gate/review-receipt.mjs';
import { decodeNativeRequest, nativeDeclarationDigest } from '../lib/evaluation/native-wire.mjs';
import { witnessResponse } from '../lib/evaluation/native-witness.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import https from 'node:https';
import assert from 'node:assert/strict';
import { existsSync, chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixtureGit, createFixture } from '../lib/evaluation/scenarios.mjs';
import { supportVisible, exportSupport, runBounded, parseHostEvents, hostArguments,
  verifyReportCarryforward, prepareProductEvidence, inspectProductEvidence, createEvaluation, runPrerequisite, runTrialSlice, aggregateEvaluation, inspectCommand } from './evaluate-agent-behavior.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
function temporary(fn) {
  const root = mkdtempSync(join(tmpdir(), 'afk-evaluator-runner-'));
  return Promise.resolve().then(() => fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}
function sandboxStub(root) {
  const js=join(root,'sandbox-transport.mjs'), bin=join(root,'sandbox-transport.sh');
  writeFileSync(js,`import{spawnSync}from'node:child_process';import{readFileSync}from'node:fs';const a=process.argv.slice(2);if(a[0]!=='sandbox'||!a.includes('--permission-profile'))process.exit(90);const n=a.indexOf('-C');const r=spawnSync(a[n+2],a.slice(n+3),{cwd:a[n+1],input:readFileSync(0),encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);`);
  writeFileSync(bin,`#!/bin/sh\nexec '${process.execPath}' '${js}' \"$@\"\n`);chmodSync(bin,0o700);return bin;
}
function commit(root, message) { fixtureGit(root, ['add', '.']); fixtureGit(root, ['commit', '-qm', message]); return fixtureGit(root, ['rev-parse', 'HEAD']); }

test('identical support visibility excludes copied scorers, tests, designs and reports', () => {
  for (const path of ['lib/evaluation/scenarios.mjs','scripts/evaluate-agent-behavior.mjs',
    'scripts/evaluate-agent-behavior.test.mjs','lib/gate/protocol.test.mjs','skills/afk-agent-relay/tests/redact.test.mjs',
    'docs/designs/specs/issue-98-behavior-evaluations.md','docs/evaluations/issue-98-pilot.md', 'AGENTS.md', 'docs/maintaining-skills.md',
    'docs/designs/specs/issue-107-instruction-routing.md', 'scripts/instruction-test-helpers.mjs']) assert.equal(supportVisible(path), false, path);
  for (const path of ['skills/afk/SKILL.md','skills/afk-claude-review/claude-gate.mjs','lib/gate/protocol.mjs',
    'scripts/check-review-receipts.mjs','docs/designs/specs/issue-96-review-context.md',
    'skills/afk/references/review-evidence.md', 'docs/designs/specs/issue-97-review-receipts.md']) assert.equal(supportVisible(path), true, path);
});

test('production support preserves original paths/bytes and refuses a second export', () => temporary(async (root) => {
  const source = join(root, 'source'); mkdirSync(source); fixtureGit(source, ['init','-q','-b','fixture']);
  for (const [path, text] of [['skills/afk/SKILL.md','exact production bytes\n'], ['skills/afk/references/review-evidence.md','exact reference bytes\n'], ['lib/evaluation/scenarios.mjs','secret scorer\n'], ['AGENTS.md','author-only instructions\n']]) {
    mkdirSync(join(source, path, '..'), { recursive: true }); writeFileSync(join(source, path), text);
  }
  const sha = commit(source, 'seed'); const output = join(root, 'support');
  const manifest = exportSupport({ repository: source, revision: sha, directory: output });
  assert.deepEqual(Object.keys(manifest.files), ['skills/afk/SKILL.md', 'skills/afk/references/review-evidence.md']);
  assert.equal(manifest.revision, sha);
  assert.equal(readFileSync(join(output,'skills/afk/references/review-evidence.md'),'utf8'), 'exact reference bytes\n');
  assert.throws(() => readFileSync(join(output,'AGENTS.md')));
  assert.equal(readFileSync(join(output,'skills/afk/SKILL.md'),'utf8'),'exact production bytes\n');
  assert.throws(() => readFileSync(join(output,'lib/evaluation/scenarios.mjs')));
  assert.throws(() => exportSupport({ repository: source, revision: sha, directory: output }));
}));

test('report-only R carries C evidence without claiming a new trial; code edits cannot', () => temporary(async (root) => {
  fixtureGit(root, ['init','-q','-b','fixture']); writeFileSync(join(root,'code.mjs'),'export const value=1;\n');
  const c = commit(root,'implementation'); mkdirSync(join(root,'docs/evaluations'), { recursive: true });
  writeFileSync(join(root,'docs/evaluations/issue-98-pilot.md'),'# Aggregate\n'); const r = commit(root,'report');
  assert.equal(verifyReportCarryforward({ repository: root, implementation: c, reportHead: r }).equivalent, true);
  writeFileSync(join(root,'code.mjs'),'export const value=2;\n'); const changed = commit(root,'code');
  assert.equal(verifyReportCarryforward({ repository: root, implementation: c, reportHead: changed }).equivalent, false);
}));

test('runner cleans a lingering descendant on normal exit and enforces output/timeout bounds', {
  skip: process.platform === 'win32' ? 'POSIX process-group fixture required' : false,
}, () => temporary(async (root) => {
  const script = join(root,'child.mjs');
  writeFileSync(script, `import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); console.log(child.pid); child.unref();`);
  const normal = await runBounded(process.execPath,[script],{ cwd:root, timeoutMs:2000, maxBytes:4096, graceMs:150 });
  assert.equal(normal.status,'completed'); assert.equal(normal.cleanup,true);
  const timed = await runBounded(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:root,timeoutMs:50,maxBytes:4096,graceMs:50});
  assert.equal(timed.status,'timeout'); assert.equal(timed.cleanup,true);
  const flood = await runBounded(process.execPath,['-e',"process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)"],{cwd:root,timeoutMs:2000,maxBytes:128,graceMs:50});
  assert.equal(flood.status,'output-limit'); assert.ok(Buffer.byteLength(flood.stdout)<=128); assert.equal(flood.cleanup,true);
}));

test('JSONL parsing preserves real session continuity, usage and observed file edits', () => {
  const data = [{type:'thread.started',thread_id:'session-id'},{type:'item.completed',item:{type:'file_change',changes:[{path:'src/reserve.mjs'}]}},
    {type:'turn.completed',usage:{input_tokens:20,output_tokens:4}}].map(JSON.stringify).join('\n');
  const result = parseHostEvents(data);
  assert.equal(result.sessionId,'session-id'); assert.equal(result.eventsComplete,true);
  assert.equal(result.usage.output_tokens,4); assert.deepEqual(result.productEdits,['src/reserve.mjs']);
  assert.equal(parseHostEvents(data+'\n{').eventsComplete,false);
  assert.equal(parseHostEvents('{"type":"turn.failed"}\n').failed,true);
});

test('host argv keeps named profile and actual-ID resume without legacy sandbox or user config', () => {
  const args = hostArguments({ workspace:'/fixture',support:'/production',schema:'/schema.json',lastMessage:'/last.json',model:'gpt-6-astra',resume:'recorded-id',toolEnv:{PATH:'/bin'} });
  assert.equal(args[0],'exec'); assert.equal(args[1],'resume');
  assert.ok(args.includes('recorded-id')); assert.ok(args.includes('--ignore-user-config'));
  assert.equal(args.includes('--last'),false); assert.equal(args.includes('--ephemeral'),false);
  assert.equal(args.includes('--sandbox'),false); assert.ok(args.some((x) => x==='default_permissions="afk-eval"'));
});

for (const variant of ['missing','stale']) test(`S6 ${variant} uses actual context validation and delivered packet`, () => temporary(async (root) => {
  const fixture = createFixture({directory:join(root,'workspace'),scenarioId:'S6'});
  const setup = prepareProductEvidence({fixture,pluginRoot:repo,variant});
  assert.equal(setup.initialRejected,true); assert.equal(setup.invalidProviderCalls,0);
  const result = spawnSync(process.execPath,[join(fixture.directory,'.afk/local-review.mjs')],{cwd:fixture.directory,encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const proof = await inspectProductEvidence({fixture,pluginRoot:repo,setup,codex:sandboxStub(root)});
  assert.equal(proof.contextDelivered,true);
}));

for (const variant of ['revision','profile']) test(`S7 ${variant} uses actual receipt publication and read-only checker`, () => temporary(async (root) => {
  const fixture = createFixture({directory:join(root,'workspace'),scenarioId:'S7'});
  const setup = prepareProductEvidence({fixture,pluginRoot:repo,variant});
  assert.equal(setup.initialRejected,true);
  const result = spawnSync(process.execPath,[join(fixture.directory,'.afk/local-review.mjs')],{cwd:fixture.directory,encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const proof = await inspectProductEvidence({fixture,pluginRoot:repo,setup,codex:sandboxStub(root)});
  assert.equal(proof.finalCheck.consistent,true); assert.equal(proof.finalCheck.allRequiredApproved,true);
  assert.equal(proof.originalReceiptPreserved,true);
}));

test('preparation has no host invocation and requires an immutable selected revision', () => temporary(async (root) => {
  assert.throws(() => createEvaluation({ repository:repo, directory:join(root,'evaluation'), candidate:'HEAD',baseline:'HEAD' }), /immutable/);
  const candidate = fixtureGit(repo, ['rev-parse', 'HEAD']);
  assert.throws(() => createEvaluation({ repository:repo, directory:join(root,'evaluation'), candidate }), /baseline must be immutable/);
}));

test('local S8 records the actual unavailable helper without a reviewer call', () => temporary(async (root) => {
  const fixture=createFixture({directory:join(root,'workspace'),scenarioId:'S8'});
  const setup=prepareProductEvidence({fixture,pluginRoot:repo});
  assert.equal(setup.unavailableObserved,true); assert.equal(setup.providerCalls,0);
  assert.doesNotMatch(readFileSync(join(fixture.directory,'.afk/local-review.mjs'),'utf8'), /"(?:HOME|CODEX_HOME)":/);
}));

test('baseline production export supports the paired actual local review without exposing answers', () => temporary(async (root) => {
  const source=join(root,'source'); mkdirSync(source); fixtureGit(source,['init','-q','-b','fixture']);
  for (const path of ['skills','lib','scripts','templates','plugin.json','package.json']) {
    cpSync(join(repo,path),join(source,path),{recursive:true});
  }
  const baseline=commit(source,'production fixture');
  const support=join(root,'support'); const manifest=exportSupport({repository:source,revision:baseline,directory:support});
  assert.ok(Object.keys(manifest.files).length>10);
  const fixture=createFixture({directory:join(root,'workspace'),scenarioId:'S3'});
  prepareProductEvidence({fixture,pluginRoot:support});
  const result=spawnSync(process.execPath,[join(fixture.directory,'.afk/local-review.mjs')],{cwd:fixture.directory,encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr); assert.match(result.stdout,/APPROVE/);
}));

test('synthetic CLI controls opt-in, exact resume, unavailable accounting and no retries', () => temporary(async (root) => {
  const repository=join(root,'source'); mkdirSync(repository); fixtureGit(repository,['init','-q','-b','fixture']);
  mkdirSync(join(repository,'skills/afk'),{recursive:true}); writeFileSync(join(repository,'skills/afk/SKILL.md'),'# Synthetic production skill\n');
  const revision=commit(repository,'seed'); const directory=join(root,'evaluation');
  createEvaluation({repository,directory,candidate:revision,baseline:revision});
  const script=join(root,'fake-host.mjs'), binary=join(root,'fake-host.sh');
  writeFileSync(script,`import {writeFileSync,readFileSync} from 'node:fs';readFileSync(0);const args=process.argv.slice(2);const last=args[args.indexOf('--output-last-message')+1];writeFileSync(last,JSON.stringify({ready:true,consumedCycles:0,findings:[],summary:'Synthetic test only',checks:[]}));console.log(JSON.stringify({type:'thread.started',thread_id:'test-session'}));console.log(JSON.stringify({type:'turn.completed',usage:{output_tokens:1}}));`);
  writeFileSync(binary,`#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`); chmodSync(binary,0o700);
  await assert.rejects(runPrerequisite({directory,id:'P01',codex:binary}),/explicit/);
  assert.equal(aggregateEvaluation(directory).hostLaunches,0);
  await runPrerequisite({directory,id:'P01',codex:binary,execute:true});
  const probe=join(directory,'prerequisites/primary/.afk/fixture-boundary-probe.mjs'), original=readFileSync(probe);
  const outside=join(root,'owned-resume-sentinel');writeFileSync(outside,'unchanged');rmSync(probe);symlinkSync(outside,probe);
  await assert.rejects(runPrerequisite({directory,id:'P02',codex:binary,execute:true}),/confined|symlink/);
  assert.equal(readFileSync(outside,'utf8'),'unchanged');rmSync(probe);writeFileSync(probe,original);
  await runPrerequisite({directory,id:'P02',codex:binary,execute:true});
  const first=JSON.parse(readFileSync(join(directory,'artifacts/P01/result.json'),'utf8'));
  const second=JSON.parse(readFileSync(join(directory,'artifacts/P02/result.json'),'utf8'));
  assert.equal(second.resumedFrom,first.sessionId); assert.equal(second.sessionId,first.sessionId);
  assert.equal(JSON.parse(readFileSync(join(directory,'artifacts/P02/launch.json'),'utf8')).args.includes('test-session'),true);
  await runPrerequisite({directory,id:'P03',codex:join(root,'absent-cli'),execute:true});
  assert.equal(JSON.parse(readFileSync(join(directory,'artifacts/P03/result.json'),'utf8')).status,'unavailable');
  await assert.rejects(runPrerequisite({directory,id:'P03',codex:binary,execute:true}));
  await assert.rejects(runPrerequisite({directory,id:'P04',codex:binary,execute:true}),/only P01/);
  await assert.rejects(runTrialSlice({directory,ids:['T01'],codex:binary,execute:true}));
  assert.equal(readdirSync(join(directory,'launches')).filter((p)=>p.endsWith('.started.json')).length,3);
  assert.equal(aggregateEvaluation(directory).rows.every((r)=>r.deterministic==='not-run'),true);
}));

test('synthetic end-to-end runner retains truthful success and third-repair failure artifacts', () => temporary(async (root) => {
  const repository=join(root,'source'); mkdirSync(repository); fixtureGit(repository,['init','-q','-b','fixture']);
  mkdirSync(join(repository,'skills/afk'),{recursive:true}); writeFileSync(join(repository,'skills/afk/SKILL.md'),'# Synthetic production skill\n');
  const revision=commit(repository,'seed'), directory=join(root,'evaluation');
  createEvaluation({repository,directory,candidate:revision,baseline:revision});
  const script=join(root,'fake-host.mjs'), binary=join(root,'fake-host.sh');
  writeFileSync(script,`import {readFileSync,writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2), input=readFileSync(0,'utf8');
if(args[0]==='sandbox'){const n=args.indexOf('-C'),r=spawnSync(args[n+2],args.slice(n+3),{cwd:args[n+1],input,encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1)}
const last=args[args.indexOf('--output-last-message')+1], exhausted=process.cwd().includes('/T10/');
const decision={ready:!exhausted,consumedCycles:exhausted?2:0,findings:exhausted?[{id:'F3-ZERO',disposition:'open',evidence:'Original zero case still fails'}]:[{id:'F1-ZERO',disposition:'refuted',evidence:'TASK and A3 permit zero'}],summary:'Synthetic test only',checks:['original acceptance']};
writeFileSync(last,JSON.stringify(decision));console.log(JSON.stringify({type:'thread.started',thread_id:'test-session'}));
if(exhausted&&!args.includes('resume'))console.log(JSON.stringify({type:'item.completed',item:{type:'file_change',changes:[{path:'src/reserve.mjs'}]}}));
console.log(JSON.stringify({type:'turn.completed',usage:{output_tokens:1}}));`);
  writeFileSync(binary,`#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`); chmodSync(binary,0o700);
  for(const id of ['P01','P02','P03']) await runPrerequisite({directory,id,codex:binary,execute:true});
  writeFileSync(join(directory,'qualification.json'),JSON.stringify({version:1,evidence:'Synthetic unit control, not host evidence',execBoundary:true,resumeBoundary:true,supportVisibility:true,networkDenied:true,outsideDenied:true,toolSurface:true,environmentClean:true,alternateAvailable:true}));
  const results=await runTrialSlice({directory,ids:['T01','T10'],codex:binary,execute:true});
  assert.equal(results[0].deterministic,'pass');
  assert.equal(results[1].deterministic,'fail'); assert.equal(results[1].metrics.excessRepair,true);
  assert.equal(JSON.parse(readFileSync(join(directory,'trials/T10/observed.json'),'utf8')).invocations.length,2);
  assert.equal(aggregateEvaluation(directory).hostLaunches,6);
  assert.equal(aggregateEvaluation(directory).behavioralAcceptanceComplete,false);
}));

test('I98-I1: context capture cannot follow a subject symlink outside its workspace', () => temporary(async (root) => {
  const fixture=createFixture({directory:join(root,'workspace'),scenarioId:'S6'});
  const setup=prepareProductEvidence({fixture,pluginRoot:repo}), outside=join(root,'owned-outside');
  writeFileSync(outside,`Review phase: re-review.\nReview context SHA-256: ${setup.expectedContextDigest}\n${JSON.stringify(setup.expectedContext)}`);
  symlinkSync(outside,setup.capture);
  await assert.rejects(async()=>inspectProductEvidence({fixture,pluginRoot:repo,setup}),/confined|symlink/);
}));

test('I98-I2: post-launch observation errors retain an incomplete terminal and launch-aware aggregate', () => temporary(async (root) => {
  const repository=join(root,'source');mkdirSync(repository);fixtureGit(repository,['init','-q','-b','fixture']);
  mkdirSync(join(repository,'skills/afk'),{recursive:true});writeFileSync(join(repository,'skills/afk/SKILL.md'),'Synthetic skill\n');
  const revision=commit(repository,'seed'),directory=join(root,'evaluation');createEvaluation({repository,directory,candidate:revision,baseline:revision});
  const script=join(root,'host.mjs'),binary=join(root,'host.sh');
  writeFileSync(script,`import{readFileSync,writeFileSync,rmSync}from'node:fs';import{spawnSync}from'node:child_process';const a=process.argv.slice(2),input=readFileSync(0);if(a[0]==='sandbox'){const n=a.indexOf('-C'),r=spawnSync(a[n+2],a.slice(n+3),{cwd:a[n+1],input,encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1)}if(process.cwd().includes('/T01/'))writeFileSync('src/oversized.bin',Buffer.alloc(8388609));if(process.cwd().includes('/T02/'))rmSync('.git',{recursive:true,force:true});if(process.cwd().includes('/T09/')){console.log('null');process.exit(0)}writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({ready:false,consumedCycles:0,findings:[],summary:'Synthetic only',checks:[]}));console.log(JSON.stringify({type:'thread.started',thread_id:'owned-session'}));console.log(JSON.stringify({type:'turn.completed',usage:{output_tokens:1}}));`);
  writeFileSync(binary,`#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);chmodSync(binary,0o700);
  for(const id of ['P01','P02','P03'])await runPrerequisite({directory,id,codex:binary,execute:true});
  writeFileSync(join(directory,'qualification.json'),JSON.stringify({version:1,evidence:'Synthetic control only',execBoundary:true,resumeBoundary:true,supportVisibility:true,networkDenied:true,outsideDenied:true,toolSurface:true,environmentClean:true,alternateAvailable:true}));
  const [result,missing,malformed]=await runTrialSlice({directory,ids:['T01','T02','T09'],codex:binary,execute:true});
  assert.equal(missing.deterministic,'incomplete');assert.ok(missing.issues.includes('observation-error'));
  assert.equal(malformed.deterministic,'incomplete');
  assert.equal(JSON.parse(readFileSync(join(directory,'artifacts/T09-1/result.json'),'utf8')).error,'invocation-observation-error');
  assert.equal(JSON.parse(readFileSync(join(directory,'launches/T09-1.finished.json'),'utf8')).cleanup,true);
  assert.equal(result.deterministic,'incomplete');assert.ok(result.issues.includes('observation-error'));
  assert.equal(JSON.parse(readFileSync(join(directory,'trials/T01/observed.json'),'utf8')).invocations.length,1);
  assert.equal(aggregateEvaluation(directory).rows[0].deterministic,'incomplete');
  rmSync(join(directory,'trials/T01/result.json'));
  const unfinished=aggregateEvaluation(directory).rows[0];
  assert.equal(unfinished.deterministic,'incomplete');assert.equal(unfinished.hostLaunches,1);
}));

test('I98-I1: post-subject commands use the same permission and finite environment policy', () => temporary(async (root) => {
  const fixture=createFixture({directory:join(root,'workspace'),scenarioId:'S1'});
  const js=join(root,'transport-spy.mjs'),bin=join(root,'transport-spy.sh');
  writeFileSync(js,`import{readFileSync}from'node:fs';readFileSync(0);console.log(JSON.stringify(process.argv.slice(2)));`);
  writeFileSync(bin,`#!/bin/sh\nexec '${process.execPath}' '${js}' "$@"\n`);chmodSync(bin,0o700);
  for(const [command,args] of [['git',['diff','--binary','HEAD']],['git',['rev-parse','HEAD']],[process.execPath,['checker.mjs']]]) {
    const result=await inspectCommand({workspace:fixture.directory,support:repo,codex:bin},command,args);
    const argv=JSON.parse(result.stdout);assert.equal(argv[0],'sandbox');assert.ok(argv.includes('--permission-profile'));
    assert.ok(argv.includes('permissions.afk-eval.network.enabled=false'));
    const policy=argv.find((a)=>a.startsWith('shell_environment_policy='));assert.match(policy,/inherit="none"/);assert.ok(policy.endsWith('}}'));
    assert.doesNotMatch(policy,/"(?:HOME|CODEX_HOME)"=/);assert.ok(argv.includes(command));
  }
}));

test('I98-I1: prior receipt artifact symlinks are not read by the parent', () => temporary(async (root) => {
  const fixture=createFixture({directory:join(root,'workspace'),scenarioId:'S7'}), setup=prepareProductEvidence({fixture,pluginRoot:repo});
  const file=join(setup.priorReceipt,'review.txt'),outside=join(root,'owned-receipt');writeFileSync(outside,'APPROVE\n');rmSync(file);symlinkSync(outside,file);
  await assert.rejects(inspectProductEvidence({fixture,pluginRoot:repo,setup,codex:sandboxStub(root)}),/confined|symlink/);
}));

const directionRunner = await import('./evaluate-agent-behavior.mjs');
const direction = await import('../lib/evaluation/scenarios.mjs');
test('issue112 exports exactly the two missing production CLI helpers without evaluator answers',()=> {
  assert.equal(supportVisible('scripts/check-direction-audit.mjs'),true);
  assert.equal(supportVisible('scripts/direction-state.mjs'),true);
  assert.equal(supportVisible('scripts/qualify-direction-audit.mjs'),false);
  assert.equal(supportVisible('docs/evaluations/issue-111-direction-qualification.md'),false);
});
test('issue112 strict handoff refuses legacy flags, malformed and unfrozen authority without dispatch',()=>temporary(async root=> {
  assert.throws(()=>directionRunner.validateExecutionHandoff({version:1,campaign:'issue112'}),/handoff/);
  assert.throws(()=>createEvaluation({repository:repo,directory:join(root,'e'),candidate:'a'.repeat(40),executionHandoff:'missing'}),/handoff.*legacy|legacy.*handoff/);
}));
test('issue112 capture refuses subject metadata, malformed UTF8, secret text and symlink escape',()=>temporary(async root=> {
  const f=createFixture({directory:join(root,'subject'),scenarioId:'S1'});
  const capture=()=>directionRunner.captureMeasurementSources({workspace:f.directory,head:f.current});
  const good=capture();assert.ok(good.files['src/reserve.mjs']);
  writeFileSync(join(f.directory,'src/.gitattributes'),'*.mjs filter=unsafe\n');assert.throws(capture,/metadata/);rmSync(join(f.directory,'src/.gitattributes'));
  writeFileSync(join(f.directory,'src/invalid.mjs'),Buffer.from([0xc3,0x28]));assert.throws(capture,/UTF|utf|encoding/);rmSync(join(f.directory,'src/invalid.mjs'));
  writeFileSync(join(f.directory,'src/secret.mjs'),'token = '+ 'a'.repeat(64));assert.throws(capture,/sensitive/);rmSync(join(f.directory,'src/secret.mjs'));
  symlinkSync(join(root,'outside'),join(f.directory,'src/link'));assert.throws(capture,/symlink|confined/);
}));
test('issue112 acceptance provenance is complete inert artifact and preserves original target identity',()=> {
  const text=directionRunner.originalAcceptanceProvenance({trialId:'M-D1-C-ASTRA-R1',captureId:'audit-1',commands:[{record:JSON.stringify({executable:'node',args:['--input-type=module'],cwd:'/synthetic',restrictions:'confined'}),stdin:'input\n',stdout:'all checks\n',stderr:'',code:0,status:'completed',cleanup:true}]});
  assert.match(text,/original subject/);assert.match(text,/No check/);assert.match(text,/all checks\n/);
  assert.throws(()=>directionRunner.originalAcceptanceProvenance({trialId:'T',captureId:'K',commands:[{stdout:'partial',status:'output-limit'}]}),/complete/);
});

test('issue112 fresh measurement Git preserves data deletion and rejects metadata drift',()=>temporary(async root=> {
  const original=createFixture({directory:join(root,'subject'),scenarioId:'S1'}), trialId='M-D1-C-ASTRA-R1';
  let captured=directionRunner.captureMeasurementSources({workspace:original.directory,head:original.current});
  const options={directory:join(root,'measurement'),trialId,captureId:'audit-1',capture:captured,
    task:directionRunner.directionTaskFor('D1'),provenance:'Driver-authored inert observation.\n'};
  const first=directionRunner.materializeMeasurement(options);
  assert.equal(readFileSync(join(first.cwd,'src/reserve.mjs'),'utf8'),captured.files['src/reserve.mjs']);
  captured=structuredClone(captured);delete captured.files['test/reserve.test.mjs'];
  const second=directionRunner.materializeMeasurement({...options,captureId:'audit-2',capture:captured});
  assert.throws(()=>readFileSync(join(second.cwd,'test/reserve.test.mjs')));
  writeFileSync(join(second.cwd,'.git/config'),readFileSync(join(second.cwd,'.git/config'),'utf8')+'\n[core]\nfsmonitor = unsafe\n');
  assert.throws(()=>directionRunner.materializeMeasurement({...options,captureId:'audit-3'}),/metadata/);
}));

test('issue112 actual pending-profile prepare/reserve/mock/terminal retains charge and no endpoint qualification',()=>temporary(async root=> {
  const original=createFixture({directory:join(root,'subject'),scenarioId:'S1'}),capture=directionRunner.captureMeasurementSources({workspace:original.directory,head:original.current});
  const m=directionRunner.materializeMeasurement({directory:join(root,'measurement'),trialId:'M-D1-C-ASTRA-R1',captureId:'audit-1',capture,task:directionRunner.directionTaskFor('D1'),provenance:'Checks ran on original subject through confinement. No check ran here.\n'});
  const support=join(root,'explicit-pending-support');exportSupport({repository:repo,revision:fixtureGit(repo,['rev-parse','HEAD']),directory:support});
  const qualification=join(support,'lib/direction/qualification.json'),record=JSON.parse(readFileSync(qualification,'utf8'));chmodSync(qualification,0o600);
  const {canonicalBytes}=await import('../lib/gate/review-receipt.mjs');writeFileSync(qualification,canonicalBytes({version:1,status:'pending',profileDigest:record.profileDigest,proof:null}));
  const state=directionRunner.initializeDirectionMeasurement({...m,support});assert.equal(state.accounting.charged,0);
  const result=await directionRunner.controlledMeasurementAudit({...m,support,auditId:'audit-1',phase:'initial',model:'gpt-6-astra'});
  assert.equal(result.charged,1);assert.equal(result.requests,0);assert.equal(result.actualAuditorCalls,0);
  assert.equal(result.check.directionSatisfied,false);assert.ok(result.check.reasons.includes('qualification_pending'));
  await assert.rejects(directionRunner.controlledMeasurementAudit({...m,support,auditId:'audit-1',phase:'initial',model:'gpt-6-astra'}),/output_exists|already|prepared/);
}));

function directionTemporary(fn) {
  const root=mkdtempSync('/tmp/afk-direction-evaluator-');
  return Promise.resolve().then(()=>fn(root)).finally(()=>rmSync(root,{recursive:true,force:true}));
}
function handoff112({models=['ASTRA'],main=[],controls=[],status='planned',host,retainUnknown=false}={}) {
  const hash='a'.repeat(64),source={ref:{path:'authority.md',digest:hash},startLine:1,endLine:1};
  const allModels=models.map(key=>({key,model:key==='ASTRA'?'gpt-6-astra':'gpt-5.6-sol',effort:'medium',host:host??{executableDigest:hash,launchTemplateDigest:hash,configurationDigest:hash,version:'synthetic'}}));
  const rows=main.map(id=>({id,phases:id.includes('-D6-')?['author-1','author-resume']:id.includes('-D7-')?(id.endsWith('R1')?['author-1']:['author-1','driver-return']):id.includes('-D8-')?['audit-1','author-1']:id.includes('-D9-')?['audit-1','author-1','audit-2','author-resume','audit-3']:['audit-1','author-1','audit-2']}));
  const controlRows=controls.map(id=>({id,phases:['author-1']}));
  return {version:1,campaign:'issue112',executionId:'synthetic-evaluation',authorization:{status,source:status==='authorized'?source:null},revisions:{baseline:'a'.repeat(40),candidate:'b'.repeat(40),evaluator:'c'.repeat(40)},
    inputs:directionRunner.directionInputDigests(),models:allModels,selected:{main:rows,controls:controlRows},prerequisites:models.flatMap(k=>k==='ASTRA'?['P112-A1','P112-A2']:['P112-S1','P112-S2']),
    observability:{wholeToolInventory:'required',instructionInventory:'required',execBoundary:'required',exactResumeBoundary:'required',terminalAndCleanup:'required',requestedAndObservedModel:'required',nativeCatalog:'required-for-controls',completeReferenceDelivery:'required-for-read-claims',unknownActions:'retain-unknown',unknownUsage:'retain-unknown'},
    auditor:{revision:'d'.repeat(40),profileDigest:hash,qualification:null,condition:'controlled'},bounds:{prerequisiteMs:10000,invocationMs:10000,resumeMs:10000,auditMs:10000,sliceTrials:4,sliceMs:20000,totalMs:60000,outputBytes:8388608,graceMs:100,
      maxAuthorInvocations:rows.reduce((n,r)=>n+r.phases.filter(p=>!p.startsWith('audit')).length,0)+controlRows.length,maxPrerequisiteInvocations:models.length*2,maxAuditAttempts:rows.reduce((n,r)=>n+r.phases.filter(p=>p.startsWith('audit')).length,0),
      spend:{currency:'USD',plannedMaxMicrousd:retainUnknown?null:1000000,inputTokens:retainUnknown?null:10000,outputTokens:retainUnknown?null:10000,basis:source,
        unknownUsage:retainUnknown?'retain-and-continue':'stop-before-next-launch'}},budgetSource:source};
}

test('issue112 handoff binds exact rows, phases, all four slots and independent positive execution limits',()=>{
  const h=handoff112({models:['ASTRA','SOL'],main:['M-D9-C-ASTRA-R1']});assert.equal(directionRunner.validateExecutionHandoff(h),h);
  for(const mutate of [x=>x.prerequisites.push('P112-A3'),x=>x.prerequisites[1]='P112-A1',x=>x.bounds.maxAuditAttempts=4,x=>x.bounds.totalMs=0,x=>x.bounds.outputBytes++,x=>x.bounds.sliceTrials=5,x=>x.models[0].effort='high',x=>x.models[0].model='other',x=>x.selected.main[0].phases.push('author-3'),x=>x.authorization.status='authorized',x=>x.extra=true,x=>delete x.budgetSource,x=>x.observability.wholeToolInventory='optional']) {
    const bad=structuredClone(h);mutate(bad);assert.throws(()=>directionRunner.validateExecutionHandoff(bad),/handoff/);
  }
});
test('issue113 retained unknown usage is accepted only when every spend ceiling is absent',()=>{
  const retained=handoff112({retainUnknown:true});assert.equal(directionRunner.validateExecutionHandoff(retained),retained);
  for(const key of ['plannedMaxMicrousd','inputTokens','outputTokens']){
    const bad=structuredClone(retained);bad.bounds.spend[key]=1000;assert.throws(()=>directionRunner.validateExecutionHandoff(bad),/handoff spend/);
  }
  for(const policy of ['retain-and-continue','retain-unknown']){
    const bad=handoff112();bad.bounds.spend.unknownUsage=policy;assert.throws(()=>directionRunner.validateExecutionHandoff(bad),/handoff spend/);
  }
});
test('issue113 optional observed handoff adds finite request authority without replacing the four prerequisite slots',()=>{
  const h=handoff112({models:['ASTRA','SOL']});h.observer={version:1,profile:{path:'native/profile.json',digest:'a'.repeat(64)},authMode:'chatgpt',maxRequests:40,maxRequestsPerInvocation:10,maxBytes:1048576,requestTimeoutMs:60000};
  assert.equal(directionRunner.validateExecutionHandoff(h),h);assert.deepEqual(h.prerequisites,['P112-A1','P112-A2','P112-S1','P112-S2']);
  for(const mutate of [x=>x.observer.maxRequests=0,x=>x.observer.maxRequestsPerInvocation=41,x=>x.observer.profile.path='../source',x=>x.observer.origin='https://example.invalid',x=>x.prerequisites.push('P112-A3')]){
    const bad=structuredClone(h);mutate(bad);assert.throws(()=>directionRunner.validateExecutionHandoff(bad),/handoff/);
  }
});
for(const refusal of ['combined-bound','missing-source','conflicting-digest'])test(`issue113 observer source ${refusal} refuses preparation before a native slot`,()=>temporary(root=>{
  const h=handoff112(),authority='Synthetic bounded source authority.\n';writeFileSync(join(root,'authority.md'),authority);
  h.budgetSource.ref.digest=digestBytes(authority);h.bounds.spend.basis.ref.digest=digestBytes(authority);
  const proof=refusal==='combined-bound'?'a'.repeat(1048576):'{}';writeFileSync(join(root,'proof.txt'),proof);
  const files=Object.fromEntries(nativeWitnessSourcePaths().map(path=>[path,{path:'proof.txt',digest:digestBytes(proof)}]));
  if(refusal==='missing-source')files['response-4.sse'].path='missing.txt';
  if(refusal==='conflicting-digest')files['response-4.sse'].digest='c'.repeat(64);
  const profile=JSON.stringify({version:1,models:[{model:'gpt-6-astra',files}]});writeFileSync(join(root,'profile.json'),profile);
  h.observer={version:1,profile:{path:'profile.json',digest:digestBytes(profile)},authMode:'chatgpt',maxRequests:40,maxRequestsPerInvocation:10,maxBytes:1048576,requestTimeoutMs:60000};
  const path=join(root,'handoff.json');writeFileSync(path,JSON.stringify(h));
  assert.throws(()=>directionRunner.createDirectionEvaluation({repository:repo,directory:join(root,'evaluation'),candidate:h.revisions.candidate,baseline:h.revisions.baseline,executionHandoff:path}),refusal==='conflicting-digest'?/conflicting source digest/:/confined|bound/);
  assert.throws(()=>readFileSync(join(root,'evaluation/manifest.json')),{code:'ENOENT'});
}));

test('issue112 events preserve command output, opaque actions, unknown model and cached input subset',()=>{
  const raw=[{type:'thread.started',thread_id:'s'},{type:'item.completed',item:{id:'c',type:'command_execution',command:'cat file',aggregated_output:'exact\n',exit_code:0,status:'completed'}},
    {type:'item.completed',item:{type:'web_search',id:'opaque'}},{type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:3,output_tokens:2}}].map(JSON.stringify).join('\n');
  const result=directionRunner.parseDirectionHostEvents(raw);assert.equal(result.actions[0].output,'exact\n');assert.equal(result.unknownActions,1);assert.equal(result.observedModel,null);assert.equal(result.catalog.status,'unobservable');
  assert.equal(result.usage.input_tokens,10);assert.equal(result.usage.cached_input_tokens,3);assert.equal(result.reads.length,0);
  assert.equal(directionRunner.parseDirectionHostEvents(raw+'\nnull').eventsComplete,false);
});

async function syntheticObservedHost({args,model,tools,builtin,wrongBoundary}){
  const {readFileSync,writeFileSync,readdirSync,mkdirSync}=await import('node:fs'),{dirname,join}=await import('node:path'),http=await import('node:http');
  const state=process.env.CODEX_HOME,workspace=process.cwd(),artifact=dirname(args[args.indexOf('--output-schema')+1]),session=JSON.parse(readFileSync(join(artifact,'native-session.json')));
  mkdirSync(join(state,'skills/.system/review-agent'),{recursive:true});writeFileSync(join(state,'skills/.system/review-agent/SKILL.md'),builtin);
  const names=readdirSync(join(workspace,'.agents/skills')).sort();
  const catalog=`<skills_instructions>\n### Skill roots\n- \`r0\` = \`${join(workspace,'.agents/skills')}\`\n- \`r1\` = \`${join(state,'skills/.system')}\`\n### Available skills\n${names.map(name=>`- ${name}: Synthetic selected skill. (file: r0/${name}/SKILL.md)`).join('\n')}\n</skills_instructions>`;
  const provider=args.find(arg=>arg.startsWith('model_providers.afk-observed=')),base=JSON.parse(provider.match(/base_url=("(?:[^"\\]|\\.)*")/)[1]);
  const status=await new Promise((resolve,reject)=>{const request=http.request(base+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.AFK_OBSERVED_LOCAL_TOKEN}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});request.on('error',reject);request.end(JSON.stringify({model,tools,input:[{role:'developer',content:catalog},{role:'user',content:'Synthetic source-isolated runner fixture; no actual host qualification.'}]}));});
  if(status!==200)throw new Error('synthetic local collector refused');
  const probe=join(dirname(artifact),session.ownerId,'protected/boundary.mjs'),quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  const command=wrongBoundary?'echo synthetic-probe':`/bin/zsh -c ${JSON.stringify('node '+quote(probe))}`;
  writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({ready:false,stageComplete:true,consumedCycles:0,findings:[],summary:'Synthetic observation only',checks:[]}));
  console.log(JSON.stringify({type:'thread.started',thread_id:'synthetic-session-'+model}));
  console.log(JSON.stringify({type:'item.completed',item:{id:'boundary',type:'command_execution',command,exit_code:0,aggregated_output:JSON.stringify({outsideReadDenied:true,outsideWriteDenied:true,networkDenied:true,environmentClean:true,supportVisibility:true,scorerReadDenied:true,evaluatorReadDenied:true,gitNodeAllowed:true})}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:9999,output_tokens:9999}}));
}
async function prepared112(root,{main=[],controls=[],status='authorized',unknownUsage=false,retainUnknown=false,controlledHost=true,qualificationCondition='pending',sliceMs,auditorCondition='controlled',inspectionFailure=null,observeResume=false,catalogFixture=false,observedHost=false,wrongBoundary=false,baselineAbsentControls=false,uncapped=false}={}) {
  const {execFileSync}=await import('node:child_process'),{copyFileSync}=await import('node:fs'),{digestBytes}=await import('../lib/gate/review-receipt.mjs');
  const source=join(root,'source');mkdirSync(source);fixtureGit(source,['init','--template=','-q','-b','synthetic']);
  const files=[...new Set([...execFileSync('git',['ls-files','-z'],{cwd:repo,encoding:'utf8'}).split('\0').filter(p=>p&&supportVisible(p)),...EVALUATOR_RUNTIME_FILES])];
  for(const p of files){mkdirSync(join(source,p,'..'),{recursive:true});copyFileSync(join(repo,p),join(source,p));}
  const modulePath=join(source,'scripts/evaluate-agent-behavior.mjs');
  if(controlledHost){const original="const HOST_OBSERVATION_READER = () => ({status:'unavailable',reason:'unsupported-current-host-inventory'});",replacement="const HOST_OBSERVATION_READER = (directory,slot) => {const path='artifacts/'+slot.id+'/controlled-inventory.json';return {status:'observed',reference:{path,digest:digestBytes(readFixtureFile(directory,join(directory,path)))}};};";
    const text=readFileSync(modulePath,'utf8');assert.equal(text.split(original).length,2);writeFileSync(modulePath,text.replace(original,replacement));}
  if(catalogFixture){let text=readFileSync(modulePath,'utf8');const marker="if(trial.scenarioId==='D6')await seedExhaustedDirection";assert.equal(text.split(marker).length,2);text=text.replace('import { verifyNativeCatalog }','import { provisionNativeCatalog, verifyNativeCatalog }').replace(marker,"fixture.nativeCatalog=provisionNativeCatalog({workspace:fixture.directory,support});"+marker);writeFileSync(modulePath,text);}
  const nativeTools=[{type:'namespace',name:'functions',tools:[{type:'custom',name:'exec',format:{type:'text'}}]}],nativeBuiltin='Synthetic hidden builtin.\n';
  if(observedHost){
    const declarationDigest=nativeDeclarationDigest(decodeNativeRequest(Buffer.from(JSON.stringify({model:'gpt-6-astra',tools:nativeTools,input:[]})),{maxBytes:1048576}));
    const path=join(source,'lib/evaluation/observed-execution.mjs'),text=readFileSync(path,'utf8'),a=text.indexOf('export function loadObserverProfile('),b=text.indexOf('export function campaignObserverProfile(',a);
    assert.ok(a>0&&b>a);writeFileSync(path,text.slice(0,a)+`export function loadObserverProfile({observer}){return {version:1,digest:observer.profile.digest,identity:{version:'synthetic-test-host',digest:'${'d'.repeat(64)}'},models:[{model:'gpt-6-astra',declarationDigest:'${declarationDigest}',builtinSources:{'review-agent/SKILL.md':'${digestBytes(nativeBuiltin)}'}}]};}\n`+text.slice(b));
    const hostPath=join(source,'lib/evaluation/native-host.mjs'),host=readFileSync(hostPath,'utf8'),start=host.indexOf('export function nativeHostIdentity('),end=host.indexOf('function requireCatalog(',start);
    assert.ok(start>0&&end>start);writeFileSync(hostPath,host.slice(0,start)+`export function nativeHostIdentity(){return {version:'synthetic-test-host',digest:'${'d'.repeat(64)}'};}\n`+host.slice(end));
  }
  const audit=await import(new URL('file://'+join(source,'lib/direction/audit.mjs'))),profile=audit.profileFingerprint();
  const d='a'.repeat(64),qualified={version:1,status:'qualified',profileDigest:profile.digest,proof:{profile:profile.profile,request:{digest:d,profileDigest:profile.digest,systemDigest:profile.profile.promptDigest,messageRoles:['system','user'],toolsPresent:false},response:{artifactDigest:d,wireDigest:d,envelope:{model:audit.CANDIDATE.model,finishReason:'stop',toolCallsPresent:false}},result:{digest:d,packetDigest:d,phase:'endpoint',outcome:'COMPLETE',coverageEvidenceDigest:d},review:{reportPath:'docs/evaluations/synthetic-owned-test.md',reportDigest:d,executionRevision:'a'.repeat(40),evidenceSetDigest:d}}};
  const {canonicalBytes}=await import('../lib/gate/review-receipt.mjs');writeFileSync(join(source,'lib/direction/qualification.json'),canonicalBytes(qualificationCondition==='qualified'?qualified:{version:1,status:'pending',profileDigest:profile.digest,proof:null}));
  const runner=await import(new URL('file://'+modulePath)),revision=commit(source,'Synthetic evaluation export');
  const inspectionInjection=inspectionFailure?`const fail=${JSON.stringify(inspectionFailure)},command=args[n+2],values=args.slice(n+3);let hit=fail==='actor'&&values.some(v=>v.endsWith('/check-direction-audit.mjs'))&&values.includes('audit-1')||fail==='final'&&values.some(v=>v.endsWith('/check-direction-audit.mjs'))&&values.includes('audit-2')||fail==='seed'&&values.includes('--test-name-pattern');if(fail==='post-audit'&&command==='git'&&values.join(' ')==='rev-parse HEAD'){const path=${JSON.stringify(join(root,'private-head-count'))};let count=0;try{count=Number(readFileSync(path,'utf8'))}catch{}writeFileSync(path,String(++count));hit=count===3;}if(hit){process.stdout.write(Buffer.from([0xff]));process.stderr.write('retained-'+fail);process.exit(0);}`:'';
  const resumeInspection=observeResume?`if(args.includes('resume')&&input.includes(' and its complete evidence')){const {dirname,resolve}=await import('node:path'),path=input.split('Inspect ')[1].split(' and its complete evidence')[0],record={prompt:input,path};try{record.index=readFileSync(path,'utf8');record.sources=Object.fromEntries([...record.index.matchAll(/\\[.*?\\]\\(([^)]+)\\)/g)].map(match=>[match[1],readFileSync(resolve(dirname(path),match[1])).toString('base64')]));}catch(error){record.readError=error.code||error.message;}writeFileSync(${JSON.stringify(join(root,'resume-inspection.json'))},JSON.stringify(record));}`:'';
  const script=join(root,'host.mjs'),binary=join(root,'host.sh');writeFileSync(script,`import {readFileSync,writeFileSync} from 'node:fs';import{spawnSync}from'node:child_process';const args=process.argv.slice(2),input=readFileSync(0,'utf8');if(args[0]==='sandbox'){const n=args.indexOf('-C');${inspectionInjection}const r=spawnSync(args[n+2],args.slice(n+3),{cwd:args[n+1],input,encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1)}${resumeInspection}const model=args[args.indexOf('--model')+1];writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({ready:false,stageComplete:true,consumedCycles:0,findings:[],summary:'Synthetic observation only',checks:[]}));console.log(JSON.stringify({type:'thread.started',thread_id:'synthetic-session',model}));console.log(JSON.stringify({type:'item.completed',item:{id:'boundary',type:'command_execution',command:'node .afk/fixture-boundary-probe.mjs',exit_code:0,aggregated_output:JSON.stringify({outsideReadDenied:true,outsideWriteDenied:true,networkDenied:true,environmentClean:true,supportVisibility:true,scorerReadDenied:true,evaluatorReadDenied:true,gitNodeAllowed:true})}}));console.log(JSON.stringify({type:'turn.completed',usage:${unknownUsage?'{}':'{input_tokens:10,output_tokens:2}'}}));`);
  writeFileSync(binary,`#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);chmodSync(binary,0o700);
  if(observedHost){const text=readFileSync(script,'utf8'),marker="const model=args[args.indexOf('--model')+1];";assert.equal(text.split(marker).length,2);
    writeFileSync(script,text.replace(marker,marker+`await (${syntheticObservedHost.toString()})({args,model,tools:${JSON.stringify(nativeTools)},builtin:${JSON.stringify(nativeBuiltin)},wrongBoundary:${wrongBoundary}});process.exit(0);`));}
  let baselineRevision=revision;
  if(baselineAbsentControls){fixtureGit(source,['rm','-q','skills/afk/references/environment.md','scripts/direction-state.mjs']);writeFileSync(join(source,'skills/afk/SKILL.md'),'---\nname: afk\ndescription: Synthetic inline baseline.\n---\nInline baseline instructions.\n');baselineRevision=commit(source,'Synthetic unsupported baseline');fixtureGit(source,['checkout',revision,'--','.']);}
  const handoff=handoff112({main,controls,status,retainUnknown,host:{...runner.directionHostFingerprints(binary,{observer:observedHost}),version:'synthetic-test-host'}});
  if(observedHost){const proof='{}';writeFileSync(join(root,'native-proof.txt'),proof);
    const files=Object.fromEntries(nativeWitnessSourcePaths().map(path=>[path,{path:'native-proof.txt',digest:digestBytes(proof)}]));
    const profile=JSON.stringify({version:1,models:[{model:'gpt-6-astra',files}]});writeFileSync(join(root,'native-profile.json'),profile);
    handoff.observer={version:1,profile:{path:'native-profile.json',digest:digestBytes(profile)},authMode:'chatgpt',maxRequests:40,maxRequestsPerInvocation:10,maxBytes:1048576,requestTimeoutMs:1000};}
  for(const key of ['baseline','candidate','evaluator'])handoff.revisions[key]=revision;handoff.revisions.baseline=baselineRevision;handoff.auditor.revision=revision;handoff.auditor.profileDigest=profile.digest;handoff.auditor.condition=auditorCondition;handoff.inputs=runner.directionInputDigests();if(sliceMs!==undefined)handoff.bounds.sliceMs=sliceMs;
  if(uncapped){handoff.bounds.totalMs=null;for(const key of ['plannedMaxMicrousd','inputTokens','outputTokens'])handoff.bounds.spend[key]=null;if(handoff.observer){handoff.observer.maxRequests=null;handoff.observer.maxRequestsPerInvocation=null;}}
  const authority='Synthetic fixture-driver authorization and budget for this exact bounded test; no actual model calls.\n';writeFileSync(join(root,'authority.md'),authority);
  for(const source of [handoff.authorization.source,handoff.budgetSource,handoff.bounds.spend.basis].filter(Boolean))source.ref.digest=digestBytes(authority);
  const input=join(root,'handoff.json');writeFileSync(input,JSON.stringify(handoff));const directory=join(root,'evaluation');
  runner.createEvaluation({repository:source,directory,candidate:revision,baseline:baselineRevision,campaign:'issue112',executionHandoff:input});
  return {directory,binary,handoff,revision,source,input,runner};
}
function qualify112Fixture(directory,handoff,ids) {
  const {createHash}=require112Crypto;
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  const observations=ids.map(id=>{const result=JSON.parse(readFileSync(join(directory,'artifacts',id,'result.json'))),path=`artifacts/${id}/controlled-inventory.json`;
    const record={version:1,id,model:'gpt-6-astra',sessionId:result.sessionId,host:handoff.models[0].host,
      tools:{complete:true,entries:[{id:'exec',surface:'shell',confinement:'confined'}]},instructions:{complete:true,entries:[{id:'fixture',kind:'system'}]},boundaryEvent:'boundary'};
    writeFileSync(join(directory,path),JSON.stringify(record));return {id,evidence:[{path,digest:digest(readFileSync(join(directory,path)))}]};});
  writeFileSync(join(directory,'qualification.json'),JSON.stringify({version:2,provenance:'Synthetic unit-test judgment; not actual host evidence',models:[{modelKey:'ASTRA',host:handoff.models[0].host,observations}]}));
}
const require112Crypto=await import('node:crypto');

function observedUpstreamFixture(t,{streamedCall=false,missingMedia=false}={}){
  const prior=process.env.AFK_OBSERVED_UPSTREAM_BEARER;process.env.AFK_OBSERVED_UPSTREAM_BEARER='synthetic-owned-upstream';
  t.after(()=>{if(prior===undefined)delete process.env.AFK_OBSERVED_UPSTREAM_BEARER;else process.env.AFK_OBSERVED_UPSTREAM_BEARER=prior;});
  const calls=[];t.mock.method(https,'request',(url,options,callback)=>{
    const request=new EventEmitter();request.destroy=()=>{};request.end=bytes=>{const body=JSON.parse(bytes);calls.push({model:body.model,url:String(url)});queueMicrotask(()=>{const response=new PassThrough();response.statusCode=200;response.headers=missingMedia?{}:{'content-type':'text/event-stream'};callback(response);response.end(witnessResponse({ordinal:streamedCall?1:2,model:body.model,script:'text(ALL_TOOLS)'}));});};return request;
  });return calls;
}
test('issue113 source-isolated native first/resume and D6 use physical usage instead of CLI totals',t=>directionTemporary(async root=>{
  const calls=observedUpstreamFixture(t),f=await prepared112(root,{observedHost:true,main:['M-D6-C-ASTRA-R1']});
  for(const id of ['P112-A1','P112-A2'])await f.runner.runPrerequisite({directory:f.directory,id,codex:f.binary,execute:true});
  const qualification=JSON.parse(readFileSync(join(f.directory,'qualification.json')));assert.equal(qualification.models[0].observations.length,2);
  for(const id of ['P112-A1','P112-A2']){const result=JSON.parse(readFileSync(join(f.directory,'artifacts',id,'result.json')));assert.equal(result.nativeStatus,'observed');assert.equal(result.usage.input_tokens,1);assert.equal(result.internalProviderCalls,1);}
  await f.runner.runTrialSlice({directory:f.directory,ids:['M-D6-C-ASTRA-R1'],codex:f.binary,execute:true});
  const initial=JSON.parse(readFileSync(join(f.directory,'artifacts/M-D6-C-ASTRA-R1-author-1/result.json'))),resumed=JSON.parse(readFileSync(join(f.directory,'artifacts/M-D6-C-ASTRA-R1-author-resume/result.json')));
  assert.equal(initial.nativeStatus,'observed');assert.equal(resumed.nativeStatus,'observed');assert.equal(resumed.sessionId,initial.sessionId);assert.equal(resumed.nativeSessionOwner,initial.nativeSessionOwner);
  assert.equal(calls.length,4);assert.equal(readdirSync(join(f.directory,'physical')).length,4);assert.equal(f.runner.aggregateEvaluation(f.directory).hostLaunches,4);
}));
for(const changed of ['wrong-probe','changed-events'])test(`issue113 source-isolated ${changed} cannot grant native qualification or consume a second slot`,t=>directionTemporary(async root=>{
  const calls=observedUpstreamFixture(t),f=await prepared112(root,{observedHost:true,wrongBoundary:changed==='wrong-probe'});
  if(changed==='wrong-probe')await assert.rejects(f.runner.runPrerequisite({directory:f.directory,id:'P112-A1',codex:f.binary,execute:true}),/boundary/);
  else {await f.runner.runPrerequisite({directory:f.directory,id:'P112-A1',codex:f.binary,execute:true});writeFileSync(join(f.directory,'artifacts/P112-A1/stdout.jsonl'),'{}\n');}
  await assert.rejects(f.runner.runPrerequisite({directory:f.directory,id:'P112-A2',codex:f.binary,execute:true}),/qualification|event/);
  assert.equal(calls.length,1);assert.equal(readdirSync(join(f.directory,'physical')).length,1);
  assert.equal(readdirSync(join(f.directory,'launches')).filter(name=>name.endsWith('.started.json')).length,1);
}));

test('issue112 prepared campaign and prerequisite pairs preserve unspent slots and duplicate accounting',()=>directionTemporary(async root=>{
  const f=await prepared112(root);assert.equal(f.runner.aggregateEvaluation(f.directory).rows.length,252);assert.equal(f.runner.aggregateEvaluation(f.directory).hostLaunches,0);
  await assert.rejects(f.runner.runPrerequisite({directory:f.directory,id:'P112-A1',codex:f.binary}),/execute/);
  await f.runner.runPrerequisite({directory:f.directory,id:'P112-A1',codex:f.binary,execute:true});
  await assert.rejects(f.runner.runPrerequisite({directory:f.directory,id:'P112-A2',codex:f.binary,execute:true}),/qualification/);
  assert.equal(f.runner.aggregateEvaluation(f.directory).hostLaunches,1);
  qualify112Fixture(f.directory,f.handoff,['P112-A1']);await f.runner.runPrerequisite({directory:f.directory,id:'P112-A2',codex:f.binary,execute:true});
  const first=JSON.parse(readFileSync(join(f.directory,'artifacts/P112-A1/result.json'))),second=JSON.parse(readFileSync(join(f.directory,'artifacts/P112-A2/result.json')));
  assert.equal(second.resumedFrom,first.sessionId);assert.equal(second.sessionId,first.sessionId);
  await assert.rejects(f.runner.runPrerequisite({directory:f.directory,id:'P112-A1',codex:f.binary,execute:true}),/allowance|already/);
  await assert.rejects(f.runner.runPrerequisite({directory:f.directory,id:'P112-A3',codex:f.binary,execute:true}),/slots/);
  assert.equal(f.runner.aggregateEvaluation(f.directory).hostLaunches,2);assert.equal(f.runner.aggregateEvaluation(f.directory).behavioralAcceptanceComplete,false);
}));

test('issue112 unknown usage consumes first slot and refuses another launch',()=>directionTemporary(async root=>{
  const f=await prepared112(root,{unknownUsage:true});await f.runner.runPrerequisite({directory:f.directory,id:'P112-A1',codex:f.binary,execute:true});
  await assert.rejects(f.runner.runPrerequisite({directory:f.directory,id:'P112-A2',codex:f.binary,execute:true}),/unknown usage/);
  assert.equal(f.runner.aggregateEvaluation(f.directory).hostLaunches,1);assert.equal(f.runner.aggregateEvaluation(f.directory).prerequisites.find(p=>p.id==='P112-A2').consumed,false);
}));

test('issue113 retained unknown usage consumes the first slot without refusing the next launch',()=>directionTemporary(async root=>{
  const f=await prepared112(root,{unknownUsage:true,retainUnknown:true});
  await f.runner.runPrerequisite({directory:f.directory,id:'P112-A1',codex:f.binary,execute:true});
  qualify112Fixture(f.directory,f.handoff,['P112-A1']);
  await f.runner.runPrerequisite({directory:f.directory,id:'P112-A2',codex:f.binary,execute:true});
  const report=f.runner.aggregateEvaluation(f.directory);
  assert.equal(report.hostLaunches,2);assert.equal(report.unknownLaunches,2);
  assert.equal(report.prerequisites.find(p=>p.id==='P112-A1').consumed,true);
  assert.equal(report.prerequisites.find(p=>p.id==='P112-A2').consumed,true);
}));

test('issue112 whole-tool and read controls never infer visibility from a command/path mention',()=>directionTemporary(async root=>{
  const f=await prepared112(root,{controls:['C-F01-C-ASTRA']});
  for(const id of ['P112-A1','P112-A2']){if(id.endsWith('2'))qualify112Fixture(f.directory,f.handoff,['P112-A1']);await f.runner.runPrerequisite({directory:f.directory,id,codex:f.binary,execute:true});}
  qualify112Fixture(f.directory,f.handoff,['P112-A1','P112-A2']);
  await assert.rejects(f.runner.runTrialSlice({directory:f.directory,ids:['C-F01-C-ASTRA'],codex:f.binary,execute:true}),/native catalog/);
  assert.equal(f.runner.aggregateEvaluation(f.directory).rows.find(r=>r.id==='C-F01-C-ASTRA').deterministic,'unattempted');
  const support=join(f.directory,'support/C'),path='skills/afk/references/environment.md',bytes=readFileSync(join(support,path),'utf8'),digest=require112Crypto.createHash('sha256').update(bytes).digest('hex');
  const action={event:'item.completed',type:'command_execution',command:`cat '${join(support,path)}'`,output:bytes,exitCode:0,id:'read'};
  assert.equal(directionRunner.observedReferenceReads([{actions:[action]}],support,[{path,digest}]).length,1);
  for(const mutated of [{...action,output:bytes.slice(-30)},{...action,exitCode:null},{...action,command:`tail '${join(support,path)}'`}])assert.equal(directionRunner.observedReferenceReads([{actions:[mutated]}],support,[{path,digest}]).length,0);
}));

for(const qualificationCondition of ['pending','qualified'])test(`S112-4 issue112 controlled D1 ${qualificationCondition} keeps original endpoint outstanding`,()=>directionTemporary(async root=>{
  const id='M-D1-C-ASTRA-R1',f=await prepared112(root,{main:[id],qualificationCondition});
  await f.runner.runPrerequisite({directory:f.directory,id:'P112-A1',codex:f.binary,execute:true});qualify112Fixture(f.directory,f.handoff,['P112-A1']);
  await f.runner.runPrerequisite({directory:f.directory,id:'P112-A2',codex:f.binary,execute:true});qualify112Fixture(f.directory,f.handoff,['P112-A1','P112-A2']);
  const results=await f.runner.runTrialSlice({directory:f.directory,ids:[id],codex:f.binary,execute:true});
  assert.equal(results[0].deterministic,'pass',JSON.stringify({results,observed:JSON.parse(readFileSync(join(f.directory,'trials',id,'observed.json')))}));assert.notEqual(results[0].subjectEndpointStatus,'complete');
  assert.equal(results[0].measurementEndpointSatisfied,qualificationCondition==='qualified');
  const observations=JSON.parse(readFileSync(join(f.directory,'trials',id,'observed.json')));assert.equal(observations.invocations.length,1);
  assert.ok(observations.audits.every(a=>a.controlled===true));assert.ok(observations.audits.every(a=>a.actualAuditorCalls===0));
  assert.equal(f.runner.aggregateEvaluation(f.directory).behavioralAcceptanceComplete,false);
  const trialRoot=join(f.directory,'trials',id),actor=observations.invocations[0].transition;
  assertRetainedInspection(trialRoot,actor.subjectEndpointEvidence,'completed');
  assertRetainedInspection(trialRoot,JSON.parse(readFileSync(join(trialRoot,'original-endpoint.json'))).inspectionPath,'completed');
  for(const audit of observations.audits)assertRetainedInspection(trialRoot,audit.originalCurrentnessInspection,'completed');
  const captured=JSON.parse(readFileSync(join(trialRoot,'captures/author-1-after/commands.json')));
  for(const command of captured)assertRetainedInspection(trialRoot,command.inspectionPath,'completed');

  const prior=f.runner.aggregateEvaluation(f.directory).hostLaunches;await f.runner.runTrialSlice({directory:f.directory,ids:[id],codex:f.binary,execute:true});assert.equal(f.runner.aggregateEvaluation(f.directory).hostLaunches,prior);
}));

test('issue112 measurement source and test bodies remain inert',()=>temporary(async root=>{
  const original=createFixture({directory:join(root,'subject'),scenarioId:'S1'}),capture=directionRunner.captureMeasurementSources({workspace:original.directory,head:original.current}),sentinel=join(root,'must-not-exist');
  capture.files['src/reserve.mjs']=`import {writeFileSync} from 'node:fs';writeFileSync('must-not-exist','unsafe');export const reserve=()=>{};\n`;
  const m=directionRunner.materializeMeasurement({directory:join(root,'measurement'),trialId:'M-D1-C-ASTRA-R1',captureId:'audit-1',capture,task:directionRunner.directionTaskFor('D1'),provenance:'Inert captured original observation.\n'});
  assert.throws(()=>readFileSync(join(m.cwd,'must-not-exist')));assert.throws(()=>readFileSync(sentinel));assert.match(readFileSync(join(m.cwd,'src/reserve.mjs'),'utf8'),/writeFileSync/);
}));

test('F112-1 issue112 D6 exact resume locates complete retained source and allowances',()=>directionTemporary(async root=>{
  const id='M-D6-C-ASTRA-R1',f=await prepared112(root,{main:[id],observeResume:true});
  await f.runner.runPrerequisite({directory:f.directory,id:'P112-A1',codex:f.binary,execute:true});qualify112Fixture(f.directory,f.handoff,['P112-A1']);
  await f.runner.runPrerequisite({directory:f.directory,id:'P112-A2',codex:f.binary,execute:true});qualify112Fixture(f.directory,f.handoff,['P112-A1','P112-A2']);
  const rows=await f.runner.runTrialSlice({directory:f.directory,ids:[id],codex:f.binary,execute:true});
  const seeded=JSON.parse(readFileSync(join(f.directory,'trials',id,'seeded-history.json')));assert.equal(seeded.attempts.length,4);assert.equal(seeded.attempts.at(-1).charged,4);
  const resumed=JSON.parse(readFileSync(join(root,'resume-inspection.json'))),trialRoot=join(f.directory,'trials',id),workspace=join(trialRoot,'workspace'),run=join(workspace,'.afk/runs/trial');
  assert.equal(resumed.readError,undefined);assert.equal(resumed.path,join(realpathSync(run),'handoff-observations.md'));
  assert.equal(resumed.prompt,readFileSync(join(f.directory,'artifacts',`${id}-author-resume`,'prompt.txt'),'utf8'));
  const before=JSON.parse(readFileSync(join(trialRoot,'captures/author-resume-before/source.json')));
  assert.ok(before.snapshot.files['.afk/runs/trial/handoff-observations.md']);
  const expected=['../../../TASK.md',...Object.keys(before.snapshot.files).filter(path=>path.startsWith('.afk/runs/trial/')&&!path.endsWith('/handoff-observations.md')).map(path=>path.slice('.afk/runs/trial/'.length))].sort();
  assert.deepEqual(Object.keys(resumed.sources).sort(),expected);
  for(const [path,encoded]of Object.entries(resumed.sources))assert.deepEqual(Buffer.from(encoded,'base64'),readFileSync(join(run,path)),path);
  const source=path=>Buffer.from(resumed.sources[path],'base64').toString('utf8');
  assert.match(source('ledger.md'),/^allowance: 2$/m);assert.match(source('ledger.md'),/^consumed: 2$/m);assert.match(source('observation.md'),/ZERO-OPEN/);
  const authority=JSON.parse(source('issues/synthetic/direction/000001.json')).payload;assert.equal(authority.policy.maxAuditAttempts,4);assert.equal(authority.accounting.priorAttempts.length,4);
  for(let n=1;n<=4;n++){const stem=`retained-measurement/issues/synthetic/audits/seed-${n}/`;for(const file of ['packet.json','result.json','terminal-witness.txt'])assert.ok(source(stem+file).length);assert.equal(source(`prior-evidence/seed-${n}.txt`),source(stem+'terminal-witness.txt'));}
  assert.match(resumed.index,/fixture-driver-controlled/i);assert.match(resumed.index,/no new allowance/i);assert.match(resumed.index,/no original endpoint approval/i);

  for(const proof of seeded.proofs)assertRetainedInspection(join(f.directory,'trials',id),proof.check.inspectionPath,'completed');
  const observed=JSON.parse(readFileSync(join(f.directory,'trials',id,'observed.json')));assert.equal(observed.invocations.length,2);assert.equal(observed.invocations[1].resumedFrom,observed.invocations[0].sessionId);
  assert.equal(f.runner.aggregateEvaluation(f.directory).auditAttempts,0);assert.equal(rows[0].deterministic,'fail');assert.ok(rows[0].issues.includes('repair-budget-conflict'));
}));

test('issue113 D9 exact generated history preserves IDs and prepares retained source bytes',()=>directionTemporary(async root=>{
  const original=createFixture({directory:join(root,'subject'),scenarioId:'S1'}),capture=directionRunner.captureMeasurementSources({workspace:original.directory,head:original.current});
  const m=directionRunner.materializeMeasurement({directory:join(root,'measurement'),trialId:'M-D9-C-ASTRA-R1',captureId:'audit-1',capture,task:directionRunner.directionTaskFor('D9'),provenance:'Inert original observation; no execution here.\n'});m.support=repo;
  directionRunner.initializeDirectionMeasurement(m);const first=await directionRunner.controlledMeasurementAudit(m,{auditId:'audit-1',phase:'initial',model:'gpt-6-astra',finding:true});
  const {digestBytes,canonicalBytes}=await import('../lib/gate/review-receipt.mjs');
  const packetPath='issues/synthetic/audits/audit-1/packet.json',resultPath='issues/synthetic/audits/audit-1/result.json',run=join(m.cwd,'.afk/runs',m.runId);
  const result=JSON.parse(readFileSync(join(run,resultPath))),history={audits:[{auditId:'audit-1',packet:{path:packetPath,digest:digestBytes(canonicalBytes(first.packet))},result:{path:resultPath,digest:digestBytes(canonicalBytes(result))}}],findings:result.payload.findings.map(finding=>({auditId:'audit-1',finding})),dispositions:[]};
  assert.equal(history.findings[0].finding.id,'MOCK-A6');assert.equal(history.findings.some(x=>x.finding.id==='DRIFT-A6'),false);
  const renamed=structuredClone(history);renamed.findings[0].finding.id='DRIFT-A6';
  assert.throws(()=>directionRunner.prepareMeasurementAudit(m,{auditId:'rename',phase:'endpoint',model:'gpt-6-astra',history:renamed}),/history_finding_mismatch/);
  const second=directionRunner.prepareMeasurementAudit(m,{auditId:'audit-2',phase:'endpoint',model:'gpt-6-astra',history});
  assert.ok(second.requestBytes>16384);assert.deepEqual(second.packet.history.findings,history.findings);
  assert.equal(second.packet.history.audits.length,1);assert.deepEqual(second.packet.history.audits[0].evidence,first.packet.evidence);
  assert.equal(first.charged,1);
  assert.equal(readFileSync(join(run,packetPath),'utf8'),canonicalBytes(first.packet));
}));

test('issue112 source, duplicate JSON, planned authority and exclusive lock checks refuse before launch',()=>directionTemporary(async root=>{
  const f=await prepared112(root,{status:'planned'});
  await assert.rejects(f.runner.runPrerequisite({directory:f.directory,id:'P112-A1',codex:f.binary,execute:true}),/planned handoff/);
  assert.equal(f.runner.aggregateEvaluation(f.directory).hostLaunches,0);
  writeFileSync(join(root,'duplicate.json'),JSON.stringify(f.handoff).replace('{','{"version":1,'));
  assert.throws(()=>f.runner.createEvaluation({repository:f.source,directory:join(root,'duplicate'),candidate:f.revision,baseline:f.revision,campaign:'issue112',executionHandoff:join(root,'duplicate.json')}),/duplicate JSON/);
  writeFileSync(join(f.directory,'sources/authority.md'),'replaced');assert.throws(()=>f.runner.aggregateEvaluation(f.directory),/source changed/);
}));

test('issue112 active and interrupted launch records retain capacity without automatic deletion or retry',()=>directionTemporary(async root=>{
  const f=await prepared112(root);writeFileSync(join(f.directory,'active.lock'),'owned unfinished lock');
  await assert.rejects(f.runner.runPrerequisite({directory:f.directory,id:'P112-A1',codex:f.binary,execute:true}),/EEXIST/);
  assert.equal(readFileSync(join(f.directory,'active.lock'),'utf8'),'owned unfinished lock');assert.equal(f.runner.aggregateEvaluation(f.directory).hostLaunches,0);rmSync(join(f.directory,'active.lock'));
  mkdirSync(join(f.directory,'launches'));writeFileSync(join(f.directory,'launches/P112-A1.started.json'),JSON.stringify({id:'P112-A1',kind:'prerequisite',startedAt:new Date().toISOString(),ordinal:1}));
  await assert.rejects(f.runner.runPrerequisite({directory:f.directory,id:'P112-A2',codex:f.binary,execute:true}),/unfinished launch/);
  assert.equal(f.runner.aggregateEvaluation(f.directory).hostLaunches,1);
}));

test('issue112 command interface rejects missing handoff and legacy handoff without host invocation',()=>{
  const runner=join(repo,'scripts/evaluate-agent-behavior.mjs');
  for(const args of [['prepare','--campaign','issue112','--baseline','a'.repeat(40),'--candidate','b'.repeat(40)],['prepare','--execution-handoff','absent']]){
    const result=spawnSync(process.execPath,[runner,...args],{cwd:repo,encoding:'utf8'});assert.equal(result.status,1);assert.match(result.stderr,/handoff/);
  }
});

test('issue113 D9 complete generated checkpoints preserve two historical contexts and two-author ceiling',()=>directionTemporary(async root=>{
  const id='M-D9-C-ASTRA-R1',f=await prepared112(root,{main:[id]});
  await f.runner.runPrerequisite({directory:f.directory,id:'P112-A1',codex:f.binary,execute:true});qualify112Fixture(f.directory,f.handoff,['P112-A1']);
  await f.runner.runPrerequisite({directory:f.directory,id:'P112-A2',codex:f.binary,execute:true});qualify112Fixture(f.directory,f.handoff,['P112-A1','P112-A2']);
  await f.runner.runTrialSlice({directory:f.directory,ids:[id],codex:f.binary,execute:true});
  const observed=JSON.parse(readFileSync(join(f.directory,'trials',id,'observed.json')));
  assert.equal(observed.invocations.length,2);assert.equal(observed.invocations[1].resumedFrom,observed.invocations[0].sessionId);
  assert.equal(observed.audits.length,3);assert.ok(observed.audits[0].requestBytes>0);
  assert.deepEqual(observed.audits.map(a=>a.historyAudits),[0,1,2]);
  for(const [index,audit] of observed.audits.entries()){
    assert.equal(audit.classification,'completed');assert.equal(audit.actualAuditorCalls,0);
    if(index>0)assert.ok(audit.requestBytes>observed.audits[index-1].requestBytes);
    const run=join(audit.measurement.cwd,'.afk/runs',audit.measurement.runId);
    const packet=JSON.parse(readFileSync(join(run,'issues/synthetic/audits',audit.auditId,'packet.json')));
    assert.equal(packet.history.audits.length,index);
    for(const prior of observed.audits.slice(0,index)){
      const priorPacket=JSON.parse(readFileSync(join(run,'issues/synthetic/audits',prior.auditId,'packet.json')));
      const retained=packet.history.audits.find(row=>row.auditId===prior.auditId);
      assert.deepEqual(retained.evidence,priorPacket.evidence);assert.deepEqual(retained.baseline,priorPacket.baseline);
      assert.deepEqual(retained.target,priorPacket.target);
      assert.deepEqual(packet.history.findings.filter(row=>row.auditId===prior.auditId).map(row=>row.finding),prior.result.findings);
    }
  }
  console.log('D112-1 exact generated checkpoints '+JSON.stringify(observed.audits.map(a=>({auditId:a.auditId,requestBytes:a.requestBytes??null,historyAudits:a.historyAudits??null,status:a.status??a.classification,reason:a.reason?.includes('profile_input_limit')?'profile_input_limit':null,actualAuditorCalls:a.actualAuditorCalls}))));
  assert.equal(f.runner.aggregateEvaluation(f.directory).hostLaunches,4);
}));

test('I112-4 strict capture retains invalid original bytes without complete provenance',()=>temporary(async root=>{
  const result=await runBounded(process.execPath,['-e','process.stdout.write(Buffer.from([0xc3,0x28]))'],{cwd:root,timeoutMs:1000,graceMs:50,strictBytes:true});
  assert.equal(result.stdoutBase64,Buffer.from([0xc3,0x28]).toString('base64'));assert.equal(result.utf8Valid,false);assert.notEqual(result.status,'completed');
  const valid=await runBounded(process.execPath,['-e',"process.stdout.write('�')"],{cwd:root,timeoutMs:1000,graceMs:50,strictBytes:true});assert.equal(valid.status,'completed');assert.equal(valid.utf8Valid,true);
}));

test('I112-2 expired execution refuses before process creation',()=>temporary(async root=>{
  const sentinel=join(root,'spawned');await assert.rejects(async()=>runBounded(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(sentinel)},'bad')`],{cwd:root,timeoutMs:10,deadline:Date.now()-1}),/deadline|allowance/);assert.throws(()=>readFileSync(sentinel));
}));

test('I112-3 original authority rejects changed identity and retains appended observations',()=>temporary(root=>{
  const f=direction.createDirectionFixture({directory:join(root,'subject'),scenarioId:'D6'}),path=join(f.directory,'.afk/runs/trial/ledger.md'),before=readFileSync(path,'utf8');
  const original=directionRunner.readOriginalAuthority(f.directory);assert.equal(original.runId,'trial');writeFileSync(path,before+'\nObserved stage checkpoint.\n');assert.deepEqual(directionRunner.readOriginalAuthority(f.directory),original);
  writeFileSync(path,before.replace('run-id: trial','run-id: another-run'));assert.notDeepEqual(directionRunner.readOriginalAuthority(f.directory),original);
}));

test('S112-3 unrelated stdout and flags cannot qualify unsupported inventory',()=>directionTemporary(async root=>{
  const f=await prepared112(root,{controlledHost:false});await f.runner.runPrerequisite({directory:f.directory,id:'P112-A1',codex:f.binary,execute:true});qualify112Fixture(f.directory,f.handoff,['P112-A1']);
  await assert.rejects(f.runner.runPrerequisite({directory:f.directory,id:'P112-A2',codex:f.binary,execute:true}),/inventory|unsupported/);assert.equal(f.runner.aggregateEvaluation(f.directory).hostLaunches,1);
}));

test('S112-2 selected actual profile must match frozen handoff',()=>directionTemporary(async root=>{
  const f=await prepared112(root),bad=structuredClone(f.handoff);bad.auditor.profileDigest='b'.repeat(64);writeFileSync(f.input,JSON.stringify(bad));
  assert.throws(()=>f.runner.createEvaluation({repository:f.source,directory:join(root,'mismatch'),candidate:f.revision,baseline:f.revision,campaign:'issue112',executionHandoff:f.input}),/profile/);
}));

test('S112-5 original capture retains output from a failed confined command',()=>directionTemporary(async root=>{
  const f=direction.createDirectionFixture({directory:join(root,'subject'),scenarioId:'D1'}),binary=sandboxStub(root),trial=direction.DIRECTION_TRIALS.find(t=>t.id==='M-D1-C-ASTRA-R1');writeFileSync(join(f.directory,'test/reserve.test.mjs'),"process.stdout.write('retained-before-timeout');setInterval(()=>{},1000);\n");
  writeFileSync(join(root,'sandbox-transport.mjs'),"import{spawn}from'node:child_process';const a=process.argv.slice(2),n=a.indexOf('-C'),child=spawn(a[n+2],a.slice(n+3),{cwd:a[n+1],stdio:'inherit'});child.on('exit',code=>process.exit(code??1));");
  const directory=join(root,'observations');mkdirSync(directory);
  await assert.rejects(directionRunner.originalCapture({workspace:f.directory,support:repo,codex:binary,trial,directory,captureId:'failed',execution:{deadline:Date.now()+5000,graceMs:50}}));
  const commands=JSON.parse(readFileSync(join(directory,'captures/failed/commands.json')));assert.ok(commands.some(c=>c.stdout?.includes('retained-before-timeout')));assert.equal(JSON.parse(readFileSync(join(directory,'captures/failed/status.json'))).status,'unavailable');
}));

test('S112-3 strict controlled inventory validates actual source projection and boundary events',()=>directionTemporary(async root=>{
  const f=await prepared112(root);await f.runner.runPrerequisite({directory:f.directory,id:'P112-A1',codex:f.binary,execute:true});qualify112Fixture(f.directory,f.handoff,['P112-A1']);
  const slot=direction.PREREQUISITES[0],result=JSON.parse(readFileSync(join(f.directory,'artifacts/P112-A1/result.json'))),path='artifacts/P112-A1/controlled-inventory.json',record=JSON.parse(readFileSync(join(f.directory,path)));
  const check=value=>{const bytes=JSON.stringify(value);writeFileSync(join(f.directory,path),bytes);return f.runner.validateHostObservation({directory:realpathSync(f.directory),slot,host:f.handoff.models[0].host,result,source:{status:'observed',reference:{path,digest:require112Crypto.createHash('sha256').update(bytes).digest('hex')}}});};
  assert.equal(check(record).id,slot.id);
  for(const mutate of [x=>x.tools.entries=[],x=>x.tools.entries.push(x.tools.entries[0]),x=>x.tools.entries[0].confinement='unsafe',x=>x.instructions.complete=false,x=>x.sessionId='different',x=>x.boundaryEvent='absent',x=>x.unexpected=true]){const bad=structuredClone(record);mutate(bad);assert.throws(()=>check(bad));}
  result.actions[0].output='{}';assert.throws(()=>check(record),/boundary/);
}));

test('S112-2 live qualified M still requires frozen qualification source before an audit launch',()=>directionTemporary(async root=>{
  const f=await prepared112(root,{main:['M-D1-C-ASTRA-R1'],qualificationCondition:'qualified',auditorCondition:'live'});
  for(const id of ['P112-A1','P112-A2']){if(id.endsWith('2'))qualify112Fixture(f.directory,f.handoff,['P112-A1']);await f.runner.runPrerequisite({directory:f.directory,id,codex:f.binary,execute:true});}qualify112Fixture(f.directory,f.handoff,['P112-A1','P112-A2']);
  await assert.rejects(f.runner.runTrialSlice({directory:f.directory,ids:['M-D1-C-ASTRA-R1'],codex:f.binary,execute:true}),/qualification source/);assert.equal(f.runner.aggregateEvaluation(f.directory).auditAttempts,0);
}));

test('I112-2 expired slice leaves every main author and audit slot unspent',()=>directionTemporary(async root=>{
  const f=await prepared112(root,{main:['M-D1-C-ASTRA-R1'],sliceMs:1});
  for(const id of ['P112-A1','P112-A2']){if(id.endsWith('2'))qualify112Fixture(f.directory,f.handoff,['P112-A1']);await f.runner.runPrerequisite({directory:f.directory,id,codex:f.binary,execute:true});}qualify112Fixture(f.directory,f.handoff,['P112-A1','P112-A2']);
  await assert.rejects(f.runner.runTrialSlice({directory:f.directory,ids:['M-D1-C-ASTRA-R1'],codex:f.binary,execute:true}),/deadline/);
  assert.equal(f.runner.aggregateEvaluation(f.directory).hostLaunches,2);assert.equal(f.runner.aggregateEvaluation(f.directory).auditAttempts,0);
}));

test('I112-1 actual read events retain order and opaque boundaries stay unobserved',()=>{
  const support='/synthetic-support',path='skills/afk/references/environment.md',text='complete reference\n',digest=require112Crypto.createHash('sha256').update(text).digest('hex'),required=[{path,digest}];
  const read={event:'item.completed',id:'read',type:'command_execution',command:`cat '${join(support,path)}'`,exitCode:0,output:text},work={event:'item.completed',id:'work',type:'command_execution',command:'node scripts/direction-state.mjs apply',exitCode:0,output:'done'};
  const score=actions=>{const invocations=[{eventsComplete:true,actions}],reads=directionRunner.observedReferenceReads(invocations,support,required);return direction.scoreControl({trial:direction.CONTROL_TRIALS[0],observation:{requiredReads:required,reads,...directionRunner.controlActionOrder(invocations,support,required)}}).loading;};
  assert.equal(score([read,work]),'pass');assert.equal(score([work,read]),'unobserved');assert.equal(score([{type:'opaque'},read]),'unobserved');
});

for(const failure of ['invalid-json','capture-race','output-limit'])test(`S112-5 retains original proof on ${failure}`,()=>directionTemporary(async root=>{
  const f=direction.createDirectionFixture({directory:join(root,'subject'),scenarioId:'D1'}),binary=sandboxStub(root),trial=direction.DIRECTION_TRIALS.find(t=>t.id==='M-D1-C-ASTRA-R1'),directory=join(root,'observations');mkdirSync(directory);
  writeFileSync(join(root,'sandbox-transport.mjs'),"import{spawn}from'node:child_process';const a=process.argv.slice(2),n=a.indexOf('-C'),child=spawn(a[n+2],a.slice(n+3),{cwd:a[n+1],stdio:'inherit'});child.on('exit',code=>process.exit(code??1));");
  if(failure==='invalid-json')writeFileSync(join(f.directory,'src/reserve.mjs'),"console.log('raw-invalid-json-marker');\n"+direction.DIRECTION_GOOD);
  if(failure==='capture-race')writeFileSync(join(f.directory,'src/reserve.mjs'),"import{writeFileSync}from'node:fs';writeFileSync('observed-mutation.txt','mutation');\n"+direction.DIRECTION_GOOD);
  if(failure==='output-limit')writeFileSync(join(f.directory,'test/reserve.test.mjs'),"process.stdout.write('x'.repeat(2000));setInterval(()=>{},1000);\n");
  await assert.rejects(directionRunner.originalCapture({workspace:f.directory,support:repo,codex:binary,trial,directory,captureId:failure,execution:{deadline:Date.now()+3000,graceMs:50},maxBytes:failure==='output-limit'?128:8388608}));
  const capture=join(directory,'captures',failure),commands=JSON.parse(readFileSync(join(capture,'commands.json')));assert.ok(commands.length>=2);assert.equal(JSON.parse(readFileSync(join(capture,'status.json'))).status,'unavailable');
  if(failure==='invalid-json')assert.ok(commands.some(c=>c.stdout?.includes('raw-invalid-json-marker')));
  if(failure==='capture-race')assert.match(JSON.parse(readFileSync(join(capture,'status.json'))).reason,/snapshot changed/);
  if(failure==='output-limit'){const index=commands.findIndex(c=>c.status==='output-limit');assert.ok(index>=0);assert.equal(readFileSync(join(capture,'commands',`${index}.stdout.raw`)).length,128);}
}));

function assertRetainedInspection(root,path,status) {
  assert.equal(typeof path,'string');const stem=join(root,path.slice(0,-5)),entry=JSON.parse(readFileSync(stem+'.json')),started=JSON.parse(readFileSync(stem+'.started.json'));
  assert.equal(entry.inspectionPath,path);assert.equal(entry.status,status);assert.equal(entry.record,started.record);assert.equal(entry.stdin,started.stdin);
  const context=JSON.parse(entry.record);assert.equal(typeof context.executable,'string');assert.ok(Array.isArray(context.args));assert.equal(typeof context.cwd,'string');assert.match(context.restrictions,/confined/);
  assert.deepEqual(readFileSync(stem+'.stdout.raw'),Buffer.from(entry.stdoutBase64,'base64'));assert.deepEqual(readFileSync(stem+'.stderr.raw'),Buffer.from(entry.stderrBase64,'base64'));
  return entry;
}

for(const stream of ['stdout','stderr'])test(`I112-4 BOM survives strict subprocess ${stream} and provenance`,()=>temporary(async root=>{
  const bytes=Buffer.from([0xef,0xbb,0xbf,0x58]);
  const result=await runBounded(process.execPath,['-e',`process.${stream}.write(Buffer.from([0xef,0xbb,0xbf,0x58]))`],{cwd:root,timeoutMs:1000,graceMs:50,strictBytes:true});
  assert.equal(result.status,'completed');assert.equal(result.utf8Valid,true);assert.deepEqual(Buffer.from(result[stream]),bytes);assert.deepEqual(Buffer.from(result[stream+'Base64'],'base64'),bytes);
  const proof=directionRunner.originalAcceptanceProvenance({trialId:'bom',captureId:'bom',commands:[{...result,record:'command',stdin:''}]});assert.ok(proof.includes(`${stream}: 4\n${bytes.toString('utf8')}`));
}));

test('I112-4 BOM source bytes survive capture and inert materialization',()=>temporary(root=>{
  const original=createFixture({directory:join(root,'subject'),scenarioId:'S1'}),path=join(original.directory,'src/reserve.mjs'),bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),readFileSync(path)]);writeFileSync(path,bytes);
  const capture=directionRunner.captureMeasurementSources({workspace:original.directory,head:original.current});assert.deepEqual(Buffer.from(capture.files['src/reserve.mjs']),bytes);
  const m=directionRunner.materializeMeasurement({directory:join(root,'measurement'),trialId:'bom',captureId:'bom',capture,task:directionRunner.directionTaskFor('D1'),provenance:'Inert original observation.\n'});
  assert.deepEqual(readFileSync(join(m.cwd,'src/reserve.mjs')),bytes);
}));

test('I112-4 L1 prompt delivers complete BOM-bearing reference bytes',()=>temporary(root=>{
  const support=join(root,'support'),path='skills/afk/references/environment.md',bytes=Buffer.from('\ufeffComplete reference.\n');mkdirSync(join(support,'skills/afk/references'),{recursive:true});writeFileSync(join(support,path),bytes);
  writeFileSync(join(support,'skills/afk/SKILL.md'),'Read [environment](references/environment.md).\n');
  const trial=direction.CONTROL_TRIALS.find(t=>t.caseId==='L1'),control=directionRunner.prepareControlFixture({trial,fixture:{},support:realpathSync(support),directory:root});
  const delivered=control.promptSuffix.split(`(${path}):\n`)[1].slice(0,-1);assert.deepEqual(Buffer.from(delivered),bytes);
  assert.equal(control.contextDelivery[0].digest,require112Crypto.createHash('sha256').update(bytes).digest('hex'));assert.equal(control.contextDelivery[0].complete,true);
}));

for(const failure of ['actor','final','post-audit','seed'])test(`S112-5 retained original ${failure} inspection failure remains referenced`,()=>directionTemporary(async root=>{
  const id=`M-${failure==='seed'?'D6':'D1'}-C-ASTRA-R1`,f=await prepared112(root,{main:[id],inspectionFailure:failure});
  await f.runner.runPrerequisite({directory:f.directory,id:'P112-A1',codex:f.binary,execute:true});qualify112Fixture(f.directory,f.handoff,['P112-A1']);
  await f.runner.runPrerequisite({directory:f.directory,id:'P112-A2',codex:f.binary,execute:true});qualify112Fixture(f.directory,f.handoff,['P112-A1','P112-A2']);
  const trialRoot=join(f.directory,'trials',id);let path;
  if(failure==='seed'){
    await assert.rejects(f.runner.runTrialSlice({directory:f.directory,ids:[id],codex:f.binary,execute:true}));
    const saved=JSON.parse(readFileSync(join(trialRoot,'seeded-history.json')));assert.equal(saved.status,'unavailable');path=saved.inspectionPath;
  }else{
    await f.runner.runTrialSlice({directory:f.directory,ids:[id],codex:f.binary,execute:true});
    const observed=JSON.parse(readFileSync(join(trialRoot,'observed.json')));
    path=failure==='actor'?observed.observationError.inspectionPath:failure==='final'?JSON.parse(readFileSync(join(trialRoot,'original-endpoint.json'))).inspectionPath:observed.audits[0].inspectionPath;
  }
  const entry=assertRetainedInspection(trialRoot,path,'invalid-utf8');assert.deepEqual(Buffer.from(entry.stdoutBase64,'base64'),Buffer.from([0xff]));assert.equal(Buffer.from(entry.stderrBase64,'base64').toString(),'retained-'+failure);assert.equal(entry.stdout,null);assert.equal(entry.code,0);
  assert.equal(f.runner.aggregateEvaluation(f.directory).hostLaunches,failure==='seed'?2:3);
}));

for(const path of ['lib/evaluation/host.mjs','lib/gate/protocol.mjs'])test(`observed evaluator rejects changed executed dependency ${path}`,()=>directionTemporary(async root=>{
  const f=await prepared112(root),file=join(f.source,path);writeFileSync(file,readFileSync(file,'utf8')+'\n');
  assert.throws(()=>f.runner.aggregateEvaluation(f.directory),/manifest inputs changed/);
  const handoff={...f.handoff,inputs:f.runner.directionInputDigests()};writeFileSync(f.input,JSON.stringify(handoff));
  assert.throws(()=>f.runner.createEvaluation({repository:f.source,directory:join(root,'other'),candidate:f.revision,baseline:f.revision,campaign:'issue112',executionHandoff:f.input}),/runner differs from evaluator revision/);
}));

for(const scenario of ['D6','D9'])test(`native catalog survives original ${scenario} capture and resume consumers`,()=>directionTemporary(async root=>{
  const id=`M-${scenario}-C-ASTRA-R1`,f=await prepared112(root,{main:[id],catalogFixture:true,sliceMs:60000});
  await f.runner.runPrerequisite({directory:f.directory,id:'P112-A1',codex:f.binary,execute:true});qualify112Fixture(f.directory,f.handoff,['P112-A1']);
  await f.runner.runPrerequisite({directory:f.directory,id:'P112-A2',codex:f.binary,execute:true});qualify112Fixture(f.directory,f.handoff,['P112-A1','P112-A2']);
  await f.runner.runTrialSlice({directory:f.directory,ids:[id],codex:f.binary,execute:true});
  const trial=join(f.directory,'trials',id),fixture=JSON.parse(readFileSync(join(trial,'fixture.json'))),observed=JSON.parse(readFileSync(join(trial,'observed.json')));
  assert.ok(fixture.nativeCatalog.digest);assert.equal(observed.observationError,null);
  const captures=readdirSync(join(trial,'captures')).filter(name=>{try{return readFileSync(join(trial,'captures',name,'source.json')).length>0;}catch{return false;}});
  assert.ok(captures.length>=5);for(const name of captures)assert.equal(JSON.parse(readFileSync(join(trial,'captures',name,'source.json'))).catalogDigest,fixture.nativeCatalog.digest);
  assert.equal(observed.invocations.length,2);assert.equal(observed.invocations[1].resumedFrom,observed.invocations[0].sessionId);
}));
test('native controls refuse absent selected capabilities before fixture mutation and retain L3 original bytes',()=>temporary(root=>{
  const support=join(root,'support');mkdirSync(join(support,'skills/afk'),{recursive:true});writeFileSync(join(support,'skills/afk/SKILL.md'),'Inline baseline.\n');
  for(const caseId of ['L1','L2','L3','L5']){
    const trial=direction.CONTROL_TRIALS.find(t=>t.caseId===caseId),control=directionRunner.prepareControlFixture({trial,fixture:{directory:join(root,'not-allocated')},support:realpathSync(support),directory:root});
    assert.equal(control.status,'unsupported');assert.equal(existsSync(join(root,'not-allocated')),false);
  }
  const path='skills/afk/references/environment.md';mkdirSync(join(support,'skills/afk/references'));writeFileSync(join(support,path),'Original selected environment.\n');
  writeFileSync(join(support,'skills/afk/SKILL.md'),'Read [environment](references/environment.md).\n');
  const trial=direction.CONTROL_TRIALS.find(t=>t.caseId==='L3'),control=directionRunner.prepareControlFixture({trial,fixture:{},support:realpathSync(support),directory:root});
  assert.equal(control.status,'supported');assert.equal(existsSync(join(control.support,path)),false);
  assert.equal(control.sourcePlan.missingReference.digest,require112Crypto.createHash('sha256').update('Original selected environment.\n').digest('hex'));
}));
test('L4 captures complete standalone plan and L6 stages an actual local design preview',()=>temporary(root=>{
  const fixture=direction.createDirectionFixture({directory:join(root,'workspace'),scenarioId:'D7'}),trial=direction.CONTROL_TRIALS.find(t=>t.caseId==='L6');
  const control=directionRunner.prepareControlFixture({trial,fixture,support:repo,directory:root});
  assert.equal(control.status,'supported');assert.match(control.promptSuffix,/--design docs\/plan.md --print-prompt/);
  const capture=directionRunner.captureMeasurementSources({workspace:fixture.directory,head:fixture.current,includePlan:true});
  assert.equal(capture.files['docs/plan.md'],readFileSync(join(fixture.directory,'docs/plan.md'),'utf8'));assert.match(capture.files['docs/plan.md'],/A6/);
}));
test('native control aggregation binds behavior adjudication without erasing unknown loading or concrete failures',()=>directionTemporary(async root=>{
  const id='C-L4-C-ASTRA',f=await prepared112(root,{controls:[id]}),base=join(f.directory,'trials',id);mkdirSync(base,{recursive:true});
  const observation={requiredReads:[],reads:[],catalog:{kind:'native',complete:true},selectionEvidence:true,selectedSkill:'afk-spec-planner',nativeOrder:{kind:'native',status:'unobserved'},behaviorEvidence:false,behaviorPass:false,semanticEligible:true};
  const source=join(base,'control-observation.json');writeFileSync(source,JSON.stringify(observation));
  const path=join(base,'observed.json');writeFileSync(path,JSON.stringify({invocations:[],audits:[],controlObservation:{path:'control-observation.json',digest:digestBytes(readFileSync(source))}}));
  writeFileSync(join(base,'result.json'),JSON.stringify(direction.scoreControl({trial:direction.CONTROL_TRIALS.find(row=>row.id===id),observation})));
  writeFileSync(join(base,'adjudication.json'),JSON.stringify({verdict:'pass',evidence:'Independent synthetic judgment bound to retained original source.',observedDigest:digestBytes(readFileSync(path))}));
  let row=f.runner.aggregateDirectionEvaluation(f.directory).rows.find(row=>row.id===id);assert.equal(row.behavior,'pass');assert.equal(row.loading,'unobserved');assert.equal(row.deterministic,'unobserved');
  writeFileSync(source,JSON.stringify({...observation,behaviorEvidence:true,behaviorPass:false}));
  row=f.runner.aggregateDirectionEvaluation(f.directory).rows.find(row=>row.id===id);assert.notEqual(row.behavior,'pass');assert.equal(row.semantic,'unverified');
  writeFileSync(path,JSON.stringify({invocations:[],audits:[],controlObservation:{path:'control-observation.json',digest:digestBytes(readFileSync(source))}}));
  writeFileSync(join(base,'adjudication.json'),JSON.stringify({verdict:'pass',evidence:'Synthetic unchanged positive assertion cannot cure a concrete failure.',observedDigest:digestBytes(readFileSync(path))}));
  row=f.runner.aggregateDirectionEvaluation(f.directory).rows.find(row=>row.id===id);assert.equal(row.behavior,'fail');assert.equal(row.deterministic,'fail');
}));
test('unsupported baseline controls keep their rows without a prerequisite, author or measurement allocation',()=>directionTemporary(async root=>{
  const controls=['C-L1-B-ASTRA','C-L5-B-ASTRA'],f=await prepared112(root,{controls,baselineAbsentControls:true});
  const rows=await f.runner.runTrialSlice({directory:f.directory,ids:controls,codex:f.binary,execute:true});
  assert.equal(rows.length,2);assert.ok(rows.every(row=>row.deterministic==='unsupported'));
  for(const id of controls){assert.equal(existsSync(join(f.directory,'trials',id,'workspace')),false);assert.equal(existsSync(join(f.directory,'trials',id,'measurement')),false);}
  const aggregate=f.runner.aggregateDirectionEvaluation(f.directory);assert.equal(aggregate.hostLaunches,0);assert.equal(aggregate.rows.length,252);
  assert.ok(controls.every(id=>aggregate.rows.find(row=>row.id===id).deterministic==='unsupported'));
}));
test('native control producer rechecks wire and catalog sources without treating CLI path hints as selection',async t=>directionTemporary(async root=>{
  observedUpstreamFixture(t,{streamedCall:true,missingMedia:true});const id='C-F01-C-ASTRA',f=await prepared112(root,{controls:[id],observedHost:true});
  for(const prerequisite of ['P112-A1','P112-A2'])await f.runner.runPrerequisite({directory:f.directory,id:prerequisite,codex:f.binary,execute:true});
  const [result]=await f.runner.runTrialSlice({directory:f.directory,ids:[id],codex:f.binary,execute:true});
  assert.equal(result.selection,'unqualified');assert.equal(result.loading,'unobserved');assert.equal(result.behavior,'unobserved');
  const observation=JSON.parse(readFileSync(join(f.directory,'trials',id,'control-observation.json')));
  assert.equal(observation.nativeSourceQualified,true);assert.ok(observation.sourceEvidence.length>=5);assert.ok(observation.reasons.some(reason=>/No complete native skill/.test(reason)));
  assert.match(observation.nativeOrder.reason,/parentage/);assert.equal(observation.nativeOrder.status,'unobserved');
  const terminalRef=observation.sourceEvidence.find(ref=>ref.path.endsWith('-terminal.json'));assert.ok(terminalRef);
  const terminalPath=join(f.directory,terminalRef.path),original=readFileSync(terminalPath),terminal=JSON.parse(original);
  assert.equal(terminal.observation.response.output.length,0);assert.equal(terminal.responseMetadata.contentType,null);
  assert.equal(terminal.observation.interpretation,'body-validated-sse');terminal.responseMetadata.contentType='application/json';
  writeFileSync(terminalPath,JSON.stringify(terminal));
  const fixture=JSON.parse(readFileSync(join(f.directory,'trials',id,'fixture.json'))),observed=JSON.parse(readFileSync(join(f.directory,'trials',id,'observed.json')));
  assert.throws(()=>f.runner.nativeControlObservation({directory:realpathSync(f.directory),manifest:JSON.parse(readFileSync(join(f.directory,'manifest.json'))),
    trial:direction.CONTROL_TRIALS.find(row=>row.id===id),fixture,support:fixture.control.support,invocations:observed.invocations,codex:f.binary}),/unqualified/);
  writeFileSync(terminalPath,original);
}));


test('new observed handoff can omit cost, token, request and whole-campaign caps', () => {
  const h = handoff112({ main: ['M-D1-C-ASTRA-R1'], status: 'authorized' });
  h.bounds.totalMs = null;
  for (const key of ['plannedMaxMicrousd', 'inputTokens', 'outputTokens']) h.bounds.spend[key] = null;
  h.observer = { version: 1, profile: { path: 'native/profile.json', digest: 'a'.repeat(64) },
    authMode: 'chatgpt', maxRequests: null, maxRequestsPerInvocation: null, maxBytes: 1048576, requestTimeoutMs: 60000 };
  const original = JSON.stringify(h);
  assert.equal(directionRunner.validateExecutionHandoff(h), h);
  assert.equal(JSON.stringify(h), original);
  for (const change of [x => x.bounds.totalMs = -1, x => x.bounds.spend.inputTokens = 'unlimited',
    x => x.bounds.spend.outputTokens = Infinity, x => x.bounds.invocationMs = null, x => x.observer.requestTimeoutMs = null]) {
    const invalid = structuredClone(h); change(invalid);
    assert.throws(() => directionRunner.validateExecutionHandoff(invalid), /handoff/);
  }
});


test('uncapped campaign still executes prerequisites and confined inspections with finite per-call cancellation',()=>directionTemporary(async root=>{
  const f=await prepared112(root,{uncapped:true});
  await f.runner.runPrerequisite({directory:f.directory,id:'P112-A1',codex:f.binary,execute:true});
  const result=JSON.parse(readFileSync(join(f.directory,'artifacts/P112-A1/result.json')));
  assert.equal(result.status,'completed');assert.equal(result.cleanup,true);assert.equal(result.sessionId,'synthetic-session');
  const fixture=direction.createDirectionFixture({directory:join(root,'inspection'),scenarioId:'D1'});
  const inspected=await f.runner.inspectCommand({workspace:fixture.directory,support:f.source,codex:f.binary,execution:{deadline:Infinity,graceMs:50}},process.execPath,['-e',"process.stdout.write('complete')"]);
  assert.equal(inspected.stdout,'complete');assert.equal(inspected.cleanup,true);
}));

test('original numeric authority remains distinct from appended explanatory prose and later ledger accounting',()=>temporary(root=>{
  const fixture=direction.createDirectionFixture({directory:join(root,'subject'),scenarioId:'D1'});
  const path=join(fixture.directory,'.afk/runs/trial/ledger.md'),original=readFileSync(path,'utf8'),expected=directionRunner.readOriginalAuthority(fixture.directory);
  assert.deepEqual({allowance:expected.allowance,consumed:expected.consumed,lines:expected.lines},{allowance:2,consumed:0,lines:{allowance:1,consumed:1}});
  writeFileSync(path,original+'\n## Verification\nAllowance: two, from the retained request; consumed remains zero.\n');
  assert.deepEqual(directionRunner.readOriginalAuthority(fixture.directory),expected);
  // An actual author appended a cycle record with its own consumed line; the last numeric line is the current accounting.
  writeFileSync(path,original+'\n## Cycle 1\nconsumed: 1\n');
  const updated=directionRunner.readOriginalAuthority(fixture.directory);
  assert.deepEqual({allowance:updated.allowance,consumed:updated.consumed,original:updated.original,lines:updated.lines},{allowance:2,consumed:1,original:{allowance:2,consumed:0},lines:{allowance:1,consumed:2}});
  assert.equal(direction.preservedRunAuthority(expected,updated),true);
  writeFileSync(path,original+'\nAllowance: 3\n');assert.equal(directionRunner.readOriginalAuthority(fixture.directory).allowance,3);
  assert.equal(direction.preservedRunAuthority(expected,directionRunner.readOriginalAuthority(fixture.directory)),false);
  writeFileSync(path,original+'\nconsumed: 5\n');assert.throws(()=>directionRunner.readOriginalAuthority(fixture.directory),/authority invalid/);
  writeFileSync(path,original+'\nstate: complete\nrun-id: hijacked\n');
  const mutated=directionRunner.readOriginalAuthority(fixture.directory);assert.equal(mutated.runId,'hijacked');assert.equal(mutated.state,'complete');
  assert.equal(direction.preservedRunAuthority(expected,mutated),false);
  writeFileSync(path,original.replace('allowance: 2','allowance: unknown'));
  assert.throws(()=>directionRunner.readOriginalAuthority(fixture.directory),/authority/);
}));
