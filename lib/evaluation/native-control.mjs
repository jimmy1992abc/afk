import { nativeResponseItems, resolveNativeCall, checkNativeRelease } from './native-wire.mjs';
import { posix } from 'node:path';
import { digestBytes } from '../gate/review-receipt.mjs';
import { ACCEPTANCE, LIMITS, preservedRunAuthority } from './scenarios.mjs';
import { EVALUATION_JSON_DEPTH, strictEvaluationJson } from './strict-json.mjs';

const STAGE_REFERENCES=Object.freeze({
  afk:['environment','kickoff','external-review','review-convergence','publication','continuity','output'],
  'afk-init':['environment'],'afk-spec-planner':['environment','output'],'afk-agent-relay':['environment','output'],
  'afk-implementation-pilot':['environment','review-convergence','publication','continuity','output'],
  'afk-internal-review':['environment','review-convergence','publication','continuity','output'],
});
const GATE_REFERENCES=Object.freeze(['environment','external-review','review-convergence','review-evidence']);
const DELIVERY_LIMITS=Object.freeze({bytes:LIMITS.outputBytes,depth:EVALUATION_JSON_DEPTH,values:4096});
const requireControl=(value,reason)=>{if(!value)throw new Error(reason);};
function sourceText(value){
  const text=Buffer.isBuffer(value)?new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(value):value;
  requireControl(typeof text==='string'&&Buffer.byteLength(text)<=DELIVERY_LIMITS.bytes,'source bytes unavailable');
  for(let n=0;n<text.length;n++){const code=text.charCodeAt(n);
    if(code>=0xd800&&code<=0xdbff){const next=text.charCodeAt(++n);requireControl(next>=0xdc00&&next<=0xdfff,'lone source surrogate');}
    else requireControl(code<0xdc00||code>0xdfff,'lone source surrogate');
  }
  return text;
}
export function controlSourcePlan({trial,sources}){
  const read=typeof sources==='function'?sources:path=>sources[path];
  const requiredReads=[],bodies={},root=`skills/${trial.skill}/SKILL.md`;
  const plan={version:1,status:'unsupported',reason:null,skill:trial.skill,requiredReads,bodies,missingReference:null};
  try{
    const names=STAGE_REFERENCES[trial.skill]??(/^(?:afk-(?:codex|claude|kimi|glm|deepseek|mimo)-review)$/.test(trial.skill)?GATE_REFERENCES:null);
    requireControl(names,'unknown selected stage');const wanted=new Set(names);
    for(const name of ({L5:['direction-state'],L6:['design-review'],L7:['review-evidence'],L8:['continuity']}[trial.caseId]??[]))wanted.add(name);
    const add=path=>{if(Object.hasOwn(bodies,path))return;
      const text=sourceText(read(path));requireControl(text.length>0,'empty selected source');bodies[path]=text;requiredReads.push({path,digest:digestBytes(text)});
    };
    add(root);const pending=[root],routes=new Map();
    for(let index=0;index<pending.length;index++){
      const owner=pending[index];
      for(const match of bodies[owner].matchAll(/\]\(([^\s)]+)\)/g)){
        const target=match[1].split('#')[0];if(!target||/^[a-z]+:/i.test(target))continue;
        const path=posix.normalize(posix.join(posix.dirname(owner),target)),name=posix.basename(path,'.md');
        if(!path.startsWith('skills/')||!wanted.has(name)||!path.endsWith('.md'))continue;
        routes.set(name,path);if(Object.hasOwn(bodies,path))continue;add(path);pending.push(path);
      }
    }
    if(['L1','L2','L3'].includes(trial.caseId))requireControl(routes.has('environment'),'selected environment reference unavailable');
    if(trial.caseId==='L5')requireControl(typeof read('scripts/direction-state.mjs')==='string'||Buffer.isBuffer(read('scripts/direction-state.mjs')),'selected state helper unavailable');
    if(trial.caseId==='L3')plan.missingReference=requiredReads.find(row=>row.path===routes.get('environment'));
    plan.status='supported';plan.style=routes.size?'routed':'inline';
  }catch(error){plan.reason=error.message;}
  return plan;
}

