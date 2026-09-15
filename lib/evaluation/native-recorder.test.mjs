import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createNativeRecorder } from './native-recorder.mjs';

const localTokens=new Map();
const upstreamBearer='synthetic-upstream-only';
const requestBody=JSON.stringify({model:'gpt-6-astra',input:'Synthetic input'});
const terminal=Buffer.from('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{id:'synthetic-response',model:'gpt-6-astra',status:'completed',output:[],usage:{input_tokens:2,output_tokens:1}}})+'\n\n');
function send(url,{body=requestBody,path='',headers={},method='POST'}={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request(url+path,{method,headers:{'content-type':'application/json',authorization:`Bearer ${localTokens.get(url)??'synthetic-only'}`,...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks)}));res.on('error',reject);
    });req.on('error',reject);req.end(body);
  });
}
function upstream(t,{status=200,body=terminal,headers={'content-type':'text/event-stream'},hold=false}={}) {
  const calls=[];
  t.mock.method(https,'request',(url,options,callback)=>{
    const req=new EventEmitter();req.end=bytes=>{
      calls.push({url:String(url),options,body:bytes});
      if(hold) return;
      queueMicrotask(()=>{const res=new PassThrough();res.statusCode=status;res.headers=headers;callback(res);res.end(body);});
    };
    req.destroy=error=>{if(error)queueMicrotask(()=>req.emit('error',error));};
    return req;
  });return calls;
}
async function setup(t,options={}) {
  const root=mkdtempSync(join(tmpdir(),'afk-native-recorder-'));
  let recorder;
  t.after(async()=>{if(recorder){localTokens.delete(recorder.url);await recorder.stop();}rmSync(root,{recursive:true,force:true});});
  const reservations=[];
  recorder=await createNativeRecorder({directory:join(root,'capture'),authMode:'chatgpt',credential:{bearer:upstreamBearer,accountId:'synthetic-account'},maxRequests:3,maxBytes:100000,
    concurrency:1,deadline:Date.now()+5000,requestTimeoutMs:1000,reserve:async record=>{reservations.push(record);return {id:`slot-${record.ordinal}`};},...options});
  localTokens.set(recorder.url,recorder.localToken);
  return {root,recorder,reservations};
}

