import { isDeepStrictEqual } from 'node:util';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shape, equal } from '../direction/schema.mjs';
import { canonicalBytes, digestBytes } from '../gate/review-receipt.mjs';
import { assertFixtureDirectory, readFixtureFile, LIMITS } from './scenarios.mjs';
import { checkNativeRelease, decodeNativeRequest, decodeNativeResponse, nativeDeclarationDigest, NATIVE_RESPONSE_ROUTES, NATIVE_RECORD_LIMIT } from './native-wire.mjs';
import { nativeHostIdentity, observeNativeCatalog, verifyNativeCatalog } from './native-host.mjs';
import { nativeWitnessSourcePaths, validateNativeWitnessSources, nativeBoundarySource, nativeBoundaryCommand } from './native-witness.mjs';
import { createNativeRecorder } from './native-recorder.mjs';
import { observedHostEnvironment, prepareNativeTempRoot } from './host.mjs';
import { strictEvaluationJson } from './strict-json.mjs';
export { strictEvaluationJson } from './strict-json.mjs';

const count=value=>Number.isSafeInteger(value)&&value>=0;
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const parentId=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
const requireObserved=(value,reason)=>{if(!value)throw new Error(`issue112 ${reason}`);};
const ordinalName=ordinal=>String(ordinal).padStart(6,'0');
const read=(directory,path)=>strictEvaluationJson(readFixtureFile(directory,join(directory,path)));
function add(a,b){const result=a+b;requireObserved(count(result),'usage sum overflow');return result;}
// Single definition of when a finished launch reports countable consumption; gating and reporting must
// agree on what "unknown" means, so both read this instead of restating the field aliases.
export function countableLaunchUsage(usage){
  const tokens=usage||{},input=tokens.input_tokens??tokens.input,output=tokens.output_tokens??tokens.output;
  return count(input)&&count(output)?{input,output}:null;
}