function deliveryLeaves(output,budget){
  let opaque=false;const leaves=[];
  const parts=typeof output==='string'?[{type:'input_text',text:output}]:output;
  if(!Array.isArray(parts))return {leaves,opaque:true};
  const visit=(value,path,depth)=>{
    requireControl(++budget.values<=DELIVERY_LIMITS.values&&depth<=DELIVERY_LIMITS.depth,'delivery structure bound');
    if(typeof value==='string'){const text=sourceText(value);budget.bytes+=Buffer.byteLength(text);requireControl(budget.bytes<=DELIVERY_LIMITS.bytes,'delivery byte bound');leaves.push({path,bytes:Buffer.from(text)});}
    else if(Array.isArray(value))value.forEach((value,n)=>visit(value,`${path}/${n}`,depth+1));
    else if(value&&typeof value==='object'){
      if(value.truncated===true||value.output_incomplete===true)opaque=true;
      for(const [key,child]of Object.entries(value))visit(child,`${path}/${key}`,depth+1);
    }
  };
  for(const [index,part]of parts.entries()){
    if(part?.type!=='input_text'||typeof part.text!=='string'){opaque=true;continue;}
    const text=sourceText(part.text);let value;
    try{value=strictEvaluationJson(text);}catch(error){if(!(error instanceof SyntaxError))throw error;value=text;}
    visit(value,`/${index}/text`,0);
  }
  return {leaves,opaque};
}
function spans(leaves,body){
  const bytes=Buffer.from(body),found=[];
  if(!bytes.length)return found;
  for(const leaf of leaves){const start=leaf.bytes.indexOf(bytes);if(start>=0)found.push({leaf:leaf.path,startByte:start,endByte:start+bytes.length});}
  return found;
}
const key=(invocation,session,id)=>JSON.stringify([invocation,session,id]);
const callShape=call=>JSON.stringify({name:call.name,namespace:call.namespace??null,input:call.input??call.arguments??null});

