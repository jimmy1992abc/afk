import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import https from 'node:https';
import { canonicalBytes, digestBytes } from '../gate/review-receipt.mjs';
import { decodeNativeRequest, decodeNativeResponse, nativeDeclarationDigest } from './native-wire.mjs';
import { witnessResponse, nativeWitnessSourcePaths } from './native-witness.mjs';
import { campaignUsage, reserveObservedRequest, observedPhysicalUsage, strictEvaluationJson, validateObserver, observerProfileReferences, prepareObservedSession } from './observed-execution.mjs';
import { provisionNativeCatalog } from './native-host.mjs';
import { EVALUATOR_RUNTIME_FILES } from './runtime.mjs';

const model='gpt-6-astra',handoffDigest='a'.repeat(64);
const observer={version:1,profile:{path:'native/profile.json',digest:'b'.repeat(64)},authMode:'chatgpt',maxRequests:4,maxRequestsPerInvocation:2,maxBytes:1048576,requestTimeoutMs:10000};
function fixture(t){
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'afk-physical-')));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const put=(path,value)=>{mkdirSync(join(directory,path,'..'),{recursive:true});writeFileSync(join(directory,path),Buffer.isBuffer(value)?value:JSON.stringify(value));};
  const start=id=>put(`launches/${id}.started.json`,{version:2,id,kind:'author',ordinal:readdirSync(join(directory,'launches')).length+1,startedAt:new Date().toISOString(),executionHandoffDigest:handoffDigest});
  mkdirSync(join(directory,'launches'));start('parent');
  const request=(ordinal=1)=>{const raw=Buffer.from(JSON.stringify({model,input:[],tools:[]}));put(`artifacts/parent/collector/${String(ordinal).padStart(6,'0')}-request.json`,raw);
    put(`artifacts/parent/collector/${String(ordinal).padStart(6,'0')}-started.json`,{version:1,ordinal,startedAt:Date.now()});return {ordinal,model,requestDigest:digestBytes(raw),startedAt:Date.now()};};
  const options={directory,parentId:'parent',executionHandoffDigest:handoffDigest,model,observer,spend:{plannedMaxMicrousd:100000,inputTokens:100,outputTokens:100},deadline:Date.now()+60000};
  const finish=(reservation,{ordinal=1,forwarded=true,dispatch=true,terminal=true}={})=>{
    const local=String(ordinal).padStart(6,'0'),requestDigest=digestBytes(readFileSync(join(directory,`artifacts/parent/collector/${local}-request.json`)));
  put('artifacts/parent/collector/configuration.json',{version:1,authMode:'chatgpt',upstream:'https://chatgpt.com/backend-api/codex/responses'});
    if(dispatch)put(`artifacts/parent/collector/${local}-dispatch.json`,{reservationId:reservation.id,requestDigest,at:Date.now()});
    const response=witnessResponse({ordinal:2,model,script:''}),observation=forwarded?decodeNativeResponse(response,{maxBytes:observer.maxBytes,contentType:'text/event-stream',requestedModel:model}):null;
    if(forwarded)put(`artifacts/parent/collector/${local}-response.body`,response);
    if(terminal)put(`artifacts/parent/collector/${local}-terminal.json`,{version:2,ordinal,forwarded,status:forwarded?200:null,responseMetadata:forwarded?{contentType:'text/event-stream',contentEncoding:null}:null,reason:forwarded?null:'collector-deadline',requestDigest,responseDigest:forwarded?digestBytes(response):null,
      inputBytes:readFileSync(join(directory,`artifacts/parent/collector/${local}-request.json`)).length,outputBytes:forwarded?response.length:0,inputIncomplete:false,outputIncomplete:!forwarded,observation,release:null,finishedAt:Date.now()});
  };
  return {directory,put,start,request,options,finish};
}

