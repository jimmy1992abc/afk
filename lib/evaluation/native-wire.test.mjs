import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digestBytes } from '../gate/review-receipt.mjs';
import { decodeNativeRequest, decodeNativeResponse } from './native-wire.mjs';

const maxBytes = 100000;
const request = input => Buffer.from(JSON.stringify({model:'gpt-6-astra',input}));
const completed = overrides => ({id:'response-1',status:'completed',model:'gpt-6-astra',output:[],usage:{input_tokens:12,output_tokens:3},...overrides});
const sse = events => Buffer.from(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
const response = (events, options={}) => decodeNativeResponse(sse(events),{maxBytes,contentType:'text/event-stream',requestedModel:'gpt-6-astra',...options});

test('native additional-tools namespaces and message instructions retain actual sources', () => {
  const bytes=request([{type:'additional_tools',role:'developer',tools:[{type:'namespace',name:'functions',tools:[{type:'custom',name:'exec',description:'Registry gateway'}]}]},
    {role:'developer',content:[{type:'input_text',text:'Exact instruction\n'}]},
    {role:'user',content:[{type:'input_text',text:'Unhinted trigger'}]}]);
  const result=decodeNativeRequest(bytes,{maxBytes});
  assert.equal(result.status,'observed'); assert.equal(result.bodyDigest,digestBytes(bytes));
  assert.deepEqual(result.tools.map(t=>t.id),['functions.exec']);
  assert.equal(result.tools[0].source,'/input/0/tools/0/tools/0');
  assert.equal(result.instructions[0].text,'Exact instruction\n');
  assert.equal(result.instructions[0].digest,digestBytes('Exact instruction\n'));
  assert.equal(result.inventoryQualified,false);
});

test('ordinary Responses forms are observed without conflating descriptions and instructions', () => {
  const result=decodeNativeRequest(Buffer.from(JSON.stringify({model:'gpt-6-astra',instructions:'System input',tools:[{type:'function',name:'read',parameters:{}}],input:'Task'})),{maxBytes});
  assert.equal(result.status,'observed'); assert.deepEqual(result.tools.map(t=>t.id),['read']);
  assert.deepEqual(result.instructions.map(i=>i.text),['System input','Task']);
});

test('registry witness needs the actual fixed call and matching host output', () => {
  const output={type:'custom_tool_call_output',call_id:'registry',output:[{type:'input_text',text:'Script completed'},{type:'input_text',text:'[{"name":"exec_command","description":"Run a command"}]'}]};
  const call={type:'custom_tool_call',call_id:'registry',namespace:'functions',name:'exec',input:'text(ALL_TOOLS)'};
  const bytes=Buffer.from(JSON.stringify({model:'gpt-6-astra',input:[call,output],tools:[{type:'namespace',name:'functions',tools:[{type:'custom',name:'exec'}]}]}));
  const result=decodeNativeRequest(bytes,{maxBytes});
  assert.deepEqual(result.registryWitnesses[0].entries.map(e=>e.name),['exec_command']);
  assert.equal(result.registryWitnesses[0].callSource,'/input/0');
  assert.equal(result.inventoryQualified,false);
  assert.equal(decodeNativeRequest(request([output]),{maxBytes}).registryWitnesses.length,0);
  assert.equal(decodeNativeRequest(request([{...call,input:'text("inventory complete")'},output]),{maxBytes}).registryWitnesses.length,0);
});

test('unresolved explicit or ambiguous historical declarations cannot qualify registry output',()=>{
  const output={type:'custom_tool_call_output',call_id:'registry',output:'[{"name":"exec_command","description":"Synthetic registry"}]'};
  for(const [namespace,tools]of [['functions',[]],['functions',[{type:'namespace',name:'other',tools:[{type:'custom',name:'exec'}]}]],
    [null,[{type:'namespace',name:'functions',tools:[{type:'custom',name:'exec'}]},{type:'namespace',name:'other',tools:[{type:'custom',name:'exec'}]}]]]){
    const call={type:'custom_tool_call',call_id:'registry',namespace,name:'exec',input:'text(ALL_TOOLS)'};
    const decoded=decodeNativeRequest(Buffer.from(JSON.stringify({model:'gpt-6-astra',input:[call,output],tools})),{maxBytes});
    assert.equal(decoded.status,'observed');assert.equal(decoded.calls[0].declarationQualified,false);
    assert.equal(decoded.registryWitnesses.length,0);
  }
});

test('duplicate declarations and unsupported input stay explicit', () => {
  const duplicate={type:'additional_tools',tools:[{type:'function',name:'read'},{type:'function',name:'read'}]};
  assert.equal(decodeNativeRequest(request([duplicate]),{maxBytes}).status,'unavailable');
  const opaque=decodeNativeRequest(request([{type:'reasoning',encrypted_content:'opaque'}, {type:'future_input',value:'uninterpreted'}]),{maxBytes});
  assert.equal(opaque.opaque.length,2); assert.equal(opaque.inventoryQualified,false);
});

test('wire decoding refuses invalid UTF-8, oversized bytes and permissive bounds', () => {
  for(const bytes of [Buffer.from([0xff]),Buffer.from('{')]) assert.equal(decodeNativeRequest(bytes,{maxBytes}).status,'unavailable');
  assert.equal(decodeNativeRequest(request([]),{maxBytes:1}).status,'unavailable');
  for(const limit of [undefined,0,Infinity,1.5]) assert.throws(()=>decodeNativeRequest(request([]),{maxBytes:limit}),/bound/);
});

test('complete SSE retains exact terminal model and known usage', () => {
  const result=response([{type:'response.created',response:completed({status:'in_progress'})},{type:'response.completed',response:completed()}]);
  assert.equal(result.status,'observed'); assert.equal(result.complete,true);
  assert.deepEqual(result.usage,{input_tokens:12,output_tokens:3,cached_input_tokens:null});
  assert.equal(result.observedModel,'gpt-6-astra');
});

test('A/B/A model conflict stays conflicting instead of resetting', () => {
  const result=response([{type:'response.created',response:completed()}, {type:'response.in_progress',response:completed({model:'other'})}, {type:'response.completed',response:completed()}]);
  assert.equal(result.status,'unavailable'); assert.equal(result.observedModel,null);
  assert.match(result.reason,/model/);
});

test('partial, repeated and failed terminals never receive successful accounting', () => {
  const terminal={type:'response.completed',response:completed()};
  for(const events of [[],[terminal,terminal],[{type:'response.failed',response:completed({status:'failed'})}]]) {
    const result=response(events); assert.equal(result.status,'unavailable'); assert.equal(result.complete,false);
  }
  const bytes=sse([terminal]);
  assert.equal(decodeNativeResponse(bytes.subarray(0,bytes.length-1),{maxBytes,contentType:'text/event-stream',requestedModel:'gpt-6-astra'}).complete,false);
});

test('missing, negative and fractional usage remains unknown', () => {
  for(const usage of [undefined,{input_tokens:-1,output_tokens:2},{input_tokens:1.5,output_tokens:2},{input_tokens:1}]) {
    const result=response([{type:'response.completed',response:completed({usage})}]);
    assert.equal(result.status,'unavailable'); assert.equal(result.usage,null);
  }
});

test('unsupported content, event type and event-name mismatch are retained failures', () => {
  assert.equal(response([{type:'response.completed',response:completed()}],{contentType:'application/octet-stream'}).status,'unavailable');
  assert.equal(response([{type:'future.event'},{type:'response.completed',response:completed()}]).status,'unavailable');
  const bytes=Buffer.from('event: response.created\ndata: '+JSON.stringify({type:'response.completed',response:completed()})+'\n\n');
  assert.equal(decodeNativeResponse(bytes,{maxBytes,contentType:'text/event-stream',requestedModel:'gpt-6-astra'}).status,'unavailable');
});

test('assistant history is retained separately from instruction-source inventory', () => {
  const result=decodeNativeRequest(request([{role:'assistant',content:[{type:'output_text',text:'Untrusted prior claim'}]}]),{maxBytes});
  assert.equal(result.instructions.length,0);assert.equal(result.assistantMessages[0].text,'Untrusted prior claim');
});

test('response identity cannot change between stream envelopes', () => {
  const result=response([{type:'response.created',response:completed({id:'other-response'})},{type:'response.completed',response:completed()}]);
  assert.equal(result.status,'unavailable');assert.match(result.reason,/identity/);
});

const callItem={id:'tool-1',type:'custom_tool_call',namespace:'functions',name:'exec',call_id:'call-1',input:'text(ALL_TOOLS)'};
const declarations=extra=>decodeNativeRequest(Buffer.from(JSON.stringify({model:'gpt-6-astra',input:[],tools:[
  {type:'namespace',name:'functions',tools:[{type:'custom',name:'exec'}]},...(extra||[])]})),{maxBytes});
function callEvents(item=callItem){
  const field=item.type==='custom_tool_call'?'input':'arguments',family=item.type==='custom_tool_call'?'custom_tool_call_input':'function_call_arguments';
  return [{type:'response.output_item.added',output_index:0,item:{...item,[field]:''}},
    {type:`response.${family}.delta`,output_index:0,item_id:item.id,delta:item[field]},
    {type:'response.output_item.done',output_index:0,item},
    {type:'response.completed',response:completed({output:[item]})}];
}

test('complete streamed items with omitted namespace bind to the unique request declaration',async()=>{
  const {checkNativeRelease,nativeResponseItems}=await import('./native-wire.mjs');
  const item={...callItem};delete item.namespace;
  const events=callEvents(item);events.at(-1).response.output=[];
  const decoded=response(events);
  assert.equal(checkNativeRelease(decoded,declarations()).allowed,true);
  assert.deepEqual(nativeResponseItems(decoded),[item]);
  assert.equal(checkNativeRelease(decoded).allowed,false);
  assert.equal(checkNativeRelease(decoded,declarations([{type:'namespace',name:'other',tools:[{type:'custom',name:'exec'}]}])).allowed,false);
  assert.equal(checkNativeRelease(decoded,decodeNativeRequest(request([]),{maxBytes})).allowed,false);
});

test('request history resolves omitted namespaces only from complete unambiguous declarations',()=>{
  const item={...callItem};delete item.namespace;
  const bytes=Buffer.from(JSON.stringify({model:'gpt-6-astra',input:[item,{type:'custom_tool_call_output',call_id:item.call_id,
    output:'[{"name":"exec_command","description":"Synthetic registry"}]'}],tools:[{type:'namespace',name:'functions',tools:[{type:'custom',name:'exec'}]}]}));
  const decoded=decodeNativeRequest(bytes,{maxBytes});assert.equal(decoded.calls[0].namespace,'functions');
  assert.equal(decoded.registryWitnesses.length,1);
});

test('empty terminal inventories cannot hide incomplete, duplicate or conflicting stream items',async()=>{
  const {checkNativeRelease}=await import('./native-wire.mjs');
  for(const mutate of [events=>events.splice(2,1),events=>events.splice(3,0,structuredClone(events[2])),
    events=>{events[2].output_index=2;},events=>{events[1].delta='changed';},
    events=>{events[2].item.name='spawn_agent';},events=>events.splice(3,0,structuredClone(events[1]))]){
    const item={...callItem};delete item.namespace;const events=callEvents(item);events.at(-1).response.output=[];mutate(events);
    assert.equal(checkNativeRelease(response(events),declarations()).allowed,false);
  }
});

test('native finite JSON preserves fractions without broadening authority canonical JSON',async()=>{
  const {nativeJsonBytes}=await import('./native-wire.mjs');
  const {canonicalBytes}=await import('../gate/review-receipt.mjs');
  assert.equal(JSON.parse(nativeJsonBytes({top_p:0.98})).top_p,0.98);
  assert.throws(()=>canonicalBytes({top_p:0.98}),/canonical/);
  assert.throws(()=>nativeJsonBytes({value:Infinity}),/finite/);
  const invalid=Buffer.from('event: response.completed\ndata: {"type":"response.completed","response":{"top_p":1e999}}\n\n');
  assert.equal(decodeNativeResponse(invalid,{maxBytes,contentType:'text/event-stream',requestedModel:'gpt-6-astra'}).status,'unavailable');
});

test('release admits complete native exec/wait/sleep sequences without granting inventory qualification',async()=>{
  const {checkNativeRelease}=await import('./native-wire.mjs');
  for(const item of [callItem,{...callItem,type:'function_call',name:'wait',input:undefined,arguments:'{"cell_id":"cell-1"}'},
    {...callItem,type:'function_call',namespace:'clock',name:'sleep',input:undefined,arguments:'{"duration_ms":1}'}]){
    assert.equal(checkNativeRelease(response(callEvents(item))).allowed,true);
  }
});

for(const [name,mutate] of [
  ['forbidden added call',events=>{events[0].item.namespace='collaboration';events[0].item.name='spawn_agent';}],
  ['changed done name',events=>{events[2].item.name='request_user_input';}],
  ['terminal call without streamed inventory',events=>events.splice(0,3)],
  ['duplicate final call ID',events=>events.at(-1).response.output.push({...callItem,id:'tool-2'})],
  ['unknown output item',events=>{events.at(-1).response.output[0].type='future_tool';}],
  ['mismatched input delta',events=>{events[1].delta='text("changed")';}],
  ['mismatched streamed index',events=>{events[1].output_index=1;}],
  ['late delta after done',events=>events.splice(3,0,structuredClone(events[1]))],
  ['hidden response envelope output',events=>events.unshift({type:'response.created',response:completed({status:'in_progress',output:[{type:'future_tool'}]})})],
])test(`release refuses ${name} while preserving decoded usage`,async()=>{
  const {checkNativeRelease}=await import('./native-wire.mjs'),events=structuredClone(callEvents());mutate(events);
  const decoded=response(events);assert.equal(decoded.status,'observed');
  assert.equal(checkNativeRelease(decoded).allowed,false);assert.equal(decoded.usage.input_tokens,12);
});

test('direct declaration fingerprint binds complete ordered names, types and source bytes',async()=>{
  const {nativeDeclarationDigest}=await import('./native-wire.mjs');
  const a=decodeNativeRequest(request([{type:'additional_tools',tools:[{type:'function',name:'a'},{type:'custom',name:'b'}]}]),{maxBytes});
  assert.notEqual(nativeDeclarationDigest(a),nativeDeclarationDigest({...a,tools:[...a.tools].reverse()}));
  assert.notEqual(nativeDeclarationDigest(a),nativeDeclarationDigest({...a,tools:a.tools.slice(0,1)}));
  assert.throws(()=>nativeDeclarationDigest({...a,status:'unavailable'}),/declaration/);
});


test('declaration fingerprint includes namespace-level descriptions and metadata',async()=>{
  const {nativeDeclarationDigest}=await import('./native-wire.mjs');
  const declaration={type:'additional_tools',tools:[{type:'namespace',name:'functions',description:'Original namespace',tools:[{type:'custom',name:'exec'}]}]};
  const before=decodeNativeRequest(request([declaration]),{maxBytes});declaration.tools[0].description='Changed namespace';
  const after=decodeNativeRequest(request([declaration]),{maxBytes});
  assert.notEqual(nativeDeclarationDigest(before),nativeDeclarationDigest(after));
});

const missingMedia={responseMetadata:{contentType:null,contentEncoding:null},transport:{upstream:'https://chatgpt.com/backend-api/codex/responses',status:200}};
test('inert keepalive retains exact wire evidence and complete tool release in both media interpretations',async()=>{
  const {checkNativeRelease}=await import('./native-wire.mjs');
  const heartbeat={type:'keepalive',sequence_number:2};
  for(const options of [{},missingMedia]){
    const events=[{type:'response.created',response:completed({status:'in_progress'})},heartbeat,...callEvents()];
    const decoded=response(events,options);
    assert.equal(decoded.status,'observed');assert.equal(decoded.bodyDigest,digestBytes(sse(events)));
    assert.deepEqual(decoded.events[1],heartbeat);assert.equal(decoded.usage.input_tokens,12);
    assert.equal(checkNativeRelease(decoded,declarations()).allowed,true);
    const forbidden=response([heartbeat,...callEvents({...callItem,name:'forbidden'})],options);
    assert.equal(forbidden.status,'observed');assert.equal(forbidden.usage.output_tokens,3);
    assert.equal(checkNativeRelease(forbidden,declarations()).allowed,false);
  }
});
test('keepalive cannot carry payloads or replace terminal and streamed-call evidence',async()=>{
  const {checkNativeRelease}=await import('./native-wire.mjs');
  const valid={type:'keepalive',sequence_number:2};
  const malformed=[{type:'keepalive'},...[-1,1.5,'2',null,Number.MAX_SAFE_INTEGER+1].map(sequence_number=>({type:'keepalive',sequence_number})),
    ...['payload','response','item','arguments','call_id'].map(key=>({...valid,[key]:'hidden'}))];
  for(const heartbeat of malformed){
    assert.equal(response([heartbeat,...callEvents()]).status,'unavailable');
    const forged=response(callEvents());forged.events.unshift(heartbeat);
    assert.equal(checkNativeRelease(forged,declarations()).allowed,false);
  }
  assert.equal(response([...callEvents(),valid]).status,'unavailable');
  assert.equal(response([valid]).status,'unavailable');
  const incomplete=callEvents();incomplete.splice(2,1);
  assert.equal(checkNativeRelease(response([valid,...incomplete]),declarations()).allowed,false);
  const named=sse([valid,...callEvents()]).toString().replace('event: keepalive','event: response.created');
  assert.equal(decodeNativeResponse(Buffer.from(named),{maxBytes,contentType:'text/event-stream',requestedModel:'gpt-6-astra'}).status,'unavailable');
  const afterDone=Buffer.concat([sse(callEvents()),Buffer.from('data: [DONE]\n\n'),sse([valid])]);
  assert.equal(decodeNativeResponse(afterDone,{maxBytes,contentType:'text/event-stream',requestedModel:'gpt-6-astra'}).status,'unavailable');
});
test('missing media requires retained metadata and fixed successful transport, then records a distinct interpretation',()=>{
  const events=[{type:'response.completed',response:completed()}];
  const result=response(events,missingMedia);
  assert.equal(result.status,'observed');assert.equal(result.interpretation,'body-validated-sse');
  assert.equal(response(events).interpretation,'declared-sse');
  for(const options of [{contentType:null},{...missingMedia,transport:undefined},
    {...missingMedia,transport:{upstream:'https://example.invalid/responses',status:200}},
    {...missingMedia,transport:{...missingMedia.transport,status:201}},
    {...missingMedia,responseMetadata:{contentType:'',contentEncoding:null}},
    {...missingMedia,responseMetadata:{contentType:'application/json',contentEncoding:null}},
    {...missingMedia,responseMetadata:{contentType:null,contentEncoding:'gzip'}}]){
    const rejected=response(events,options);assert.equal(rejected.status,'unavailable');assert.equal(rejected.interpretation,null);
  }
});
test('missing media preserves framing, terminal identity, usage and release refusals',async()=>{
  const {checkNativeRelease}=await import('./native-wire.mjs');
  for(const events of [[{type:'future.event'}],[{type:'response.completed',response:completed({usage:null})}],
    [{type:'response.created',response:completed({id:'other'})},{type:'response.completed',response:completed()}],
    [{type:'response.completed',response:completed({model:'other'})}],
    [{type:'response.completed',response:completed()},{type:'response.completed',response:completed()}]])assert.equal(response(events,missingMedia).status,'unavailable');
  const valid=sse([{type:'response.completed',response:completed()}]);
  for(const bytes of [valid.subarray(0,-1),Buffer.from([255]),Buffer.from('data: {"type":"response.completed","type":"response.completed"}\n\n')]){
    assert.equal(decodeNativeResponse(bytes,{maxBytes,requestedModel:'gpt-6-astra',...missingMedia}).status,'unavailable');
  }
  const events=callEvents({...callItem,name:'forbidden'}),decoded=response(events,missingMedia);
  assert.equal(decoded.status,'observed');assert.equal(decoded.usage.input_tokens,12);
  assert.equal(checkNativeRelease(decoded,declarations()).allowed,false);
});