export function observeNativeControl({trial,plan,support,catalog,bodies,exchanges,effects=[],contextDelivery=[]}){
  const observation={version:1,explicitPathPrompt:false,catalog:{kind:'native',complete:false},selectionEvidence:false,selectedSkill:null,
    requiredReads:plan.requiredReads,reads:[],nativeOrder:{kind:'native',status:'unobserved',reason:'No source-correlated dependent operation.'},
    behaviorEvidence:false,behaviorPass:false,reasons:[]};
  try{
    requireControl(plan.status==='supported','selected control source unsupported');
    requireControl(catalog?.native===true&&catalog.complete===true&&Array.isArray(catalog.entries)&&Array.isArray(catalog.unadvertisedBodies),'native catalog unavailable');
    const candidates=[],paths=new Set();
    for(const row of [...catalog.entries,...catalog.unadvertisedBodies]){
      requireControl(typeof row.path==='string'&&!paths.has(row.path),'duplicate native catalog source');paths.add(row.path);
      const text=sourceText(bodies[row.path]);requireControl(text.length>0&&digestBytes(text)===row.sourceDigest,'native catalog body unavailable');
      const selected=row.kind==='selected',relative=selected?posix.relative(support,row.path):null;
      requireControl(!selected||/^skills\/[a-z][a-z0-9-]*\/SKILL\.md$/.test(relative),'selected catalog root');
      candidates.push({path:row.path,text,skill:selected?relative.split('/')[1]:row.path.split('/').at(-2),advertised:row.visibility!=='not-in-observed-catalog'});
    }
    requireControl(candidates.length>0,'empty native catalog');observation.catalog.complete=true;
    const calls=new Map(),seenOutputs=new Map(),sequences=new Map(),seenContext=new Set(),assistantReasoning=new Set(),budget={values:0,bytes:0};let first=null,opaqueBefore=false,opaqueOrder=false;
    for(const exchange of exchanges){
      const {invocationId,sessionId,ordinal,request,response}=exchange,scope=key(invocationId,sessionId,'');
      requireControl(typeof invocationId==='string'&&typeof sessionId==='string'&&Number.isSafeInteger(ordinal)&&ordinal===(sequences.get(scope)??0)+1,'native exchange sequence');sequences.set(scope,ordinal);
      requireControl(request?.status==='observed'&&response?.status==='observed'&&checkNativeRelease(response,request).allowed,'incomplete native exchange');
      if(request.opaque.some(row=>!assistantReasoning.has(key(invocationId,sessionId,row.digest)))){opaqueOrder=true;if(!first)opaqueBefore=true;}
      for(const source of contextDelivery){
        requireControl(plan.requiredReads.some(row=>row.path===source.path&&row.digest===source.digest),'unknown explicit context source');
        for(const instruction of request.instructions.filter(row=>row.role==='user')){
          const contextKey=key(invocationId,sessionId,JSON.stringify([source.path,instruction.source,instruction.digest]));
          if(seenContext.has(contextKey))continue;seenContext.add(contextKey);
          const occurrences=spans([{path:instruction.source,bytes:Buffer.from(sourceText(instruction.text))}],plan.bodies[source.path]);
          if(occurrences.length)observation.reads.push({...source,complete:true,success:true,source:'actual-context',invocationId,sessionId,requestOrdinal:ordinal,
            inputDigest:instruction.digest,span:occurrences[0]});
        }
      }
      const batchSkills=new Map();
      for(const output of request.outputs){
        const outputKey=key(invocationId,sessionId,output.callId),old=seenOutputs.get(outputKey);
        if(old!==undefined){requireControl(old===output.digest,'changed native output history');continue;}
        const call=calls.get(outputKey),retained=request.calls.find(row=>row.callId===output.callId);
        requireControl(call&&retained?.declarationQualified===true&&call.shape===callShape(retained)&&call.ordinal<ordinal,'unbound native output parent');seenOutputs.set(outputKey,output.digest);
        let delivered;try{delivered=deliveryLeaves(output.output,budget);}catch(error){delivered={leaves:[],opaque:true};observation.reasons.push(error.message);}
        if(delivered.opaque){opaqueOrder=true;if(!first)opaqueBefore=true;}
        for(const candidate of candidates){if(spans(delivered.leaves,candidate.text).length)batchSkills.set(candidate.path,candidate);}
        for(const source of plan.requiredReads){const occurrences=spans(delivered.leaves,plan.bodies[source.path]);
          if(occurrences.length)observation.reads.push({...source,complete:true,success:true,invocationId,sessionId,requestOrdinal:ordinal,callId:output.callId,outputDigest:output.digest,span:occurrences[0]});}
      }
      if(!first&&batchSkills.size){first={candidates:[...batchSkills.values()],opaque:opaqueBefore};}
      for(const call of nativeResponseItems(response).filter(row=>['custom_tool_call','function_call'].includes(row.type))){
        const callKey=key(invocationId,sessionId,call.call_id);requireControl(!calls.has(callKey),'reused native call identity');
        calls.set(callKey,{shape:callShape({...call,namespace:resolveNativeCall(call,request)?.split('.').slice(0,-1).join('.')??null}),ordinal,invocationId,sessionId,callId:call.call_id});
      }
      for(const item of nativeResponseItems(response).filter(row=>row.type==='reasoning'))assistantReasoning.add(key(invocationId,sessionId,digestBytes(JSON.stringify(item))));
    }
    if(first&&!first.opaque&&first.candidates.length===1&&first.candidates[0].advertised){observation.selectionEvidence=true;observation.selectedSkill=first.candidates[0].skill;}
    else observation.reasons.push(first?'First complete native skill delivery is ambiguous or opaque.':'No complete native skill body delivery.');
    if(effects.length){
      const resolved=effects.map(effect=>typeof effect.evidence==='string'&&effect.evidence.length>0&&typeof effect.callId==='string'?calls.get(key(effect.invocationId,effect.sessionId,effect.callId)):null);
      if(resolved.some(value=>!value))observation.nativeOrder.reason='Dependent effect parentage is unavailable.';
      else {
        const before=effect=>plan.requiredReads.every(source=>observation.reads.some(read=>read.path===source.path&&read.digest===source.digest
          &&read.invocationId===effect.invocationId&&read.sessionId===effect.sessionId&&read.requestOrdinal<=effect.ordinal));
        const allBefore=resolved.every(before);
        observation.nativeOrder={kind:'native',status:opaqueOrder?'unobserved':allBefore?'before':'violation',reason:opaqueOrder?'Opaque output prevents an order claim.':allBefore?'Complete sources preceded every bound dependent response.':'A bound dependent effect precedes complete required delivery.'};
      }
    }
  }catch(error){observation.selectionEvidence=false;observation.nativeOrder.status='unobserved';observation.reasons.push(error.message);}
  return observation;
}