export function validateObserver(observer){
  shape(observer,['version','profile','authMode','maxRequests','maxRequestsPerInvocation','maxBytes','requestTimeoutMs']);
  observerReference(observer.profile);
  requireObserved(observer.version===1&&['chatgpt','api-key'].includes(observer.authMode),'observer identity');
  for(const key of ['maxRequests','maxRequestsPerInvocation'])requireObserved(observer[key]===null||count(observer[key])&&observer[key]>0,'observer positive bound');
  for(const key of ['maxBytes','requestTimeoutMs'])requireObserved(count(observer[key])&&observer[key]>0,'observer positive bound');
  requireObserved((observer.maxRequests===null||observer.maxRequests<=NATIVE_RECORD_LIMIT)&&(observer.maxRequestsPerInvocation===null||observer.maxRequests===null||observer.maxRequestsPerInvocation<=observer.maxRequests)&&observer.maxBytes<=LIMITS.outputBytes,'observer upper bound');
  return observer;
}
function observerReference(ref){
  shape(ref,['path','digest']);const path=ref.path;
  requireObserved(typeof path==='string'&&path.length>0&&!isAbsolute(path)&&!/[\\:\0]/.test(path)
    &&path.split('/').every(part=>part&&part!=='.'&&part!=='..')&&digest(ref.digest),'observer profile reference');
}
export function observerProfileReferences(profile,models){
  shape(profile,['version','models']);
  requireObserved(profile.version===1&&Array.isArray(profile.models)&&Array.isArray(models)&&models.length>0&&models.length<=2
    &&new Set(models).size===models.length&&profile.models.length===models.length,'observer profile models');
  const seen=new Set(),refs=[];
  for(const row of profile.models){
    shape(row,['model','files']);requireObserved(models.includes(row.model)&&!seen.has(row.model),'observer profile models');seen.add(row.model);
    requireObserved(row.files&&typeof row.files==='object'&&!Array.isArray(row.files)
      &&equal(Object.keys(row.files).sort(),nativeWitnessSourcePaths().sort()),'observer profile source set');
    for(const ref of Object.values(row.files)){observerReference(ref);refs.push(ref);}
  }
  return refs;
}
export function loadObserverProfile({observer,models,readRef,codex}){
  validateObserver(observer);requireObserved(typeof readRef==='function','observer source reader');
  const source=ref=>{observerReference(ref);const bytes=readRef(ref);requireObserved((typeof bytes==='string'||Buffer.isBuffer(bytes))
    &&digestBytes(bytes)===ref.digest,'observer source digest changed');return bytes;};
  const profile=strictEvaluationJson(source(observer.profile));observerProfileReferences(profile,models);
  const files=profile.models.map(row=>({model:row.model,files:Object.fromEntries(Object.entries(row.files).map(([path,ref])=>[path,source(ref)]))}));
  const identity=nativeHostIdentity(codex);
  return {version:1,digest:observer.profile.digest,identity,models:files.map(row=>({...validateNativeWitnessSources({...row,identity}),
    builtinSources:Object.fromEntries(Object.entries(row.files).filter(([path])=>path.startsWith('native-state/skills/.system/')).map(([path,bytes])=>[path.slice('native-state/skills/.system/'.length),digestBytes(bytes)]))}))};
}
export function campaignObserverProfile({directory,manifest,codex}){
  requireObserved(digestBytes(canonicalBytes(manifest.handoff))===manifest.executionHandoffDigest,'observer handoff authority');
  return loadObserverProfile({observer:manifest.handoff.observer,models:manifest.handoff.models.map(row=>row.model),codex,
    readRef:ref=>readFixtureFile(directory,join(directory,'sources',ref.path))});
}
export function prepareObservedSession({directory,id,workspace,support,model,catalog,profileDigest,identityDigest,resume,priorId}){
  assertFixtureDirectory(directory);assertFixtureDirectory(workspace);assertFixtureDirectory(support);
  requireObserved(parentId(id)&&digest(profileDigest)&&digest(identityDigest)&&['gpt-6-astra','gpt-5.6-sol'].includes(model),'native session identity');
  requireObserved(catalog.workspace===workspace&&catalog.support===support,'native session catalog identity');verifyNativeCatalog(catalog);
  let ownerId=id;
  if(resume!==undefined){
    requireObserved(typeof resume==='string'&&resume.length>0&&parentId(priorId)&&priorId!==id,'native exact resume identity');
    const prior=read(directory,`artifacts/${priorId}/native-session.json`),result=read(directory,`artifacts/${priorId}/result.json`);
    requireObserved(prior.id===priorId&&parentId(prior.ownerId)&&prior.workspace===workspace&&prior.support===support&&prior.model===model
      &&prior.catalogDigest===catalog.digest&&prior.profileDigest===profileDigest&&prior.identityDigest===identityDigest,'native resume source identity');
    requireObserved(result.status==='completed'&&result.cleanup===true&&result.eventsComplete===true&&result.sessionId===resume&&result.observedModel===model,'native exact resume terminal');
    ownerId=prior.ownerId;
  }else requireObserved(priorId===undefined,'native prior without resume');
  const root=join(directory,'artifacts',id),ownerRoot=join(directory,'artifacts',ownerId),stateRoot=join(ownerRoot,'native-state'),protectedRoot=join(ownerRoot,'protected'),probe=join(protectedRoot,'boundary.mjs');
  const outside=relative(workspace,ownerRoot);requireObserved(outside==='..'||outside.startsWith('../')||isAbsolute(outside),'native state inside writable workspace');
  const record={version:1,id,ownerId,workspace,support,model,catalogDigest:catalog.digest,profileDigest,identityDigest,resumedFrom:resume??null,priorId:priorId??null};
  const probeBytes=nativeBoundarySource({outside:join(ownerRoot,'outside.txt'),scorer:fileURLToPath(new URL('./scenarios.mjs',import.meta.url)),
    evaluator:fileURLToPath(new URL('../../scripts/evaluate-agent-behavior.mjs',import.meta.url)),support,skill:'afk'});
  const put=(path,bytes)=>writeFileSync(path,typeof bytes==='string'?bytes:canonicalBytes(bytes),{flag:'wx',mode:0o600});
  const existing=existsSync(join(root,'native-session.json'));
  if(existing)requireObserved(equal(read(directory,`artifacts/${id}/native-session.json`),record),'native session record changed');
  else {
    mkdirSync(root,{recursive:true,mode:0o700});assertFixtureDirectory(directory,root);
    if(ownerId===id){mkdirSync(stateRoot,{mode:0o700});mkdirSync(protectedRoot,{mode:0o700});put(probe,probeBytes);put(join(ownerRoot,'outside.txt'),'owned boundary sentinel\n');}
    put(join(root,'native-session.json'),record);
  }
  assertFixtureDirectory(directory,stateRoot);assertFixtureDirectory(directory,protectedRoot);
  requireObserved(readFixtureFile(directory,probe).toString('utf8')===probeBytes
    &&readFixtureFile(directory,join(ownerRoot,'outside.txt')).toString('utf8')==='owned boundary sentinel\n','native protected source changed');
  return {record,stateRoot,protectedRoot,probe,command:nativeBoundaryCommand(probe)};
}
function catalogProfile(observed,profile){
  const sources=Object.fromEntries([...observed.entries.filter(row=>row.kind==='builtin'),...observed.unadvertisedBodies].map(row=>{
    const marker='/skills/.system/',index=row.path.lastIndexOf(marker);requireObserved(index>=0,'native builtin source identity');
    return [row.path.slice(index+marker.length),row.sourceDigest];
  }));
  requireObserved(equal(sources,profile.builtinSources),'native builtin source changed');
}
export async function openObservedCollector({directory,id,workspace,support,model,catalog,manifest,codex,deadline,resume,priorId,env=process.env}){
  requireObserved(manifest.handoff.authorization.status==='authorized','planned observer cannot execute');
  const observer=validateObserver(manifest.handoff.observer),profile=campaignObserverProfile({directory,manifest,codex});
  const selected=profile.models.find(row=>row.model===model);requireObserved(selected,'unselected observed model');
  parentAuthority(directory,id,manifest.executionHandoffDigest);
  const sessionOptions={directory,id,workspace,support,model,catalog,profileDigest:profile.digest,identityDigest:profile.identity.digest,resume,priorId};
  const session=prepareObservedSession(sessionOptions),root=join(directory,'artifacts',id),collectorRoot=join(root,'collector'),tempRoot=prepareNativeTempRoot(root);
  const put=(path,record)=>writeFileSync(path,canonicalBytes(record),{flag:'wx',mode:0o600});
  const recorder=await createNativeRecorder({directory:collectorRoot,authMode:observer.authMode,credential:{bearer:env.AFK_OBSERVED_UPSTREAM_BEARER,
    ...(env.AFK_OBSERVED_ACCOUNT_ID!==undefined?{accountId:env.AFK_OBSERVED_ACCOUNT_ID}:{})},declarationDigest:selected.declarationDigest,
    maxRequests:observer.maxRequestsPerInvocation,maxBytes:observer.maxBytes,concurrency:1,deadline,requestTimeoutMs:observer.requestTimeoutMs,
    reserve:async request=>{
      const prefix=join(collectorRoot,ordinalName(request.ordinal));
      try{
        requireObserved(request.model===model,'observed request model changed');
        requireObserved(nativeHostIdentity(codex).digest===profile.identity.digest,'observed host/runtime source changed');
        prepareObservedSession(sessionOptions);
        const decoded=decodeNativeRequest(readFixtureFile(directory,`${prefix}-request.json`,{maxBytes:observer.maxBytes}),{maxBytes:observer.maxBytes});
        const observed=observeNativeCatalog({request:decoded,catalog,stateRoot:session.stateRoot});catalogProfile(observed,selected);
        put(`${prefix}-catalog.json`,observed);
        return reserveObservedRequest({directory,parentId:id,executionHandoffDigest:manifest.executionHandoffDigest,model,observer,
          spend:manifest.handoff.bounds.spend,deadline,request});
      }catch(error){put(`${prefix}-source-refusal.json`,{reason:error.message});throw error;}
    }});
  let finished;
  const finish=()=>finished??=(async()=>{
    await recorder.stop();
    const summary=readObservedInvocation({directory,id,workspace,support,model,catalog,manifest,codex,resume,priorId});
    put(join(root,'native-observation.json'),summary);return summary;
  })();
  return {session,observer:{url:recorder.url,readRoots:[session.protectedRoot,join(session.stateRoot,'skills/.system')]},
    environment:observedHostEnvironment({stateRoot:session.stateRoot,tempRoot,localToken:recorder.localToken}),finish};
}

