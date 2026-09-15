import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digestBytes } from '../gate/review-receipt.mjs';
import { decodeNativeRequest, decodeNativeResponse, nativeResponseItems } from './native-wire.mjs';
import { witnessResponse } from './native-witness.mjs';
import { controlSourcePlan, observeNativeControl, observeControlBehavior } from './native-control.mjs';

const skill='---\nname: afk\ndescription: Synthetic driver.\n---\nRead [environment](references/environment.md).\n';
const environment='\ufeffComplete synthetic environment.\n',hidden='---\nname: hidden\n---\nHidden synthetic body.\n';
const sources={'skills/afk/SKILL.md':skill,'skills/afk/references/environment.md':environment};
const trial={caseId:'F01',skill:'afk',condition:'advertised-form'};
function setup({body=skill,extraBodies={}}={}){
  const selected='/support/skills/afk/SKILL.md',unadvertised='/state/skills/.system/hidden/SKILL.md';
  const bodies={[selected]:body,[unadvertised]:hidden,...extraBodies};
  const catalog={native:true,complete:true,entries:[{name:'afk-skills:afk',kind:'selected',path:selected,sourceDigest:digestBytes(body)}],unadvertisedBodies:[{path:unadvertised,sourceDigest:digestBytes(hidden),visibility:'not-in-observed-catalog'}]};
  const plan=controlSourcePlan({trial,sources:{...sources,'skills/afk/SKILL.md':body}});
  return {trial,plan,support:'/support',catalog,bodies};
}
function trace(outputs){
  const history=[],exchanges=[];
  for(let ordinal=1;ordinal<=outputs.length+1;ordinal++){
    if(ordinal>1)history.push({type:'custom_tool_call_output',call_id:`witness-call-${(ordinal-1)*2-1}`,output:outputs[ordinal-2]});
    const request=decodeNativeRequest(Buffer.from(JSON.stringify({model:'gpt-6-astra',input:history,tools:[{type:'namespace',name:'functions',tools:[{type:'custom',name:'exec'}]}]})),{maxBytes:1048576});
    const response=decodeNativeResponse(witnessResponse({ordinal:ordinal<=outputs.length?ordinal*2-1:ordinal*2,model:'gpt-6-astra',script:'text("synthetic owned fixture");'}),{maxBytes:1048576,requestedModel:'gpt-6-astra',contentType:'text/event-stream'});
    exchanges.push({invocationId:'actor',sessionId:'session',ordinal,request,response});history.push(...nativeResponseItems(response).filter(item=>item.type==='custom_tool_call'));
  }
  return exchanges;
}
const output=text=>[{type:'input_text',text:JSON.stringify({output:text,exit_code:0})}];

