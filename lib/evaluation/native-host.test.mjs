import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nativeHostIdentity, observeNativeCatalog, provisionNativeCatalog, verifyNativeCatalog } from './native-host.mjs';
import { decodeNativeRequest } from './native-wire.mjs';
import { createFixture } from './scenarios.mjs';
import { captureMeasurementSources } from '../../scripts/evaluate-agent-behavior.mjs';

function setup(t){const root=realpathSync(mkdtempSync(join(tmpdir(),'afk-native-catalog-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const fixture=createFixture({directory:join(root,'workspace'),scenarioId:'S1'}),support=join(root,'support');
  mkdirSync(join(support,'skills/afk/references'),{recursive:true});writeFileSync(join(support,'skills/afk/SKILL.md'),'---\nname: afk\ndescription: Synthetic catalog test.\n---\nRead references/owned.md.\n');writeFileSync(join(support,'skills/afk/references/owned.md'),'Exact synthetic source.\n');
  const catalog=provisionNativeCatalog({workspace:fixture.directory,support});return {root,fixture,support,catalog};
}
test('verified native links coexist with snapshots without following support into the subject',t=>{
  const {fixture,catalog}=setup(t);const verified=verifyNativeCatalog(catalog);assert.deepEqual(verified.links,['.agents/skills/afk']);
  const capture=captureMeasurementSources({workspace:fixture.directory,head:fixture.current,nativeCatalog:catalog});
  assert.equal(capture.snapshot.files['.agents/skills/afk'],undefined);assert.ok(capture.files['src/reserve.mjs']);
  assert.equal(capture.catalogDigest,verified.digest);
  assert.throws(()=>captureMeasurementSources({workspace:fixture.directory,head:fixture.current}),/symlink/);
});
for(const change of ['extra','missing','retarget','source','ancestor','arbitrary'])test(`catalog ${change} refuses capture`,t=>{
  const {root,fixture,support,catalog}=setup(t),link=join(fixture.directory,'.agents/skills/afk');
  if(change==='extra')symlinkSync(join(support,'skills/afk'),join(fixture.directory,'.agents/skills/extra'));
  if(change==='missing')unlinkSync(link);
  if(change==='retarget'){unlinkSync(link);symlinkSync(root,link);}
  if(change==='source')writeFileSync(join(support,'skills/afk/references/owned.md'),'Changed source.\n');
  if(change==='ancestor'){rmSync(join(fixture.directory,'.agents'),{recursive:true});symlinkSync(support,join(fixture.directory,'.agents'));}
  if(change==='arbitrary')symlinkSync(support,join(fixture.directory,'arbitrary'));
  assert.throws(()=>captureMeasurementSources({workspace:fixture.directory,head:fixture.current,nativeCatalog:catalog}),/catalog|symlink/);
});
test('unknown native entry point cannot acquire the reviewed host profile',t=>{
  const {root}=setup(t),binary=join(root,'unknown-codex');writeFileSync(binary,'Synthetic unknown host.\n');
  assert.throws(()=>nativeHostIdentity(binary),/native host/);
});
test('catalog support must be outside the writable workspace even with a dot-prefixed name',t=>{
  const {fixture}=setup(t);
  for(const name of ['support','..support']){const support=join(fixture.directory,name);mkdirSync(support);
    assert.throws(()=>provisionNativeCatalog({workspace:fixture.directory,support}),/support inside writable workspace/);
  }
});
test('native catalog binds displayed bodies separately from unadvertised disk bodies',t=>{
  const {root,fixture,catalog}=setup(t),stateRoot=join(root,'native-state'),builtin=join(stateRoot,'skills/.system');
  for(const name of ['visible','hidden']){mkdirSync(join(builtin,name),{recursive:true});writeFileSync(join(builtin,name,'SKILL.md'),`Synthetic ${name} source.\n`);}
  const text=`<skills_instructions>\n## Skills\n### Skill roots\n- \`r0\` = \`${builtin}\`\n- \`r1\` = \`${fixture.directory}/.agents/skills\`\n### Available skills\n- visible: Synthetic visible skill. (file: r0/visible/SKILL.md)\n- afk-skills:afk: Synthetic selected skill. (file: r1/afk/SKILL.md)\n</skills_instructions>`;
  const request=decodeNativeRequest(Buffer.from(JSON.stringify({model:'gpt-6-astra',input:[{role:'developer',content:text}]})),{maxBytes:100000});
  const observed=observeNativeCatalog({request,catalog,stateRoot});assert.equal(observed.complete,true);assert.equal(observed.entries.length,2);
  assert.equal(observed.unadvertisedBodies.length,1);assert.equal(observed.unadvertisedBodies[0].path,join(builtin,'hidden/SKILL.md'));
  assert.throws(()=>observeNativeCatalog({request:{...request,instructions:[...request.instructions,...request.instructions]},catalog,stateRoot}),/instruction block/);
});
