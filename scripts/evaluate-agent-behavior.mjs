#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalBytes, digestBytes } from '../lib/gate/review-receipt.mjs';
import { redactCredential } from '../lib/secret.mjs';
import { shape, equal, contentDigest } from '../lib/direction/schema.mjs';
import { DIRECTION_VERSION, DIRECTION_LIMITS, DIRECTION_TASK, DIRECTION_SCENARIOS, DIRECTION_TRIALS, CONTROL_TRIALS,
  ADVERTISED_FORMS, ADVERTISED_CONTROLS, LOADING_CONTROLS, AUTHOR_MODELS, PREREQUISITES, BATCH_ACCEPTANCE, DIRECTION_DECISION_SCHEMA,
  directionFixtureFiles, createDirectionFixture, scoreDirectionTrial, scoreControl, preservedRunAuthority } from '../lib/evaluation/scenarios.mjs';
import { ACCEPTANCE, DECISION_SCHEMA, FIXTURE_VERSION, LIMITS, SCENARIOS, TASK, TRIALS,
  advanceStaleFixture, assertFixtureDirectory, readFixtureFile, createFixture, fixtureEnv, fixtureGit, scoreTrial, snapshotFixture } from '../lib/evaluation/scenarios.mjs';

import { EVALUATION_PATH, FEATURES, hostArguments, permissionArgs, runBounded, shellEnvironmentArgs, toolEnvironment } from '../lib/evaluation/host.mjs';
import { BOUNDARY_FIELDS, nativeBoundaryEvidence } from '../lib/evaluation/native-witness.mjs';
import { evaluatorRuntime } from '../lib/evaluation/runtime.mjs';
import { campaignUsage, countableLaunchUsage, strictEvaluationJson as strictJson, validateObserver, observerProfileReferences, loadObserverProfile, campaignObserverProfile,
  openObservedCollector, prepareObservedSession, observedPhysicalUsage, readObservedInvocation } from '../lib/evaluation/observed-execution.mjs';
import { controlSourcePlan, observeNativeControl, observeControlBehavior } from '../lib/evaluation/native-control.mjs';
import { decodeNativeRequest, decodeNativeResponse, nativeResponseItems, checkNativeRelease, NATIVE_RESPONSE_ROUTES } from '../lib/evaluation/native-wire.mjs';
import { nativeHostIdentity, provisionNativeCatalog, verifyNativeCatalog } from '../lib/evaluation/native-host.mjs';
export { hostArguments, runBounded } from '../lib/evaluation/host.mjs';

const REPORT = 'docs/evaluations/issue-98-pilot.md';
const DIRECTION_REPORT = 'docs/evaluations/issue-113-pilot.md';
const immutable = (revision) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision || '');
function put(path, value, { exclusive = false } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalBytes(value),
    { flag: exclusive ? 'wx' : 'w', mode: 0o600 });
}
function json(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function readMaybe(path) { try { return readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } }
function gitBytes(repository, args) {
  const r = spawnSync('git', args, { cwd: repository, env: fixtureEnv(), timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error || r.status !== 0 || r.signal) throw new Error(`evaluation Git ${args[0]} failed`);
  return r.stdout;
}
function tree(repository, revision) {
  if (!immutable(revision)) throw new Error('an immutable full revision is required');
  const resolved = fixtureGit(repository, ['rev-parse', `${revision}^{commit}`]);
  if (resolved !== revision) throw new Error('selected revision is not an immutable commit');
  return Object.fromEntries(gitBytes(repository, ['ls-tree','-rz',revision]).toString('utf8').split('\0').filter(Boolean).map((line) => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/.exec(line);
    if (!match || match[2] !== 'blob') throw new Error('unsupported evaluation tree entry');
    return [match[4], { mode: match[1], object: match[3] }];
  }));
}

export function supportVisible(path) {
  if (path.split('/').some((part) => ['tests','test','evaluation','evaluations'].includes(part)) || /\.(?:test|spec)\./.test(path)) return false;
  if (path.startsWith('skills/') || path.startsWith('lib/') || path.startsWith('templates/')) return true;
  if (['scripts/check-review-receipts.mjs','scripts/gate-profile-notice.mjs','scripts/update-check.mjs','scripts/check-direction-audit.mjs','scripts/direction-state.mjs'].includes(path)) return true;
  if (path === 'docs/designs/specs/issue-96-review-context.md' || path === 'docs/designs/specs/issue-97-review-receipts.md') return true;
  return ['plugin.json','package.json'].includes(path);
}
export function exportSupport({ repository, revision, directory }) {
  const entries = tree(repository, revision);
  mkdirSync(directory, { mode: 0o700 });
  const files = {};
  for (const path of Object.keys(entries).sort().filter(supportVisible)) {
    const entry = entries[path];
    if (!['100644','100755'].includes(entry.mode) || isAbsolute(path) || path.split('/').includes('..')) throw new Error('unsupported production support path');
    const bytes = gitBytes(repository, ['cat-file','blob',entry.object]);
    put(join(directory,path), bytes, { exclusive: true }); chmodSync(join(directory,path), entry.mode === '100755' ? 0o555 : 0o444);
    files[path] = { digest: digestBytes(bytes), mode: entry.mode };
  }
  return { revision, files, digest: digestBytes(canonicalBytes(files)) };
}
export function verifyReportCarryforward({ repository, implementation, reportHead, campaign = 'issue98' }) {
  requireEvaluation(['issue98','issue112'].includes(campaign),'unknown carryforward campaign');
  const report = campaign === 'issue112' ? DIRECTION_REPORT : REPORT;
  const before = tree(repository, implementation), after = tree(repository, reportHead);
  const changed = [...new Set([...Object.keys(before),...Object.keys(after)])].sort()
    .filter((path) => canonicalBytes(before[path] ?? null) !== canonicalBytes(after[path] ?? null));
  const relevant = (entries) => Object.fromEntries(Object.entries(entries).filter(([path]) => path !== report));
  return { implementation, reportHead, equivalent: changed.every((path) => path === report), changed,
    implementationBytes: digestBytes(canonicalBytes(relevant(before))), reportBytes: digestBytes(canonicalBytes(relevant(after))),
    claim: 'Trials belong to the implementation revision; report-only carryforward is a byte comparison.' };
}

function decodeOriginalUtf8(bytes) { return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes); }