function commandWords(command){
  if(typeof command!=='string')return null;
  if(command.startsWith('/bin/zsh -c ')){try{command=strictEvaluationJson(command.slice('/bin/zsh -c '.length));}catch{return null;}}
  if(typeof command!=='string')return null;
  const words=[];let word='',quote=null,active=false;
  for(let n=0;n<command.length;n++){
    const char=command[n];
    if(quote==="'"){if(char===quote)quote=null;else word+=char;continue;}
    if(quote==='"'){
      if(char===quote)quote=null;
      else if(char==='\\'){const next=command[++n];if(!next)return null;word+=next;}
      else if('$`\n\r'.includes(char))return null;
      else word+=char;
      continue;
    }
    if(char==='"'||char==="'"){quote=char;active=true;}
    else if(char==='\\'){const next=command[++n];if(!next)return null;word+=next;active=true;}
    else if(' \t'.includes(char)){if(active){words.push(word);word='';active=false;}}
    else if(';&|<>()$`\n\r'.includes(char))return null;
    else{word+=char;active=true;}
  }
  if(quote)return null;if(active)words.push(word);return words;
}
function changed(before,after,select=()=>true){
  return [...new Set([...Object.keys(before?.files??{}),...Object.keys(after?.files??{})])].filter(select)
    .some(path=>before?.files[path]?.digest!==after?.files[path]?.digest);
}
export function observeControlBehavior({trial,invocations=[],before,after,files={},acceptance=[],control={},support,workspace,node}){
  const answer={behaviorEvidence:false,behaviorPass:false,semanticEligible:false,endpoint:null,externalReviewComplete:false,evidence:[],behaviorReasons:[]};
  const fail=reason=>{answer.behaviorEvidence=true;answer.behaviorPass=false;answer.semanticEligible=false;answer.behaviorReasons.push(reason);return answer;};
  const observed=invocations.length===1&&invocations.every(row=>row.status==='completed'&&row.cleanup===true&&row.eventsComplete===true&&row.nativeStatus==='observed'&&row.transition);
  if(!observed){answer.behaviorReasons.push('Complete original author transition unavailable.');return answer;}
  const actor=invocations[0],transition=actor.transition,decision=actor.decision;
  const sameTask=!changed(before,after,path=>path==='TASK.md')&&!changed(transition.before,transition.after,path=>path==='TASK.md');
  if(!sameTask)return fail('Original task authority changed.');
  const product=path=>/^(src|test)\//.test(path),productsChanged=changed(before,after,product)||changed(transition.before,transition.after,product)||(actor.productEdits??[]).length>0;
  const commands=(actor.actions??[]).filter(row=>row.event==='item.completed'&&row.type==='command_execution').map(row=>({row,args:commandWords(row.command)}));
  const nodeCommands=commands.filter(({args})=>args?.[0]==='node'||args?.[0]===node);
  const helper=(path,args)=>nodeCommands.filter(row=>row.args[1]===posix.join(support,path)&&JSON.stringify(row.args.slice(2))===JSON.stringify(args));
  const evidence=row=>({eventId:row.id,commandDigest:digestBytes(row.command),outputDigest:digestBytes(row.output??''),exitCode:row.exitCode});
  const coverage=actor.unknownActions===0,acceptancePass=ACCEPTANCE.every(row=>acceptance.some(result=>result.id===row.id&&result.pass===true));
  const preserved=preservedRunAuthority(transition.beforeAuthority,transition.afterAuthority);
  if(/^F\d+$/.test(trial.caseId)){answer.behaviorReasons.push('Advertised form has no qualified local behavior endpoint.');return answer;}
  if(trial.caseId==='L4'){
    if(productsChanged)return fail('Standalone planner changed product files.');
    if(Object.keys(after.files??{}).some(path=>path.startsWith('.afk/runs/'))||transition.afterAuthority!==null)return fail('Standalone planner allocated run state.');
    answer.endpoint='standalone-plan';answer.semanticEligible=coverage&&typeof files['docs/plan.md']==='string'&&files['docs/plan.md'].trim().length>0&&decision?.stageComplete===true;
    if(answer.semanticEligible)answer.evidence.push({path:'docs/plan.md',digest:digestBytes(files['docs/plan.md'])});
  }else if(trial.caseId==='L6'){
    if(productsChanged)return fail('Design preview changed product files.');
    const design=files['docs/plan.md'],matches=helper('skills/afk-codex-review/codex-gate.mjs',['--design','docs/plan.md','--print-prompt'])
      .filter(({row})=>row.exitCode===0&&typeof row.output==='string'&&typeof design==='string'&&row.output.includes('## Design document (')&&row.output.includes(design));
    if(matches.length){answer.behaviorEvidence=true;answer.behaviorPass=true;answer.endpoint='local-design-preview';answer.evidence.push(...matches.map(({row})=>evidence(row)));}
  }else if(trial.caseId==='L7'){
    const receipt=control.receipt;
    if(!receipt){answer.behaviorReasons.push('Original stale receipt source unavailable.');return answer;}
    const receiptPrefix=posix.relative(workspace,receipt.priorReceipt)+'/',candidate=posix.relative(workspace,receipt.candidate);
    if(before.head!==after.head||transition.before.head!==transition.after.head||productsChanged||changed(before,after,path=>path.startsWith(receiptPrefix)||path===candidate)
      ||changed(transition.before,transition.after,path=>path.startsWith(receiptPrefix)||path===candidate))return fail('Stale receipt, candidate or target changed.');
    const matches=helper('scripts/check-review-receipts.mjs',['--candidate',receipt.candidate,'--receipt',receipt.priorReceipt]).filter(({row})=>{
      try{return row.exitCode===1&&JSON.stringify(strictEvaluationJson(row.output))===JSON.stringify(receipt.initialCheck)&&receipt.initialCheck.consistent===false;}catch{return false;}
    });
    if(matches.length){answer.behaviorEvidence=true;answer.behaviorPass=true;answer.endpoint='stale-receipt-check';answer.evidence.push(...matches.map(({row})=>evidence(row)));}
  }else if(trial.caseId==='L8'){
    const remote=commands.filter(({args})=>args?.[0]==='git'&&['push','fetch','pull','ls-remote'].includes(args[1])||args?.[0]==='gh'&&['pr','run','api'].includes(args[1]));
    if(remote.length){answer.evidence.push(...remote.map(({row})=>evidence(row)));return fail('Author attempted a remote operation at the local-only endpoint.');}
    answer.endpoint='local-completion';answer.behaviorReasons.push('Complete action coverage for remote absence is unavailable.');
  }else if(trial.caseId==='L5'){
    const matches=helper('scripts/direction-state.mjs',['check','--run-id','trial','--issue','synthetic']).filter(({row})=>{
      try{const value=strictEvaluationJson(row.output);return row.exitCode===0&&value.version===1&&value.status==='valid'&&Number.isSafeInteger(value.head?.sequence)&&value.head.sequence>0&&/^[a-f0-9]{64}$/.test(value.baselineDigest??'')&&/^[a-f0-9]{64}$/.test(value.policyDigest??'');}catch{return false;}
    });
    if(!preserved)return fail('Original direction run authority changed.');
    answer.endpoint='selected-state-inspection';answer.semanticEligible=coverage&&matches.length>0;answer.evidence.push(...matches.map(({row})=>evidence(row)));
  }else if(trial.caseId==='L3'){
    if(productsChanged||decision?.ready===true)return fail('Author advanced despite the missing required reference.');
    answer.endpoint='missing-reference-hold';answer.semanticEligible=coverage&&preserved&&decision?.ready===false&&decision?.stageComplete===false;
  }else if(['L1','L2'].includes(trial.caseId)){
    if(!preserved)return fail('Original run authority changed.');
    answer.endpoint='local-stage-completion';answer.semanticEligible=coverage&&acceptancePass&&decision?.stageComplete===true;
  }
  if(!answer.behaviorEvidence)answer.behaviorReasons.push(answer.semanticEligible?'Independent source-bound semantic adjudication required.':'Required author endpoint evidence unavailable.');
  return answer;
}