test('recorder reserves then forwards to fixed origin without persisting auth headers',async t=>{
  const calls=upstream(t);const {root,recorder,reservations}=await setup(t);
  const reply=await send(recorder.url,{headers:{originator:'synthetic-native-source'}});
  assert.equal(reply.status,200);assert.deepEqual(reply.body,terminal);
  assert.equal(calls.length,1);assert.equal(reservations.length,1);
  assert.equal(calls[0].url,'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(calls[0].options.headers.authorization,`Bearer ${upstreamBearer}`);
  assert.equal(calls[0].options.headers.originator,'synthetic-native-source');
  assert.notEqual(recorder.localToken,upstreamBearer);
  assert.equal(calls[0].options.headers['chatgpt-account-id'],'synthetic-account');
  const files=readdirSync(join(root,'capture'));
  const evidence=files.map(file=>readFileSync(join(root,'capture',file),'utf8')).join('\n');
  assert.equal(evidence.includes(upstreamBearer),false);
  assert.equal(evidence.includes(recorder.localToken),false);
  assert.equal(JSON.parse(readFileSync(join(root,'capture','000001-terminal.json'))).observation.complete,true);
  await recorder.stop();await recorder.stop();
  const stopped=JSON.parse(readFileSync(join(root,'capture/stopped.json')));
  assert.equal(stopped.version,1);assert.equal(stopped.requests,1);assert.equal(stopped.reason,null);
});

test('fractional provider metadata survives terminal publication with actual media headers',async t=>{
  const event={type:'response.completed',response:{id:'fractional-response',model:'gpt-6-astra',status:'completed',output:[],top_p:0.98,
    metadata:{created:123.456},usage:{input_tokens:2,output_tokens:1}}};
  const body=Buffer.from('event: response.completed\ndata: '+JSON.stringify(event)+'\n\n');
  upstream(t,{body,headers:{'content-type':'text/event-stream; charset=utf-8','content-encoding':'identity','set-cookie':'unrelated-private-header'}});
  const {root,recorder}=await setup(t);assert.equal((await send(recorder.url)).status,200);await recorder.stop();
  const recorded=JSON.parse(readFileSync(join(root,'capture/000001-terminal.json')));
  assert.equal(recorded.version,2);assert.equal(recorded.observation.response.top_p,0.98);
  assert.deepEqual(recorded.responseMetadata,{contentType:'text/event-stream; charset=utf-8',contentEncoding:'identity'});
  assert.equal(JSON.stringify(recorded).includes('unrelated-private-header'),false);
});

test('media-type refusal retains actual metadata and complete body without release',async t=>{
  upstream(t,{headers:{'content-type':'application/json'}});const {root,recorder}=await setup(t);
  assert.equal((await send(recorder.url)).status,502);await recorder.stop();
  const recorded=JSON.parse(readFileSync(join(root,'capture/000001-terminal.json')));
  assert.deepEqual(recorded.responseMetadata,{contentType:'application/json',contentEncoding:null});
  assert.equal(recorded.observation.status,'unavailable');assert.equal(recorded.release,null);
  assert.deepEqual(readFileSync(join(root,'capture/000001-response.body')),terminal);
});

test('API auth selects its fixed Responses route and refuses caller upstream injection',async t=>{
  const calls=upstream(t);const {recorder}=await setup(t,{authMode:'api-key',credential:{bearer:upstreamBearer}});
  assert.equal((await send(recorder.url)).status,200);
  assert.equal(calls[0].url,'https://api.openai.com/v1/responses');
  await assert.rejects(()=>setup(t,{upstream:'https://example.invalid'}),/unsupported option/);
});

test('bounds and single concurrency are mandatory before listener creation',async t=>{
  for(const option of [{maxBytes:0},{maxRequests:Infinity},{deadline:0},{requestTimeoutMs:1.5},{concurrency:2},{reserve:null}]) {
    await assert.rejects(()=>setup(t,option),/bound|concurrency|reservation/);
  }
});

test('unsupported routes and content encodings never dispatch',async t=>{
  const calls=upstream(t);
  const a=await setup(t);assert.equal((await send(a.recorder.url,{path:'/compact'})).status,400);
  const b=await setup(t);assert.equal((await send(b.recorder.url,{headers:{'content-encoding':'gzip'}})).status,400);
  const c=await setup(t);assert.equal((await send(c.recorder.url,{method:'GET',body:''})).status,400);
  assert.equal(calls.length,0);assert.equal(a.reservations.length,0);
});

test('reservation failure and late completion after stop cannot dispatch',async t=>{
  const calls=upstream(t);
  const a=await setup(t,{reserve:async()=>{throw new Error('synthetic refusal');}});
  assert.equal((await send(a.recorder.url)).status,502);
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});
  const b=await setup(t,{reserve:()=>new Promise(resolve=>{release=resolve;entered();})});
  const pending=send(b.recorder.url).catch(error=>({error:error.code}));await started;
  const stopped=b.recorder.stop();release({id:'late'});await stopped;await pending;
  assert.equal(calls.length,0);
});

test('unknown usage and redirect responses latch failure without retries',async t=>{
  const calls=upstream(t,{status:302,headers:{location:'https://example.invalid'}});
  const {recorder}=await setup(t);
  assert.equal((await send(recorder.url)).status,502);
  assert.equal((await send(recorder.url)).status,409);assert.equal(calls.length,1);
});