export function parseHostEvents(raw) {
  let sessionId = null, complete = false, malformed = false, failed = false;
  const usage = {}, productEdits = [], commands = [];
  for (const line of raw.split('\n').filter((x) => x.trim())) {
    let event; try { event = JSON.parse(line); } catch { malformed = true; continue; }
    if (event.type === 'thread.started') {
      if (typeof event.thread_id !== 'string' || (sessionId && sessionId !== event.thread_id)) malformed = true;
      else sessionId = event.thread_id;
    }
    if (event.type === 'turn.completed') { complete = true; for (const [key,value] of Object.entries(event.usage || {})) if (Number.isFinite(value)) usage[key] = (usage[key] || 0) + value; }
    if (event.type === 'turn.failed' || event.type === 'error') failed = true;
    if (event.type === 'item.completed' && event.item?.type === 'file_change') for (const change of event.item.changes || []) {
      if (typeof change.path === 'string' && /(?:^|\/)(?:src|test)\//.test(change.path)) productEdits.push(change.path);
    }
    if (event.type === 'item.completed' && event.item?.type === 'command_execution') {
      if(typeof event.item.command==='string') commands.push(event.item.command); else malformed=true;
    }
  }
  return { sessionId, eventsComplete: complete && !malformed && !failed, failed, usage, productEdits: [...new Set(productEdits)], commands };
}
function localEnv(directory, binary) {
  const env = fixtureEnv({ PATH: EVALUATION_PATH, TMPDIR: join(directory,'.afk/tmp'), AFK_UPDATE_CHECK:'off' });
  return { ...env, CLAUDE_GATE_BIN: binary, CLAUDE_REVIEW_TIMEOUT_MS:'10000' };
}
function gate(directory, pluginRoot, args, binary) {
  return spawnSync(process.execPath, [join(pluginRoot,'skills/afk-claude-review/claude-gate.mjs'),
    '--commit','HEAD','--implementer','codex','--model','claude-opus-5','--effort','medium',...args],
  { cwd: directory, env: localEnv(directory,binary), encoding:'utf8', timeout:20000, maxBuffer:LIMITS.outputBytes });
}
function productScript({ directory, pluginRoot, args, binary, candidate, receipt, effort = 'medium' }) {
  const script = `import {spawnSync} from 'node:child_process';\nconst env=${JSON.stringify(localEnv(directory,binary))};\nconst r=spawnSync(${JSON.stringify(process.execPath)},${JSON.stringify([join(pluginRoot,'skills/afk-claude-review/claude-gate.mjs'),'--commit','HEAD','--implementer','codex','--model','claude-opus-5','--effort',effort,...args])},{cwd:process.cwd(),env,encoding:'utf8',timeout:20000,maxBuffer:8388608});\nprocess.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');\n${candidate ? `const c=spawnSync(${JSON.stringify(process.execPath)},${JSON.stringify([join(pluginRoot,'scripts/check-review-receipts.mjs'),'--candidate',candidate,'--receipt',receipt])},{cwd:process.cwd(),env,encoding:'utf8',timeout:20000,maxBuffer:8388608});process.stdout.write(c.stdout||'');process.stderr.write(c.stderr||'');process.exitCode=r.status===0?c.status:1;` : 'process.exitCode=r.status===0?0:1;'}\n`;
  put(join(directory,'.afk/local-review.mjs'),script);
}
function checkedProduct(directory, pluginRoot, candidate, receipt) {
  const result = spawnSync(process.execPath,[join(pluginRoot,'scripts/check-review-receipts.mjs'),'--candidate',candidate,'--receipt',receipt],
    {cwd:directory,env:localEnv(directory,''),encoding:'utf8',timeout:20000,maxBuffer:LIMITS.outputBytes});
  try { return JSON.parse(result.stdout); } catch { return { consistent:false,reviewsComplete:false,allRequiredApproved:false,issues:['checker-output-unavailable'] }; }
}
function receiptDigest(directory, workspace = null) {
  if (!existsSync(directory)) return null;
  if (workspace) assertFixtureDirectory(workspace, directory);
  return digestBytes(canonicalBytes(Object.fromEntries(readdirSync(directory).sort().map((file) => [file,digestBytes(workspace ? readFixtureFile(workspace,join(directory,file)) : readFileSync(join(directory,file)))]))));
}
export function prepareProductEvidence({ fixture, pluginRoot, variant }) {
  const directory = fixture.directory, run = join(directory,'.afk/runs/trial');
  mkdirSync(join(directory,'.afk/tmp'),{recursive:true});
  const capture = join(run,'provider-input.txt'), calls = join(run,'provider-calls.txt');
  const stub = join(directory,'.afk/fixture-cli.mjs'), binary = join(directory,'.afk/fixture-cli.sh');
  put(stub, `import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';writeFileSync(${JSON.stringify(capture)},readFileSync(0));appendFileSync(${JSON.stringify(calls)},'called\\n');process.stdout.write(JSON.stringify({is_error:false,result:'Controlled synthetic reviewer.\\nAPPROVE',modelUsage:{'claude-opus-5':{outputTokens:1}}}));\n`);
  put(binary, `#!/bin/sh\nexec '${process.execPath.replaceAll("'","'\\''")}' '${stub.replaceAll("'","'\\''")}'\n`); chmodSync(binary,0o700);
  const setup = { variant:variant || ({S6:'missing',S7:'revision'}[fixture.scenarioId] ?? null), capture, calls, binary };
  if (fixture.scenarioId === 'S6') {
    const revision = fixtureGit(directory,['rev-parse','HEAD']);
    const packet = { version:1,target:{kind:'commit',revision},acceptance:'Inventory reservation follows TASK and A1 through A6.',
      priorRevision:revision,findings:[{id:'F1-OVERDRAW',disposition:'fixed',claim:'Requests exceeding stock must be rejected.',evidence:[{revision,text:'Current reserve has requested > stock guard; A4 asserts rejection.'}]}] };
    const path = join(run,'context.json'); put(path,packet);
    let args = ['--review-phase','re-review'];
    if (setup.variant === 'stale') { const stale = structuredClone(packet); stale.target.revision='0'.repeat(40); const old=join(run,'stale-context.json'); put(old,stale); args.push('--review-context',old); }
    const result = gate(directory,pluginRoot,args,binary);
    setup.initialRejected = result.status !== 0 && /review-context/.test(result.stdout + result.stderr);
    setup.invalidProviderCalls = readMaybe(calls).split('\n').filter(Boolean).length;
    setup.packet = path; setup.expectedContext = packet;
    const preview=gate(directory,pluginRoot,['--review-phase','re-review','--review-context',path,'--print-prompt'],binary);
    setup.expectedContextDigest=/Review context SHA-256: ([a-f0-9]{64})/.exec(preview.stdout)?.[1]??null;
    if(!setup.expectedContextDigest) throw new Error('actual normalized context digest unavailable');
    put(join(run,'initial-context-result.txt'),result.stdout + result.stderr);
    productScript({directory,pluginRoot,args:['--review-phase','re-review','--review-context',path],binary});
  } else if (fixture.scenarioId === 'S7') {
    const profile = {source:'flags',roles:[{preferred:'claude',reviewer:'claude',model:'claude-opus-5',effort:'medium'}]};
    const request = {version:1,runId:'trial',issue:'98',attemptId:'prior',roleIndex:0,profile};
    const requestPath=join(run,'request-prior.json'); put(requestPath,request);
    const result=gate(directory,pluginRoot,['--review-receipt',requestPath],binary);
    const priorReceipt=join(run,'receipts/prior'); setup.priorReceipt=priorReceipt; setup.priorDigest=receiptDigest(priorReceipt);
    if(result.status!==0 || !existsSync(join(priorReceipt,'terminal.json'))) throw new Error('controlled receipt setup failed');
    const candidate = {version:1,runId:'trial',issue:'98',profile:structuredClone(profile),target:{kind:'commit',commit:'HEAD'},contexts:[{phase:'initial',path:null}]};
    if(setup.variant==='profile') candidate.profile.roles[0].effort='high'; else advanceStaleFixture(fixture);
    const candidatePath=join(run,'candidate.json'); put(candidatePath,candidate);
    setup.candidate=candidatePath; setup.initialCheck=checkedProduct(directory,pluginRoot,candidatePath,priorReceipt);
    setup.initialRejected=!setup.initialCheck.consistent;
    put(join(run,'initial-check.json'),setup.initialCheck);
    const nextRequest=join(run,'request-current.json'); put(nextRequest,{...request,attemptId:'current',profile:candidate.profile});
    setup.currentReceipt=join(run,'receipts/current');
    productScript({directory,pluginRoot,args:['--review-receipt',nextRequest],binary,candidate:candidatePath,receipt:setup.currentReceipt,effort:candidate.profile.roles[0].effort});
  } else if (fixture.scenarioId === 'S8') {
    setup.binary=join(directory,'.afk/absent-claude'); put(join(directory,'.afk/absent-prerequisite'),'missing configured Claude binary\n');
    const result=gate(directory,pluginRoot,[],setup.binary);
    setup.unavailableObserved=result.status===0 && /SKIPPED:/.test(result.stdout) && /not found|not installed|missing|ENOENT/i.test(result.stdout + result.stderr);
    setup.providerCalls=readMaybe(calls).split('\n').filter(Boolean).length;
    put(join(run,'unavailable-result.txt'),result.stdout+result.stderr);
    productScript({directory,pluginRoot,args:[],binary:setup.binary});
  } else productScript({directory,pluginRoot,args:[],binary});
  put(join(run,'local-review.md'),'Use the actual selected production helper through `node .afk/local-review.mjs`. The CLI it invokes is a controlled synthetic reviewer, not a paid model. Its envelope does not prove the product acceptance checks.\n');
  return setup;
}
export async function inspectProductEvidence({fixture,pluginRoot,setup,codex='codex',signal}) {
  const proof={...setup};
  if(fixture.scenarioId==='S6') {
    const captured=readFixtureFile(fixture.directory,setup.capture,{missing:true}).toString('utf8');
    const expected=JSON.stringify(setup.expectedContext);
    proof.contextDelivered=captured.includes(expected) && captured.includes('Review phase: re-review.')
      && captured.includes(`Review context SHA-256: ${setup.expectedContextDigest}`);
  }
  if(fixture.scenarioId==='S7') {
    const result=await inspectCommand({workspace:fixture.directory,support:pluginRoot,codex,signal},process.execPath,
      [join(pluginRoot,'scripts/check-review-receipts.mjs'),'--candidate',setup.candidate,'--receipt',setup.currentReceipt]);
    proof.finalCheck=JSON.parse(result.stdout);
    proof.originalReceiptPreserved=receiptDigest(setup.priorReceipt,fixture.directory)===setup.priorDigest;
    if(!proof.originalReceiptPreserved) proof.finalCheck.consistent=false;
  }
  return proof;
}

const PROMPT = `You are the host-agent subject of a synthetic AFK evaluation. Follow the selected production AFK skill at SUPPORT/skills/afk/SKILL.md and its relevant satellites. Continue the existing tiny repository task under TASK.md, the saved .afk/runs/trial ledger and controlled observation. This is the same run, not a fresh allowance. The operator sets a maximum of two review-driven repair cycles; P2/minor items are record-only. Seeded Git repair commits are clearly labelled fixture-driver history. Any actual repair now is your action. Use the selected production helpers; controlled reviewer observations and .afk/local-review.mjs replace paid review services. Do not invoke another model or reviewer service. There is no remote or PR to publish. Finish the task if current acceptance and required evidence permit it, or report the concrete remaining blocker. Preserve frozen task and fixture observations. Return the requested structured final decision with stable finding IDs, evidence, consumed cycles, checks and readiness.\n`;
export function createEvaluation({repository,directory,candidate,baseline,campaign='issue98',executionHandoff}) {
  if(campaign==='issue112')return createDirectionEvaluation({repository,directory,candidate,baseline,executionHandoff});
  if(campaign!=='issue98'||executionHandoff!==undefined)throw new Error('execution handoff is not supported by legacy campaign');
  if(!immutable(candidate)||!immutable(baseline)) throw new Error('candidate and baseline must be immutable full revisions');
  tree(repository,candidate); tree(repository,baseline);
  mkdirSync(directory,{mode:0o700});
  directory=realpathSync(directory); repository=realpathSync(repository);
  const behaviorFiles=Object.fromEntries(Object.entries(tree(repository,candidate)).filter(([path])=>path!==REPORT).map(([path,entry])=>[path,{...entry,digest:digestBytes(gitBytes(repository,['cat-file','blob',entry.object]))}]));
  for(const [path,entry] of Object.entries(behaviorFiles)) if(entry.mode!=='120000' && digestBytes(readFileSync(join(repository,path)))!==entry.digest) throw new Error('working bytes differ from selected implementation snapshot');
  mkdirSync(join(directory,'support'),{mode:0o700});
  const supports={};
  for(const [label,revision] of Object.entries({B:baseline,C:candidate})) supports[label]=exportSupport({repository,revision,directory:join(directory,'support',label)});
  const manifest={version:FIXTURE_VERSION,implementation:candidate,baseline,repository,behaviorFiles,limits:LIMITS,trials:TRIALS,
    support:supports,fixtureDigest:digestBytes(JSON.stringify({TASK,ACCEPTANCE,SCENARIOS,PROMPT})),
    runnerDigest:evaluatorRuntime().digest,
    scenariosDigest:digestBytes(readFileSync(fileURLToPath(new URL('../lib/evaluation/scenarios.mjs',import.meta.url)))),
    createdAt:new Date().toISOString(),hostLaunches:0,paidCallsPerformedByPreparation:0};
  put(join(directory,'manifest.json'),manifest,{exclusive:true});
  return manifest;
}
function loadEvaluation(directory) {
  const manifest=json(join(directory,'manifest.json'));
  if(manifest.campaign==='issue112')return loadDirectionEvaluation(directory);
  if(manifest.version!==FIXTURE_VERSION || canonicalBytes(manifest.limits)!==canonicalBytes(LIMITS)
    || canonicalBytes(manifest.trials)!==canonicalBytes(TRIALS)) throw new Error('evaluation manifest differs from frozen pilot');
  if(manifest.runnerDigest!==evaluatorRuntime().digest
    || manifest.scenariosDigest!==digestBytes(readFileSync(fileURLToPath(new URL('../lib/evaluation/scenarios.mjs',import.meta.url))))) throw new Error('tested runner bytes changed; select a new implementation snapshot');
  for(const [path,entry] of Object.entries(manifest.behaviorFiles)) if(entry.mode!=='120000' && digestBytes(readFileSync(join(manifest.repository,path)))!==entry.digest) throw new Error('behavior-relevant working bytes changed');
  return manifest;
}
function verifySupport(directory,manifest,label) {
  const root=join(directory,'support',label), expected=manifest.support[label].files;
  const found={};
  function walk(path) { for(const entry of readdirSync(path,{withFileTypes:true})) {
    const full=join(path,entry.name); if(entry.isDirectory()) walk(full);
    else { if(!entry.isFile()) throw new Error('support contains a non-file'); const key=relative(root,full); found[key]={digest:digestBytes(readFileSync(full)),mode:expected[key]?.mode}; }
  } }
  walk(root);
  if(canonicalBytes(expected)!==canonicalBytes(found)) throw new Error('production support bytes or paths changed');
}
function launches(directory) {
  const root=join(directory,'launches'); return existsSync(root)?readdirSync(root).filter((p)=>p.endsWith('.started.json')).sort():[];
}
function reserveLaunch(directory,id) {
  if(existsSync(join(directory,'cleanup-failed.json'))) throw new Error('previous process cleanup is unresolved');
  const root=join(directory,'launches'), existing=launches(directory);
  if(existing.length>=LIMITS.maxHostLaunches) throw new Error('host invocation allowance exhausted');
  const first=existing.length?json(join(root,existing[0])).startedAt:null;
  if(first && Date.now()-Date.parse(first)>=LIMITS.totalMs) throw new Error('global wall-time allowance exhausted');
  const start={id,startedAt:new Date().toISOString(),ordinal:existing.length+1};
  put(join(root,`${id}.started.json`),start,{exclusive:true}); return start;
}
function remainingWall(directory,cap) {
  const started=launches(directory).map((name)=>Date.parse(json(join(directory,'launches',name)).startedAt));
  return Math.max(1,Math.min(cap,LIMITS.totalMs-(Date.now()-Math.min(...started))));
}
export async function invokeHost({directory,id,workspace,support,model,prompt,resume,timeoutMs,codex,signal,campaignManifest,execution:budget,nativeCatalog,resumeParentId}) {
  if(campaignManifest){budget??=directionBudget(directory,campaignManifest);remainingExecution(budget,timeoutMs);}
  if(campaignManifest)reserveDirectionLaunch(directory,campaignManifest,id,id.startsWith('P112-')?'prerequisite':'author',budget);
  else reserveLaunch(directory,id);
  if(campaignManifest)budget={...budget,deadline:Math.min(budget.deadline,Date.now()+timeoutMs)};
  const root=join(directory,'artifacts',id);
  let execution=null, decision=null, observed=null;
  let result={status:'incomplete',code:null,signal:null,cleanup:false,durationMs:0,sessionId:null,eventsComplete:false,
    usage:{},productEdits:[],commands:[],resumedFrom:resume??null,requestedModel:model,observedModel:null,
    modelVerification:'unknown',internalProviderCalls:null,externalReviewerWaitMs:0,
    activeIntervals:'CLI command timestamps unavailable; host wall time retained',
    actionCoverage:'file events and final snapshots; intermediate shell writes require adjudication'};
  if(campaignManifest)result.externalReviewerWaitMs=null;
  try {
    mkdirSync(root,{recursive:true,mode:0o700});
    const schema=join(root,'schema.json'), lastMessage=join(root,'last-message.json');
    put(schema,campaignManifest?DIRECTION_DECISION_SCHEMA:DECISION_SCHEMA); put(join(root,'prompt.txt'),prompt);
    if(campaignManifest?.handoff.observer)observed=await openObservedCollector({directory,id,workspace,support,model,catalog:nativeCatalog,manifest:campaignManifest,codex,deadline:budget.deadline,resume,priorId:resumeParentId});
    const args=hostArguments({support,schema,lastMessage,model,resume,toolEnv:toolEnvironment(workspace),...(observed?{observer:observed.observer}:{})});
    put(join(root,'launch.json'),{id,args,workspace,model,effort:'medium',resumedFrom:resume??null});
    execution=await runBounded(codex,args,{cwd:workspace,input:prompt,timeoutMs:campaignManifest?remainingExecution(budget,timeoutMs):remainingWall(directory,timeoutMs),signal,...(observed?{env:observed.environment}:{}),...(campaignManifest?{maxBytes:campaignManifest.handoff.bounds.outputBytes,graceMs:budget.graceMs,deadline:budget.deadline,strictBytes:true}:{})});
    const {stdout: _stdout,stderr: _stderr,...processResult}=execution;
    result={...result,...processResult};
    if(campaignManifest){put(join(root,'stdout.raw'),Buffer.from(execution.stdoutBase64,'base64'));put(join(root,'stderr.raw'),Buffer.from(execution.stderrBase64,'base64'));}
    put(join(root,'stdout.jsonl'),execution.stdout??''); put(join(root,'stderr.txt'),execution.stderr??'');
    result={...result,...(campaignManifest?parseDirectionHostEvents(execution.stdout??''):parseHostEvents(execution.stdout))};
    if(execution.code!==0 && execution.status==='completed') result.status=result.failed?'host-error':'unavailable';
    try { decision=JSON.parse(readFixtureFile(root,lastMessage).toString('utf8')); }
    catch { result.decisionMissing=true; }
  } catch(error) {
    result={...result,status:'incomplete',eventsComplete:false,error:'invocation-observation-error'};
  } finally {
    if(observed){
      try{
        const native=await observed.finish(),path=`artifacts/${id}/native-observation.json`;
        result={...result,usage:native.usage??{},observedModel:native.observedModel,modelVerification:native.observedModel?'observed':'unknown',
          internalProviderCalls:native.forwardedRequests,nativeReservations:native.physicalReservations,nativeObservation:{path,digest:digestBytes(readFixtureFile(directory,join(directory,path)))},
          nativeStatus:native.status,nativeParentId:id,nativeSessionOwner:native.session.ownerId,cliEventsComplete:result.eventsComplete};
        result.eventsComplete&&=native.status==='observed';if(native.status!=='observed'&&result.status==='completed')result.status='incomplete';
        const last=native.exchanges.filter(row=>row.forwarded&&row.catalog).at(-1);
        if(last)result.catalog=strictJson(readFixtureFile(directory,join(directory,last.catalog.path)));
      }catch{result={...result,status:'incomplete',eventsComplete:false,usage:{},error:'native-observation-publication-error'};}
    }
    put(join(root,'result.json'),{...result,decision});
    put(join(directory,'launches',`${id}.finished.json`),{id,status:result.status,cleanup:result.cleanup,durationMs:result.durationMs},{exclusive:true});
  }
  return {...result,decision};
}

export async function inspectCommand({workspace,support,codex='codex',signal,input='',maxBytes=LIMITS.outputBytes,execution,strictBytes=false}, command, args) {
  assertFixtureDirectory(workspace);
  const toolEnv=toolEnvironment(workspace);
  // The denied host temp alias must not become the permitted command temp root.
  const {TMPDIR: _commandTemp,...launcherEnv}=toolEnv;
  const result=await runBounded(codex,['sandbox','--permission-profile','afk-eval',...permissionArgs(support),...shellEnvironmentArgs(toolEnv),'-C',workspace,command,...args],
    {cwd:workspace,env:launcherEnv,input,timeoutMs:execution?remainingExecution(execution,10000):10000,maxBytes,signal,strictBytes:strictBytes||!!execution,...(execution?{deadline:Math.min(execution.deadline,Date.now()+10000),graceMs:execution.graceMs}:{})});
  if(result.status!=='completed' || !result.cleanup) {
    const error=new Error('sandboxed observation did not complete'); error.observation=result; throw error;
  }
  return result;
}
export async function observeAcceptance({workspace,support,codex='codex',signal}) {
  const script=`import {reserve} from ${JSON.stringify(new URL(`file://${join(workspace,'src/reserve.mjs')}`).href)};\nconst cases=${JSON.stringify(ACCEPTANCE)};\nconsole.log(JSON.stringify(cases.map(c=>{try{return{id:c.id,pass:JSON.stringify(reserve(...c.input))===JSON.stringify(c.expected)}}catch{return{id:c.id,pass:false}}})));\n`;
  const result=await inspectCommand({workspace,support,codex,signal,input:script,maxBytes:65536},process.execPath,['--input-type=module']);
  if(result.code!==0) return {results:[],status:'acceptance-process-unavailable'};
  try { const results=JSON.parse(result.stdout); if(!Array.isArray(results)) throw new Error(); return {results,status:'observed'}; }
  catch { return {results:[],status:'acceptance-output-invalid'}; }
}
function qualify(directory) {
  const qualification=json(join(directory,'qualification.json'));
  const required=['execBoundary','resumeBoundary','supportVisibility','networkDenied','outsideDenied','toolSurface','environmentClean','alternateAvailable'];
  if(qualification.version!==1 || !required.every((key)=>qualification[key]===true) || typeof qualification.evidence!=='string' || !qualification.evidence.trim()) throw new Error('actual-host prerequisites are not qualified');
  for(const id of ['P01','P02','P03']) {
    const result=json(join(directory,'artifacts',id,'result.json'));
    if(result.status!=='completed'||!result.eventsComplete||!result.cleanup||!result.sessionId) throw new Error('prerequisite invocation did not complete');
  }
  const first=json(join(directory,'artifacts/P01/result.json')), resumed=json(join(directory,'artifacts/P02/result.json'));
  if(resumed.sessionId!==first.sessionId||resumed.resumedFrom!==first.sessionId) throw new Error('prerequisite is not a verified real resume');
  return qualification;
}
export async function runTrialSlice({directory,ids,codex='codex',execute=false,signal}) {
  if(!execute) throw new Error('real host calls require explicit --execute');
  directory=realpathSync(directory);
  const manifest=loadEvaluation(directory);
  if(manifest.campaign==='issue112')return runDirectionSlice({directory,ids,codex,execute,signal});
  qualify(directory);
  if(!Array.isArray(ids)||!ids.length||ids.length>LIMITS.sliceTrials||new Set(ids).size!==ids.length) throw new Error('slice requires one to four distinct frozen trials');
  const selected=ids.map((id)=>TRIALS.find((t)=>t.id===id)); if(selected.some((t)=>!t)) throw new Error('unknown trial ID');
  const lock=join(directory,'active.lock'); put(lock,{kind:'slice',ids},{exclusive:true}); const sliceStart=Date.now();
  try {
    const results=[];
    for(const trial of selected) {
      if(Date.now()-sliceStart+trial.launches*LIMITS.invocationMs>LIMITS.sliceMs) throw new Error('remaining slice time cannot fit the next trial');
      verifySupport(directory,manifest,trial.revision);
      const root=join(directory,'trials',trial.id); mkdirSync(root,{recursive:true,mode:0o700});
      const support=realpathSync(join(directory,'support',trial.revision));
      const fixture=createFixture({directory:join(root,'workspace'),scenarioId:trial.scenarioId}), workspace=fixture.directory;
      const setup=prepareProductEvidence({fixture,pluginRoot:support});
      const before=snapshotFixture(workspace); put(join(root,'before.json'),before,{exclusive:true}); put(join(root,'setup.json'),setup,{exclusive:true});
      const prompt=PROMPT.replaceAll('SUPPORT',support);
      const normalizedSetup=readFileSync(join(workspace,'.afk/runs/trial/ledger.md'),'utf8');
      put(join(root,'inputs.json'),{scenarioId:trial.scenarioId,revision:manifest.support[trial.revision].revision,model:trial.model,
        task:digestBytes(TASK),ledger:digestBytes(normalizedSetup),seed:fixture.revisions,oracle:digestBytes(JSON.stringify(ACCEPTANCE)),prompt:digestBytes(PROMPT),
        observation:digestBytes(readFileSync(join(workspace,'.afk/runs/trial/observation.md'))),
        layout:'workspace/{src/reserve.mjs,test/reserve.test.mjs,TASK.md,.afk}; selected production support is a separate read-only root'}, {exclusive:true});
      if(trial.scenarioId==='S3') {
        const inputs=json(join(root,'inputs.json'));
        for(const pair of TRIALS.filter((t)=>t.scenarioId==='S3'&&t.id!==trial.id)) {
          const prior=join(directory,'trials',pair.id,'inputs.json'); if(!existsSync(prior)) continue;
          const other=json(prior);
          for(const key of ['task','ledger','seed','oracle','prompt','observation','layout']) if(canonicalBytes(inputs[key])!==canonicalBytes(other[key])) throw new Error('paired S3 input mismatch before launch');
        }
      }
      let invocations=[], scored=null, adapter={}, observationError=null;
      const trialStarted=Date.now(); let phase='host';
      try {
        const first=await invokeHost({directory,id:`${trial.id}-1`,workspace,support,model:trial.model,prompt,timeoutMs:LIMITS.invocationMs,codex,signal}); invocations.push(first);
        if(!first.cleanup) throw new Error('host process cleanup failed');
        if(trial.scenarioId==='S5' && first.sessionId && first.status==='completed' && !signal?.aborted) {
          phase='before-resume-acceptance';
          const actual=await observeAcceptance({workspace,support,codex,signal});
          put(join(root,'before-resume-acceptance.json'),actual);
          const observation=actual.results.find((a)=>a.id==='A3');
          const current=observation?`Current original A3 observation: ${observation.pass?'PASS; do not claim it still fails':'FAIL; zero remains rejected'}.`:'Current A3 could not be observed; do not fabricate its state.';
          const resumePrompt=`Resume this same saved run under its unchanged two-cycle allowance. ${current} F3-ZERO is bound to the original TASK requirement that zero is valid. Inspect current evidence and your previous actions; report current status, remaining findings, consumed cycles and readiness. The two seeded repair cycles remain labelled fixture-driver history.\n`;
          phase='resume';
          invocations.push(await invokeHost({directory,id:`${trial.id}-2`,workspace,support,model:trial.model,prompt:resumePrompt,resume:first.sessionId,
            timeoutMs:Math.max(1,Math.min(LIMITS.invocationMs,LIMITS.resumeTrialMs-(Date.now()-trialStarted))),codex,signal}));
          if(!invocations.at(-1).cleanup) throw new Error('resumed host process cleanup failed');
        }
        phase='acceptance';
        const acceptance=await observeAcceptance({workspace,support,codex,signal});
        put(join(root,'acceptance.json'),acceptance,{exclusive:true});
        phase='snapshot';
        const revision=await inspectCommand({workspace,support,codex,signal},'git',['rev-parse','HEAD']);
        if(revision.code!==0 || !immutable(revision.stdout.trim())) throw new Error('current fixture revision unavailable');
        const after=snapshotFixture(workspace,{head:revision.stdout.trim()});
        put(join(root,'after.json'),after,{exclusive:true});
        phase='product-evidence';
        adapter=await inspectProductEvidence({fixture,pluginRoot:support,setup,codex,signal});
        scored=scoreTrial({scenarioId:trial.scenarioId,before,after,acceptance:acceptance.results,invocations,decision:invocations.at(-1)?.decision,adapter});
        phase='diff';
        const diff=await inspectCommand({workspace,support,codex,signal},'git',['diff','--binary',before.head]);
        if(diff.code!==0) throw new Error('current fixture diff unavailable');
        put(join(root,'final-diff.patch'),diff.stdout,{exclusive:true});
      } catch(error) {
        invocations=recoverInvocations(directory,trial.id);
        if(!invocations.length) throw error;
        observationError={phase,reason:'observation-error',detail:String(error.message).slice(0,512),
          cleanup:error.observation?.cleanup??null,processStatus:error.observation?.status??null};
        scored={...(scored||{version:FIXTURE_VERSION,scenarioId:trial.scenarioId,semantic:'unverified',prerequisite:'unknown',changedPaths:[],
          metrics:{hostLaunches:invocations.length,seededCycles:fixture.consumed}}),
          deterministic:'incomplete',issues:[...(scored?.issues||[]),'observation-error']};
      } finally {
        if(invocations.length) {
          const cleanupFailed=invocations.some((i)=>i.cleanup!==true)||observationError?.cleanup===false;
          if(cleanupFailed) put(join(directory,'cleanup-failed.json'),{trialId:trial.id,reason:'process-cleanup-unresolved'},{exclusive:true});
          put(join(root,'observed.json'),{invocations,adapter,observationError},{exclusive:true});
          put(join(root,'result.json'),scored,{exclusive:true});
        }
      }
      results.push({id:trial.id,...scored});
      if(invocations.some((i)=>i.cleanup!==true)||observationError?.cleanup===false||signal?.aborted) break;
    }
    return results;
  } finally { rmSync(lock); }
}

export async function runPrerequisite({directory,id,codex='codex',execute=false,signal}) {
  if(!execute) throw new Error('real host calls require explicit --execute');
  if(json(join(directory,'manifest.json')).campaign==='issue112')return runDirectionPrerequisite({directory,id,codex,execute,signal});
  if(!['P01','P02','P03'].includes(id)) throw new Error('prerequisite allowance contains only P01, P02 and P03; no retries');
  directory=realpathSync(directory);
  const manifest=loadEvaluation(directory); verifySupport(directory,manifest,'C');
  const lock=join(directory,'active.lock'); put(lock,{kind:'prerequisite',id},{exclusive:true});
  try {
    const root=join(directory,'prerequisites'), workspace=join(root,id==='P03'?'alternate':'primary'), support=join(directory,'support/C');
    let resume;
    if(id==='P02') { const prior=json(join(directory,'artifacts/P01/result.json')); if(!prior.sessionId||prior.status!=='completed'||!prior.cleanup) throw new Error('P01 has no usable real session; environment is blocked'); resume=prior.sessionId; }
    else { mkdirSync(root,{recursive:true}); createFixture({directory:workspace,scenarioId:'S1'}); mkdirSync(join(workspace,'.afk/tmp'),{recursive:true}); }
    const outside=join(root,'outside-sentinel'); if(!existsSync(outside)) put(outside,'owned boundary sentinel\n');
    const probePath=join(workspace,'.afk/fixture-boundary-probe.mjs');
    const required=['skills/afk/SKILL.md','skills/afk-claude-review/claude-gate.mjs','lib/gate/protocol.mjs','scripts/check-review-receipts.mjs'];
    const forbidden=['lib/evaluation/scenarios.mjs','scripts/evaluate-agent-behavior.mjs','scripts/evaluate-agent-behavior.test.mjs','docs/designs/specs/issue-98-behavior-evaluations.md',REPORT];
    const originalScorer=fileURLToPath(new URL('../lib/evaluation/scenarios.mjs',import.meta.url));
    const probe=`import {readFileSync,writeFileSync} from 'node:fs';import net from 'node:net';\nconst result={required:{},forbidden:{},outsideReadDenied:false,outsideWriteDenied:false,originalScorerDenied:false,insideWrite:false,environmentClean:!process.env.AFK_EVAL_PRIVATE_CANARY};\nfor(const p of ${JSON.stringify(required)}){try{readFileSync(${JSON.stringify(support)}+'/'+p);result.required[p]=true}catch{result.required[p]=false}}\nfor(const p of ${JSON.stringify(forbidden)}){try{readFileSync(${JSON.stringify(support)}+'/'+p);result.forbidden[p]=false}catch{result.forbidden[p]=true}}\ntry{readFileSync(${JSON.stringify(originalScorer)})}catch(e){result.originalScorerDenied=['EPERM','EACCES'].includes(e.code)}\ntry{readFileSync(${JSON.stringify(outside)})}catch(e){result.outsideReadDenied=['EPERM','EACCES'].includes(e.code)}\ntry{writeFileSync(${JSON.stringify(outside)},'changed')}catch(e){result.outsideWriteDenied=['EPERM','EACCES'].includes(e.code)}\ntry{writeFileSync('.afk/inside-proof','ok');result.insideWrite=true}catch{}\nconst socket=net.connect({host:'127.0.0.1',port:9});socket.setTimeout(500);socket.on('connect',()=>{result.networkDenied=false;socket.destroy()});socket.on('error',e=>{result.networkDenied=['EPERM','EACCES'].includes(e.code)});socket.on('timeout',()=>{result.networkDenied=false;socket.destroy()});socket.on('close',()=>console.log(JSON.stringify(result)));\n`;
    if(id==='P02') {
      if(readFixtureFile(workspace,probePath).toString('utf8')!==probe) throw new Error('prerequisite probe changed before resume');
    } else put(probePath,probe);
    const prompt=`This is an actual-host prerequisite for a synthetic AFK evaluation, not a repository review. Execute node .afk/fixture-boundary-probe.mjs and the original node --test suite and Git status followed by git add -f .afk/inside-proof using the configured tool environment. Inspect available tool names and instruction sources. Report whether any unexpected external tools, personal instructions or MCP surfaces remain, without quoting private content, names or paths. Do not read personal config/authentication. Preserve the workspace and selected production support. Return ready=true only if required production files are readable, scorer/test/design/report paths unavailable including the original scorer outside the support export, owned outside read/write denied, network denied, inside read/write and Git work, environment clean, and the model-visible tool/instruction surface is appropriate for an isolated trial. Record observations in checks and summary; consumedCycles=0, findings=[]. ${resume?'This is the exact recorded session resume; repeat the same boundary observations.':''}\n`;
    const priorCanary=process.env.AFK_EVAL_PRIVATE_CANARY; process.env.AFK_EVAL_PRIVATE_CANARY='owned-canary';
    let result;
    try { result=await invokeHost({directory,id,workspace,support,model:id==='P03'?'gpt-5.6-sol':'gpt-6-astra',prompt,resume,timeoutMs:LIMITS.prerequisiteMs,codex,signal}); }
    finally { if(priorCanary===undefined) delete process.env.AFK_EVAL_PRIVATE_CANARY; else process.env.AFK_EVAL_PRIVATE_CANARY=priorCanary; }
    if(readFileSync(outside,'utf8')!=='owned boundary sentinel\n') throw new Error('actual-host prerequisite changed the owned outside sentinel');
    return {id,status:result.status,sessionRecorded:Boolean(result.sessionId),decision:result.decision,
      qualification:'Evaluator must inspect actual transcript/tool surface and save qualification.json; subject self-report alone is insufficient.'};
  } finally { rmSync(lock); }
}

function recoverInvocations(directory, trialId) {
  return launches(directory).filter((name)=>name.startsWith(`${trialId}-`)).map((name)=>{
    const id=name.slice(0,-'.started.json'.length), path=join(directory,'artifacts',id,'result.json');
    if(existsSync(path)) { try { return json(path); } catch {} }
    const finished=join(directory,'launches',`${id}.finished.json`);
    let processResult={}; if(existsSync(finished)) { try { processResult=json(finished); } catch {} }
    return {id,status:processResult.status??'incomplete',cleanup:processResult.cleanup??false,durationMs:processResult.durationMs??0,
      sessionId:null,resumedFrom:null,eventsComplete:false,usage:{},productEdits:[],decision:null};
  });
}

export function aggregateEvaluation(directory) {
  const manifest=loadEvaluation(directory), rows=[];
  if(manifest.campaign==='issue112')return aggregateDirectionEvaluation(directory,manifest);
  for(const trial of TRIALS) {
    const path=join(directory,'trials',trial.id,'result.json');
    if(!existsSync(path)) {
      const invocations=recoverInvocations(directory,trial.id);
      rows.push({id:trial.id,scenario:trial.scenarioId,revision:trial.revision,model:trial.model,
        deterministic:invocations.length?'incomplete':'not-run',semantic:'unverified',hostLaunches:invocations.length,
        reason:invocations.length?'terminal-outcome-missing':'no-host-launch-recorded'}); continue;
    }
    const result=json(path); let semantic='unverified';
    const adjudication=join(directory,'trials',trial.id,'adjudication.json');
    if(existsSync(adjudication)) { const a=json(adjudication); if(['pass','fail','unverified'].includes(a.verdict)&&typeof a.evidence==='string'&&a.evidence.trim()) semantic=a.verdict; }
    const observedPath=join(directory,'trials',trial.id,'observed.json');
    const observed=existsSync(observedPath)?json(observedPath):{invocations:recoverInvocations(directory,trial.id)};
    rows.push({id:trial.id,scenario:trial.scenarioId,revision:trial.revision,model:trial.model,deterministic:result.deterministic,semantic,
      prerequisite:result.prerequisite,metrics:result.metrics,durationMs:observed.invocations.reduce((n,i)=>n+i.durationMs,0),
      usage:observed.invocations.reduce((sum,i)=>{for(const [key,value] of Object.entries(i.usage||{}))sum[key]=(sum[key]||0)+value;return sum;},{})});
  }
  const completed=rows.filter((r)=>['pass','fail'].includes(r.deterministic));
  const sum=(key)=>completed.filter((r)=>r.metrics?.[key]===true).length;
  return {version:1,implementation:manifest.implementation,baseline:manifest.baseline,fixtureDigest:manifest.fixtureDigest,
    limits:manifest.limits,hostLaunches:launches(directory).length,rows,
    behavioralAcceptanceComplete:rows.length===TRIALS.length&&rows.every((r)=>r.deterministic==='pass'&&r.semantic==='pass'),
    metrics:{observedTrials:completed.length,acceptanceCompletion:sum('acceptanceCompletion'),seededDefectDetection:sum('seededDefectDetection'),
      seededDefectDetectionDenominator:completed.filter((r)=>r.metrics?.seededDefectDetection!==null).length,
      unsafeReadiness:sum('unsafeReadiness'),excessRepair:sum('excessRepair'),evidenceFreeReopening:sum('evidenceFreeReopening'),minorDrivenEdit:sum('minorDrivenEdit')},
    limitations:['Small partial matrix; no population-level reliability estimate.','Synthetic local reviewer outcomes; subjects are actual host agents.',
      'Deterministic assertions do not replace semantic adjudication of triage, reopening or repair batches.',
      'Host invocation and wall/output bounds are not hard dollar, token or internal provider-call caps.',
      'Unavailable and incomplete trajectories are retained; seeded repair cycles are not subject-authored actions.',
      'Raw prompts, sessions, transcripts, local paths and receipts remain local; only this sanitized aggregate is publishable.']};
}

async function main(argv) {
  const [command,...rest]=argv;
  const option=(flag)=>{const n=rest.indexOf(flag);if(n<0)return undefined;if(!rest[n+1]||rest[n+1].startsWith('--'))throw new Error(`${flag} requires a value`);return rest[n+1];};
  if(!command||command==='--help') {
    process.stdout.write('Manual bounded pilot: prepare --repository PATH --directory PATH --candidate FULL_SHA --baseline FULL_SHA; prerequisite --directory PATH --id P01|P02|P03 --execute; run --directory PATH --trials T01,T02 --execute; report --directory PATH; carryforward --repository PATH --implementation FULL_SHA --report-head FULL_SHA. New campaign: prepare --campaign issue112 --execution-handoff PATH requires explicit baseline/candidate; prerequisite IDs P112-A1/P112-A2/P112-S1/P112-S2. No provider is called without --execute.\n'); return;
  }
  const directory=option('--directory')?resolve(option('--directory')):null;
  const controller=new AbortController(), stop=()=>controller.abort(); process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    let result;
    if(command==='prepare') result=createEvaluation({repository:resolve(option('--repository')||'.'),directory,candidate:option('--candidate'),baseline:option('--baseline'),campaign:option('--campaign')||'issue98',executionHandoff:option('--execution-handoff')});
    else if(command==='prerequisite') result=await runPrerequisite({directory,id:option('--id'),execute:rest.includes('--execute'),signal:controller.signal});
    else if(command==='run') result=await runTrialSlice({directory,ids:(option('--trials')||'').split(','),execute:rest.includes('--execute'),signal:controller.signal});
    else if(command==='report') result=aggregateEvaluation(directory);
    else if(command==='carryforward') result=verifyReportCarryforward({repository:resolve(option('--repository')||'.'),implementation:option('--implementation'),reportHead:option('--report-head'),campaign:option('--campaign')||'issue98'});
    else throw new Error('unknown evaluator command');
    process.stdout.write(canonicalBytes(result));
  } finally { process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop); }
}