export function readObservedInvocation({directory,id,workspace,support,model,catalog,manifest,codex,resume,priorId}){
  const observer=validateObserver(manifest.handoff.observer),profile=campaignObserverProfile({directory,manifest,codex});
  const selected=profile.models.find(row=>row.model===model);requireObserved(selected,'unselected observed model');
  requireObserved(existsSync(join(directory,'artifacts',id,'native-session.json')),'native session evidence missing');
  const sessionOptions={directory,id,workspace,support,model,catalog,profileDigest:profile.digest,identityDigest:profile.identity.digest,resume,priorId};
  const session=prepareObservedSession(sessionOptions),collectorRoot=join(directory,'artifacts',id,'collector');
  const summary={version:2,parentId:id,profileDigest:profile.digest,identityDigest:profile.identity.digest,session:session.record,
    status:'unavailable',reason:null,collectorStopped:false,usage:null,physicalReservations:null,forwardedRequests:0,observedModel:null,exchanges:[]};
  try{
    const stopped=read(directory,`artifacts/${id}/collector/stopped.json`),configuration=read(directory,`artifacts/${id}/collector/configuration.json`);
    requireObserved(stopped.version===1&&count(stopped.requests)&&count(stopped.stoppedAt),'collector stop evidence missing');
    requireObserved(configuration.version===1&&configuration.authMode===observer.authMode&&configuration.upstream===NATIVE_RESPONSE_ROUTES[observer.authMode]&&configuration.maxRequests===observer.maxRequestsPerInvocation
      &&configuration.maxBytes===observer.maxBytes&&configuration.concurrency===1&&configuration.requestTimeoutMs===observer.requestTimeoutMs
      &&configuration.declarationDigest===selected.declarationDigest,'collector configuration changed');summary.collectorStopped=true;
    const physical=observedPhysicalUsage({directory,observer,executionHandoffDigest:manifest.executionHandoffDigest,unknownUsage:manifest.handoff.bounds?.spend?.unknownUsage}),parent=physical.parents[id];
    summary.usage=parent?.usage??{input_tokens:0,output_tokens:0,cached_input_tokens:0};summary.physicalReservations=parent?.requests??0;
    const names=readdirSync(collectorRoot).filter(name=>name.endsWith('-started.json')).sort();
    requireObserved(names.length===stopped.requests&&(observer.maxRequestsPerInvocation===null||names.length<=observer.maxRequestsPerInvocation),'collector request census');let complete=names.length>0;
    for(const [index,name]of names.entries()){
      const ordinal=index+1;requireObserved(name===`${ordinalName(ordinal)}-started.json`,'collector request ordinal');
      const prefix=`artifacts/${id}/collector/${ordinalName(ordinal)}`,terminal=read(directory,`${prefix}-terminal.json`);
      requireObserved(terminal.version===2&&terminal.ordinal===ordinal&&typeof terminal.forwarded==='boolean'&&count(terminal.finishedAt)&&terminal.finishedAt<=stopped.stoppedAt,'collector terminal missing');
      if(!terminal.forwarded){
        requireObserved(terminal.status===null&&terminal.observation===null&&terminal.outputBytes===0&&terminal.responseDigest===null
          &&typeof terminal.reason==='string'&&terminal.reason.length>0,'no-forward collector terminal incomplete');
        complete=false;summary.exchanges.push({ordinal,forwarded:false,reason:terminal.reason});continue;
      }
      summary.forwardedRequests++;
      requireObserved(physicalRecords(directory).some(row=>row.parentId===id&&row.collectorOrdinal===ordinal),'unreserved forwarded exchange');
      const bytes=readFixtureFile(directory,join(directory,`${prefix}-request.json`),{maxBytes:observer.maxBytes});
      const request=decodeNativeRequest(bytes,{maxBytes:observer.maxBytes});
      requireObserved(request.status==='observed'&&request.model===model&&nativeDeclarationDigest(request)===selected.declarationDigest,'observed request source changed');
      const responseBytes=readFixtureFile(directory,join(directory,`${prefix}-response.body`),{maxBytes:observer.maxBytes});
      const response=decodeNativeResponse(responseBytes,{maxBytes:observer.maxBytes,requestedModel:model,responseMetadata:terminal.responseMetadata,transport:{upstream:configuration.upstream,status:terminal.status}});
      const release=checkNativeRelease(response,request);
      requireObserved(response.status==='observed'&&isDeepStrictEqual(response,terminal.observation)&&equal(release,terminal.release),'observed response source changed');
      const catalogBytes=readFixtureFile(directory,join(directory,`${prefix}-catalog.json`)),observed=strictEvaluationJson(catalogBytes);
      requireObserved(observed.requestDigest===digestBytes(bytes),'observed catalog request binding');catalogProfile(observed,selected);
      requireObserved(equal(observed,observeNativeCatalog({request,catalog,stateRoot:session.stateRoot})),'observed catalog source changed');
      summary.observedModel=model;
      summary.exchanges.push({ordinal,forwarded:true,request:{path:`${prefix}-request.json`,digest:digestBytes(bytes)},response:{path:`${prefix}-response.body`,digest:digestBytes(responseBytes)},
        catalog:{path:`${prefix}-catalog.json`,digest:digestBytes(catalogBytes)},terminal:{path:`${prefix}-terminal.json`,digest:digestBytes(readFixtureFile(directory,join(directory,`${prefix}-terminal.json`)))},responseId:response.response.id,released:release.allowed&&terminal.reason===null});
      complete&&=release.allowed&&terminal.reason===null;
    }
    requireObserved(nativeHostIdentity(codex).digest===profile.identity.digest,'observed host/runtime source changed');
    prepareObservedSession(sessionOptions);
    if(complete&&summary.forwardedRequests>0&&!existsSync(join(collectorRoot,'refusal.json')))summary.status='observed';
    else summary.reason=existsSync(join(collectorRoot,'refusal.json'))?'collector-refused':'no-complete-forwarded-exchange';
  }catch(error){summary.reason=error.message;}
  return summary;
}