test('request and response byte limits retain failure and prohibit later dispatch',async t=>{
  const calls=upstream(t,{body:Buffer.alloc(2000,120)});
  const a=await setup(t,{maxBytes:500});assert.equal((await send(a.recorder.url,{body:'x'.repeat(501)})).status,400);
  assert.equal(calls.length,0);
  const b=await setup(t,{maxBytes:500});assert.equal((await send(b.recorder.url)).status,502);
  assert.equal((await send(b.recorder.url)).status,409);assert.equal(calls.length,1);
  assert.equal(readFileSync(join(b.root,'capture','000001-response.partial')).length,500);
  const result=JSON.parse(readFileSync(join(b.root,'capture','000001-terminal.json')));
  assert.equal(result.outputIncomplete,true);assert.equal(result.outputBytes,2000);
});

test('credential-bearing bodies are refused without storing those bytes',async t=>{
  const calls=upstream(t);const {root,recorder}=await setup(t);
  const body=JSON.stringify({model:'gpt-6-astra',input:recorder.localToken});
  assert.equal((await send(recorder.url,{body})).status,400);assert.equal(calls.length,0);
  assert.equal(readdirSync(join(root,'capture')).map(file=>readFileSync(join(root,'capture',file),'utf8')).join('').includes(recorder.localToken),false);
});

test('physical request cap is independent of successful invocation count',async t=>{
  const calls=upstream(t);const {recorder}=await setup(t,{maxRequests:1});
  assert.equal((await send(recorder.url)).status,200);assert.equal((await send(recorder.url)).status,409);
  assert.equal(calls.length,1);
});

test('concurrent request refusal prevents a pending reservation dispatch',async t=>{
  const calls=upstream(t);let release,entered;const started=new Promise(resolve=>{entered=resolve;});
  const {root,recorder}=await setup(t,{reserve:()=>new Promise(resolve=>{release=resolve;entered();})});
  const first=send(recorder.url);await started;
  assert.equal((await send(recorder.url)).status,409);release({id:'late'});
  assert.equal((await first).status,502);assert.equal(calls.length,0);
});

test('stalled upstream reaches a retained timeout with no retry',async t=>{
  const calls=upstream(t,{hold:true});const {root,recorder}=await setup(t,{requestTimeoutMs:20});
  assert.equal((await send(recorder.url)).status,502);assert.equal(calls.length,1);
  const result=JSON.parse(readFileSync(join(root,'capture','000001-terminal.json')));
  assert.equal(result.forwarded,true);assert.equal(result.reason,'request-timeout');
});

test('missing usage is distinct from zero and its full response stays retained',async t=>{
  const body=Buffer.from(terminal.toString().replace('"usage":{"input_tokens":2,"output_tokens":1}','"usage":{}'));
  const calls=upstream(t,{body});const {root,recorder}=await setup(t);
  assert.equal((await send(recorder.url)).status,502);
  assert.equal((await send(recorder.url)).status,409);assert.equal(calls.length,1);
  const result=JSON.parse(readFileSync(join(root,'capture','000001-terminal.json')));
  assert.equal(result.observation.usage,null);
  assert.deepEqual(readFileSync(join(root,'capture','000001-response.body')),body);
});

test('upgrade refusal is recorded without forwarding or retaining credential headers',async t=>{
  const calls=upstream(t);const {root,recorder}=await setup(t);const url=new URL(recorder.url);
  await new Promise((resolve,reject)=>{
    const socket=net.connect(Number(url.port),'127.0.0.1',()=>socket.end('GET '+url.pathname+' HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer synthetic-only\r\n\r\n'));
    socket.on('data',()=>{});socket.on('end',resolve);socket.on('error',reject);
  });
  assert.equal(calls.length,0);
  const refusal=readFileSync(join(root,'capture','refusal.json'),'utf8');
  assert.match(refusal,/unsupported-upgrade/);assert.equal(refusal.includes('synthetic-only'),false);
});