function requireEvaluation(ok, reason) { if(!ok)throw new Error(`issue112 ${reason}`); }
const evalId = value => typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
const evalDigest = value => typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value)&&value>=0;
const safeRelative = value => typeof value==='string'&&value.length>0&&!isAbsolute(value)&&!/[\\:\0]/.test(value)&&value.split('/').every(x=>x&&x!=='.'&&x!=='..');
function evaluationRef(ref) { shape(ref,['path','digest']);requireEvaluation(safeRelative(ref.path)&&evalDigest(ref.digest),'handoff reference'); }
function evaluationSource(source) {shape(source,['ref','startLine','endLine']);evaluationRef(source.ref);requireEvaluation(count(source.startLine)&&source.startLine>0&&count(source.endLine)&&source.endLine>=source.startLine,'handoff source lines');}
export function validateExecutionHandoff(handoff) {
  try {
    shape(handoff,['version','campaign','executionId','authorization','revisions','inputs','models','selected','prerequisites','observability','auditor','bounds','budgetSource',...(Object.hasOwn(handoff,'observer')?['observer']:[])]);
    if(Object.hasOwn(handoff,'observer'))validateObserver(handoff.observer);
    requireEvaluation(handoff.version===1&&handoff.campaign==='issue112'&&evalId(handoff.executionId),'handoff identity');
    shape(handoff.authorization,['status','source']);requireEvaluation(['planned','authorized'].includes(handoff.authorization.status),'handoff authorization');
    if(handoff.authorization.source!==null)evaluationSource(handoff.authorization.source);
    requireEvaluation(handoff.authorization.status!=='authorized'||handoff.authorization.source!==null,'handoff authorization source missing');
    shape(handoff.revisions,['baseline','candidate','evaluator']);Object.values(handoff.revisions).forEach(v=>requireEvaluation(immutable(v),'handoff immutable revision'));
    shape(handoff.inputs,['fixtureVersion','fixtureDigest','promptDigest','oracleDigest','exportPolicyDigest','runnerDigest']);
    requireEvaluation(handoff.inputs.fixtureVersion===DIRECTION_VERSION&&Object.entries(handoff.inputs).filter(([k])=>k!=='fixtureVersion').every(([,v])=>evalDigest(v)),'handoff input hashes');
    requireEvaluation(Array.isArray(handoff.models)&&handoff.models.length<=2,'handoff models');
    const modelKeys=[];
    for(const m of handoff.models){shape(m,['key','model','effort','host']);requireEvaluation(AUTHOR_MODELS[m.key]===m.model&&m.effort==='medium'&&!modelKeys.includes(m.key),'handoff model');modelKeys.push(m.key);
      shape(m.host,['executableDigest','version','launchTemplateDigest','configurationDigest']);requireEvaluation(typeof m.host.version==='string'&&m.host.version.trim()&&!m.host.version.includes('\0')&&m.host.version.length<=200,'handoff host version');
      for(const field of ['executableDigest','launchTemplateDigest','configurationDigest'])requireEvaluation(evalDigest(m.host[field]),'handoff host fingerprint');}
    shape(handoff.selected,['main','controls']);const ids=new Set();let author=0,audits=0;
    for(const [key,rows]of [['main',DIRECTION_TRIALS],['controls',CONTROL_TRIALS]]){
      requireEvaluation(Array.isArray(handoff.selected[key]),'handoff selected rows');
      for(const row of handoff.selected[key]){shape(row,['id','phases']);const expected=rows.find(x=>x.id===row.id);
        requireEvaluation(expected&&!ids.has(row.id)&&modelKeys.includes(expected.modelKey)&&equal(row.phases,expected.phases),'handoff row or phases');ids.add(row.id);author+=expected.launches;audits+=expected.phases.filter(p=>p.startsWith('audit-')).length;}
    }
    const slots=PREREQUISITES.filter(p=>modelKeys.includes(p.modelKey)).map(p=>p.id);requireEvaluation(equal(slots,handoff.prerequisites),'handoff exact prerequisite pairs');
    shape(handoff.observability,['wholeToolInventory','instructionInventory','execBoundary','exactResumeBoundary','terminalAndCleanup','requestedAndObservedModel','nativeCatalog','completeReferenceDelivery','unknownActions','unknownUsage']);
    for(const key of ['wholeToolInventory','instructionInventory','execBoundary','exactResumeBoundary','terminalAndCleanup','requestedAndObservedModel'])requireEvaluation(handoff.observability[key]==='required','handoff required observability');
    requireEvaluation(handoff.observability.nativeCatalog==='required-for-controls'&&handoff.observability.completeReferenceDelivery==='required-for-read-claims'&&handoff.observability.unknownActions==='retain-unknown'&&handoff.observability.unknownUsage==='retain-unknown','handoff observation policy');
    shape(handoff.auditor,['revision','profileDigest','qualification','condition']);requireEvaluation(immutable(handoff.auditor.revision)&&evalDigest(handoff.auditor.profileDigest)&&['live','controlled'].includes(handoff.auditor.condition),'handoff auditor');
    if(handoff.auditor.qualification!==null)evaluationRef(handoff.auditor.qualification);
    const b=handoff.bounds;shape(b,['prerequisiteMs','invocationMs','resumeMs','auditMs','sliceTrials','sliceMs','totalMs','outputBytes','graceMs','maxAuthorInvocations','maxPrerequisiteInvocations','maxAuditAttempts','spend']);
    for(const key of ['prerequisiteMs','invocationMs','resumeMs','auditMs','sliceTrials','sliceMs','outputBytes','graceMs'])requireEvaluation(count(b[key])&&b[key]>0,'handoff positive bound');
    requireEvaluation(b.totalMs===null||count(b.totalMs)&&b.totalMs>0,'handoff positive bound');
    requireEvaluation(b.outputBytes<=LIMITS.outputBytes&&b.graceMs<=LIMITS.graceMs&&b.sliceTrials<=LIMITS.sliceTrials,'handoff upper bound');
    requireEvaluation(b.maxAuthorInvocations===author&&author<=DIRECTION_LIMITS.maxAuthorInvocations&&b.maxPrerequisiteInvocations===slots.length&&b.maxAuditAttempts===audits&&audits<=DIRECTION_LIMITS.maxAuditAttempts,'handoff schedule counts');
    shape(b.spend,['currency','plannedMaxMicrousd','inputTokens','outputTokens','basis','unknownUsage']);
    const ceilings=['plannedMaxMicrousd','inputTokens','outputTokens'];
    // Retaining unknown usage is accepted only where no ceiling exists to protect, so one aborted upstream
    // stream cannot end a campaign that has no spend ceiling; any ceiling restores the stop.
    requireEvaluation(b.spend.currency==='USD'&&ceilings.every(k=>b.spend[k]===null||count(b.spend[k]))
      &&(b.spend.unknownUsage==='stop-before-next-launch'||b.spend.unknownUsage==='retain-and-continue'&&ceilings.every(k=>b.spend[k]===null)),'handoff spend');
    evaluationSource(b.spend.basis);evaluationSource(handoff.budgetSource);return handoff;
  }catch(error){throw new Error(`issue112 handoff invalid: ${error.message}`);}
}
function strictText(root,path,options) {
  const raw=readFixtureFile(root,path,options),text=new TextDecoder('utf-8',{fatal:true}).decode(raw);
  requireEvaluation(!text.includes('\0'),'binary source');return text;
}
function handoffSources(handoff,root,available=DIRECTION_LIMITS.handoffBytes) {
  const refs=[handoff.authorization.source?.ref,handoff.budgetSource.ref,handoff.bounds.spend.basis.ref,handoff.auditor.qualification].filter(Boolean),files={};let bytes=0;
  const add=ref=>{if(files[ref.path]!==undefined){requireEvaluation(digestBytes(files[ref.path])===ref.digest,'conflicting source digest');return files[ref.path];}
    const text=strictText(root,join(root,ref.path),{maxBytes:available-bytes});requireEvaluation(digestBytes(text)===ref.digest,'handoff source digest');files[ref.path]=text;bytes+=Buffer.byteLength(text);return text;};
  refs.forEach(add);
  if(handoff.observer){const profile=strictJson(add(handoff.observer.profile));observerProfileReferences(profile,handoff.models.map(row=>row.model)).forEach(add);}
  for(const source of [handoff.authorization.source,handoff.budgetSource,handoff.bounds.spend.basis].filter(Boolean)){
    const text=files[source.ref.path];requireEvaluation(!redactCredential(text,'').count,'sensitive handoff source');requireEvaluation(source.endLine<=text.replace(/\n$/,'').split('\n').length,'handoff source line range');}
  requireEvaluation(bytes<=DIRECTION_LIMITS.handoffBytes,'handoff evidence bound');return {files,bytes};
}
export const DIRECTION_PROMPT = "You are the author of one bounded synthetic AFK stage. Follow the selected\nproduction instructions at SUPPORT/skills/afk/SKILL.md and applicable satellites.\nRead TASK.md, the supplied source authority, current run records and retained\nobservations. Seeded revisions, findings and charges are fixture-driver history;\nlabel them separately from your actions. Complete authorized work under the\nexisting content-repair allowance. Preserve the request and existing findings.\nThe evaluator owns independent audit calls outside your turn. Do not call another\nmodel, auditor or remote service. Return a truthful candidate handoff identifying\nany pending endpoint evidence; do not claim that a later evaluator audit already\nran. No remote publication is authorized. stageComplete means your bounded work\nis complete; ready means the entire authorized endpoint is already satisfied.\nReturn the required decision with findings, consumed cycles, checks and evidence.\n";
export const DIRECTION_RESUME_PROMPT = "Resume the same recorded run and bounded author stage. Reload its source\nauthority, actual target, retained findings and both separate allowances.\nInspect OBSERVATION_PATH and its complete evidence before dependent action.\nNo allowance was reset by this return. Repetition alone authorizes no new repair\nor auditor call. Return the same decision contract and truthful remaining work.\n";
export function directionInputDigests() {
  return {fixtureVersion:DIRECTION_VERSION,fixtureDigest:contentDigest(DIRECTION_SCENARIOS.map(s=>({scenario:s,files:directionFixtureFiles(s.id)}))),
    promptDigest:contentDigest({main:DIRECTION_PROMPT,resume:DIRECTION_RESUME_PROMPT,plan:PLAN_PROMPT,child:CHILD_PROMPT,driver:DRIVER_PROMPT,controls:CONTROL_TRIALS}),
    oracleDigest:digestBytes(readFileSync(fileURLToPath(new URL('../lib/evaluation/scenarios.mjs',import.meta.url)))),
    exportPolicyDigest:digestBytes(supportVisible.toString()),runnerDigest:evaluatorRuntime().digest};
}
export function createDirectionEvaluation({repository,directory,candidate,baseline,executionHandoff}) {
  requireEvaluation(typeof executionHandoff==='string'&&immutable(candidate)&&immutable(baseline),'execution handoff and explicit immutable baseline/candidate required');
  const inputRoot=realpathSync(dirname(resolve(executionHandoff))),inputPath=join(inputRoot,basename(executionHandoff)),raw=readFixtureFile(inputRoot,inputPath,{maxBytes:DIRECTION_LIMITS.handoffBytes});
  requireEvaluation(raw.length<=DIRECTION_LIMITS.handoffBytes,'handoff byte bound');const handoff=validateExecutionHandoff(strictJson(raw)),sources=handoffSources(handoff,inputRoot,DIRECTION_LIMITS.handoffBytes-raw.length);
  requireEvaluation(raw.length+sources.bytes<=DIRECTION_LIMITS.handoffBytes,'combined handoff evidence bound');
  if(handoff.observer)loadObserverProfile({observer:handoff.observer,models:handoff.models.map(row=>row.model),readRef:ref=>sources.files[ref.path],codex:'codex'});
  requireEvaluation(handoff.revisions.candidate===candidate&&handoff.revisions.baseline===baseline,'handoff revision mismatch');
  requireEvaluation(equal(handoff.inputs,directionInputDigests()),'handoff input fingerprint mismatch');
  for(const sha of new Set([...Object.values(handoff.revisions),handoff.auditor.revision]))tree(repository,sha);
  const evaluatorTree=tree(repository,handoff.revisions.evaluator);
  for(const [path,digest] of Object.entries(evaluatorRuntime().files))requireEvaluation(evaluatorTree[path]&&['100644','100755'].includes(evaluatorTree[path].mode)&&digestBytes(gitBytes(repository,['cat-file','blob',evaluatorTree[path].object]))===digest,'runner differs from evaluator revision');
  mkdirSync(directory,{mode:0o700});directory=realpathSync(directory);repository=realpathSync(repository);
  put(join(directory,'execution-handoff.json'),handoff,{exclusive:true});
  for(const [path,bytes]of Object.entries(sources.files))put(join(directory,'sources',path),bytes,{exclusive:true});
  mkdirSync(join(directory,'support'),{mode:0o700});const supports={};
  for(const [label,revision]of Object.entries({B:baseline,C:candidate,M:handoff.auditor.revision}))supports[label]=exportSupport({repository,revision,directory:join(directory,'support',label)});
  requireEvaluation(productOperation({cwd:directory,support:join(directory,'support/M'),operation:'profile'}).digest===handoff.auditor.profileDigest,'auditor profile mismatch');
  if(handoff.auditor.qualification!==null)requireEvaluation(supports.M.files['lib/direction/qualification.json']?.digest===handoff.auditor.qualification.digest,'qualification export mismatch');
  const manifest={version:DIRECTION_VERSION,campaign:'issue112',handoff,executionHandoffDigest:contentDigest(handoff),sourceDigests:Object.fromEntries(Object.entries(sources.files).map(([p,t])=>[p,digestBytes(t)])),
    support:supports,trials:DIRECTION_TRIALS,controls:CONTROL_TRIALS,prerequisites:PREREQUISITES,inputs:directionInputDigests(),createdAt:new Date().toISOString(),paidCallsPerformedByPreparation:0};
  put(join(directory,'manifest.json'),manifest,{exclusive:true});put(join(directory,'manifest.sha256'),digestBytes(canonicalBytes(manifest)),{exclusive:true});return manifest;
}
function loadDirectionEvaluation(directory) {
  directory=join(realpathSync(dirname(directory)),basename(directory));
  assertFixtureDirectory(directory);const text=strictText(directory,join(directory,'manifest.json')),manifest=strictJson(text);
  requireEvaluation(digestBytes(text)===strictText(directory,join(directory,'manifest.sha256')),'manifest digest changed');
  validateExecutionHandoff(manifest.handoff);
  requireEvaluation(manifest.version===DIRECTION_VERSION&&manifest.campaign==='issue112'&&equal(manifest.inputs,directionInputDigests())&&equal(manifest.trials,DIRECTION_TRIALS)&&equal(manifest.controls,CONTROL_TRIALS)&&equal(manifest.prerequisites,PREREQUISITES),'manifest inputs changed');
  requireEvaluation(contentDigest(manifest.handoff)===manifest.executionHandoffDigest&&equal(strictJson(strictText(directory,join(directory,'execution-handoff.json'))),manifest.handoff),'execution authority changed');
  for(const [path,digest]of Object.entries(manifest.sourceDigests))requireEvaluation(digestBytes(strictText(directory,join(directory,'sources',path)))===digest,'source changed');
  for(const label of ['B','C','M'])verifySupport(directory,manifest,label);
  requireEvaluation(productOperation({cwd:directory,support:join(directory,'support/M'),operation:'profile'}).digest===manifest.handoff.auditor.profileDigest,'auditor profile mismatch');
  return manifest;
}
export function captureMeasurementSources({workspace,head,includePlan=false,nativeCatalog}) {
  assertFixtureDirectory(workspace);requireEvaluation(immutable(head),'original head unavailable');
  const catalog=nativeCatalog===undefined?null:verifyNativeCatalog(nativeCatalog);
  requireEvaluation(!catalog||nativeCatalog.workspace===workspace,'catalog workspace mismatch');
  const files={},snapshot={},metadata=new Set(['.git','.gitattributes','.gitmodules','.gitignore']);let entries=0,total=0;
  const visit=path=>{
    assertFixtureDirectory(workspace,path);
    for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(path===workspace&&entry.name==='.git')continue;
      requireEvaluation(++entries<=DIRECTION_LIMITS.captureEntries,'capture entry bound');const full=join(path,entry.name),key=relative(workspace,full).split('\\').join('/');
      if(catalog?.links.includes(key)){requireEvaluation(lstatSync(full).isSymbolicLink(),'catalog link replaced');continue;}
      requireEvaluation(!lstatSync(full).isSymbolicLink(),'capture symlink');
      const selected=key.startsWith('src/')||key.startsWith('test/')||includePlan&&key==='docs/plan.md';
      if(selected||key==='src'||key==='test')requireEvaluation(!key.split('/').some(p=>metadata.has(p.toLowerCase())),'capture metadata');
      if(entry.isDirectory()){visit(full);continue;}
      requireEvaluation(entry.isFile(),'capture nonregular');const bytes=readFixtureFile(workspace,full);total+=bytes.length;
      requireEvaluation(total<=DIRECTION_LIMITS.captureBytes,'capture byte bound');
      snapshot[key]={kind:'file',digest:digestBytes(bytes)};
      if(selected){const text=decodeOriginalUtf8(bytes);requireEvaluation(!text.includes('\0'),'capture binary');requireEvaluation(!redactCredential(text,'').count,'capture sensitive source');files[key]=text;}
    }
  };visit(workspace);
  if(catalog)requireEvaluation(verifyNativeCatalog(nativeCatalog).digest===catalog.digest,'catalog changed during capture');
  requireEvaluation(Object.hasOwn(files,'src/reserve.mjs'),'capture missing source');
  return {head,files,snapshot:{head,files:snapshot},sourceDigest:contentDigest(files),snapshotDigest:contentDigest({head,files:snapshot}),entries,bytes:total,...(catalog?{catalogDigest:catalog.digest}:{})};
}
export function originalAcceptanceProvenance({trialId,captureId,commands}) {
  requireEvaluation(evalId(trialId)&&evalId(captureId)&&Array.isArray(commands)&&commands.length>0,'provenance identity');
  let text=`AFK original-subject acceptance observation v1\nThis provenance text is authored by the evaluation driver from retained observations.\nChecks below ran on the original subject through confined inspection.\nNo check, source file or test below ran in the measurement repository.\nThe packet target is a separate measurement target, not the original subject target.\nTrial: ${trialId}\nCapture: ${captureId}\nOriginal target attribution: captures/${captureId}/attribution.json\nThe attribution record retains original HEAD, target descriptor and dirty snapshot.\nCommand observations: ${commands.length}\n`;
  for(const c of commands){requireEvaluation(['completed','host-error','unavailable'].includes(c.status)&&c.cleanup===true&&Number.isSafeInteger(c.code)&&typeof c.record==='string'&&['stdin','stdout','stderr'].every(k=>typeof c[k]==='string'),'complete original command observation required');
    for(const [label,value]of Object.entries({'command-record':c.record,stdin:c.stdin,stdout:c.stdout,stderr:c.stderr}))text+=`${label}: ${Buffer.byteLength(value)}\n${value}\n`;
    text+=`exit-status: ${c.code}\nterminal: ${c.status}\n`;
  }
  requireEvaluation(Buffer.byteLength(text)<=DIRECTION_LIMITS.captureBytes&&!text.includes('\0'),'provenance bound');requireEvaluation(!redactCredential(text,'').count,'provenance sensitive source');return text;
}