export function campaignUsage(directory,{skipParent,unknownUsage='stop-before-next-launch'}={}){
  assertFixtureDirectory(directory);const launchRoot=join(directory,'launches');let input=0,output=0,unknown=0;
  if(!existsSync(launchRoot))return {input,output,unknown};
  assertFixtureDirectory(directory,launchRoot);
  for(const name of readdirSync(launchRoot).filter(name=>name.endsWith('.started.json'))){
    const record=read(directory,`launches/${name}`);requireObserved(parentId(record.id)&&name===`${record.id}.started.json`,'launch identity');
    if(record.id===skipParent)continue;
    const path=`artifacts/${record.id}/result.json`;
    requireObserved(existsSync(join(directory,path)),'unfinished launch remains charged; inspect recovery');
    const result=read(directory,path);requireObserved(result.cleanup===true,'cleanup unresolved');
    if(record.kind==='audit'&&result.controlled===true)continue;
    const counted=countableLaunchUsage(result.usage);
    if(!counted){
      // 'retain-and-continue' is accepted only when every spend ceiling is absent, so an unknown launch
      // can exhaust no ceiling; it is counted as unknown rather than summed as zero.
      requireObserved(unknownUsage==='retain-and-continue','unknown usage stops next launch');unknown++;continue;
    }
    input=add(input,counted.input);output=add(output,counted.output);
  }
  return {input,output,unknown};
}