test('optional observer requires explicit finite bounds and a safe immutable profile reference',()=>{
  assert.deepEqual(validateObserver(observer),observer);
  for(const change of [{maxRequests:0},{maxRequestsPerInvocation:5},{maxBytes:8388609},{requestTimeoutMs:Infinity},{profile:{path:'../profile',digest:'b'.repeat(64)}},{authMode:'proxy'},{extra:true}])assert.throws(()=>validateObserver({...observer,...change}));
});
test('strict evaluation JSON rejects duplicate decoded keys and excessive nesting',()=>{
  assert.throws(()=>strictEvaluationJson('{"x":1,"\\u0078":2}'),/duplicate/);
  assert.throws(()=>strictEvaluationJson('['.repeat(129)+'0'+']'.repeat(129)),/depth/);
  assert.deepEqual(strictEvaluationJson('{"x":[1]}'),{x:[1]});
});
test('profile sources bind exactly the selected model set and every native witness source',()=>{
  const row={model,files:Object.fromEntries(nativeWitnessSourcePaths().map(path=>[path,{path:'proof/'+path,digest:'c'.repeat(64)}]))},profile={version:1,models:[row]};
  assert.equal(observerProfileReferences(profile,[model]).length,nativeWitnessSourcePaths().length);
  assert.throws(()=>observerProfileReferences(profile,[model,'gpt-5.6-sol']),/models/);
  assert.throws(()=>observerProfileReferences({version:1,models:[row,row]},[model]),/models/);
  const missing=structuredClone(profile);delete missing.models[0].files['response-4.sse'];
  assert.throws(()=>observerProfileReferences(missing,[model]),/source set/);
  const unsafe=structuredClone(profile);unsafe.models[0].files['response-4.sse'].path='../escaped';
  assert.throws(()=>observerProfileReferences(unsafe,[model]),/reference/);
});
test('reservation skips only its unfinished parent and uses completed audit usage once',t=>{
  const f=fixture(t);f.start('audit');
  f.put('artifacts/audit/result.json',{cleanup:true,usage:{input:7,output:3}});
  assert.deepEqual(campaignUsage(f.directory,{skipParent:'parent'}),{input:7,output:3,unknown:0});
  const first=reserveObservedRequest({...f.options,request:f.request()});f.finish(first);
  const second=reserveObservedRequest({...f.options,request:f.request(2)});f.finish(second,{ordinal:2});
  assert.notEqual(first.id,second.id);
  const usage=observedPhysicalUsage(f.options);
  assert.equal(usage.requests,2);assert.deepEqual(usage.parents.parent.usage,{input_tokens:2,output_tokens:2,cached_input_tokens:null});
  f.put('artifacts/parent/result.json',{cleanup:true,usage:usage.parents.parent.usage});
  assert.deepEqual(campaignUsage(f.directory),{input:9,output:5,unknown:0});
});
test('an unknown completed launch stops the next launch unless the campaign retains unknown usage',t=>{
  const f=fixture(t);f.start('audit');f.start('aborted');
  f.put('artifacts/audit/result.json',{cleanup:true,usage:{input:7,output:3}});
  f.put('artifacts/aborted/result.json',{cleanup:true,usage:{}});
  assert.throws(()=>campaignUsage(f.directory,{skipParent:'parent'}),/unknown usage/);
  assert.deepEqual(campaignUsage(f.directory,{skipParent:'parent',unknownUsage:'retain-and-continue'}),{input:7,output:3,unknown:1});
});
test('an unchanged unsuccessful stream is unknown usage under the retain policy and altered evidence is still refused',t=>{
  const f=fixture(t),first=reserveObservedRequest({...f.options,request:f.request()});f.finish(first);
  const body=Buffer.from('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","object":"response","status":"in_progress","model":"'+model+'","output":[]}}\n\nevent: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_1","object":"response","status":"failed","model":"'+model+'","output":[]}}\n\n');
  const observation=decodeNativeResponse(body,{maxBytes:observer.maxBytes,contentType:'text/event-stream',requestedModel:model});
  assert.equal(observation.status,'unavailable');
  const path='artifacts/parent/collector/000001-terminal.json',record=JSON.parse(readFileSync(join(f.directory,path)));
  f.put('artifacts/parent/collector/000001-response.body',body);
  f.put(path,{...record,outputBytes:body.length,responseDigest:digestBytes(body),observation});
  assert.throws(()=>observedPhysicalUsage(f.options),/usage unknown/);
  const usage=observedPhysicalUsage({...f.options,unknownUsage:'retain-and-continue'});
  assert.deepEqual(usage.parents.parent.usage,{input_tokens:null,output_tokens:null,cached_input_tokens:null});assert.equal(usage.unknownParents,1);
  f.put(path,{...record,outputBytes:body.length,responseDigest:digestBytes(body),observation:{...observation,reason:'tampered'}});
  assert.throws(()=>observedPhysicalUsage({...f.options,unknownUsage:'retain-and-continue'}),/observation changed/);
});
test('an upstream-aborted exchange stays unknown usage and only the retain policy keeps the campaign going',t=>{
  const f=fixture(t),first=reserveObservedRequest({...f.options,request:f.request()});f.finish(first);
  const path='artifacts/parent/collector/000001-terminal.json',record=JSON.parse(readFileSync(join(f.directory,path)));
  f.put(path,{...record,outputIncomplete:true});
  assert.throws(()=>observedPhysicalUsage(f.options),/usage unknown/);
  const retained={...f.options,unknownUsage:'retain-and-continue'},usage=observedPhysicalUsage(retained);
  assert.deepEqual(usage.parents.parent.usage,{input_tokens:null,output_tokens:null,cached_input_tokens:null});
  assert.equal(usage.unknownParents,1);
  f.put('artifacts/parent/result.json',{cleanup:true,usage:{}});
  assert.equal(observedPhysicalUsage(retained).unknownParents,1);
  f.put('artifacts/parent/result.json',{cleanup:true,usage:{input_tokens:0,output_tokens:0}});
  assert.throws(()=>observedPhysicalUsage(retained),/parent usage/);
});
test('a reservation cannot replay its collector ordinal or reset global/per-parent accounting',t=>{
  const f=fixture(t),request=f.request(),first=reserveObservedRequest({...f.options,request});f.finish(first);
  assert.throws(()=>reserveObservedRequest({...f.options,request}),/already reserved/);
  assert.throws(()=>reserveObservedRequest({...f.options,observer:{...observer,maxRequests:1,maxRequestsPerInvocation:1},request:f.request(2)}),/request allowance/);
  assert.throws(()=>reserveObservedRequest({...f.options,observer:{...observer,maxRequestsPerInvocation:1},request:f.request(2)}),/request allowance/);
  assert.equal(readdirSync(join(f.directory,'physical')).length,1);
});
test('missing dispatch alone is unknown; a complete no-forward terminal proves zero while retaining the reservation',t=>{
  const f=fixture(t),first=reserveObservedRequest({...f.options,request:f.request()});
  assert.throws(()=>observedPhysicalUsage(f.options),/terminal/);
  f.finish(first,{forwarded:false,dispatch:false});
  const usage=observedPhysicalUsage(f.options);
  assert.equal(usage.requests,1);assert.equal(usage.parents.parent.usage.input_tokens,0);
  assert.doesNotThrow(()=>reserveObservedRequest({...f.options,request:f.request(2)}));
});
test('a conflicting reservation, missing response or tampered usage cannot authorize another dispatch',t=>{
  const f=fixture(t),first=reserveObservedRequest({...f.options,request:f.request()});f.finish(first);
  const path='artifacts/parent/collector/000001-terminal.json',original=JSON.parse(readFileSync(join(f.directory,path)));
  f.put(path,{...original,observation:{...original.observation,usage:{input_tokens:0,output_tokens:0,cached_input_tokens:null}}});
  assert.throws(()=>reserveObservedRequest({...f.options,request:f.request(2)}),/response observation/);
  f.put(path,original);f.put('artifacts/parent/collector/000001-dispatch.json',{reservationId:'wrong',requestDigest:original.requestDigest,at:Date.now()});
  assert.throws(()=>observedPhysicalUsage(f.options),/dispatch binding/);
  f.finish(first);rmSync(join(f.directory,'artifacts/parent/collector/000001-response.body'));
  assert.throws(()=>observedPhysicalUsage(f.options),/response/);
});

