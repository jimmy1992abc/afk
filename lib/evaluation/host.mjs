import { spawn } from 'node:child_process';
import { NATIVE_RESPONSE_ROUTES } from './native-wire.mjs';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { assertFixtureDirectory, fixtureEnv, readFixtureFile, LIMITS } from './scenarios.mjs';

function requireEvaluation(ok,reason){if(!ok)throw new Error(`issue112 ${reason}`);}
function decodeOriginalUtf8(bytes){return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
// Xcode's Git avoids the system shim's denied global discovery cache.
const GIT_DIRECTORIES = process.platform === 'darwin'
  ? ['/Applications/Xcode.app/Contents/Developer/usr/bin','/Library/Developer/CommandLineTools/usr/bin'].filter((path)=>existsSync(join(path,'git'))) : [];
export const EVALUATION_PATH = [...GIT_DIRECTORIES,'/usr/bin','/bin','/usr/sbin','/sbin',dirname(process.execPath)].join(':');
export const FEATURES = ['multi_agent','apps','plugins','hooks','computer_use','browser_use','image_generation',
  'remote_plugin','skill_mcp_dependency_install','workspace_dependencies','goals','unbounded_connection_retries'];

export function runBounded(command, args, { cwd, env = process.env, input = '', timeoutMs = LIMITS.invocationMs,
  maxBytes = LIMITS.outputBytes, graceMs = LIMITS.graceMs, signal, strictBytes = false, deadline } = {}) {
  if(deadline!==undefined){requireEvaluation(Number.isFinite(deadline)&&deadline-Date.now()>2*graceMs&&timeoutMs>0,'execution deadline exhausted');timeoutMs=Math.min(timeoutMs,deadline-Date.now()-2*graceMs);}
  if (process.platform === 'win32') throw new Error('this bounded pilot requires POSIX process groups');
  return new Promise((done) => {
    const start = Date.now(); let status = 'completed', code = null, childSignal = null, count = 0, finishing = false;
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe','pipe','pipe'] });
    const alive = () => { try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
    const kill = (kind) => { if (!child.pid) return; try { process.kill(-child.pid, kind); } catch (error) { if (error.code !== 'ESRCH') status = 'cleanup-error'; } };
    const finish = async () => {
      if (finishing) return; finishing = true; clearTimeout(timer);
      signal?.removeEventListener('abort', interrupt);
      if (child.pid && alive()) {
        kill('SIGTERM');
        const until = Date.now() + graceMs;
        while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
        if (alive()) kill('SIGKILL');
        const reaped = Date.now() + graceMs;
        while (alive() && Date.now() < reaped) await new Promise((r) => setTimeout(r, 10));
      }
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      let out=stdout.toString('utf8'),err=stderr.toString('utf8'),raw={};
      if(strictBytes){let utf8Valid=true;try{out=decodeOriginalUtf8(stdout);err=decodeOriginalUtf8(stderr);}catch{utf8Valid=false;out=null;err=null;if(status==='completed')status='invalid-utf8';}
        raw={stdoutBase64:stdout.toString('base64'),stderrBase64:stderr.toString('base64'),utf8Valid};}
      done({ status, code, signal: childSignal, cleanup: !child.pid || !alive(),stdout:out,stderr:err,...raw,bytes:count,durationMs:Date.now()-start });
    };
    const collect = (which, data) => {
      const kept = data.subarray(0, Math.max(0, maxBytes - count)); count += data.length;
      if (which === 'stdout') stdout = Buffer.concat([stdout, kept]); else stderr = Buffer.concat([stderr, kept]);
      if (count > maxBytes && !finishing) { status = 'output-limit'; void finish(); }
    };
    const interrupt = () => { if (!finishing) { status = 'interrupted'; void finish(); } };
    const timer = setTimeout(() => { status = 'timeout'; void finish(); }, timeoutMs);
    child.stdout.on('data', (data) => collect('stdout', data)); child.stderr.on('data', (data) => collect('stderr', data));
    child.on('error', (error) => { status = error.code === 'ENOENT' ? 'unavailable' : 'spawn-error'; void finish(); });
    child.on('exit', (value, sig) => { code = value; childSignal = sig; void finish(); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
    signal?.addEventListener('abort', interrupt, { once: true }); if (signal?.aborted) interrupt();
  });
}
export function permissionArgs(support, readRoots = []) {
  const filesystem = { ':root':'deny', ':minimal':'read', ':tmpdir':'deny', ':slash_tmp':'deny',
    ':workspace_roots': { '.git':'write' }, '/System/Library/OpenSSL/openssl.cnf':'read', [support]:'read', ...Object.fromEntries(readRoots.map(root=>[root,'read'])) };
  const toml = (value) => typeof value === 'object' ? `{${Object.entries(value).map(([k,v]) => `${JSON.stringify(k)}=${toml(v)}`).join(',')}}` : JSON.stringify(value);
  return ['-c','permissions.afk-eval.extends=":workspace"','-c',`permissions.afk-eval.filesystem=${toml(filesystem)}`,
    '-c','permissions.afk-eval.network.enabled=false'];
}
export function shellEnvironmentArgs(toolEnv) {
  return ['-c',`shell_environment_policy={inherit="none",ignore_default_excludes=false,set={${Object.entries(toolEnv).map(([k,v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(',')}},filters={${Object.keys(toolEnv).map((key)=>`${JSON.stringify(key)}="include"`).join(',')}}}`,'-c','allow_login_shell=false'];
}
export function hostArguments({ support, schema, lastMessage, model, resume, toolEnv = {}, observer }) {
  if (!['gpt-6-astra','gpt-5.6-sol'].includes(model)) throw new Error('model is outside the frozen pilot');
  if (resume != null && (typeof resume !== 'string' || !resume || resume.startsWith('-'))) throw new Error('recorded session ID is required');
  const observed=observer===undefined?null:observedOptions(observer);
  return ['exec', ...(resume ? ['resume'] : []), '--ignore-user-config','--ignore-rules','--json',
    '--model',model,'--output-schema',schema,'--output-last-message',lastMessage,
    '-c','model_reasoning_effort="medium"','-c','approval_policy="never"','-c','default_permissions="afk-eval"',
    ...permissionArgs(support,observed?.readRoots), ...FEATURES.flatMap((feature) => ['-c',`features.${feature}=false`]),
    ...shellEnvironmentArgs(toolEnv),
    ...(observed ? observed.arguments : []),
    ...(resume ? [resume] : []), '-'];
}

export function toolEnvironment(workspace) {
  assertFixtureDirectory(workspace);
  const absent=readFixtureFile(workspace,join(workspace,'.afk/absent-prerequisite'),{missing:true}).length>0;
  return fixtureToolEnvironment(workspace,{absent});
}
export function fixtureToolEnvironment(workspace,{absent=false}={}) {
  return fixtureEnv({PATH:EVALUATION_PATH,TMPDIR:join(workspace,'.afk/tmp'),AFK_UPDATE_CHECK:'off',
    CLAUDE_GATE_BIN:join(workspace,'.afk',absent?'absent-claude':'fixture-cli.sh')});
}
// The launcher accepts exactly the loopback paths the recorder serves, one per supported auth mode.
const OBSERVED_ROUTE_PATHS=Object.values(NATIVE_RESPONSE_ROUTES).map(route=>new URL(route).pathname);
function observedOptions(observer) {
  requireEvaluation(observer&&Object.keys(observer).sort().join(',')==='readRoots,url','invalid observed options');
  const url=new URL(observer.url);
  requireEvaluation(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&OBSERVED_ROUTE_PATHS.includes(url.pathname),'invalid observed collector URL');
  requireEvaluation(Array.isArray(observer.readRoots)&&new Set(observer.readRoots).size===observer.readRoots.length&&observer.readRoots.every(root=>typeof root==='string'&&isAbsolute(root)&&resolve(root)===root&&root!=='/'),'invalid observed read root');
  const base=url.href.slice(0,-'/responses'.length);
  return {readRoots:observer.readRoots,arguments:['-c','model_provider="afk-observed"','-c',`model_providers.afk-observed={name="AFK Observed Native",base_url=${JSON.stringify(base)},env_key="AFK_OBSERVED_LOCAL_TOKEN",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0,supports_websockets=false}`,'-c','web_search="disabled"']};
}
export function prepareNativeTempRoot(root) {
  assertFixtureDirectory(root);
  const path=join(root,'native-tmp');
  try{mkdirSync(path,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  assertFixtureDirectory(root,path);return path;
}
export function observedHostEnvironment({stateRoot,tempRoot,localToken}) {
  requireEvaluation([stateRoot,tempRoot].every(path=>typeof path==='string'&&isAbsolute(path))&&typeof localToken==='string'&&localToken.length>0&&!/[\x00-\x20\x7f]/.test(localToken),'invalid observed environment');
  assertFixtureDirectory(stateRoot);assertFixtureDirectory(tempRoot);
  return {PATH:EVALUATION_PATH,CODEX_HOME:stateRoot,TMPDIR:tempRoot,AFK_OBSERVED_LOCAL_TOKEN:localToken,OTEL_SDK_DISABLED:'true',AFK_UPDATE_CHECK:'off'};
}