function physicalRecords(directory){
  const root=join(directory,'physical');if(!existsSync(root))return [];
  assertFixtureDirectory(directory,root);const names=readdirSync(root).sort();
  requireObserved(names.length<=999999,'physical record bound');
  return names.map((name,index)=>{
    requireObserved(name===`${ordinalName(index+1)}-started.json`,'physical ordinal census');
    const record=read(directory,`physical/${name}`);
    shape(record,['version','id','ordinal','parentId','collectorOrdinal','model','requestDigest','executionHandoffDigest','startedAt']);
    requireObserved(record.version===1&&record.ordinal===index+1&&record.id===`native-${ordinalName(index+1)}`
      &&parentId(record.parentId)&&count(record.collectorOrdinal)&&record.collectorOrdinal>0
      &&typeof record.model==='string'&&record.model.length>0&&digest(record.requestDigest)&&digest(record.executionHandoffDigest)
      &&count(record.startedAt),'physical record identity');return record;
  });
}

function parentAuthority(directory,id,executionHandoffDigest){
  requireObserved(parentId(id)&&digest(executionHandoffDigest),'physical parent authority');
  const parent=read(directory,`launches/${id}.started.json`);
  requireObserved(parent.version===2&&parent.id===id&&['author','prerequisite'].includes(parent.kind)
    &&parent.executionHandoffDigest===executionHandoffDigest,'physical parent authority');return parent;
}

