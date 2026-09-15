import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hostArguments, observedHostEnvironment, runBounded } from './host.mjs';
import * as host from './host.mjs';
import * as runner from '../../scripts/evaluate-agent-behavior.mjs';

const options={support:'/support',schema:'/schema',lastMessage:'/last',model:'gpt-6-astra',toolEnv:{PATH:'/bin'}};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('native temporary storage is a reusable owned leaf and rejects substituted paths',t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'afk-native-temp-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const leaf=host.prepareNativeTempRoot(root);
  assert.equal(leaf,join(root,'native-tmp'));assert.equal(host.prepareNativeTempRoot(root),leaf);
  rmSync(leaf,{recursive:true});writeFileSync(leaf,'not a directory');
  assert.throws(()=>host.prepareNativeTempRoot(root),/confined|EEXIST/);
  rmSync(leaf);symlinkSync(root,leaf,'dir');
  assert.throws(()=>host.prepareNativeTempRoot(root),/confined|EEXIST/);
});
test('shared launcher preserves complete legacy first/resume argv and runner exports',()=>{
  assert.equal(runner.hostArguments,hostArguments);assert.equal(runner.runBounded,runBounded);
  assert.equal(hash(hostArguments(options)),'1b2538431a5d0f366d6b12d9baa320a7844ab656e3a6126203bbf13ba3d9f7ea');
  assert.equal(hash(hostArguments({...options,resume:'retained-session'})),'091615f7eaf5027215172bcbb8ede0acda99d91f6c79e78704ff6b01950d4dcb');
});
test('observed launcher fixes local provider and keeps token out of arguments',()=>{
  const observer={url:'http://127.0.0.1:12345/backend-api/codex/responses',readRoots:['/owned-probe']};
  const args=hostArguments({...options,observer,resume:'retained-session'});
  assert.deepEqual(args.slice(-2),['retained-session','-']);
  assert.ok(args.includes('model_provider="afk-observed"'));
  const provider=args.find(x=>x.startsWith('model_providers.'));
  for(const text of ['AFK_OBSERVED_LOCAL_TOKEN','request_max_retries=0','stream_max_retries=0','supports_websockets=false','requires_openai_auth=false'])assert.ok(provider.includes(text),text);
  assert.ok(args.some(x=>x.includes('"/owned-probe"="read"')));
  assert.ok(args.includes('web_search="disabled"'));
  for(const url of ['https://example.com/responses','http://localhost:123/responses','http://127.0.0.1:123/responses?x=1','http://127.0.0.1:123/responses'])assert.throws(()=>hostArguments({...options,observer:{...observer,url}}),/observed/);
  assert.throws(()=>hostArguments({...options,observer:{...observer,readRoots:['/']}}),/read root/);
});
test('observed child environment is explicit and nested tools do not inherit local credentials',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'afk-observed-env-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const env=observedHostEnvironment({stateRoot:root,tempRoot:root,localToken:'synthetic-local-only'});
  assert.equal(env.AFK_OBSERVED_LOCAL_TOKEN,'synthetic-local-only');assert.equal(env.CODEX_HOME,root);
  assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.HOME,undefined);
  const observed=await runBounded(process.execPath,['-e','console.log(JSON.stringify(process.env))'],{cwd:root,env,timeoutMs:2000,graceMs:100,maxBytes:10000});
  assert.equal(observed.cleanup,true);assert.equal(observed.code,0);const actual=JSON.parse(observed.stdout);if(process.platform==='darwin')delete actual.__CF_USER_TEXT_ENCODING;assert.deepEqual(actual,env);
  const args=hostArguments({...options,observer:{url:'http://127.0.0.1:123/v1/responses',readRoots:[]}});
  assert.equal(args.find(x=>x.startsWith('shell_environment_policy=')).includes('AFK_OBSERVED_LOCAL_TOKEN'),false);
});