test('client disconnect while awaiting reservation cannot lead to late dispatch',async t=>{
  const calls=upstream(t);let release,entered;const started=new Promise(resolve=>{entered=resolve;});
  const {root,recorder}=await setup(t,{reserve:()=>new Promise(resolve=>{release=resolve;entered();})});
  const req=http.request(recorder.url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${recorder.localToken}`}});
  req.on('error',()=>{});req.end(requestBody);await started;req.destroy();
  const deadline=Date.now()+1000;
  while(!existsSync(join(root,'capture','000001-terminal.json'))&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(JSON.parse(readFileSync(join(root,'capture','000001-terminal.json'))).reason,'client-disconnected');
  release({id:'disconnected'});await new Promise(resolve=>setImmediate(resolve));await recorder.stop();
  assert.equal(calls.length,0);
});


test('local capabilities are distinct and wrong or missing tokens never reserve or forward',async t=>{
  const calls=upstream(t);const a=await setup(t),b=await setup(t);
  assert.match(a.recorder.localToken,/^[a-f0-9]{64}$/);
  assert.notEqual(a.recorder.localToken,b.recorder.localToken);
  assert.equal((await send(a.recorder.url,{headers:{authorization:`Bearer ${b.recorder.localToken}`}})).status,400);
  assert.equal((await send(b.recorder.url,{headers:{authorization:''}})).status,400);
  assert.equal(calls.length,0);assert.equal(a.reservations.length+b.reservations.length,0);
});

test('client account and organization selectors cannot override memory-held credentials',async t=>{
  const calls=upstream(t);const {root,recorder}=await setup(t);
  assert.equal((await send(recorder.url,{headers:{'chatgpt-account-id':'spoofed-account','openai-organization':'spoofed-org','openai-project':'spoofed-project'}})).status,200);
  assert.equal(calls[0].options.headers['chatgpt-account-id'],'synthetic-account');
  assert.equal(calls[0].options.headers['openai-organization'],undefined);
  assert.equal(calls[0].options.headers['openai-project'],undefined);
  const saved=readdirSync(join(root,'capture')).map(p=>readFileSync(join(root,'capture',p),'utf8')).join('');
  for(const value of [upstreamBearer,recorder.localToken,'synthetic-account','spoofed-account'])assert.equal(saved.includes(value),false);
});

test('upstream credential in a request body never publishes or reserves',async t=>{
  const calls=upstream(t);const {root,recorder,reservations}=await setup(t);
  assert.equal((await send(recorder.url,{body:JSON.stringify({model:'gpt-6-astra',input:upstreamBearer})})).status,400);
  assert.equal(calls.length,0);assert.equal(reservations.length,0);
  assert.equal(existsSync(join(root,'capture','000001-request.json')),false);
  assert.equal(existsSync(join(root,'capture','000001-request.partial')),false);
});

for(const partial of [false,true])test(`credential-bearing response ${partial?'partial':'full'} is suppressed`,async t=>{
  const {root,recorder}=await setup(t,{maxBytes:500});
  upstream(t,{body:Buffer.from(upstreamBearer+' '+recorder.localToken+(partial?'x'.repeat(600):''))});
  assert.equal((await send(recorder.url)).status,502);
  assert.equal(existsSync(join(root,'capture','000001-response.body')),false);
  assert.equal(existsSync(join(root,'capture','000001-response.partial')),false);
  const saved=readdirSync(join(root,'capture')).map(p=>readFileSync(join(root,'capture',p),'utf8')).join('');
  assert.equal(saved.includes(upstreamBearer),false);assert.equal(saved.includes(recorder.localToken),false);
  assert.equal(JSON.parse(readFileSync(join(root,'capture','000001-terminal.json'))).forwarded,true);
});

test('malformed credentials refuse before artifacts and listener creation',async t=>{
  const root=mkdtempSync(join(tmpdir(),'afk-credential-invalid-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const credential of [null,{},[],{bearer:''},{bearer:'has space'},{bearer:'nul\0value'},{bearer:'del\x7fvalue'},
    {bearer:'nonasciié'},{bearer:'valid',accountId:'bad\rheader'},{bearer:'valid',extra:'unknown'}]){
    const directory=join(root,'must-not-exist');
    await assert.rejects(()=>createNativeRecorder({directory,authMode:'chatgpt',credential,maxRequests:1,maxBytes:500,concurrency:1,
      deadline:Date.now()+5000,requestTimeoutMs:1000,reserve:async()=>({id:'synthetic'})}),/credential/);
    assert.equal(existsSync(directory),false);
  }
  await assert.rejects(()=>setup(t,{authMode:'api-key',credential:{bearer:'valid',accountId:'unsupported'}}),/credential/);
});

test('profile request mismatch refuses before a physical reservation',async t=>{
  const calls=upstream(t);const {nativeDeclarationDigest,decodeNativeRequest}=await import('./native-wire.mjs');
  const body=Buffer.from(JSON.stringify({model:'gpt-6-astra',tools:[{type:'custom',name:'exec'}],input:'Synthetic input'}));
  const declarationDigest=nativeDeclarationDigest(decodeNativeRequest(body,{maxBytes:100000}));
  const {recorder,reservations}=await setup(t,{declarationDigest});
  assert.equal((await send(recorder.url)).status,400);assert.equal(reservations.length,0);assert.equal(calls.length,0);
});

for(const headers of [{'content-type':'text/event-stream'},{}])test(`profile denial retains response and usage with ${Object.keys(headers).length?'declared':'missing'} media but releases no executable SSE`,async t=>{
  const {nativeDeclarationDigest,decodeNativeRequest}=await import('./native-wire.mjs');
  const body=JSON.stringify({model:'gpt-6-astra',tools:[{type:'custom',name:'exec'}],input:'Synthetic input'});
  const declarationDigest=nativeDeclarationDigest(decodeNativeRequest(Buffer.from(body),{maxBytes:100000}));
  const denied=Buffer.concat([Buffer.from('event: response.output_item.added\ndata: '+JSON.stringify({type:'response.output_item.added',output_index:0,
    item:{type:'function_call',id:'denied-item',namespace:'collaboration',name:'spawn_agent',call_id:'denied-call',arguments:'{}'}})+'\n\n'),terminal]);
  const calls=upstream(t,{body:denied,headers});const {root,recorder}=await setup(t,{declarationDigest});
  const reply=await send(recorder.url,{body});assert.equal(reply.status,502);assert.doesNotMatch(reply.body.toString(),/spawn_agent|event:/);
  assert.deepEqual(readFileSync(join(root,'capture','000001-response.body')),denied);
  const saved=JSON.parse(readFileSync(join(root,'capture','000001-terminal.json')));
  assert.equal(saved.observation.usage.input_tokens,2);assert.equal(saved.release.allowed,false);
  assert.equal((await send(recorder.url,{body})).status,409);assert.equal(calls.length,1);
});

test('fixed upstream missing media preserves actual null fields and validates complete SSE',async t=>{
  upstream(t,{headers:{}});const {root,recorder}=await setup(t);
  assert.equal((await send(recorder.url)).status,200);await recorder.stop();
  const recorded=JSON.parse(readFileSync(join(root,'capture/000001-terminal.json')));
  assert.deepEqual(recorded.responseMetadata,{contentType:null,contentEncoding:null});
  assert.equal(recorded.observation.interpretation,'body-validated-sse');
  assert.deepEqual(readFileSync(join(root,'capture/000001-response.body')),terminal);
});


test('uncapped recorder still reserves and retains each actual exchange', async t => {
  const calls = upstream(t);
  const { root, recorder, reservations } = await setup(t, { maxRequests: null });
  for (let i = 0; i < 5; i++) assert.equal((await send(recorder.url)).status, 200);
  await recorder.stop();
  assert.equal(calls.length, 5);
  assert.equal(reservations.length, 5);
  assert.equal(JSON.parse(readFileSync(join(root, 'capture/configuration.json'))).maxRequests, null);
  assert.ok(existsSync(join(root, 'capture/000005-terminal.json')));
});