test('fractional response replay retains media metadata and rejects absent or changed transport evidence',t=>{
  const f=fixture(t),first=reserveObservedRequest({...f.options,request:f.request()});f.finish(first);
  const path='artifacts/parent/collector/000001-terminal.json',original=JSON.parse(readFileSync(join(f.directory,path)));
  assert.equal(original.observation.response.top_p,0.98);
  assert.equal(observedPhysicalUsage(f.options).parents.parent.usage.input_tokens,1);
  f.put(path,{...original,responseMetadata:{contentType:'application/json',contentEncoding:null}});
  assert.throws(()=>observedPhysicalUsage(f.options),/response observation/);
  f.put(path,{...original,responseMetadata:null});assert.throws(()=>observedPhysicalUsage(f.options),/response observation/);
  const missing={...original};delete missing.responseMetadata;f.put(path,missing);assert.throws(()=>observedPhysicalUsage(f.options));
  f.put(path,{...original,version:1});assert.throws(()=>observedPhysicalUsage(f.options),/terminal binding/);
});
test('completed parent summaries must match physical usage and are never counted twice',t=>{
  const f=fixture(t),first=reserveObservedRequest({...f.options,request:f.request()});f.finish(first);
  f.put('artifacts/parent/result.json',{cleanup:true,usage:{input_tokens:2,output_tokens:1}});
  assert.throws(()=>observedPhysicalUsage(f.options),/parent usage/);
  f.put('artifacts/parent/result.json',{cleanup:true,usage:{input_tokens:1,output_tokens:1,cached_input_tokens:null}});
  assert.equal(observedPhysicalUsage(f.options).requests,1);
});
test('unknown prior launch usage, wrong model, changed authority or exhausted tokens refuse before reservation',t=>{
  const f=fixture(t),request=f.request();f.start('earlier');
  assert.throws(()=>reserveObservedRequest({...f.options,request}),/unfinished launch/);
  f.put('artifacts/earlier/result.json',{cleanup:true,usage:{}});
  assert.throws(()=>reserveObservedRequest({...f.options,request}),/unknown usage/);
  f.put('artifacts/earlier/result.json',{cleanup:true,usage:{input:100,output:1}});
  assert.throws(()=>reserveObservedRequest({...f.options,request}),/ceiling/);
  f.put('artifacts/earlier/result.json',{cleanup:true,usage:{input:0,output:0}});
  assert.throws(()=>reserveObservedRequest({...f.options,request:{...request,model:'gpt-5.6-sol'}}),/model/);
  assert.throws(()=>reserveObservedRequest({...f.options,executionHandoffDigest:'c'.repeat(64),request}),/authority/);
  assert.throws(()=>reserveObservedRequest({...f.options,deadline:Date.now()-1,request}),/deadline/);
});
test('observed session uses protected evaluator-owned state and resumes only the exact completed original session',t=>{
  const f=fixture(t),workspace=join(f.directory,'workspace'),support=join(f.directory,'support');
  mkdirSync(workspace);mkdirSync(join(support,'skills/afk'),{recursive:true});writeFileSync(join(support,'skills/afk/SKILL.md'),'Synthetic selected support.\n');
  const catalog=provisionNativeCatalog({workspace,support}),options={directory:f.directory,id:'parent',workspace,support,model,catalog,profileDigest:'b'.repeat(64),identityDigest:'d'.repeat(64)};
  const first=prepareObservedSession(options);assert.equal(first.record.ownerId,'parent');
  assert.equal(first.stateRoot.startsWith(workspace+'/'),false);assert.equal(first.probe.startsWith(workspace+'/'),false);
  assert.deepEqual(prepareObservedSession(options),first);
  const resumed={...options,id:'resume',resume:'exact-session',priorId:'parent'};
  assert.throws(()=>prepareObservedSession(resumed));
  f.put('artifacts/parent/result.json',{status:'completed',cleanup:true,eventsComplete:true,sessionId:'exact-session',observedModel:model});
  const next=prepareObservedSession(resumed);assert.equal(next.stateRoot,first.stateRoot);assert.equal(next.record.resumedFrom,'exact-session');
  assert.throws(()=>prepareObservedSession({...resumed,id:'wrong',resume:'wrong-session'}),/resume/);
  assert.throws(()=>prepareObservedSession({...resumed,id:'changed',identityDigest:'e'.repeat(64)}),/identity/);
  writeFileSync(first.probe,'console.log("changed");');
  assert.throws(()=>prepareObservedSession(options),/protected/);
});
for(const refusal of ['wrong-model','changed-catalog'])test(`source-isolated collector integration keeps prior usage and refuses ${refusal} before another physical dispatch`,async t=>{
  const f=fixture(t),workspace=join(f.directory,'workspace'),support=join(f.directory,'support');mkdirSync(workspace);
  mkdirSync(join(support,'skills/afk'),{recursive:true});writeFileSync(join(support,'skills/afk/SKILL.md'),'Synthetic selected support.\n');
  const catalog=provisionNativeCatalog({workspace,support}),stateRoot=join(f.directory,'artifacts/parent/native-state'),builtin='Synthetic hidden builtin.\n';
  const body={model,tools:[{type:'namespace',name:'functions',tools:[{type:'custom',name:'exec',format:{type:'text'}}]}],input:[{role:'developer',content:`<skills_instructions>\n### Skill roots\n- \`r0\` = \`${join(workspace,'.agents/skills')}\`\n- \`r1\` = \`${join(stateRoot,'skills/.system')}\`\n### Available skills\n- afk: Synthetic selected skill. (file: r0/afk/SKILL.md)\n</skills_instructions>`},{role:'user',content:'Synthetic source-isolated collector test; no native host qualification.'}]};
  const declarationDigest=nativeDeclarationDigest(decodeNativeRequest(Buffer.from(JSON.stringify(body)),{maxBytes:observer.maxBytes}));
  const profile={version:1,digest:observer.profile.digest,identity:{digest:'d'.repeat(64)},models:[{model,declarationDigest,builtinSources:{'review-agent/SKILL.md':digestBytes(builtin)}}]};
  const source=join(f.directory,'source'),repository=fileURLToPath(new URL('../..',import.meta.url));
  for(const path of EVALUATOR_RUNTIME_FILES){mkdirSync(dirname(join(source,path)),{recursive:true});writeFileSync(join(source,path),readFileSync(join(repository,path)));}
  const modulePath=join(source,'lib/evaluation/observed-execution.mjs'),text=readFileSync(modulePath,'utf8'),start=text.indexOf('export function campaignObserverProfile('),end=text.indexOf('export function prepareObservedSession(',start);
  assert.ok(start>0&&end>start);writeFileSync(modulePath,text.slice(0,start)+`export function campaignObserverProfile(){return ${JSON.stringify(profile)};}\n`+text.slice(end));
  const hostPath=join(source,'lib/evaluation/native-host.mjs'),host=readFileSync(hostPath,'utf8'),a=host.indexOf('export function nativeHostIdentity('),b=host.indexOf('function requireCatalog(',a);
  assert.ok(a>0&&b>a);writeFileSync(hostPath,host.slice(0,a)+`export function nativeHostIdentity(){return {digest:${JSON.stringify(profile.identity.digest)}};}\n`+host.slice(b));
  const api=await import(pathToFileURL(modulePath));
  assert.equal(typeof api.openObservedCollector,'function');
  const handoff={observer,models:[{model}],authorization:{status:'authorized'},bounds:{spend:f.options.spend}},manifest={handoff,executionHandoffDigest:digestBytes(canonicalBytes(handoff))};
  f.put('launches/parent.started.json',{version:2,id:'parent',kind:'author',startedAt:new Date().toISOString(),ordinal:1,executionHandoffDigest:manifest.executionHandoffDigest});
  const calls=[];t.mock.method(https,'request',(url,options,callback)=>{
    const request=new EventEmitter();request.destroy=()=>{};request.end=bytes=>{calls.push({url:String(url),options,bytes});queueMicrotask(()=>{const response=new PassThrough();response.statusCode=200;response.headers={'content-type':'text/event-stream'};callback(response);response.end(witnessResponse({ordinal:2,model,script:''}));});};return request;
  });
  const opened=await api.openObservedCollector({directory:f.directory,id:'parent',workspace,support,model,catalog,manifest,codex:'source-isolated-test-only',deadline:Date.now()+5000,env:{AFK_OBSERVED_UPSTREAM_BEARER:'synthetic-parent-secret'}});
  t.after(()=>opened.finish());mkdirSync(join(stateRoot,'skills/.system/review-agent'),{recursive:true});writeFileSync(join(stateRoot,'skills/.system/review-agent/SKILL.md'),builtin);
  for(const readable of opened.observer.readRoots)assert.equal(readable.startsWith(opened.environment.TMPDIR+'/'),false,'denied native temporary root must not contain a readable source');
  assert.equal(opened.environment.TMPDIR.startsWith(workspace+'/'),false);
  assert.notEqual(opened.environment.AFK_OBSERVED_LOCAL_TOKEN,'synthetic-parent-secret');assert.equal(opened.environment.AFK_OBSERVED_UPSTREAM_BEARER,undefined);
  const send=value=>new Promise((resolve,reject)=>{const request=http.request(opened.observer.url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+opened.environment.AFK_OBSERVED_LOCAL_TOKEN}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});request.on('error',reject);request.end(JSON.stringify(value));});
  assert.equal(await send(body),200);assert.equal(calls.length,1);
  if(refusal==='changed-catalog')writeFileSync(join(stateRoot,'skills/.system/review-agent/SKILL.md'),'changed source');
  assert.notEqual(await send(refusal==='wrong-model'?{...body,model:'gpt-5.6-sol'}:body),200);
  assert.equal(calls.length,1);assert.equal(readdirSync(join(f.directory,'physical')).length,1);
  const result=await opened.finish();assert.equal(result.status,'unavailable');assert.equal(result.usage.input_tokens,1);assert.equal(result.forwardedRequests,1);
  const retained=JSON.parse(readFileSync(join(f.directory,'artifacts/parent/collector/000001-terminal.json')));
  assert.deepEqual(retained.observation.events.filter(event=>event.type==='keepalive'),[{type:'keepalive',sequence_number:2}]);
  assert.equal(retained.release.allowed,true);
  assert.equal(readFileSync(join(f.directory,'artifacts/parent/native-observation.json'),'utf8').includes('synthetic-parent-secret'),false);
});