function exchangeUsage(directory,record,observer,{unknownUsage}={}){
  const prefix=`artifacts/${record.parentId}/collector/${ordinalName(record.collectorOrdinal)}`;
  const started=read(directory,`${prefix}-started.json`);
  requireObserved(started.version===1&&started.ordinal===record.collectorOrdinal&&count(started.startedAt)&&started.startedAt<=record.startedAt,'collector start binding');
  const bytes=readFixtureFile(directory,join(directory,`${prefix}-request.json`),{maxBytes:observer.maxBytes});
  requireObserved(digestBytes(bytes)===record.requestDigest,'physical request digest');
  const request=decodeNativeRequest(bytes,{maxBytes:observer.maxBytes});
  requireObserved(request.status==='observed'&&request.model===record.model,'physical request model');
  requireObserved(existsSync(join(directory,`${prefix}-terminal.json`)),'physical terminal missing; unknown usage');
  const terminal=read(directory,`${prefix}-terminal.json`);
  shape(terminal,['version','ordinal','forwarded','status','responseMetadata','reason','requestDigest','responseDigest','inputBytes','outputBytes','inputIncomplete','outputIncomplete','observation','release','finishedAt']);
  requireObserved(terminal.version===2&&terminal.ordinal===record.collectorOrdinal&&typeof terminal.forwarded==='boolean'
    &&terminal.requestDigest===record.requestDigest&&terminal.inputBytes===bytes.length&&terminal.inputIncomplete===false
    &&count(terminal.outputBytes)&&typeof terminal.outputIncomplete==='boolean'&&count(terminal.finishedAt)&&terminal.finishedAt>=record.startedAt,'physical terminal binding');
  const dispatchPath=join(directory,`${prefix}-dispatch.json`),hasDispatch=existsSync(dispatchPath);
  if(hasDispatch){const dispatch=read(directory,`${prefix}-dispatch.json`);shape(dispatch,['reservationId','requestDigest','at']);
    requireObserved(dispatch.reservationId===record.id&&dispatch.requestDigest===record.requestDigest&&count(dispatch.at)
      &&dispatch.at>=record.startedAt&&dispatch.at<=terminal.finishedAt,'physical dispatch binding');}
  if(!terminal.forwarded){
    requireObserved(terminal.status===null&&typeof terminal.reason==='string'&&terminal.reason.length>0&&terminal.outputBytes===0
      &&terminal.responseDigest===null&&terminal.observation===null,'no-forward terminal incomplete');
    return {input_tokens:0,output_tokens:0,cached_input_tokens:0};
  }
  // An exchange the upstream aborted keeps every binding above but carries no countable usage, and a
  // partial body is retained under a different name; retaining it as unknown never reports it as zero.
  const retainUnknown=reason=>{requireObserved(unknownUsage==='retain-and-continue',reason);return {input_tokens:null,output_tokens:null,cached_input_tokens:null};};
  if(!(hasDispatch&&terminal.status===200&&!terminal.outputIncomplete))return retainUnknown('forwarded response usage unknown');
  requireObserved(existsSync(join(directory,`${prefix}-response.body`)),'physical response missing');
  const response=readFixtureFile(directory,join(directory,`${prefix}-response.body`),{maxBytes:observer.maxBytes});
  requireObserved(response.length===terminal.outputBytes&&digestBytes(response)===terminal.responseDigest,'physical response binding');
  const configuration=read(directory,`artifacts/${record.parentId}/collector/configuration.json`);
  requireObserved(configuration.version===1&&configuration.authMode===observer.authMode&&configuration.upstream===NATIVE_RESPONSE_ROUTES[observer.authMode],'physical transport configuration changed');
  const observation=decodeNativeResponse(response,{maxBytes:observer.maxBytes,responseMetadata:terminal.responseMetadata,transport:{upstream:configuration.upstream,status:terminal.status},requestedModel:record.model});
  requireObserved(isDeepStrictEqual(observation,terminal.observation),'physical response observation changed');
  // An unchanged but unsuccessful stream (response.failed or response.incomplete on HTTP 200) is unknown usage, not altered evidence.
  if(observation.status!=='observed')return retainUnknown('forwarded response usage unknown');
  const usage=observation.usage;
  if(!(count(usage?.input_tokens)&&count(usage?.output_tokens)
    &&(usage.cached_input_tokens===null||count(usage.cached_input_tokens))))return retainUnknown('forwarded response usage unknown');
  return usage;
}

