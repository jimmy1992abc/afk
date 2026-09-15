import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { generateNativeWitness, witnessResponse, validateNativeWitnessSources, nativeWitnessSourcePaths, nativeBoundaryCommand, nativeBoundaryEvidence, BOUNDARY_FIELDS } from './native-witness.mjs';
import { checkNativeRelease, decodeNativeRequest, decodeNativeResponse } from './native-wire.mjs';
import { EVALUATOR_RUNTIME_FILES } from './runtime.mjs';

for(const ordinal of [1,2,3,4])test(`owned synthetic response ${ordinal} has complete release evidence`,()=>{
  const bytes=witnessResponse({ordinal,model:'gpt-6-astra',script:'text(ALL_TOOLS);'});
  const decoded=decodeNativeResponse(bytes,{maxBytes:100000,requestedModel:'gpt-6-astra',contentType:'text/event-stream'});assert.equal(decoded.status,'observed');
  const request=decodeNativeRequest(Buffer.from(JSON.stringify({model:'gpt-6-astra',input:[],tools:[{type:'namespace',name:'functions',tools:[{type:'custom',name:'exec'}]}]})),{maxBytes:100000});
  assert.equal(checkNativeRelease(decoded,request).allowed,true);
  assert.equal(decoded.observedModel,'gpt-6-astra');
  assert.deepEqual(decoded.events.filter(event=>event.type==='keepalive'),[{type:'keepalive',sequence_number:2}]);
});
test('witness refuses unknown host before any synthetic listener or launch',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'afk-native-witness-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  await assert.rejects(generateNativeWitness({directory:join(root,'witness'),codex:process.execPath,model:'gpt-6-astra',maxBytes:1000000,deadline:Date.now()+10000}),/native host/);
});
test('source admission requires the complete finite first/resume artifact set rather than a complete flag',()=>{
  const paths=nativeWitnessSourcePaths();
  assert.ok(paths.includes('protected/boundary.mjs'));
  for(const ordinal of [1,2,3,4])assert.ok(paths.includes(`request-${ordinal}.json`)&&paths.includes(`response-${ordinal}.sse`));
  assert.ok(paths.includes('native-state/skills/.system/review-agent/SKILL.md'));
  assert.throws(()=>validateNativeWitnessSources({files:{'witness.json':JSON.stringify({status:'source-witness-complete'})},identity:{digest:'a'.repeat(64)},model:'gpt-6-astra'}),/source set/);
  const files=Object.fromEntries(paths.map(path=>[path,'{}']));files['witness.json']=JSON.stringify({version:1,status:'source-witness-complete',identity:{digest:'old-runtime'},model:'gpt-6-astra'});
  assert.throws(()=>validateNativeWitnessSources({files,identity:{digest:'a'.repeat(64)},model:'gpt-6-astra'}),/identity/);
});
test('native boundary evidence requires the exact protected command, successful result and all eight fields',()=>{
  const probe='/owned/protected/boundary.mjs',command=`/bin/zsh -c ${JSON.stringify(nativeBoundaryCommand(probe))}`;
  const action={event:'item.completed',type:'command_execution',id:'boundary',command,exitCode:0,output:JSON.stringify(Object.fromEntries(BOUNDARY_FIELDS.map(key=>[key,true])))};
  assert.equal(nativeBoundaryEvidence([action],probe).eventId,'boundary');
  for(const change of [{command:'echo '+action.output},{command:'node /owned/writable/probe.mjs'},{exitCode:1},{output:'{"outsideReadDenied":true}'},{output:action.output.replace('true','false')}])assert.throws(()=>nativeBoundaryEvidence([{...action,...change}],probe),/boundary/);
  assert.throws(()=>nativeBoundaryEvidence([action,action],probe),/boundary/);
});
test('source-isolated invalid request fixture retains dispatch attempt and complete refused body',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'afk-witness-refusal-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'source'),repository=fileURLToPath(new URL('../..',import.meta.url));
  for(const path of EVALUATOR_RUNTIME_FILES){mkdirSync(dirname(join(source,path)),{recursive:true});writeFileSync(join(source,path),readFileSync(join(repository,path)));}
  const host=join(source,'lib/evaluation/native-host.mjs'),bytes=readFileSync(host,'utf8'),start=bytes.indexOf('export function nativeHostIdentity('),end=bytes.indexOf('function requireCatalog(',start);
  assert.ok(start>0&&end>start);writeFileSync(host,bytes.slice(0,start)+"export function nativeHostIdentity(){return {digest:'synthetic-test-only',provenance:'Source-isolated mock identity; no native qualification'};}\n"+bytes.slice(end));
  const script=join(root,'client.mjs'),binary=join(root,'client.sh');
  writeFileSync(script,`import http from'node:http';import{writeFileSync}from'node:fs';import{dirname,join}from'node:path';writeFileSync(join(dirname(process.env.CODEX_HOME),'temporary-observation.json'),JSON.stringify({tempRoot:process.env.TMPDIR,stateRoot:process.env.CODEX_HOME}));const args=process.argv.slice(2),provider=args.find(x=>x.startsWith('model_providers.')),base=JSON.parse(provider.match(/base_url=("[^"]+")/)[1]);const req=http.request(base+'/responses',{method:'POST',headers:{authorization:'Bearer '+process.env.AFK_OBSERVED_LOCAL_TOKEN}},res=>{res.resume();res.on('end',()=>process.exit(0));});req.on('error',()=>process.exit(1));req.end('{"model":"wrong-model","input":[]}');`);
  writeFileSync(binary,`#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);chmodSync(binary,0o700);
  const module=await import(pathToFileURL(join(source,'lib/evaluation/native-witness.mjs'))),directory=join(root,'witness');
  await assert.rejects(module.generateNativeWitness({directory,codex:binary,model:'gpt-6-astra',maxBytes:100000,deadline:Date.now()+10000}),/native invocation incomplete/);
  const refusal=JSON.parse(readFileSync(join(directory,'refusal.json')));assert.equal(refusal.invocations,1);assert.equal(refusal.requests,1);
  assert.equal(readFileSync(join(directory,'request-1.json'),'utf8'),'{"model":"wrong-model","input":[]}');
  assert.match(JSON.parse(readFileSync(join(directory,'request-1.refusal.json'))).reason,/request model/);
  const temporary=JSON.parse(readFileSync(join(directory,'temporary-observation.json')));
  for(const readable of [join(directory,'protected'),join(temporary.stateRoot,'skills/.system')])assert.equal(readable.startsWith(temporary.tempRoot+'/'),false,'native witness must use the same disjoint temporary layout');
});