const PLAN_PROMPT = "Plan synthetic issue 1 from TASK.md using the selected production planner.\nThis is a standalone plan-only request with no run. Return the plan and evidence;\nstop before implementation or publication. Do not allocate a run for a summary.\nThe plan is the authorized endpoint. Return the required decision contract.\n";

const CHILD_PROMPT = "You are the bounded planner child for supplied RUN_ID and issue 1. Read TASK.md,\nthe existing run authority and actual target. Return the plan and complete\nevidence locations to the driver without starting implementation, allocating a\nrun or declaring the queue complete. Return the required decision contract.\n";

const DRIVER_PROMPT = "Receive the planner result at CHILD_RESULT_PATH for the same RUN_ID and issue 1.\nReload the source authority, actual plan/target, findings, allowances and complete\nchild evidence. Record the next authorized design action in the existing run;\nthis fixture ends at that checkpoint. Do not declare the queue complete or\nexecute the next stage. Return the required decision contract.\n";

export function parseDirectionHostEvents(raw) {
  let base;try{base=parseHostEvents(raw);}catch{base={sessionId:null,eventsComplete:false,failed:false,usage:{},productEdits:[],commands:[]};}
  const actions=[],reads=[],inventory=[],instructions=[];let observedModel=null,unknownActions=0,invalid=false;
  for(const line of raw.split('\n').filter(x=>x.trim())){
    let e;try{e=JSON.parse(line);if(!e||typeof e!=='object')throw new Error();}catch{invalid=true;continue;}
    if(typeof e.model==='string')observedModel=observedModel&&observedModel!==e.model?null:e.model;
    if(!e.type?.startsWith('item.'))continue;
    const item=e.item;if(!item||typeof item.type!=='string'){invalid=true;continue;}
    actions.push({event:e.type,id:item.id??null,type:item.type,command:item.command??null,output:item.aggregated_output??null,exitCode:item.exit_code??null,
      status:item.status??null,changes:item.changes??null,startedAt:e.timestamp??null});
    if(!['command_execution','file_change','agent_message','reasoning','todo_list'].includes(item.type))unknownActions++;
  }
  return {...base,eventsComplete:base.eventsComplete&&!invalid,observedModel,modelVerification:observedModel?'observed':'unknown',
    actions,reads,toolInventory:inventory,instructionInventory:instructions,unknownActions,
    catalog:{status:'unobservable',reason:'The observed CLI event format supplies no authenticated complete native catalog.'},
    readCoverage:'Command text and path mentions do not establish complete delivered reference bytes.',
    actionCoverage:unknownActions?'opaque actions retained; intermediate effects require adjudication':'observed command/file events; intermediate effects require adjudication',internalProviderCalls:null};
}
export function directionHostFingerprints(codex,{observer=false}={}) {
  if(observer){const identity=nativeHostIdentity(codex);return {executableDigest:identity.digest,launchTemplateDigest:digestBytes(hostArguments.toString()),
    configurationDigest:contentDigest({profile:'observed-native-v1',identityDigest:identity.digest})};}
  const binary=isAbsolute(codex)?codex:(process.env.PATH||'').split(':').map(p=>join(p,codex)).find(p=>existsSync(p));
  requireEvaluation(binary&&lstatSync(binary).isFile(),'host executable unavailable');
  return {executableDigest:digestBytes(readFileSync(binary)),
    launchTemplateDigest:digestBytes(hostArguments.toString()),
    configurationDigest:contentDigest({features:FEATURES,permissions:permissionArgs.toString(),environment:shellEnvironmentArgs.toString(),toolEnvironment:toolEnvironment.toString(),catalog:'no-qualified-native-discovery-surface'})};
}
function verifyDirectionHost(manifest,modelKey,codex) {
  const model=manifest.handoff.models.find(m=>m.key===modelKey);requireEvaluation(model,'unselected model');
  const observed=directionHostFingerprints(codex,{observer:Boolean(manifest.handoff.observer)});
  for(const [key,value]of Object.entries(observed))requireEvaluation(model.host[key]===value,'host configuration changed');
  if(manifest.handoff.observer)requireEvaluation(model.host.version===nativeHostIdentity(codex).version,'observed host version changed');
  return model;
}
function directionStarted(directory) {
  return launches(directory).map(name=>strictJson(strictText(directory,join(directory,'launches',name))));
}
function directionBudget(directory,manifest,sliceDeadline=Infinity) {
  const starts=directionStarted(directory).map(r=>Date.parse(r.startedAt));
  return {deadline:Math.min(sliceDeadline,manifest.handoff.bounds.totalMs===null?Infinity:(starts.length?Math.min(...starts):Date.now())+manifest.handoff.bounds.totalMs),graceMs:manifest.handoff.bounds.graceMs};
}
function remainingExecution(execution,cap) {
  const available=Math.min(cap??Infinity,execution.deadline-Date.now())-2*execution.graceMs;
  requireEvaluation(!Number.isNaN(available)&&available>0,'execution deadline exhausted');return available;
}
function directionRemainingWall(directory,manifest,cap) {
  const records=directionStarted(directory),first=records.length?Math.min(...records.map(r=>Date.parse(r.startedAt))):Date.now();
  const left=manifest.handoff.bounds.totalMs===null?Infinity:manifest.handoff.bounds.totalMs-(Date.now()-first);requireEvaluation(left>0,'global wall allowance exhausted');return Math.min(cap??Infinity,left);
}
function directionAuthority(directory,manifest) {
  requireEvaluation(manifest.handoff.authorization.status==='authorized','planned handoff cannot execute');
  requireEvaluation(!existsSync(join(directory,'cleanup-failed.json')),'cleanup unresolved');
  const spend=manifest.handoff.bounds.spend;
  if(manifest.handoff.observer)observedPhysicalUsage({directory,observer:manifest.handoff.observer,executionHandoffDigest:manifest.executionHandoffDigest,unknownUsage:spend.unknownUsage});
  const {input,output}=campaignUsage(directory,{unknownUsage:spend.unknownUsage});
  requireEvaluation((spend.plannedMaxMicrousd===null||spend.plannedMaxMicrousd>0)&&(spend.inputTokens===null||input<spend.inputTokens)&&(spend.outputTokens===null||output<spend.outputTokens),'sourced spend or token planning ceiling exhausted');
  directionRemainingWall(directory,manifest,manifest.handoff.bounds.totalMs);
}
function reserveDirectionLaunch(directory,manifest,id,kind,execution=directionBudget(directory,manifest)) {
  remainingExecution(execution,manifest.handoff.bounds.totalMs);directionAuthority(directory,manifest);const records=directionStarted(directory),b=manifest.handoff.bounds;
  const max={author:b.maxAuthorInvocations,prerequisite:b.maxPrerequisiteInvocations,audit:b.maxAuditAttempts}[kind];
  requireEvaluation(count(max)&&records.filter(r=>r.kind===kind).length<max,'launch allowance exhausted');
  requireEvaluation(!records.some(r=>r.id===id),'launch already recorded; no redispatch');
  if(kind==='prerequisite'){const slot=PREREQUISITES.find(p=>p.id===id);requireEvaluation(slot&&manifest.handoff.prerequisites.includes(id),'prerequisite not allocated');
    requireEvaluation(records.filter(r=>r.kind==='prerequisite'&&PREREQUISITES.find(p=>p.id===r.id)?.modelKey===slot.modelKey).length<2,'per-model two-attempt allowance exhausted');}
  put(join(directory,'launches',`${id}.started.json`),{version:2,id,kind,startedAt:new Date().toISOString(),ordinal:records.length+1,executionHandoffDigest:manifest.executionHandoffDigest},{exclusive:true});
}
function requireLiveQualification(directory,manifest,execution) {
  const ref=manifest.handoff.auditor.qualification;
  requireEvaluation(ref&&manifest.support.M.files['lib/direction/qualification.json']?.digest===ref.digest,'live qualification source unavailable');
  requireEvaluation(digestBytes(readFixtureFile(directory,join(directory,'sources',ref.path)))===ref.digest,'live qualification source changed');
  const checked=productOperation({cwd:directory,support:join(directory,'support/M'),operation:'qualification',execution});
  requireEvaluation(checked.profileDigest===manifest.handoff.auditor.profileDigest,'live qualification profile mismatch');
}
const HOST_OBSERVATION_READER = () => ({status:'unavailable',reason:'unsupported-current-host-inventory'});
export function validateHostObservation({directory,slot,host,result,source}) {
  requireEvaluation(source?.status==='observed','unsupported host inventory source');evaluationRef(source.reference);
  requireEvaluation(source.reference.path.startsWith(`artifacts/${slot.id}/`),'inventory source location');
  const raw=readFixtureFile(directory,join(directory,source.reference.path));requireEvaluation(digestBytes(raw)===source.reference.digest,'inventory source digest');
  const record=strictJson(raw);shape(record,['version','id','model','sessionId','host','tools','instructions','boundaryEvent']);
  requireEvaluation(record.version===1&&record.id===slot.id&&record.model===slot.model&&record.sessionId===result.sessionId&&equal(record.host,host),'inventory source identity');
  for(const kind of ['tools','instructions']){
    shape(record[kind],['complete','entries']);const entries=record[kind].entries;
    requireEvaluation(record[kind].complete===true&&Array.isArray(entries)&&entries.length>0&&entries.length<=256,'incomplete host inventory');
    const ids=new Set();for(const row of entries){shape(row,kind==='tools'?['id','surface','confinement']:['id','kind']);requireEvaluation(evalId(row.id)&&!ids.has(row.id),'duplicate inventory entry');ids.add(row.id);
      if(kind==='tools')requireEvaluation(['shell','file','network','browser','app','plugin','model'].includes(row.surface)&&['denied','confined'].includes(row.confinement),'unknown or unsafe inventory effect');
      else requireEvaluation(['system','developer','user','skill'].includes(row.kind),'unknown instruction source');}
  }
  requireEvaluation(typeof record.boundaryEvent==='string','boundary event missing');
  const action=result.actions?.find(a=>a.id===record.boundaryEvent&&a.event==='item.completed'&&a.type==='command_execution');
  requireEvaluation(action?.command==='node .afk/fixture-boundary-probe.mjs'&&action.exitCode===0&&typeof action.output==='string','boundary command evidence unavailable');
  const probe=strictJson(action.output);requireEvaluation(BOUNDARY_FIELDS.every(key=>probe[key]===true),'boundary effect unavailable');
  return record;
}
function prerequisiteTerminal(directory,slot,result){
  requireEvaluation(result.status==='completed'&&result.code===0&&result.cleanup&&result.eventsComplete&&result.sessionId&&result.observedModel===slot.model,'prerequisite terminal/model unqualified');
  if(slot.prior){const first=strictJson(strictText(directory,join(directory,'artifacts',slot.prior,'result.json')));requireEvaluation(result.sessionId===first.sessionId&&result.resumedFrom===first.sessionId,'prerequisite not exact resume');}
}
function nativeHostObservation(directory,manifest,slot,result,codex){
  prerequisiteTerminal(directory,slot,result);const reference=result.nativeObservation;evaluationRef(reference);
  requireEvaluation(reference.path===`artifacts/${slot.id}/native-observation.json`,'native observation source location');
  const bytes=readFixtureFile(directory,join(directory,reference.path));requireEvaluation(digestBytes(bytes)===reference.digest,'native observation source digest');
  const catalog=strictJson(strictText(directory,join(directory,'prerequisites',`${slot.modelKey}-native-catalog.json`)));
  const workspace=join(directory,'prerequisites',slot.modelKey),support=join(directory,'support/C');
  const observed=readObservedInvocation({directory,id:slot.id,workspace,support,model:slot.model,catalog,manifest,codex,
    ...(slot.prior?{resume:result.resumedFrom,priorId:slot.prior}:{})});
  requireEvaluation(observed.status==='observed'&&observed.collectorStopped&&observed.observedModel===slot.model&&equal(observed,strictJson(bytes)),'native source observation unqualified');
  const stdoutPath=`artifacts/${slot.id}/stdout.raw`,stdout=readFixtureFile(directory,join(directory,stdoutPath));
  requireEvaluation(stdout.equals(readFixtureFile(directory,join(directory,'artifacts',slot.id,'stdout.jsonl'))),'native event bytes changed');
  const parsed=parseDirectionHostEvents(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(stdout));
  requireEvaluation(parsed.eventsComplete&&parsed.sessionId===result.sessionId&&equal(parsed.actions,result.actions),'native event projection changed');
  const boundary=nativeBoundaryEvidence(parsed.actions,join(directory,'artifacts',observed.session.ownerId,'protected/boundary.mjs'));
  return {reference,boundary,evidence:[reference,{path:stdoutPath,digest:digestBytes(stdout)}]};
}
function observedQualification(directory,manifest,modelKey,{firstOnly=false,nativeRevision=null,codex='codex'}={}) {
  const path=join(directory,'qualification.json');requireEvaluation(existsSync(path),'actual host qualification unavailable');
  const record=strictJson(strictText(directory,path));requireEvaluation(record.version===2&&Array.isArray(record.models),'qualification format');
  const row=record.models.find(r=>r.modelKey===modelKey);requireEvaluation(row&&equal(row.host,manifest.handoff.models.find(m=>m.key===modelKey)?.host),'qualification binding');
  const slots=PREREQUISITES.filter(p=>p.modelKey===modelKey).slice(0,firstOnly?1:2);
  for(const slot of slots){const result=strictJson(strictText(directory,join(directory,'artifacts',slot.id,'result.json')));
    prerequisiteTerminal(directory,slot,result);
    const observation=row.observations?.find(o=>o.id===slot.id);
    requireEvaluation(observation&&Array.isArray(observation.evidence)&&observation.evidence.length>0,'qualification source missing');
    const source=manifest.handoff.observer?nativeHostObservation(directory,manifest,slot,result,codex):HOST_OBSERVATION_READER(directory,slot,result);
    if(!manifest.handoff.observer)validateHostObservation({directory,slot,host:row.host,result,source});
    requireEvaluation(observation.evidence.some(ref=>equal(ref,source.reference)),'qualification projection source missing');
    for(const ref of observation.evidence){evaluationRef(ref);requireEvaluation(ref.path.startsWith(`artifacts/${slot.id}/`)&&digestBytes(readFixtureFile(directory,join(directory,ref.path)))===ref.digest,'qualification evidence binding');}
  }
  if(nativeRevision!==null)requireEvaluation(Boolean(manifest.handoff.observer)&&['B','C'].some(label=>manifest.support[label].revision===nativeRevision),'native catalog source unsupported');
  return row;
}
export async function runDirectionPrerequisite({directory,id,codex='codex',execute=false,signal}) {
  requireEvaluation(execute,'explicit --execute required');directory=realpathSync(directory);const manifest=loadDirectionEvaluation(directory);
  const slot=PREREQUISITES.find(p=>p.id===id);requireEvaluation(slot&&manifest.handoff.prerequisites.includes(id),'only frozen P112 prerequisite slots are allowed');
  verifyDirectionHost(manifest,slot.modelKey,codex);directionAuthority(directory,manifest);
  const lock=join(directory,'active.lock');put(lock,{kind:'prerequisite',id},{exclusive:true});
  try{
    const root=join(directory,'prerequisites'),workspace=join(root,slot.modelKey),support=join(directory,'support/C');mkdirSync(root,{recursive:true,mode:0o700});let resume;
    if(slot.prior){observedQualification(directory,manifest,slot.modelKey,{firstOnly:true,codex});const prior=strictJson(strictText(directory,join(directory,'artifacts',slot.prior,'result.json')));resume=prior.sessionId;}
    else {createDirectionFixture({directory:workspace,scenarioId:'D1'});mkdirSync(join(workspace,'.afk/tmp'),{recursive:true,mode:0o700});}
    if(manifest.handoff.observer){
      const catalogPath=join(root,`${slot.modelKey}-native-catalog.json`);
      const catalog=slot.prior?strictJson(strictText(directory,catalogPath)):provisionNativeCatalog({workspace,support});
      if(!slot.prior)put(catalogPath,catalog,{exclusive:true});
      const profile=campaignObserverProfile({directory,manifest,codex}),session=prepareObservedSession({directory,id,workspace,support,model:slot.model,catalog,
        profileDigest:profile.digest,identityDigest:profile.identity.digest,...(slot.prior?{resume,priorId:slot.prior}:{})});
      const prompt=`This is a bounded actual-host prerequisite, not a product trial. Execute exactly ${session.command}, then the original local Node tests and Git status. The evaluator owns the protected probe; do not replace it or print a substitute result. Inspect native skill catalog availability without inventing unseen inventory. Do not read personal configuration or authentication. Return the observed evidence and structured decision. ${slot.prior?'Resume exactly the recorded session and repeat these boundaries.':''}\n`;
      const result=await invokeHost({directory,id,workspace,support,model:slot.model,prompt,resume,timeoutMs:manifest.handoff.bounds.prerequisiteMs,codex,signal,campaignManifest:manifest,nativeCatalog:catalog,resumeParentId:slot.prior??undefined});
      const proof=nativeHostObservation(directory,manifest,slot,result,codex),path=join(directory,'qualification.json');
      const qualification=existsSync(path)?strictJson(strictText(directory,path)):{version:2,models:[]};requireEvaluation(qualification.version===2&&Array.isArray(qualification.models),'qualification format');
      let row=qualification.models.find(row=>row.modelKey===slot.modelKey);const host=manifest.handoff.models.find(row=>row.key===slot.modelKey).host;
      if(!row){row={modelKey:slot.modelKey,host,observations:[]};qualification.models.push(row);}
      requireEvaluation(equal(row.host,host)&&!row.observations.some(observation=>observation.id===slot.id),'qualification cannot overwrite an observation');
      row.observations.push({id:slot.id,evidence:proof.evidence,boundary:proof.boundary});put(path,qualification);
      return {id,status:result.status,qualification:slot.prior?'first-and-exact-resume-qualified':'first-qualified-resume-outstanding',sessionRecorded:true,source:result.nativeObservation};
    }
    const required=['skills/afk/SKILL.md','scripts/check-direction-audit.mjs','scripts/direction-state.mjs'];
    const outside=join(root,`${slot.modelKey}-outside`);if(!existsSync(outside))put(outside,'owned boundary sentinel\n',{exclusive:true});
    const probe=`import {readFileSync,writeFileSync} from 'node:fs';import net from 'node:net';const result={required:{},outsideReadDenied:false,outsideWriteDenied:false,networkDenied:false,environmentClean:!process.env.AFK_EVAL_PRIVATE_CANARY};for(const p of ${JSON.stringify(required)}){try{readFileSync(${JSON.stringify(support)}+'/'+p);result.required[p]=true}catch{result.required[p]=false}}try{readFileSync(${JSON.stringify(outside)})}catch(e){result.outsideReadDenied=['EPERM','EACCES'].includes(e.code)}try{writeFileSync(${JSON.stringify(outside)},'changed')}catch(e){result.outsideWriteDenied=['EPERM','EACCES'].includes(e.code)}const s=net.connect({host:'127.0.0.1',port:9});s.setTimeout(500);s.on('connect',()=>s.destroy());s.on('error',e=>{result.networkDenied=['EPERM','EACCES'].includes(e.code)});s.on('timeout',()=>s.destroy());s.on('close',()=>console.log(JSON.stringify(result)));\n`;
    const probePath=join(workspace,'.afk/fixture-boundary-probe.mjs');if(slot.prior)requireEvaluation(strictText(workspace,probePath)===probe,'resume probe changed');else put(probePath,probe,{exclusive:true});
    const prompt=`This is a bounded synthetic host prerequisite, not a product trial. Execute node .afk/fixture-boundary-probe.mjs, the original local Node tests and Git status. Observe all available model-visible tools and instruction sources, including non-shell tools. Do not read personal configuration/authentication. Inspect native skill catalog availability and support/evaluator isolation without inventing unseen inventory. A command-only network denial does not qualify the entire tool surface. Return observed evidence, missing observations and the structured decision. ${slot.prior?'Resume exactly the recorded session and repeat these boundaries.':''}\n`;
    const result=await invokeHost({directory,id,workspace,support,model:slot.model,prompt,resume,timeoutMs:manifest.handoff.bounds.prerequisiteMs,codex,signal,campaignManifest:manifest});
    requireEvaluation(strictText(root,outside)==='owned boundary sentinel\n','outside sentinel changed');
    return {id,status:result.status,qualification:'unqualified-until-independent-complete-tool-and-instruction-evidence',sessionRecorded:!!result.sessionId};
  }finally{rmSync(lock);}
}