test('source plans retain baseline inline ownership and follow only actual selected-revision routes',()=>{
  const old=controlSourcePlan({trial,sources:{'skills/afk/SKILL.md':'---\nname: afk\n---\nInline baseline instructions.\n'}});
  assert.equal(old.status,'supported');assert.equal(old.requiredReads.length,1);assert.equal(old.requiredReads[0].path,'skills/afk/SKILL.md');
  const current=controlSourcePlan({trial,sources});assert.equal(current.status,'supported');assert.equal(current.requiredReads.length,2);
  assert.equal(current.requiredReads.find(row=>row.path.endsWith('environment.md')).digest,digestBytes(environment));
});
for(const caseId of ['L1','L2','L3','L5'])test(`${caseId} refuses absent baseline capabilities without inventing candidate routes`,()=>{
  const plan=controlSourcePlan({trial:{...trial,caseId},sources:{'skills/afk/SKILL.md':'Inline original skill.\n'}});
  assert.equal(plan.status,'unsupported');assert.match(plan.reason,/environment|state helper/);
});
test('L3 retains the original removed reference digest',()=>{
  const plan=controlSourcePlan({trial:{...trial,caseId:'L3'},sources});
  assert.equal(plan.missingReference.path,'skills/afk/references/environment.md');assert.equal(plan.missingReference.digest,digestBytes(environment));
});
test('complete decoded native delivery is separate from a path mention or partial prefix',()=>{
  const options=setup();
  const full=observeNativeControl({...options,exchanges:trace([output(skill),output(environment)])});
  assert.equal(full.selectionEvidence,true);assert.equal(full.selectedSkill,'afk');assert.equal(full.reads.length,2);
  for(const text of ['Read /support/skills/afk/SKILL.md',skill.slice(0,-10)]){
    const partial=observeNativeControl({...options,exchanges:trace([output(text)])});assert.equal(partial.selectionEvidence,false);
  }
});
test('BOM and newline bytes are significant and repeated history cannot create a later read',()=>{
  const options=setup(),observed=observeNativeControl({...options,exchanges:trace([output(skill),output(environment.slice(1)),output(environment)])});
  const reads=observed.reads.filter(row=>row.path.endsWith('environment.md'));assert.equal(reads.length,1);assert.equal(reads[0].requestOrdinal,4);
  assert.equal(observed.reads.filter(row=>row.path.endsWith('SKILL.md')).length,1);
});
test('unadvertised bodies and missing catalog source bytes prevent an expected-answer-only selection claim',()=>{
  const options=setup();
  assert.equal(observeNativeControl({...options,exchanges:trace([output(hidden),output(skill)])}).selectionEvidence,false);
  const bodies={...options.bodies};delete bodies['/state/skills/.system/hidden/SKILL.md'];
  assert.equal(observeNativeControl({...options,bodies,exchanges:trace([output(skill)])}).selectionEvidence,false);
});
test('multiple first skill bodies in one native call remain ambiguous',()=>{
  const options=setup(),other='---\nname: other\n---\nAnother entire skill.\n',path='/support/skills/other/SKILL.md';
  options.catalog.entries.push({name:'other',kind:'selected',path,sourceDigest:digestBytes(other)});options.bodies[path]=other;
  const observed=observeNativeControl({...options,exchanges:trace([output(skill+'\n'+other)])});assert.equal(observed.selectionEvidence,false);
});
test('native causal loading uses a later response edge, never same-cell or missing parentage',()=>{
  const options=setup(),exchanges=trace([output(skill+'\n'+environment),output('actual bounded endpoint')]);
  const effect={invocationId:'actor',sessionId:'session',callId:'witness-call-3',evidence:'synthetic source-correlated endpoint fixture'};
  assert.equal(observeNativeControl({...options,exchanges,effects:[effect]}).nativeOrder.status,'before');
  assert.equal(observeNativeControl({...options,exchanges,effects:[{...effect,callId:'witness-call-1'}]}).nativeOrder.status,'violation');
  assert.equal(observeNativeControl({...options,exchanges,effects:[{...effect,callId:null}]}).nativeOrder.status,'unobserved');
});
test('opaque earlier output and lone surrogates do not establish complete selection',()=>{
  const options=setup();
  for(const first of [[{type:'input_image',image_url:'synthetic'}],output('\ud800')]){
    assert.equal(observeNativeControl({...options,exchanges:trace([first,output(skill)])}).selectionEvidence,false);
  }
});
test('opaque output after selection still prevents a positive loading order claim',()=>{
  const options=setup(),exchanges=trace([output(skill),[{type:'input_image',image_url:'synthetic'}],output(environment),output('endpoint')]);
  const observed=observeNativeControl({...options,exchanges,effects:[{invocationId:'actor',sessionId:'session',callId:'witness-call-7',evidence:'synthetic bound effect'}]});
  assert.equal(observed.selectionEvidence,true);assert.equal(observed.nativeOrder.status,'unobserved');
});
test('unexplained native input items keep selection unqualified',()=>{
  const options=setup(),exchanges=trace([output(skill)]);exchanges[0].request.opaque.push({source:'/input/0',digest:'a'.repeat(64),reason:'uninterpreted input item'});
  assert.equal(observeNativeControl({...options,exchanges}).selectionEvidence,false);
});
test('L1 context delivery needs retained complete user input and never selects the hinted skill',()=>{
  const options=setup(),exchanges=trace([output(skill)]),contextDelivery=[{path:'skills/afk/references/environment.md',digest:digestBytes(environment)}];
  exchanges[0].request.instructions.push({role:'user',source:'/input/0',text:`Supplied environment:\n${environment}`,digest:'synthetic'});
  const observed=observeNativeControl({...options,contextDelivery,exchanges});
  assert.equal(observed.reads.find(row=>row.path.endsWith('environment.md')).source,'actual-context');
  assert.equal(observed.reads.find(row=>row.path.endsWith('environment.md')).requestOrdinal,1);
  const missing=observeNativeControl({...options,contextDelivery,exchanges:trace([output(skill)])});
  assert.equal(missing.reads.some(row=>row.path.endsWith('environment.md')),false);
  const injected=trace([]);injected[0].request.instructions.push({role:'user',source:'/input/0',text:skill,digest:'synthetic'});
  assert.equal(observeNativeControl({...options,exchanges:injected,contextDelivery:[{path:'skills/afk/SKILL.md',digest:digestBytes(skill)}]}).selectionEvidence,false);
});
function behaviorSetup(caseId){
  const files={'TASK.md':{digest:'task'},'src/reserve.mjs':{digest:'product'},'test/reserve.test.mjs':{digest:'tests'},'.afk/config.md':{digest:'config'}};
  const before={head:'a'.repeat(40),files},after=structuredClone(before),authority={runId:'trial',scope:'task',allowance:2,consumed:0,state:'active'};
  const invocation={status:'completed',cleanup:true,eventsComplete:true,nativeStatus:'observed',unknownActions:0,actions:[],productEdits:[],decision:{ready:false,stageComplete:true},
    transition:{before,after,beforeAuthority:authority,afterAuthority:authority}};
  return {trial:{caseId},invocations:[invocation],before,after,files:{'docs/plan.md':'Plan TASK A1 through A6.\n'},support:'/support',workspace:'/workspace',node:'/node',control:{},acceptance:['A1','A2','A3','A4','A5','A6'].map(id=>({id,pass:true}))};
}
const command=(text,output,exitCode=0)=>({event:'item.completed',id:'actor-operation',type:'command_execution',command:`/bin/zsh -c ${JSON.stringify(text)}`,output,exitCode});
test('standalone plan behavior needs original actor transition and independent plan adjudication',()=>{
  const input=behaviorSetup('L4');input.invocations[0].transition.beforeAuthority=null;input.invocations[0].transition.afterAuthority=null;
  assert.equal(observeControlBehavior(input).semanticEligible,true);assert.equal(observeControlBehavior(input).behaviorEvidence,false);
  input.invocations[0].transition.after.files['src/reserve.mjs']={digest:'changed'};
  assert.equal(observeControlBehavior(input).behaviorPass,false);assert.equal(observeControlBehavior(input).behaviorEvidence,true);
  input.invocations=[];assert.equal(observeControlBehavior(input).semanticEligible,false);
});
test('local design preview requires actual selected helper output and never claims a completed reviewer',()=>{
  const input=behaviorSetup('L6'),action=command("node /support/skills/afk-codex-review/codex-gate.mjs --design docs/plan.md --print-prompt",'## Design document (docs/plan.md)\n'+input.files['docs/plan.md']);
  assert.equal(observeControlBehavior(input).behaviorEvidence,false);input.invocations[0].actions=[action];
  const observed=observeControlBehavior(input);assert.equal(observed.behaviorPass,true);assert.equal(observed.endpoint,'local-design-preview');assert.equal(observed.externalReviewComplete,false);
  input.invocations[0].actions=[{...action,command:'echo '+action.command}];assert.equal(observeControlBehavior(input).behaviorEvidence,false);
});
test('stale receipt behavior belongs to an actual author checker, never the fixture seed',()=>{
  const input=behaviorSetup('L7'),receipt='/workspace/.afk/runs/trial/receipts/prior',candidate='/workspace/.afk/runs/trial/candidate.json';
  input.control={receipt:{priorReceipt:receipt,candidate,initialCheck:{consistent:false,reviewsComplete:true,issues:['revision mismatch']}}};
  assert.equal(observeControlBehavior(input).behaviorEvidence,false);
  input.invocations[0].actions=[command(`node /support/scripts/check-review-receipts.mjs --candidate ${candidate} --receipt ${receipt}`,JSON.stringify(input.control.receipt.initialCheck),1)];
  assert.equal(observeControlBehavior(input).behaviorPass,true);
  input.after.head='b'.repeat(40);assert.equal(observeControlBehavior(input).behaviorPass,false);
});
test('unknown action coverage never proves remote absence or controlled state inspection',()=>{
  const input=behaviorSetup('L8');assert.equal(observeControlBehavior(input).behaviorEvidence,false);
  input.invocations[0].actions=[command('git push origin HEAD','network denied',1)];assert.equal(observeControlBehavior(input).behaviorEvidence,true);assert.equal(observeControlBehavior(input).behaviorPass,false);
  input.trial.caseId='L5';input.invocations[0].actions=[];assert.equal(observeControlBehavior(input).behaviorEvidence,false);
  input.invocations[0].actions=[command('node /support/scripts/direction-state.mjs check --run-id trial --issue synthetic',JSON.stringify({version:1,status:'valid',head:{sequence:1},baselineDigest:'a'.repeat(64),policyDigest:'b'.repeat(64)}))];
  assert.equal(observeControlBehavior(input).semanticEligible,true);assert.equal(observeControlBehavior(input).behaviorEvidence,false);
});
