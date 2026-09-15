import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EVALUATOR_RUNTIME_FILES, evaluatorRuntime } from './runtime.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
test('finite inventory includes the full local ESM dependency closure',()=>{
  const script=`import{SourceTextModule}from'node:vm';import{readFileSync}from'node:fs';import{dirname,relative,resolve}from'node:path';const root=process.argv[1],seen=new Set();function visit(path){if(seen.has(path))return;seen.add(path);const m=new SourceTextModule(readFileSync(resolve(root,path),'utf8'));for(const spec of m.dependencySpecifiers)if(spec.startsWith('.'))visit(relative(root,resolve(root,dirname(path),spec)));}for(const p of ['scripts/evaluate-agent-behavior.mjs','lib/evaluation/native-recorder.mjs'])visit(p);console.log(JSON.stringify([...seen]));`;
  const seen=JSON.parse(execFileSync(process.execPath,['--experimental-vm-modules','--disable-warning=ExperimentalWarning','--input-type=module','-e',script,root],{encoding:'utf8',timeout:10000}));
  for(const path of seen)assert.ok(EVALUATOR_RUNTIME_FILES.includes(path),path);
  assert.equal(new Set(EVALUATOR_RUNTIME_FILES).size,EVALUATOR_RUNTIME_FILES.length);
  assert.equal(Object.keys(evaluatorRuntime().files).length,EVALUATOR_RUNTIME_FILES.length);
});
test('executed runtime digest covers host and transitive dependency bytes',t=>{
  const copy=mkdtempSync(join(tmpdir(),'afk-runtime-'));t.after(()=>rmSync(copy,{recursive:true,force:true}));
  for(const path of EVALUATOR_RUNTIME_FILES){mkdirSync(dirname(join(copy,path)),{recursive:true});writeFileSync(join(copy,path),readFileSync(join(root,path)));}
  const before=evaluatorRuntime(copy);assert.equal(before.digest,evaluatorRuntime().digest);
  for(const path of ['lib/evaluation/host.mjs','lib/gate/protocol.mjs']){
    const bytes=readFileSync(join(copy,path));writeFileSync(join(copy,path),Buffer.concat([bytes,Buffer.from('\n')]));assert.notEqual(evaluatorRuntime(copy).digest,before.digest);writeFileSync(join(copy,path),bytes);
  }
});