export function observedPhysicalUsage({directory,observer,executionHandoffDigest,unknownUsage}){
  validateObserver(observer);assertFixtureDirectory(directory);
  const records=physicalRecords(directory),parents={};
  requireObserved(records.length<=NATIVE_RECORD_LIMIT,'physical record count exhausted');
  requireObserved(observer.maxRequests===null||records.length<=observer.maxRequests,'global request allowance exceeded');
  for(const record of records){
    requireObserved(record.executionHandoffDigest===executionHandoffDigest,'physical authority changed');
    parentAuthority(directory,record.parentId,executionHandoffDigest);
    const parent=parents[record.parentId]??={requests:0,model:record.model,usage:{input_tokens:0,output_tokens:0,cached_input_tokens:0}};
    requireObserved(parent.model===record.model&&record.collectorOrdinal===parent.requests+1,'physical parent sequence/model');
    parent.requests++;
    requireObserved(observer.maxRequestsPerInvocation===null||parent.requests<=observer.maxRequestsPerInvocation,'parent request allowance exceeded');
    const usage=exchangeUsage(directory,record,observer,{unknownUsage});
    for(const key of ['input_tokens','output_tokens','cached_input_tokens'])parent.usage[key]=usage[key]===null||parent.usage[key]===null?null:add(parent.usage[key],usage[key]);
  }
  let unknownParents=0;
  for(const [id,parent]of Object.entries(parents)){
    // cached_input_tokens is legitimately null on a known exchange, so only the two counted fields decide
    // whether a parent's physical usage is unknown.
    const unknown=parent.usage.input_tokens===null||parent.usage.output_tokens===null;if(unknown)unknownParents++;
    const path=`artifacts/${id}/result.json`;if(!existsSync(join(directory,path)))continue;
    const result=read(directory,path),usage=result.usage;
    if(unknown)requireObserved(['input_tokens','output_tokens','cached_input_tokens'].every(key=>(usage?.[key]??null)===null),'completed parent usage differs from physical evidence');
    else requireObserved(usage&&usage.input_tokens===parent.usage.input_tokens&&usage.output_tokens===parent.usage.output_tokens
      &&(usage.cached_input_tokens??null)===parent.usage.cached_input_tokens,'completed parent usage differs from physical evidence');
  }
  return {requests:records.length,parents,unknownParents};
}