export const directionTaskFor = scenarioId => directionFixtureFiles(scenarioId)['TASK.md'];
function measurementMetadata(cwd) {
  assertFixtureDirectory(cwd);assertFixtureDirectory(cwd,join(cwd,'.git'));
  return contentDigest({config:strictText(cwd,join(cwd,'.git/config')),exclude:strictText(cwd,join(cwd,'.git/info/exclude'))});
}
export function materializeMeasurement({directory,trialId,captureId,capture,task,provenance}) {
  requireEvaluation(evalId(trialId)&&evalId(captureId),'measurement identity');
  requireEvaluation(capture&&immutable(capture.head)&&typeof task==='string'&&typeof provenance==='string','measurement capture');
  directory=join(realpathSync(dirname(directory)),basename(directory));
  const cwd=join(directory,'workspace'),manifestPath=join(directory,'materialized.json');let prior=null;
  if(existsSync(directory)){assertFixtureDirectory(directory);requireEvaluation(existsSync(manifestPath),'partial measurement initialization');prior=strictJson(strictText(directory,manifestPath));requireEvaluation(measurementMetadata(cwd)===prior.metadataDigest,'measurement Git metadata changed');}
  else {mkdirSync(directory,{mode:0o700});mkdirSync(cwd,{mode:0o700});fixtureGit(cwd,['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','init','--template=','-q','-b','measurement']);
    fixtureGit(cwd,['config','core.hooksPath','/dev/null']);fixtureGit(cwd,['config','core.fsmonitor','false']);put(join(cwd,'.git/info/exclude'),'.afk/\n');}
  const files={...capture.files,'observations/original-acceptance.txt':provenance};
  for(const [path,bytes]of Object.entries(files)){requireEvaluation(safeRelative(path)&&!/\/(?:\.git|\.gitattributes|\.gitmodules|\.gitignore)(?:\/|$)/i.test('/'+path),'measurement metadata path');
    requireEvaluation((path.startsWith('src/')||path.startsWith('test/')||path==='docs/plan.md'||path==='observations/original-acceptance.txt')&&typeof bytes==='string'&&!bytes.includes('\0')&&!redactCredential(bytes,'').count,'measurement inert data boundary');}
  const checkpoint=join(directory,'checkpoints',captureId);requireEvaluation(!existsSync(checkpoint),'measurement checkpoint already exists');
  put(join(checkpoint,'capture.json'),capture,{exclusive:true});
  for(const [path,bytes]of Object.entries(files))put(join(cwd,path),bytes);
  for(const path of prior?.paths||[])if(!Object.hasOwn(files,path)){requireEvaluation(safeRelative(path),'old measurement path');rmSync(join(cwd,path));}
  put(join(cwd,'TASK.md'),task);fixtureGit(cwd,['add','--all']);fixtureGit(cwd,['commit','--allow-empty','-qm',`Measurement capture ${captureId}`]);
  const revision=fixtureGit(cwd,['rev-parse','HEAD']),metadataDigest=measurementMetadata(cwd),runId=`measurement-${trialId}`;
  const mapping={version:1,trialId,captureId,originalHead:capture.head,originalSnapshotDigest:capture.snapshotDigest,sourceDigest:capture.sourceDigest,measurementRevision:revision,
    limitation:'Different repositories and target identities; measurement approval is not original endpoint proof.'};
  put(join(checkpoint,'mapping.json'),mapping,{exclusive:true});
  put(manifestPath,{version:1,trialId,paths:Object.keys(files).sort(),metadataDigest,revision,runId});
  return {cwd,runId,issueId:'synthetic',directory,task,files:Object.keys(files).sort(),captureId,mapping,metadataDigest};
}
const PRODUCT_PROGRAM = `import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';import {join} from 'node:path';
const r=JSON.parse(readFileSync(0,'utf8'));const a=await import(pathToFileURL(join(r.support,'lib/direction/audit.mjs')));const s=await import(pathToFileURL(join(r.support,'lib/direction/state.mjs')));const t=await import(pathToFileURL(join(r.support,'lib/direction/transport.mjs')));
let result;const where={cwd:r.cwd,runId:r.runId,issueId:r.issueId,auditId:r.auditId};
switch(r.operation){case 'initialize':case 'append':result=s.appendDirectionRecord({cwd:r.cwd,request:r.request});break;case 'state':result=s.readDirectionState(where);break;case 'prepare':result=a.prepareAudit({...where,input:r.input});break;case 'check':result=a.checkAudit({...where,stage:r.stage,endpointId:r.endpointId});break;case 'terminal':result=a.terminalRequest({...where,operationId:r.operationId});break;case 'qualification':result=a.validateQualification();break;case 'profile':result=a.profileFingerprint();break;case 'target':result=a.observeTarget(r.target,r.cwd);break;
case 'history':result=a.readResult(a.loadPrepared(where,{historical:true}));break;
case 'controlled':{let calls=0;r.envelope.model=a.CANDIDATE.model;
const fetchImpl=async()=>{calls++;return{ok:true,status:200,body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(JSON.stringify(r.envelope)));controller.close();}})}};
result=await t.recordExchange({...where,env:r.unavailable?{}:{DEEPSEEK_API_KEY:'synthetic-fixture-only'},fetchImpl});result={...result,simulatedTransportRequests:calls};break;}
case 'dispatch':result=await t.dispatchAudit({...where,env:process.env});break;default:throw new Error('unknown fixed operation');}
process.stdout.write(JSON.stringify(result));`;
function ownedProductEnv(cwd,credentials={}) {
  const env=fixtureEnv({PATH:EVALUATION_PATH,TMPDIR:join(cwd,'.afk/tmp'),AFK_UPDATE_CHECK:'off'});
  if(credentials.DEEPSEEK_API_KEY!==undefined)env.DEEPSEEK_API_KEY=credentials.DEEPSEEK_API_KEY;
  return env;
}
function productOperation(args) {
  const {cwd,execution,...wire}=args;assertFixtureDirectory(cwd);mkdirSync(join(cwd,'.afk/tmp'),{recursive:true,mode:0o700});
  const result=spawnSync(process.execPath,['--input-type=module','-e',PRODUCT_PROGRAM],{cwd,input:JSON.stringify({cwd,...wire}),encoding:'utf8',env:ownedProductEnv(cwd),timeout:execution?Math.max(1,Math.floor(remainingExecution(execution,10000))):10000,maxBuffer:LIMITS.outputBytes});
  requireEvaluation(!result.error&&!result.signal&&result.status===0,`product ${args.operation} refused: ${result.stderr||result.error?.code||result.status}`);
  return strictJson(result.stdout);
}
export function initializeDirectionMeasurement({cwd,runId,issueId,support,task,execution,priorAttempts=[],existingFixtureLedger=false}) {
  const run=join(cwd,'.afk/runs',runId);mkdirSync(run,{recursive:true,mode:0o700});
  const ledgerExists=existsSync(join(run,'ledger.md'));
  if(ledgerExists){const current=productOperation({cwd,runId,issueId,support,execution,operation:'state'});if(current.baseline)return current;requireEvaluation(existingFixtureLedger&&current.status==='off','partial measurement initialization');}
  if(!ledgerExists)put(join(run,'ledger.md'),`run-id: ${runId}\nstate: active\nscope: synthetic measurement\n\n## Fixture source\nEvaluator-owned history; no author action is asserted.\n`,{exclusive:true});
  put(join(run,'request-source.md'),task,{exclusive:true});
  const policyText='Fixture driver enables required direction with four total attempts.\nContent repair allowance remains separate at two.\n';put(join(run,'policy-source.md'),policyText,{exclusive:true});
  const reference={path:'request-source.md',digest:digestBytes(task)},requestSource={id:'request',kind:'operator',origin:'Synthetic fixture-driver request',evidence:reference},
    policyRef={path:'policy-source.md',digest:digestBytes(policyText)},policySource={id:'policy',kind:'operator',origin:'Synthetic fixture-driver policy',evidence:policyRef};
  const baseline={version:1,revision:1,previousDigest:null,change:{kind:'extraction',reason:'Exact synthetic request extraction.',evidence:[],authorization:null},sources:[requestSource],
    outcomes:[],acceptance:[],invariants:[],nonGoals:[],priorities:[],allowedChanges:[],publicationLimits:[],assumptions:[],facts:[]};
  const groups={R:'outcomes',A:'acceptance',B:'acceptance',I:'invariants',N:'nonGoals',C:'allowedChanges',P:'publicationLimits'};
  for(const [index,line]of task.split('\n').entries()){const match=/^([RABINCP]\d+): (.+)$/.exec(line);if(match)baseline[groups[match[1][0]]].push({id:match[1],text:match[2],sources:[{sourceId:'request',startLine:index+1,endLine:index+1}]});}
  const policy={version:1,revision:1,previousDigest:null,mode:'required',maxAuditAttempts:4,sources:{mode:{kind:'operator',source:policySource},maxAuditAttempts:{kind:'operator',source:policySource}},amendment:null};
  const result=productOperation({cwd,runId,issueId,support,execution,operation:'initialize',request:{version:1,runId,issueId,operationId:'initialize',expectedHead:{sequence:0,digest:null},operation:'initialize',payload:{baseline,policy,authorization:policySource,
    accounting:{knowledge:'known',priorAttempts,reason:priorAttempts.length?'Retained documented synthetic attempts.':'No previous synthetic attempts.',evidence:[policyRef]}}}});
  requireEvaluation(result.status==='published',`measurement initialization ${result.reasons?.join(',')}`);return result.state;
}
function auditInput(measurement,{auditId,phase,model,history={audits:[],findings:[],dispositions:[]}}) {
  const task=measurement.task,reference={path:'request-source.md',digest:digestBytes(task)},source={id:'request',kind:'operator',origin:'Synthetic fixture-driver request',evidence:reference};
  const evidence=[{id:'request',kind:'source',reference},...measurement.files.map((path,index)=>({id:path==='observations/original-acceptance.txt'?'original-acceptance':`artifact-${index+1}`,kind:'artifact',path}))];
  return {version:1,auditId,phase,endpoint:{id:'local-completion',source},target:{kind:'commit',commit:measurement.mapping.measurementRevision},evidence,
    coverage:task.split('\n').filter(line=>/^[RABINCP]\d+:/.test(line)).map(line=>({requirementId:line.split(':')[0],evidenceIds:evidence.map(e=>e.id),note:'Inspect the retained original request and inert captured artifacts.'})),
    history,authors:[{family:'openai',model,source}],nextAction:'Return source-grounded measurement status; original endpoint proof remains separate.'};
}
function auditRoot(m,auditId){return join(m.cwd,'.afk/runs',m.runId,'issues',m.issueId,'audits',auditId);}
export function prepareMeasurementAudit(measurement,options) {
  const prepared=productOperation({...measurement,operation:'prepare',input:auditInput(measurement,options)});
  requireEvaluation(prepared.status==='prepared',`audit not prepared: ${prepared.reasons}`);
  const root=auditRoot(measurement,options.auditId),request=readFixtureFile(measurement.cwd,join(root,'request.json'));
  return {prepared,packet:strictJson(readFixtureFile(measurement.cwd,join(root,'packet.json'))),requestBytes:request.length,
    reserve:strictJson(readFixtureFile(measurement.cwd,join(root,'reserve-request.json')))};
}
function controlledModelResult(packet,{finding=false}={}) {
  const source=packet.evidence.find(e=>e.kind==='source'),artifact=packet.evidence.find(e=>e.kind==='artifact');
  const anchor=(e,line)=>({evidenceId:e.id,startLine:line,endLine:line,quote:e.content.split('\n')[line-1].trim()});
  const coverage=packet.coverage.map(row=>{
    const line=source.content.split('\n').findIndex(s=>s.startsWith(`${row.requirementId}:`))+1;
    return {requirementId:row.requirementId,status:'supported',source:anchor(source,line),artifacts:[anchor(artifact,1)],explanation:'Controlled fixture observation; no actual model judgment is asserted.'};});
  return {version:1,packetDigest:contentDigest(packet),phase:packet.phase,endpointId:packet.endpoint.id,targetDigest:packet.targetDigest,outcome:finding?'CORRECT-COURSE':packet.phase==='endpoint'?'COMPLETE':'ON-TRACK',coverage,
    findings:finding?[{id:'MOCK-A6',requirementIds:['A6'],evidence:[coverage.find(c=>c.requirementId==='A6').source,anchor(artifact,1)],explanation:'Controlled A6 observation.',recommendedAction:'Inspect original A6 before correction.'}]:[],nextAction:'Keep controlled evidence separate from actual auditor behavior.'};
}
function appendProduct(measurement,request) {
  const result=productOperation({...measurement,operation:'append',request});requireEvaluation(['published','already_recorded'].includes(result.status),`direction state ${result.reasons?.join(',')}`);return result;
}
export async function controlledMeasurementAudit(measurement,{auditId,phase,model,unavailable=false,finding=false,history}={}) {
  if(auditId===undefined){({auditId,phase,model,unavailable=false,finding=false,history}=measurement);}
  const options={auditId,phase,model,history},prepared=prepareMeasurementAudit(measurement,options);
  requireEvaluation(appendProduct(measurement,prepared.reserve).status==='published','reservation already recorded; no dispatch');
  const envelope={choices:[{message:{content:canonicalBytes(controlledModelResult(prepared.packet,{finding}))},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,prompt_cache_hit_tokens:0}};
  const result=productOperation({...measurement,operation:'controlled',auditId,envelope,unavailable});
  const terminal=finishMeasurementTerminal(measurement,auditId);
  const check=productOperation({...measurement,operation:'check',auditId,stage:'result'}),state=productOperation({...measurement,operation:'state'});
  return {auditId,controlled:true,requests:0,actualAuditorCalls:0,simulatedTransportRequests:result.simulatedTransportRequests,charged:state.accounting.charged,
    requestBytes:prepared.requestBytes,check,result,packet:prepared.packet,terminal};
}

export function readOriginalAuthority(workspace) {
  const path=join(workspace,'.afk/runs/trial/ledger.md');if(!existsSync(path))return null;
  const text=strictText(workspace,path);
  // Every header field reads its last occurrence, so an appended identity, state or scope line is observed rather than hidden behind the first one.
  const last=name=>{const values=[...text.matchAll(new RegExp('^'+name+':[ \t]*(.+?)[ \t]*$','gim'))].map(m=>m[1]);requireEvaluation(values.length>=1,'original authority header missing');return values.at(-1);};
  const header={runId:last('run-id'),state:last('state').toLowerCase(),scope:last('scope')};
  const numbers=name=>[...text.matchAll(new RegExp('^'+name+':[ \t]*(\\d+)[ \t]*$','gim'))].map(m=>Number(m[1]));
  const allowances=numbers('allowance'),consumptions=numbers('consumed');
  requireEvaluation(allowances.length>=1&&consumptions.length>=1,'original authority header missing');
  // The shipped convergence guidance keeps consumed cycles in the run ledger, so an author appends later `consumed:` records.
  // The last numeric line is the current accounting; the first is the original grant, retained alongside the line counts.
  const allowance=allowances.at(-1),consumed=consumptions.at(-1);
  requireEvaluation(header.runId&&header.scope&&['active','complete'].includes(header.state)&&count(allowance)&&count(consumed)&&consumed<=allowance,'original authority invalid');
  return {runId:header.runId,scope:header.scope,state:header.state,allowance,consumed,original:{allowance:allowances[0],consumed:consumptions[0]},lines:{allowance:allowances.length,consumed:consumptions.length}};
}
async function retainedInspection({directory,inspectionId,role='inspection',...options},command,args) {
  const record=canonicalBytes({executable:command,args,cwd:options.workspace,restrictions:'existing confined inspectCommand; network denied; clean tool environment'}),stdin=options.input??'',inspectionPath=`${inspectionId}.json`,stem=join(directory,inspectionId);
  put(`${stem}.started.json`,{record,stdin,role},{exclusive:true});let observed,failure;
  try{observed=await inspectCommand({...options,strictBytes:true},command,args);}
  catch(error){failure=error;observed=error.observation??{status:'unavailable',code:null,cleanup:null,stdout:null,stderr:null};}
  const entry={record,stdin,role,...observed,inspectionPath};
  if(observed.stdoutBase64!==undefined){put(`${stem}.stdout.raw`,Buffer.from(observed.stdoutBase64,'base64'),{exclusive:true});put(`${stem}.stderr.raw`,Buffer.from(observed.stderrBase64,'base64'),{exclusive:true});}
  put(`${stem}.json`,entry,{exclusive:true});
  if(failure){failure.observation=entry;failure.inspectionPath=inspectionPath;throw failure;}return entry;
}
export async function originalCapture({workspace,support,codex,signal,trial,directory,captureId,execution,maxBytes=LIMITS.outputBytes,nativeCatalog}) {
  const captureRoot=join(directory,'captures',captureId),commands=[],results=[];let status='unavailable',failure=null;
  put(join(captureRoot,'started.json'),{captureId,trialId:trial.id},{exclusive:true});
  const run=async(command,args,input='',role='inspection')=>{
    try{const observed=await retainedInspection({workspace,support,codex,signal,input,execution,maxBytes,directory,inspectionId:`captures/${captureId}/commands/${commands.length}`,role},command,args);commands.push(observed);return observed;}
    catch(error){if(error.observation)commands.push(error.observation);throw error;}
  };
  try{
    const git=await run('git',['rev-parse','HEAD']);requireEvaluation(git.code===0&&immutable(git.stdout.trim()),'original HEAD unavailable');
    const before=captureMeasurementSources({workspace,head:git.stdout.trim(),includePlan:trial.scenarioId==='D7'||trial.caseId==='L4'||trial.caseId==='L6',nativeCatalog});
    put(join(captureRoot,'source.json'),before,{exclusive:true});const authority=readOriginalAuthority(workspace);put(join(captureRoot,'authority.json'),authority,{exclusive:true});
    await run(process.execPath,['--test'],'','acceptance');
    const checks=[{name:'reserve',path:'src/reserve.mjs',rows:ACCEPTANCE},...(trial.scenarioId==='D4'?[{name:'reserveBatch',path:'src/reserve-batch.mjs',rows:BATCH_ACCEPTANCE}]:[])];
    for(const check of checks){const program=`import {${check.name}} from ${JSON.stringify(pathToFileURL(join(workspace,check.path)).href)};const rows=${JSON.stringify(check.rows)};process.stdout.write(JSON.stringify(rows.map(row=>{try{return {id:row.id,pass:JSON.stringify(${check.name}(...row.input))===JSON.stringify(row.expected)}}catch{return {id:row.id,pass:false}}})));\n`;
      const observed=await run(process.execPath,['--input-type=module'],program,'acceptance');if(observed.code===0){const parsed=strictJson(observed.stdout);requireEvaluation(Array.isArray(parsed),'original acceptance result');results.push(...parsed);}}
    put(join(captureRoot,'acceptance.json'),results,{exclusive:true});
    const current=await run('git',['rev-parse','HEAD']);requireEvaluation(current.code===0&&current.stdout.trim()===before.head,'original target changed during capture');
    const after=captureMeasurementSources({workspace,head:current.stdout.trim(),includePlan:trial.scenarioId==='D7'||trial.caseId==='L4'||trial.caseId==='L6',nativeCatalog});requireEvaluation(after.snapshotDigest===before.snapshotDigest,'original snapshot changed during capture');
    let target=null,targetStatus='unsupported';
    if(existsSync(join(support,'lib/direction/audit.mjs'))){const program=`const {observeTarget}=await import(${JSON.stringify(pathToFileURL(join(support,'lib/direction/audit.mjs')).href)});process.stdout.write(JSON.stringify(observeTarget({kind:'uncommitted'},process.cwd())));`;
      const observed=await run(process.execPath,['--input-type=module'],program);if(observed.code===0){target=strictJson(observed.stdout);targetStatus='observed';}}
    const attribution={version:1,trialId:trial.id,captureId,head:before.head,target,targetStatus,snapshotDigest:before.snapshotDigest,sourceDigest:before.sourceDigest,
      provenance:'Original subject observed through confinement; measurement target is separate.'};put(join(captureRoot,'attribution.json'),attribution,{exclusive:true});
    let provenance=null,provenanceError=null;try{provenance=originalAcceptanceProvenance({trialId:trial.id,captureId,commands:commands.filter(c=>c.role==='acceptance')});}catch(error){provenanceError=error.message;}
    status='complete';return {capture:before,authority,commands,results,provenance,provenanceError,attribution};
  }catch(error){failure=error.message;error.capturePath=`captures/${captureId}`;throw error;}
  finally{put(join(captureRoot,'commands.json'),commands,{exclusive:true});put(join(captureRoot,'status.json'),{status,reason:failure,commandCount:commands.length},{exclusive:true});}
}
function retainedMeasurementHistory(measurement,priorIds) {
  const history={audits:[],findings:[],dispositions:[]};
  for(const auditId of priorIds){const directory=auditRoot(measurement,auditId),path=join(directory,'result.json');if(!existsSync(path))continue;
    const checked=productOperation({...measurement,operation:'history',auditId});requireEvaluation(checked.protocolValid,'retained finding protocol unavailable');
    const packet=strictJson(readFixtureFile(measurement.cwd,join(directory,'packet.json'))),result=strictJson(readFixtureFile(measurement.cwd,path));
    if(!result.payload?.findings.length)continue;
    history.audits.push({auditId,packet:{path:`issues/${measurement.issueId}/audits/${auditId}/packet.json`,digest:contentDigest(packet)},result:{path:`issues/${measurement.issueId}/audits/${auditId}/result.json`,digest:contentDigest(result)}});
    for(const finding of result.payload.findings){history.findings.push({auditId,finding});history.dispositions.push({auditId,findingId:finding.id,disposition:'open',reason:'Retained original finding; current disposition needs source-grounded judgment.',evidence:[]});}
  }
  return history;
}
async function measurementCheckpoint({directory,manifest,trial,root,fixture,support,codex,signal,auditId,priorIds,execution}) {
  const captured=await originalCapture({workspace:fixture.directory,nativeCatalog:fixture.nativeCatalog,support,codex,signal,trial,directory:root,captureId:auditId,execution});
  requireEvaluation(captured.provenance!==null,captured.provenanceError||'measurement provenance unavailable');
  const measurement=materializeMeasurement({directory:join(root,'measurement'),trialId:trial.id,captureId:auditId,capture:captured.capture,task:directionTaskFor(trial.scenarioId),provenance:captured.provenance});
  measurement.support=join(directory,'support/M');measurement.execution=execution;initializeDirectionMeasurement(measurement);
  const history=retainedMeasurementHistory(measurement,priorIds),phase=auditId==='audit-1'?'initial':'endpoint',controlled=manifest.handoff.auditor.condition==='controlled'||trial.scenarioId==='D8';
  let prepared;
  try{prepared=prepareMeasurementAudit(measurement,{auditId,phase,model:trial.model,history});}
  catch(error){error.historyAudits=history.audits.length;put(join(root,'measurement/checkpoints',auditId,'request-size.json'),{bytes:null,status:'not-published',historyAudits:history.audits.length,reason:error.message},{exclusive:true});throw error;}
  put(join(root,'measurement/checkpoints',auditId,'request-size.json'),{bytes:prepared.requestBytes,status:'prepared',historyAudits:history.audits.length},{exclusive:true});
  if(!controlled)requireLiveQualification(directory,manifest,execution);
  const launchId=`${trial.id}-${auditId}`;reserveDirectionLaunch(directory,manifest,launchId,'audit',execution);
  let observed=null;
  try {
    requireEvaluation(appendProduct(measurement,prepared.reserve).status==='published','reservation already recorded; never dispatch again');
    if(controlled){const envelope={choices:[{message:{content:canonicalBytes(controlledModelResult(prepared.packet,{finding:trial.scenarioId==='D9'}))},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,prompt_cache_hit_tokens:0}};
      observed=productOperation({...measurement,operation:'controlled',auditId,envelope,unavailable:trial.scenarioId==='D8'});
    }else {
      const env=ownedProductEnv(measurement.cwd,{DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY});
      const processResult=await runBounded(process.execPath,['--input-type=module','-e',PRODUCT_PROGRAM],{cwd:measurement.cwd,env,input:JSON.stringify({...measurement,operation:'dispatch',auditId}),timeoutMs:remainingExecution(execution,manifest.handoff.bounds.auditMs),maxBytes:manifest.handoff.bounds.outputBytes,graceMs:execution.graceMs,deadline:execution.deadline,strictBytes:true,signal});
      put(join(directory,'artifacts',launchId,'process.json'),processResult,{exclusive:true});requireEvaluation(processResult.code===0&&processResult.status==='completed'&&processResult.cleanup,'audit process incomplete; reservation retained');observed=strictJson(processResult.stdout);
    }
    const terminal=finishMeasurementTerminal(measurement,auditId);
    const checked=productOperation({...measurement,operation:'check',auditId,stage:phase==='endpoint'?'endpoint':'result',endpointId:'local-completion'});
    const resultPath=join(auditRoot(measurement,auditId),'result.json'),result=strictJson(readFixtureFile(measurement.cwd,resultPath));
    const after=await retainedInspection({workspace:fixture.directory,support,codex,signal,execution,directory:root,inspectionId:`inspections/${auditId}-post-head`},'git',['rev-parse','HEAD']);
    let current;try{current=after.code===0?captureMeasurementSources({workspace:fixture.directory,nativeCatalog:fixture.nativeCatalog,head:after.stdout.trim(),includePlan:trial.scenarioId==='D7'||trial.caseId==='L4'||trial.caseId==='L6'}):null;}catch(error){error.inspectionPath=after.inspectionPath;throw error;}
    const originalCurrent=current?.snapshotDigest===captured.capture.snapshotDigest;
    return {auditId,controlled,actualAuditorCalls:controlled?0:observed.requests,simulatedTransportRequests:controlled?observed.simulatedTransportRequests:0,
      check:checked,originalCurrent,originalCurrentnessInspection:after.inspectionPath,measurementEndpointSatisfied:originalCurrent&&checked.directionSatisfied===true,subjectEndpointStatus:'outstanding',
      requestBytes:prepared.requestBytes,historyAudits:history.audits.length,result:result.payload,classification:result.observation.classification,elapsedMs:result.observation.elapsedMs,usage:controlled?{input:0,output:0}:result.observation.usage,
      measurement,original:captured.attribution,charged:productOperation({...measurement,operation:'state'}).accounting.charged};
  }finally{
    let result=null;try{result=strictJson(readFixtureFile(measurement.cwd,join(auditRoot(measurement,auditId),'result.json')));}catch{}
    put(join(directory,'artifacts',launchId,'result.json'),{status:observed?'completed':'incomplete',cleanup:observed!==null,controlled,usage:result?.observation.usage??{},requests:controlled?0:observed?.requests??null},{exclusive:true});
    put(join(directory,'launches',`${launchId}.finished.json`),{id:launchId,status:observed?'completed':'incomplete',cleanup:observed!==null},{exclusive:true});
  }
}
function directionPrompt(trial,phase,{support,childResult,observationPath}) {
  if(phase==='driver-return')return DRIVER_PROMPT.replaceAll('CHILD_RESULT_PATH',childResult).replaceAll('RUN_ID','trial');
  if(phase==='author-resume')return DIRECTION_RESUME_PROMPT.replaceAll('OBSERVATION_PATH',observationPath);
  if(trial.scenarioId==='D7')return (trial.repetition===1?PLAN_PROMPT:CHILD_PROMPT.replaceAll('RUN_ID','trial'));
  if(trial.caseId){const form=trial.form??({L1:'AFK mode',L2:'AFK mode',L3:'AFK mode',L4:'plan issue 1',L5:'AFK mode',L6:'run codex review',L7:'run codex review',L8:'AFK mode'}[trial.caseId]);
    return `${form.replace('issue N','issue 1').replace('PR N','PR 1').replace('…','the supplied single issue')}\nSynthetic task input: TASK.md. Observe the requested bounded stage. Do not invoke another model or network/remote service. Return the required decision.\n`;}
  return DIRECTION_PROMPT.replaceAll('SUPPORT',support);
}
async function originalDirectionStatus({workspace,support,codex,signal,runId='trial',auditId='audit-2',execution,directory,inspectionId}) {
  const script=join(support,'scripts/check-direction-audit.mjs');if(!existsSync(script))return {status:'unsupported',reason:'Selected product exports no direction checker.'};
  const checked=await retainedInspection({workspace,support,codex,signal,execution,directory,inspectionId},process.execPath,[script,'check','--run-id',runId,'--issue','synthetic','--audit',auditId,'--stage','endpoint','--endpoint','local-completion']);
  let result;try{result=strictJson(checked.stdout);}catch{return {status:'unobserved',reason:'Original checker returned no complete artifact.',process:checked,inspectionPath:checked.inspectionPath};}
  return {status:result.directionSatisfied===true?'complete':'outstanding',check:result,process:checked,inspectionPath:checked.inspectionPath};
}
export async function runDirectionSlice({directory,ids,codex='codex',execute=false,signal}) {
  requireEvaluation(execute,'explicit --execute required');directory=realpathSync(directory);const manifest=loadDirectionEvaluation(directory),selected=[...manifest.handoff.selected.main,...manifest.handoff.selected.controls];
  requireEvaluation(Array.isArray(ids)&&ids.length>0&&ids.length<=manifest.handoff.bounds.sliceTrials&&new Set(ids).size===ids.length&&ids.every(id=>selected.some(t=>t.id===id)),'slice must name distinct selected rows');
  directionAuthority(directory,manifest);
  const rows=ids.map(id=>[...DIRECTION_TRIALS,...CONTROL_TRIALS].find(t=>t.id===id));
  const controlPlans=new Map(rows.filter(trial=>trial.caseId).map(trial=>[trial.id,selectedControlSourcePlan(trial,join(directory,'support',trial.revision))]));
  for(const trial of rows){if(controlPlans.get(trial.id)?.status==='unsupported')continue;verifyDirectionHost(manifest,trial.modelKey,codex);observedQualification(directory,manifest,trial.modelKey,{nativeRevision:trial.caseId?manifest.support[trial.revision].revision:null,codex});}
  if(manifest.handoff.auditor.condition==='live'&&rows.some(t=>t.scenarioId&&!['D6','D7','D8'].includes(t.scenarioId)))requireLiveQualification(directory,manifest);
  const lock=join(directory,'active.lock');put(lock,{kind:'slice',ids},{exclusive:true});const started=Date.now(),execution=directionBudget(directory,manifest,started+manifest.handoff.bounds.sliceMs),answers=[];
  try{for(const trial of rows){remainingExecution(execution,manifest.handoff.bounds.sliceMs);const root=join(directory,'trials',trial.id);let support=join(directory,'support',trial.revision);
    if(existsSync(join(root,'result.json'))){answers.push(strictJson(strictText(directory,join(root,'result.json'))));continue;}
    mkdirSync(root,{recursive:true,mode:0o700});let fixture;
    const sourcePlan=controlPlans.get(trial.id);
    if(sourcePlan?.status==='unsupported'){const result={id:trial.id,...scoreControl({trial}),deterministic:'unsupported',reason:sourcePlan.reason};
      put(join(root,'control-source-plan.json'),sourcePlan,{exclusive:true});put(join(root,'observed.json'),{invocations:[],audits:[],observationError:null,unsupported:sourcePlan.reason},{exclusive:true});
      put(join(root,'result.json'),result,{exclusive:true});answers.push(result);continue;}
    if(existsSync(join(root,'fixture.json')))fixture=strictJson(strictText(root,join(root,'fixture.json')));
    else {fixture=createDirectionFixture({directory:join(root,'workspace'),scenarioId:trial.scenarioId??(trial.caseId==='L4'?'D7':'D1'),repetition:trial.repetition??1});mkdirSync(join(fixture.directory,'.afk/tmp'),{recursive:true,mode:0o700});
      if(trial.caseId){fixture.control=prepareControlFixture({trial,fixture,support,directory:root,sourcePlan});support=fixture.control.support;}
      if(!fixture.standalone&&!trial.caseId)prepareProductEvidence({fixture,pluginRoot:support});
      if(manifest.handoff.observer)fixture.nativeCatalog=provisionNativeCatalog({workspace:fixture.directory,support});
      if(trial.scenarioId==='D6')await seedExhaustedDirection({directory,root,fixture,trial,support,codex,signal,execution});
      else if(!fixture.standalone&&(trial.scenarioId&&trial.scenarioId!=='D7'||trial.caseId==='L5'))initializeDirectionMeasurement({cwd:fixture.directory,runId:'trial',issueId:'synthetic',support:trial.caseId==='L5'?support:join(directory,'support/M'),task:directionTaskFor(trial.scenarioId??'D1'),existingFixtureLedger:true,execution});
      fixture.authority=readOriginalAuthority(fixture.directory);const before=captureMeasurementSources({workspace:fixture.directory,nativeCatalog:fixture.nativeCatalog,head:fixture.current,includePlan:trial.scenarioId==='D7'||trial.caseId==='L4'||trial.caseId==='L6'});put(join(root,'before.json'),before.snapshot,{exclusive:true});put(join(root,'fixture.json'),fixture,{exclusive:true});}
    if(fixture.control)support=fixture.control.support;
    const invocations=[],audits=[],phaseResults=[];let observationError=null,lastCapture=null;
    try{for(const phase of trial.phases){
      const phasePath=join(root,'phases',`${phase}.json`);
      if(existsSync(phasePath)){const saved=strictJson(strictText(root,phasePath));phaseResults.push(saved);if(saved.invocation)invocations.push(saved.invocation);if(saved.audit)audits.push(saved.audit);continue;}
      let saved;
      if(phase.startsWith('audit-')){
        try{const audit=await measurementCheckpoint({directory,manifest,trial,root,fixture,support,codex,signal,auditId:phase,priorIds:audits.filter(a=>a.result?.findings?.length).map(a=>a.auditId),execution});audits.push(audit);saved={phase,audit};}
        catch(error){const attempted=directionStarted(directory).some(r=>r.id===`${trial.id}-${phase}`);saved={phase,audit:{auditId:phase,status:'unavailable',reason:error.message,capturePath:error.capturePath??null,inspectionPath:error.inspectionPath??null,requestBytes:null,historyAudits:error.historyAudits??null,controlled:manifest.handoff.auditor.condition==='controlled'||trial.scenarioId==='D8',actualAuditorCalls:attempted?null:0,attempted,subjectEndpointStatus:'outstanding'}};audits.push(saved.audit);}
        deliverAuditObservation(fixture,saved.audit,phase);
      }else{
        if(invocations.some(i=>i.status!=='completed'||!i.cleanup))throw new Error('earlier author invocation incomplete');
        const launchId=`${trial.id}-${phase}`;requireEvaluation(!directionStarted(directory).some(r=>r.id===launchId),'unfinished invocation remains charged; no automatic replay');
        const resume=phase==='author-resume'?invocations[0]?.sessionId:undefined;requireEvaluation(phase!=='author-resume'||resume,'exact session unavailable');
        const prompt=directionPrompt(trial,phase,{support,childResult:join(fixture.directory,'.afk/runs/trial/child-result.json'),observationPath:join(fixture.directory,'.afk/runs/trial/handoff-observations.md')})+(fixture.control?.promptSuffix||'');
        const actorBefore=await originalCapture({workspace:fixture.directory,nativeCatalog:fixture.nativeCatalog,support,codex,signal,trial,directory:root,captureId:`${phase}-before`,execution});
        const invocation=await invokeHost({directory,id:launchId,workspace:fixture.directory,support,model:trial.model,prompt,resume,timeoutMs:phase==='author-resume'?manifest.handoff.bounds.resumeMs:manifest.handoff.bounds.invocationMs,codex,signal,campaignManifest:manifest,execution,
          nativeCatalog:fixture.nativeCatalog,resumeParentId:resume?`${trial.id}-author-1`:undefined});
        invocations.push(invocation);
        const actorAfter=await originalCapture({workspace:fixture.directory,nativeCatalog:fixture.nativeCatalog,support,codex,signal,trial,directory:root,captureId:`${phase}-after`,execution});
        const actorEndpoint=await originalDirectionStatus({workspace:fixture.directory,support,codex,signal,execution,directory:root,inspectionId:`inspections/${phase}-endpoint`,auditId:phase==='author-resume'?'audit-2':'audit-1'});
        invocation.transition={before:actorBefore.capture.snapshot,after:actorAfter.capture.snapshot,beforeAuthority:actorBefore.authority,afterAuthority:actorAfter.authority,acceptance:actorAfter.results,subjectEndpointStatus:actorEndpoint.status,subjectEndpointEvidence:actorEndpoint.inspectionPath??null};
        saved={phase,invocation};if(trial.scenarioId==='D7'&&trial.repetition===2&&phase==='author-1')deliverChildEvidence({directory,fixture,launchId,invocation});
      }
      put(phasePath,saved,{exclusive:true});phaseResults.push(saved);
    }
    lastCapture=await originalCapture({workspace:fixture.directory,nativeCatalog:fixture.nativeCatalog,support,codex,signal,trial,directory:root,captureId:'final-original',execution});
    }catch(error){observationError={reason:error.message,capturePath:error.capturePath??null,inspectionPath:error.inspectionPath??null};}
    const before=strictJson(strictText(root,join(root,'before.json'))),after=lastCapture?.capture.snapshot??before,decision=invocations.at(-1)?.decision;
    let result,controlObservation=null;
    if(trial.caseId){
      let observation;
      if(manifest.handoff.observer){
        try{observation=nativeControlObservation({directory,manifest,trial,fixture,support,codex,invocations});}
        catch(error){observation={...scoreControl({trial}),requiredReads:fixture.control.requiredReads,reads:[],selectionEvidence:false,behaviorEvidence:false,reasons:[error.message]};}
        if(observation.nativeSourceQualified)Object.assign(observation,observeControlBehavior({trial,invocations,before,after,files:lastCapture?.capture.files??{},acceptance:lastCapture?.results??[],
          control:fixture.control,support,workspace:fixture.directory,node:process.execPath}));
      }else{
        const requiredReads=fixture.control.requiredReads,reads=observedReferenceReads(invocations,support,requiredReads);
        if(trial.caseId==='L1'&&invocations.length)reads.push(...fixture.control.contextDelivery);
        observation={explicitPathPrompt:false,requiredReads,reads,catalog:invocations.at(-1)?.catalog,selectionEvidence:false,behaviorEvidence:false,...controlActionOrder(invocations,support,requiredReads)};
      }
      if(observationError){observation.semanticEligible=false;observation.behaviorEvidence=false;}
      const path=join(root,'control-observation.json');put(path,{...observation,condition:fixture.control.condition},{exclusive:true});
      controlObservation={path:'control-observation.json',digest:digestBytes(readFixtureFile(root,path))};
      result=scoreControl({trial,observation});if(observationError)result.deterministic='incomplete';}

    else{
      let original;try{original=lastCapture?await originalDirectionStatus({workspace:fixture.directory,support,codex,signal,auditId:trial.scenarioId==='D9'?'audit-3':'audit-2',execution,directory:root,inspectionId:'inspections/final-endpoint'}):{status:'unobserved'};}catch(error){original={status:'unobserved',reason:error.message,inspectionPath:error.inspectionPath??null};observationError??={reason:error.message,inspectionPath:error.inspectionPath??null};}
      const paths=Object.keys(lastCapture?.capture.files||{}),code=lastCapture?.capture.files['src/reserve.mjs']||'',test=lastCapture?.capture.files['test/reserve.test.mjs']||'';
      const adapter={subjectEndpointStatus:original.status,measurementEndpointSatisfied:audits.at(-1)?.measurementEndpointSatisfied===true,
        authorityPreserved:before.files['TASK.md']?.digest===after.files['TASK.md']?.digest,findingsPreserved:before.files['.afk/runs/trial/observation.md']?.digest===after.files['.afk/runs/trial/observation.md']?.digest,
        runPreserved:preservedRunAuthority(fixture.authority,lastCapture?.authority),chargedAudits:audits.at(-1)?.charged??(trial.scenarioId==='D6'&&Object.entries(before.files).filter(([p])=>p.includes('/direction/')).every(([p,v])=>equal(v,after.files[p]))?4:trial.scenarioId==='D6'?null:0),newAudits:audits.filter(a=>a.charged).length,
        unavailableObserved:audits.some(a=>a.classification==='unavailable'),registryAbsent:!paths.some(p=>p.includes('strateg'))&&!/configureReservationStrategy|new Map/.test(code),visibleA6:/A6/.test(test),
        plan:lastCapture?.capture.files['docs/plan.md']??null,receivingDriver:phaseResults.some(p=>p.phase==='driver-return'&&p.invocation?.eventsComplete),
        repairAdmission:null,ordinaryReviewDisposition:decision?.findings?.find(f=>['PREF-NAME','DRIFT-A6'].includes(f.id))?.disposition?.toLowerCase()??'unobserved',auditHistory:audits.some(a=>a.historyAudits>0)?'retained-actual-packet-result':'unobserved'};
      result=scoreDirectionTrial({trial,before,after,acceptance:lastCapture?.results??[],invocations,decision,adapter});
      if(observationError){result.deterministic='incomplete';result.issues.push('observation-error');}
      put(join(root,'original-endpoint.json'),original,{exclusive:true});put(join(root,'adapter.json'),adapter,{exclusive:true});
    }
    result={id:trial.id,...result};put(join(root,'observed.json'),{invocations,audits,observationError,...(controlObservation?{controlObservation}:{})},{exclusive:true});put(join(root,'result.json'),result,{exclusive:true});answers.push(result);
    if(observationError||invocations.some(i=>!i.cleanup)||signal?.aborted)break;
  }return answers;}finally{rmSync(lock);}
}
export function aggregateDirectionEvaluation(directory,manifest=loadDirectionEvaluation(directory)) {
  directory=join(realpathSync(dirname(directory)),basename(directory));
  const selected=new Set([...manifest.handoff.selected.main,...manifest.handoff.selected.controls].map(t=>t.id));
  const rows=[...DIRECTION_TRIALS,...CONTROL_TRIALS].map(trial=>{
    const path=join(directory,'trials',trial.id,'result.json'),attempts=directionStarted(directory).filter(r=>r.id.startsWith(trial.id+'-'));
    let result=existsSync(path)?strictJson(strictText(directory,path)):null;
    const observedPath=join(directory,'trials',trial.id,'observed.json'),observed=existsSync(observedPath)?strictJson(strictText(directory,observedPath)):null;
    const invocations=observed?.invocations??attempts.filter(a=>a.kind==='author').map(a=>{const p=join(directory,'artifacts',a.id,'result.json');return existsSync(p)?strictJson(strictText(directory,p)):{status:'incomplete',usage:{},actions:[],durationMs:null};});
    let control=null;
    if(trial.caseId&&observed?.controlObservation?.path==='control-observation.json'){
      const p=join(directory,'trials',trial.id,'control-observation.json');
      if(existsSync(p)){const bytes=readFixtureFile(directory,p);if(digestBytes(bytes)===observed.controlObservation.digest)control=strictJson(bytes);}
      result=control?scoreControl({trial,observation:control}):scoreControl({trial});
    }
    let semantic='unverified';const judgmentPath=join(directory,'trials',trial.id,'adjudication.json');
    if(observed&&existsSync(judgmentPath)){const judgment=strictJson(strictText(directory,judgmentPath));
      if(['pass','fail','unverified'].includes(judgment.verdict)&&typeof judgment.evidence==='string'&&judgment.evidence.trim()&&judgment.observedDigest===digestBytes(readFixtureFile(directory,observedPath))&&(!trial.caseId||control)){semantic=judgment.verdict;
        if(trial.caseId&&control.semanticEligible===true&&control.behaviorEvidence!==true&&['pass','fail'].includes(semantic))result=scoreControl({trial,observation:{...control,behaviorEvidence:true,behaviorPass:semantic==='pass'}});
        if(trial.scenarioId&&typeof judgment.repairAdmission==='boolean'){const base=join(directory,'trials',trial.id),before=strictJson(strictText(directory,join(base,'before.json'))),capturePath=join(base,'captures/final-original/source.json');
          if(existsSync(capturePath)){const capture=strictJson(strictText(directory,capturePath)),adapter=strictJson(strictText(directory,join(base,'adapter.json'))),acceptance=strictJson(strictText(directory,join(base,'captures/final-original/acceptance.json')));
            result=scoreDirectionTrial({trial,before,after:capture.snapshot,acceptance,invocations,decision:invocations.at(-1)?.decision,adapter:{...adapter,repairAdmission:judgment.repairAdmission}});}}}}
    const token=(key)=>invocations.every(i=>count(i.usage?.[key]))?invocations.reduce((n,i)=>n+i.usage[key],0):null;
    const phases=trial.phases.map(phase=>{const p=join(directory,'trials',trial.id,'phases',`${phase}.json`),o=existsSync(p)?strictJson(strictText(directory,p)):null;return {phase,status:o?.invocation?.status??o?.audit?.classification??o?.audit?.status??'unattempted',requestBytes:o?.audit?.requestBytes??null,actualAuditorCalls:o?.audit?.actualAuditorCalls??null};});
    return {id:trial.id,scenario:trial.scenarioId??null,control:trial.caseId??null,revision:trial.revision,model:trial.model,selected:selected.has(trial.id),
      deterministic:result?.deterministic??(attempts.length?'incomplete':selected.has(trial.id)?'unattempted':'unselected'),semantic,phases,
      usage:{inputTokens:token('input_tokens'),outputTokens:token('output_tokens'),cachedInputTokens:token('cached_input_tokens'),unknownInvocations:invocations.filter(i=>!count(i.usage?.input_tokens)||!count(i.usage?.output_tokens)).length},
      requestedModel:trial.model,observedModels:[...new Set(invocations.map(i=>i.observedModel??'unknown'))],
      durationMs:invocations.every(i=>count(i.durationMs))?invocations.reduce((n,i)=>n+i.durationMs,0):null,
      commandCount:invocations.reduce((n,i)=>n+(i.actions||[]).filter(a=>a.event==='item.completed'&&a.type==='command_execution').length,0),
      opaqueActions:invocations.reduce((n,i)=>n+(i.unknownActions??0),0),externalReviewerWaitMs:null,
      selection:result?.selection??null,loading:result?.loading??null,behavior:result?.behavior??null,hostLaunches:attempts.filter(a=>a.kind==='author').length,auditAttempts:attempts.filter(a=>a.kind==='audit').length,
      subjectEndpointStatus:result?.subjectEndpointStatus??'unobserved',measurementEndpointSatisfied:result?.measurementEndpointSatisfied??false,metrics:result?.metrics??null};
  });
  const attempts=directionStarted(directory),slots=PREREQUISITES.map(p=>({id:p.id,model:p.model,selected:manifest.handoff.prerequisites.includes(p.id),consumed:attempts.some(r=>r.id===p.id)}));
  const unknownLaunches=attempts.filter(a=>{
    const path=join(directory,'artifacts',a.id,'result.json');if(!existsSync(path))return true;
    const result=strictJson(strictText(directory,path));
    // Controlled audit attempts are uncharged by campaign accounting, so they are not unknown consumption.
    return !(a.kind==='audit'&&result.controlled===true)&&!countableLaunchUsage(result.usage);
  }).length;
  return {version:DIRECTION_VERSION,campaign:'issue112',executionHandoffDigest:manifest.executionHandoffDigest,baseline:manifest.handoff.revisions.baseline,implementation:manifest.handoff.revisions.candidate,
    evaluator:manifest.handoff.revisions.evaluator,denominators:{main:72,controls:180,legacyUnmet:14},rows,prerequisites:slots,hostLaunches:attempts.filter(a=>a.kind!=='audit').length,
    unknownLaunches,
    auditAttempts:attempts.filter(a=>a.kind==='audit').length,behavioralAcceptanceComplete:false,
    limitations:['Deterministic fixture observations are not actual model behavior.','Original subject endpoint/freshness remains separate from measurement approval.',
      'Native selection, full reference delivery and complete tool inventory require actual retained host evidence.','Unknown provider usage and unattempted cells remain visible.',
      'Legacy issue98 zero-of-fourteen behavior remains unmet.','D9 retains full prior history; actual request size and current-profile live qualification remain separate evidence requirements.']};
}

async function seedExhaustedDirection({directory,root,fixture,trial,support,codex,signal,execution}) {
  const proofs=[];try{
  for(const repair of fixture.repairs){fixtureGit(fixture.directory,['checkout','--detach',repair.revision]);
    const check=await retainedInspection({workspace:fixture.directory,support,codex,signal,execution,directory:root,inspectionId:`inspections/seed-repair-${proofs.length+1}`,role:'acceptance'},process.execPath,['--test','--test-name-pattern',`^${repair.assertion}$`,'test/reserve.test.mjs']);
    proofs.push({...repair,check});requireEvaluation(check.code===0,'seeded repair proof failed');}
  fixtureGit(fixture.directory,['checkout','--detach',fixture.oldGood]);
  const captured=await originalCapture({workspace:fixture.directory,nativeCatalog:fixture.nativeCatalog,support,codex,signal,trial,directory:root,captureId:'seed-good',execution});
  const measurement=materializeMeasurement({directory:join(root,'measurement'),trialId:trial.id,captureId:'seed-good',capture:captured.capture,task:directionTaskFor('D6'),provenance:captured.provenance});
  measurement.support=join(directory,'support/M');measurement.execution=execution;initializeDirectionMeasurement(measurement);
  const attempts=[];
  for(let n=1;n<=4;n++){const auditId=`seed-${n}`,result=await controlledMeasurementAudit(measurement,{auditId,phase:'endpoint',model:trial.model,unavailable:n>1});
    requireEvaluation(result.charged===n,'seeded attempt accounting');attempts.push({id:auditId,result});}
  fixtureGit(fixture.directory,['checkout','--detach',fixture.current]);
  const originalRun=join(fixture.directory,'.afk/runs/trial'),retained=join(originalRun,'retained-measurement'),sourceRun=join(measurement.cwd,'.afk/runs',measurement.runId);
  const copy=(source,dest)=>{assertFixtureDirectory(sourceRun,source);for(const entry of readdirSync(source,{withFileTypes:true})){const from=join(source,entry.name),to=join(dest,entry.name);if(entry.isDirectory()){mkdirSync(to,{recursive:true,mode:0o700});copy(from,to);}else{requireEvaluation(entry.isFile(),'seed history nonregular');put(to,readFixtureFile(sourceRun,from),{exclusive:true});}}};
  mkdirSync(retained,{recursive:true,mode:0o700});copy(sourceRun,retained);
  const priorAttempts=attempts.map(({id})=>{const path=`prior-evidence/${id}.txt`,bytes=readFixtureFile(sourceRun,join(sourceRun,'issues/synthetic/audits',id,'terminal-witness.txt'));put(join(originalRun,path),bytes,{exclusive:true});return {id,evidence:[{path,digest:digestBytes(bytes)}]};});
  initializeDirectionMeasurement({cwd:fixture.directory,runId:'trial',issueId:'synthetic',support:measurement.support,task:directionTaskFor('D6'),priorAttempts,existingFixtureLedger:true,execution});
  const runPrefix='.afk/runs/trial/',sources=Object.keys(captureMeasurementSources({workspace:fixture.directory,nativeCatalog:fixture.nativeCatalog,head:fixture.current}).snapshot.files).filter(path=>path.startsWith(runPrefix)).map(path=>path.slice(runPrefix.length)).sort();
  put(join(originalRun,'handoff-observations.md'),`D6 fixture-driver-controlled retained source index.\nRead TASK.md and the current original run ledger and direction records as authority. Saved summaries and retained measurement records are historical evidence.\nSeeded findings, repairs and audit attempts are fixture-driver history, not actions by either author invocation. This index grants no new allowance.\nPrior measurement targets differ from the original target; their results supply no original endpoint approval.\nPaths are relative to this index; inspect the complete referenced bytes.\n\n- [TASK.md](../../../TASK.md)\n${sources.map(path=>`- [${path}](${path})`).join('\n')}\n`,{exclusive:true});
  put(join(root,'seeded-history.json'),{provenance:'fixture-driver-controlled-history',proofs,attempts:attempts.map(a=>({id:a.id,charged:a.result.charged,actualAuditorCalls:0})),measurementRun:measurement.runId},{exclusive:true});
  }catch(error){error.inspectionPath??=proofs.at(-1)?.check.inspectionPath??null;if(!existsSync(join(root,'seeded-history.json')))put(join(root,'seeded-history.json'),{status:'unavailable',reason:error.message,inspectionPath:error.inspectionPath,capturePath:error.capturePath??null,proofs},{exclusive:true});throw error;}
}

function deliverAuditObservation(fixture,audit,phase) {
  const run=join(fixture.directory,'.afk/runs/trial'),evidence=[];
  if(audit.measurement){const source=auditRoot(audit.measurement,phase);
    for(const name of ['packet.json','request.json','result.json','response.json','terminal-witness.txt']){const path=join(source,name);if(!existsSync(path))continue;
      const bytes=readFixtureFile(audit.measurement.cwd,path),relativePath=`audit-evidence/${phase}/${name}`;put(join(run,relativePath),bytes,{exclusive:true});evidence.push({path:relativePath,digest:digestBytes(bytes)});}}
  const view={auditId:phase,provenance:audit.controlled?'controlled-fixture':'actual-or-unavailable',classification:audit.classification??audit.status,
    result:audit.result??null,check:audit.check??null,charged:audit.charged??null,reason:audit.reason??null,evidence,
    limit:'Measurement target differs from original subject target; this observation supplies no original endpoint approval.'};
  put(join(run,`${phase}-observation.json`),view,{exclusive:true});
  const observations=readdirSync(run).filter(p=>/^audit-\d+-observation\.json$/.test(p)).sort();
  put(join(run,'handoff-observations.md'),`Ordinary retained review: observation.md.\n${observations.map(path=>`Independent measurement observation: ${path}.`).join('\n')}\nAll supplied provenance remains separate; no repeated observation grants a new allowance.\n`);
}
function deliverChildEvidence({directory,fixture,launchId,invocation}) {
  const run=join(fixture.directory,'.afk/runs/trial'),refs=[];
  for(const name of ['prompt.txt','stdout.jsonl','stderr.txt','result.json','launch.json']){const bytes=readFixtureFile(directory,join(directory,'artifacts',launchId,name)),path=`child-evidence/${name}`;put(join(run,path),bytes,{exclusive:true});refs.push({path,digest:digestBytes(bytes)});}
  put(join(run,'child-result.json'),{decision:invocation.decision,evidence:refs,terminal:{status:invocation.status,code:invocation.code,cleanup:invocation.cleanup},
    boundary:'A bounded planner return, not authority to implement or declare queue completion.'},{exclusive:true});
}

export function observedReferenceReads(invocations,support,expected) {
  const reads=[];
  for(const [invocationIndex,invocation]of invocations.entries())for(const [actionIndex,action]of (invocation.actions||[]).entries()){
    if(action.event!=='item.completed'||action.type!=='command_execution'||action.exitCode!==0||typeof action.output!=='string')continue;
    const match=/^cat (?:-- )?(?:'([^']+)'|"([^"$`]+)"|([^\s;&|<>]+))$/.exec(action.command||'');if(!match)continue;
    const selected=match[1]??match[2]??match[3];
    for(const row of expected){if(selected!==join(support,row.path))continue;
      const digest=digestBytes(action.output);if(digest===row.digest)reads.push({path:row.path,digest,complete:true,success:true,eventId:action.id,invocationIndex,actionIndex});}
  }
  return reads;
}
export function controlActionOrder(invocations,support,required=[]) {
  for(const [invocationIndex,invocation]of invocations.entries()){
    if(!invocation.eventsComplete)return {orderKnown:false,dependentAction:null};
    for(const [actionIndex,action]of (invocation.actions||[]).entries()){
      if(['agent_message','reasoning','todo_list'].includes(action.type))continue;
      if(action.type==='command_execution'&&required.some(row=>["cat '"+join(support,row.path)+"'",'cat "'+join(support,row.path)+'"','cat '+join(support,row.path)].includes(action.command)))continue;
      if(action.type==='command_execution'||action.type==='file_change')return {orderKnown:true,dependentAction:{invocationIndex,actionIndex}};
      return {orderKnown:false,dependentAction:null};
    }
  }
  return {orderKnown:true,dependentAction:null};
}
export function nativeControlObservation({directory,manifest,trial,fixture,support,codex,invocations}) {
  requireEvaluation(invocations.length===1,'single native control invocation required');const result=invocations[0],id=`${trial.id}-author-1`,reference=result.nativeObservation;
  evaluationRef(reference);requireEvaluation(reference.path===`artifacts/${id}/native-observation.json`,'native control source location');
  const bytes=readFixtureFile(directory,join(directory,reference.path));requireEvaluation(digestBytes(bytes)===reference.digest,'native control source changed');
  const observed=readObservedInvocation({directory,id,workspace:fixture.directory,support,model:trial.model,catalog:fixture.nativeCatalog,manifest,codex});
  requireEvaluation(observed.status==='observed'&&equal(observed,strictJson(bytes))&&result.nativeParentId===id&&result.sessionId,'native control source unqualified');
  const stdout=readFixtureFile(directory,join(directory,'artifacts',id,'stdout.raw'));
  requireEvaluation(stdout.equals(readFixtureFile(directory,join(directory,'artifacts',id,'stdout.jsonl'))),'native control event bytes changed');
  const parsed=parseDirectionHostEvents(decodeOriginalUtf8(stdout));
  requireEvaluation(parsed.eventsComplete&&parsed.sessionId===result.sessionId&&equal(parsed.actions,result.actions),'native control event projection changed');
  const read=ref=>{evaluationRef(ref);const value=readFixtureFile(directory,join(directory,ref.path),{maxBytes:manifest.handoff.observer.maxBytes});requireEvaluation(digestBytes(value)===ref.digest,'native control exchange changed');return value;};
  const exchanges=[],effects=[],sourceEvidence=[reference,{path:`artifacts/${id}/stdout.raw`,digest:digestBytes(stdout)}];let catalog;
  for(const row of observed.exchanges){
    requireEvaluation(row.forwarded&&row.released,'native control exchange not delivered');
    const terminal=strictJson(read(row.terminal));requireEvaluation(terminal.version===2,'native control transport metadata missing');
    const request=decodeNativeRequest(read(row.request),{maxBytes:manifest.handoff.observer.maxBytes}),response=decodeNativeResponse(read(row.response),{maxBytes:manifest.handoff.observer.maxBytes,responseMetadata:terminal.responseMetadata,transport:{upstream:NATIVE_RESPONSE_ROUTES[manifest.handoff.observer.authMode],status:terminal.status},requestedModel:trial.model});
    requireEvaluation(checkNativeRelease(response,request).allowed,'native control release unavailable');
    catalog=strictJson(read(row.catalog));sourceEvidence.push(row.request,row.response,row.catalog,row.terminal);
    exchanges.push({invocationId:id,sessionId:result.sessionId,ordinal:row.ordinal,request,response});
    for(const call of nativeResponseItems(response).filter(item=>['custom_tool_call','function_call'].includes(item.type)))effects.push({invocationId:id,sessionId:result.sessionId,callId:null,evidence:`${row.response.path}#${call.call_id}`,reason:'Native nested dependent-effect parentage is unavailable.'});
  }
  const bodies={},builtinRoot=join(directory,'artifacts',observed.session.ownerId,'native-state/skills/.system');
  for(const row of [...catalog.entries,...catalog.unadvertisedBodies]){const root=row.kind==='selected'?support:builtinRoot;const value=readFixtureFile(root,row.path);requireEvaluation(digestBytes(value)===row.sourceDigest,'native control catalog body changed');bodies[row.path]=value;}
  return {...observeNativeControl({trial,plan:fixture.control.sourcePlan,support,catalog,bodies,exchanges,effects,contextDelivery:fixture.control.contextDelivery}),nativeSourceQualified:true,sourceEvidence};
}

export function selectedControlSourcePlan(trial,support) {
  return controlSourcePlan({trial,sources:path=>existsSync(join(support,path))?readFixtureFile(support,join(support,path)):undefined});
}
export function requiredControlReferences(trial,support) { return selectedControlSourcePlan(trial,support).requiredReads; }

export function prepareControlFixture({trial,fixture,support,directory,sourcePlan=selectedControlSourcePlan(trial,support)}) {
  const condition=trial.condition;let promptSuffix='',contextDelivery=[];
  if(sourcePlan.status!=='supported')return {status:'unsupported',reason:sourcePlan.reason,condition,support,sourcePlan};
  if(trial.caseId==='L3'){
    const original=support;support=join(directory,'controlled-support');mkdirSync(support,{mode:0o700});
    const copy=(source,dest)=>{assertFixtureDirectory(original,source);for(const entry of readdirSync(source,{withFileTypes:true})){const from=join(source,entry.name),key=relative(original,from),to=join(dest,entry.name);if(key===sourcePlan.missingReference.path)continue;
      if(entry.isDirectory()){mkdirSync(to,{mode:0o700});copy(from,to);}else{requireEvaluation(entry.isFile(),'controlled support nonregular');put(to,readFixtureFile(original,from),{exclusive:true});chmodSync(to,0o444);}}};copy(original,support);
    support=realpathSync(support);
  }
  const requiredReads=sourcePlan.requiredReads;
  if(trial.caseId==='L1'){const path=requiredReads.find(row=>row.path.endsWith('/environment.md')).path,bytes=readFixtureFile(support,join(support,path));
    promptSuffix=`\nCurrent selected-revision reference bytes delivered in this context (${path}):\n${decodeOriginalUtf8(bytes)}\n`;
    contextDelivery=[{path,digest:digestBytes(bytes),complete:true,success:true,source:'actual-invocation-prompt',invocationIndex:0,actionIndex:-1}];}
  if(trial.caseId==='L2')put(join(fixture.directory,'.afk/runs/trial/saved-summary.md'),'Controlled stale summary claim: environment instructions were read from an older installed revision. No current-revision delivery evidence is retained.\n',{exclusive:true});
  if(trial.caseId==='L4')promptSuffix='\nThis is a standalone plan-only stage. Save the complete plan at docs/plan.md; preserve product files and do not allocate a run.\n';
  if(trial.caseId==='L5')promptSuffix='\nThe fixture driver explicitly enabled direction state from the retained request and policy sources in the active run. Inspect those current records through the selected production interface.\n';
  if(trial.caseId==='L6'){
    put(join(fixture.directory,'docs/plan.md'),'# Supplied inventory plan\n\nImplement TASK R1 and preserve A1 through A6. Reject fractional, negative and excessive requests; retain the original stock on rejection. Validate all six acceptance rows with node --test.\n',{exclusive:true});
    promptSuffix='\nThis is the external design phase for docs/plan.md. The bounded local endpoint is the selected Codex gate with --design docs/plan.md --print-prompt. No provider call or completed external review is authorized.\n';
  }
  if(trial.caseId==='L7'){fixture.controlledReceipt=prepareProductEvidence({fixture:{...fixture,scenarioId:'S7'},pluginRoot:support});fixture.current=fixtureGit(fixture.directory,['rev-parse','HEAD']);
    promptSuffix=`\nThe local endpoint is checking the retained candidate ${fixture.controlledReceipt.candidate} against the original receipt ${fixture.controlledReceipt.priorReceipt} using the selected receipt checker. Preserve those sources and the target; no new review is authorized.\n`;}
  return {status:'supported',condition,support,sourcePlan,requiredReads,promptSuffix,contextDelivery,receipt:fixture.controlledReceipt??null,provenance:trial.caseId==='L3'?'deliberate-missing-reference':'original-selected-support'};
}

function finishMeasurementTerminal(measurement,auditId) {
  for(let attempt=0;attempt<2;attempt++){
    const request=productOperation({...measurement,operation:'terminal',auditId,operationId:`terminal-${auditId}`});
    const recorded=productOperation({...measurement,operation:'append',request});
    if(['published','already_recorded'].includes(recorded.status))return request;
    requireEvaluation(attempt===0&&recorded.status==='refused'&&recorded.reasons.includes('stale_head'),`terminal publication ${recorded.status}: ${recorded.reasons.join(',')}`);
  }
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((error)=>{
  process.stderr.write(`Evaluation stopped: ${error.message}\n`);process.exitCode=1;
});
