import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { release } from 'node:os';
import { evaluatorRuntime } from './runtime.mjs';
import { canonicalBytes, digestBytes } from '../gate/review-receipt.mjs';
import { assertFixtureDirectory, readFixtureFile, LIMITS } from './scenarios.mjs';

const CATALOG_LIMITS=Object.freeze({entries:4096,bytes:16777216});
const REVIEWED_NATIVE=Object.freeze({
  'bin/codex':'b973d440acac501fd2594a43e7ca9ce41e0a65b9dfb28d0d7a7837c99e1261e3',
  'bin/codex-code-mode-host':'d8a2222e017342718d16a5dbe092921c628961f812f62f42036b8d960e1ffe56',
  'codex-package.json':'d9ca6b160a46bf8e06748df83ccadb91418ded2d1c35045518b7305f866c9a54',
  'codex-path/rg':'3969d598288585478bd9b2fd6c9f7e120b711cf96c5a03844d0197ea6abec346',
  'codex-resources/zsh/bin/zsh':'712ebaa416a7505fe6719ba99440ae3125423ce46d42d0174963553d81f3f8f1',
});
export function nativeHostIdentity(codex){
  try{
    if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('unreviewed platform');
    const binary=isAbsolute(codex)?codex:(process.env.PATH||'').split(':').map(path=>join(path,codex)).find(path=>existsSync(path));
    const launcher=realpathSync(binary),packageRoot=dirname(dirname(launcher));
    const packagePath=join(packageRoot,'package.json'),metadata=JSON.parse(readFileSync(packagePath,'utf8'));
    if(metadata.name!=='@openai/codex'||metadata.version!=='0.153.4'||digestBytes(readFileSync(launcher))!=='61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70')throw new Error('unreviewed launcher');
    const platformPackage=createRequire(launcher).resolve('@openai/codex-darwin-arm64/package.json');
    const vendor=join(dirname(platformPackage),'vendor/aarch64-apple-darwin'),files={};
    function visit(directory){for(const entry of readdirSync(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())visit(path);else{if(!entry.isFile())throw new Error('nonregular distribution');files[relative(vendor,path)]=digestBytes(readFileSync(path));}}}
    visit(vendor);if(canonicalBytes(files)!==canonicalBytes(REVIEWED_NATIVE))throw new Error('unreviewed distribution bytes');
    const identity={version:'0.153.4',platform:process.platform,architecture:process.arch,osRelease:release(),files,
      launcher:digestBytes(readFileSync(launcher)),package:digestBytes(readFileSync(packagePath)),platformPackage:digestBytes(readFileSync(platformPackage)),node:digestBytes(readFileSync(process.execPath)),runtime:evaluatorRuntime().digest};
    return {...identity,digest:digestBytes(canonicalBytes(identity))};
  }catch(error){throw new Error(`native host identity unavailable: ${error.message}`);}
}
function requireCatalog(value,reason){if(!value)throw new Error(`native catalog ${reason}`);}
function outsideWorkspace(workspace,support){const path=relative(workspace,support).split('\\').join('/');return path==='..'||path.startsWith('../')||isAbsolute(path);}
function supportSources(support){
  assertFixtureDirectory(support);const sources={};let entries=0,bytes=0;
  function visit(directory){assertFixtureDirectory(support,directory);
    for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      requireCatalog(++entries<=CATALOG_LIMITS.entries,'entry bound');const path=join(directory,entry.name),stat=lstatSync(path);
      requireCatalog(!stat.isSymbolicLink(),'source symlink');
      if(stat.isDirectory()){visit(path);continue;}
      requireCatalog(stat.isFile(),'source nonregular');const value=readFixtureFile(support,path,{maxBytes:Math.min(LIMITS.outputBytes,CATALOG_LIMITS.bytes-bytes)});bytes+=value.length;
      requireCatalog(bytes<=CATALOG_LIMITS.bytes,'source byte bound');sources[relative(support,path)]={digest:digestBytes(value),mode:stat.mode&0o777};
    }
  }visit(support);return sources;
}
function catalogDigest({version,workspace,support,entries,sources}){return digestBytes(canonicalBytes({version,workspace,support,entries,sources}));}
export function provisionNativeCatalog({workspace,support}){
  workspace=realpathSync(workspace);support=realpathSync(support);
  requireCatalog(outsideWorkspace(workspace,support),'support inside writable workspace');
  assertFixtureDirectory(workspace);assertFixtureDirectory(support);
  const sources=supportSources(support),entries={};
  for(const path of Object.keys(sources)){
    const match=/^skills\/([a-z][a-z0-9-]*)\/SKILL\.md$/.exec(path);if(!match)continue;
    const name=match[1];entries[name]={link:`.agents/skills/${name}`,target:join(support,'skills',name)};
  }
  requireCatalog(Object.keys(entries).length>0,'no selected skills');
  mkdirSync(join(workspace,'.agents'),{mode:0o700});mkdirSync(join(workspace,'.agents/skills'),{mode:0o700});
  for(const entry of Object.values(entries))symlinkSync(entry.target,join(workspace,entry.link),'dir');
  const record={version:1,workspace,support,entries,sources};record.digest=catalogDigest(record);verifyNativeCatalog(record);return record;
}
export function verifyNativeCatalog(record){
  requireCatalog(record&&Object.keys(record).sort().join(',')==='digest,entries,sources,support,version,workspace','binding shape');
  requireCatalog(record.version===1&&record.digest===catalogDigest(record),'binding digest');
  const {workspace,support,entries,sources}=record;
  requireCatalog([workspace,support].every(path=>typeof path==='string'&&isAbsolute(path)&&resolve(path)===path),'root identity');
  requireCatalog(outsideWorkspace(workspace,support),'support inside writable workspace');
  assertFixtureDirectory(workspace);assertFixtureDirectory(support);
  for(const path of ['.agents','.agents/skills']){
    const stat=lstatSync(join(workspace,path));requireCatalog(stat.isDirectory()&&!stat.isSymbolicLink(),'ancestor replaced');
  }
  const names=Object.keys(entries).sort(),actual=readdirSync(join(workspace,'.agents/skills')).sort();
  requireCatalog(names.length>0&&canonicalBytes(names)===canonicalBytes(actual),'entry set changed');
  for(const name of names){
    const entry=entries[name],path=join(workspace,'.agents/skills',name),target=join(support,'skills',name);
    requireCatalog(/^[a-z][a-z0-9-]*$/.test(name)&&entry.link===`.agents/skills/${name}`&&entry.target===target,'entry identity');
    requireCatalog(lstatSync(path).isSymbolicLink()&&readlinkSync(path)===target&&realpathSync(path)===target,'link changed');
    assertFixtureDirectory(support,target);requireCatalog(sources[`skills/${name}/SKILL.md`],'missing skill source');
  }
  requireCatalog(canonicalBytes(supportSources(support))===canonicalBytes(sources),'source bytes changed');
  return {digest:record.digest,links:names.map(name=>entries[name].link)};
}
export function observeNativeCatalog({request,catalog,stateRoot}){
  verifyNativeCatalog(catalog);assertFixtureDirectory(stateRoot);
  const builtinRoot=join(stateRoot,'skills/.system');
  const builtinNames=readdirSync(builtinRoot,{withFileTypes:true}).filter(row=>row.isDirectory()).map(row=>row.name).sort();
  return projectNativeCatalog({request,catalog,stateRoot,builtinNames,readSource:(root,path)=>readFixtureFile(root,path)});
}
export function projectNativeCatalog({request,catalog,stateRoot,builtinNames,readSource}){
  requireCatalog(Array.isArray(builtinNames)&&builtinNames.length>0&&new Set(builtinNames).size===builtinNames.length
    &&builtinNames.every(name=>/^[a-z][a-z0-9-]*$/.test(name)),'builtin source census');
  const blocks=request.instructions.filter(row=>row.role==='developer'&&row.text.includes('<skills_instructions>'));
  requireCatalog(blocks.length===1,'native instruction block unavailable');
  const text=blocks[0].text,sections=[...text.matchAll(/<skills_instructions>\n([\s\S]*?)\n<\/skills_instructions>/g)];
  requireCatalog(sections.length===1,'native instruction framing');
  const parts=sections[0][1].split('### Available skills\n');requireCatalog(parts.length===2,'native entry framing');
  const roots={};for(const match of parts[0].matchAll(/^- `(r\d+)` = `([^`\n]+)`$/gm)){requireCatalog(!roots[match[1]],'duplicate native root');roots[match[1]]=match[2];}
  const nativeRoot=join(catalog.workspace,'.agents/skills'),builtinRoot=join(stateRoot,'skills/.system');
  requireCatalog(Object.values(roots).length===2&&Object.values(roots).includes(nativeRoot)&&Object.values(roots).includes(builtinRoot),'native roots changed');
  const entries=[],paths=new Set();
  for(const line of parts[1].trim().split('\n')){
    const match=/^- (.+?): (.+) \(file: (r\d+)\/([a-z][a-z0-9-]*\/SKILL\.md)\)$/.exec(line);
    requireCatalog(match&&roots[match[3]],'native entry unavailable');const [,name,description,alias,path]=match,root=roots[alias],kind=root===nativeRoot?'selected':'builtin';
    const full=kind==='selected'?join(catalog.support,'skills',path):join(builtinRoot,path),key=kind+'/'+path;
    requireCatalog(!paths.has(key),'duplicate native skill');paths.add(key);
    const sourceRoot=kind==='selected'?catalog.support:builtinRoot;
    const bytes=readSource(sourceRoot,full);entries.push({name,description,path:full,kind,sourceDigest:digestBytes(bytes)});
  }
  const selected=entries.filter(row=>row.kind==='selected').map(row=>relative(join(catalog.support,'skills'),row.path).split('/')[0]).sort();
  requireCatalog(canonicalBytes(selected)===canonicalBytes(Object.keys(catalog.entries).sort()),'native skill set changed');
  const unadvertisedBodies=builtinNames.filter(name=>!paths.has(`builtin/${name}/SKILL.md`)).map(name=>{
    const path=join(builtinRoot,name,'SKILL.md');return {path,sourceDigest:digestBytes(readSource(builtinRoot,path)),visibility:'not-in-observed-catalog'};
  });
  const record={native:true,complete:true,source:blocks[0].source,sourceDigest:blocks[0].digest,requestDigest:request.bodyDigest,entries,unadvertisedBodies};
  return {...record,digest:digestBytes(canonicalBytes(record))};
}