export function reserveObservedRequest({directory,parentId:id,executionHandoffDigest,model,observer,spend,deadline,request}){
  validateObserver(observer);assertFixtureDirectory(directory);parentAuthority(directory,id,executionHandoffDigest);
  requireObserved(count(deadline)&&Date.now()<deadline,'physical deadline exhausted');
  requireObserved(!existsSync(join(directory,'cleanup-failed.json')),'cleanup unresolved');
  requireObserved(!existsSync(join(directory,`artifacts/${id}/result.json`)),'physical parent already finished');
  requireObserved(count(request.ordinal)&&request.ordinal>0&&request.model===model&&digest(request.requestDigest)&&count(request.startedAt),'physical request model or identity');
  const records=physicalRecords(directory);
  requireObserved(!records.some(row=>row.parentId===id&&row.collectorOrdinal===request.ordinal),'collector ordinal already reserved');
  const observed=observedPhysicalUsage({directory,observer,executionHandoffDigest,unknownUsage:spend.unknownUsage}),prior=campaignUsage(directory,{skipParent:id,unknownUsage:spend.unknownUsage});
  const current=observed.parents[id],own=current?.usage;
  requireObserved(observed.requests<NATIVE_RECORD_LIMIT,'physical record count exhausted');
  requireObserved((observer.maxRequests===null||observed.requests<observer.maxRequests)&&(observer.maxRequestsPerInvocation===null||(current?.requests??0)<observer.maxRequestsPerInvocation),'physical request allowance exhausted');
  requireObserved(request.ordinal===(current?.requests??0)+1,'physical request sequence');
  const input=add(prior.input,own?.input_tokens??0),output=add(prior.output,own?.output_tokens??0);
  requireObserved((spend.plannedMaxMicrousd===null||count(spend.plannedMaxMicrousd)&&spend.plannedMaxMicrousd>0)
    &&(spend.inputTokens===null||count(spend.inputTokens)&&input<spend.inputTokens)
    &&(spend.outputTokens===null||count(spend.outputTokens)&&output<spend.outputTokens),'sourced spend or token planning ceiling exhausted');
  const prefix=`artifacts/${id}/collector/${ordinalName(request.ordinal)}`;
  const bytes=readFixtureFile(directory,join(directory,`${prefix}-request.json`),{maxBytes:observer.maxBytes});
  const decoded=decodeNativeRequest(bytes,{maxBytes:observer.maxBytes});
  requireObserved(digestBytes(bytes)===request.requestDigest&&decoded.status==='observed'&&decoded.model===model,'physical request source changed');
  const ordinal=records.length+1,record={version:1,id:`native-${ordinalName(ordinal)}`,ordinal,parentId:id,collectorOrdinal:request.ordinal,
    model,requestDigest:request.requestDigest,executionHandoffDigest,startedAt:request.startedAt};
  requireObserved(Date.now()<deadline,'physical deadline exhausted');
  mkdirSync(join(directory,'physical'),{recursive:true,mode:0o700});assertFixtureDirectory(directory,join(directory,'physical'));
  writeFileSync(join(directory,'physical',`${ordinalName(ordinal)}-started.json`),canonicalBytes(record),{flag:'wx',mode:0o600});return {id:record.id};
}