test('missing-media replay binds interpretation and fixed transport while preserving denied usage',t=>{
  const f=fixture(t),first=reserveObservedRequest({...f.options,request:f.request()});f.finish(first);
  const path='artifacts/parent/collector/000001-terminal.json',record=JSON.parse(readFileSync(join(f.directory,path)));
  const bytes=readFileSync(join(f.directory,'artifacts/parent/collector/000001-response.body'));
  record.responseMetadata={contentType:null,contentEncoding:null};
  record.observation=decodeNativeResponse(bytes,{maxBytes:observer.maxBytes,requestedModel:model,responseMetadata:record.responseMetadata,transport:{upstream:'https://chatgpt.com/backend-api/codex/responses',status:200}});
  record.release={allowed:false,reason:'synthetic policy denial'};record.reason='response-policy-denied';f.put(path,record);
  assert.equal(observedPhysicalUsage(f.options).parents.parent.usage.input_tokens,1);
  f.put(path,{...record,observation:{...record.observation,interpretation:'declared-sse'}});
  assert.throws(()=>observedPhysicalUsage(f.options),/response observation/);f.put(path,record);
  f.put('artifacts/parent/collector/configuration.json',{version:1,authMode:'chatgpt',upstream:'https://example.invalid/responses'});
  assert.throws(()=>observedPhysicalUsage(f.options),/transport configuration/);
});


test('uncapped observed requests retain every exchange and explicit zero still refuses', t => {
  const f = fixture(t);
  const options = { ...f.options, observer: { ...observer, maxRequests: null, maxRequestsPerInvocation: null },
    spend: { plannedMaxMicrousd: null, inputTokens: null, outputTokens: null } };
  validateObserver(options.observer);
  for (let ordinal = 1; ordinal <= 5; ordinal++) {
    const reserved = reserveObservedRequest({ ...options, request: f.request(ordinal) });
    f.finish(reserved, { ordinal });
  }
  const usage = observedPhysicalUsage(options);
  assert.equal(usage.requests, 5);
  assert.equal(usage.parents.parent.requests, 5);
  assert.equal(usage.parents.parent.usage.input_tokens, 5);
  assert.throws(() => reserveObservedRequest({ ...options, spend: { ...options.spend, inputTokens: 0 }, request: f.request(6) }), /ceiling exhausted/);
  assert.equal(readdirSync(join(f.directory, 'physical')).length, 5);
});
