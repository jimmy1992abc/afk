import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { basename, dirname, join } from 'node:path';
import { digestBytes } from '../gate/review-receipt.mjs';
import { decodeNativeRequest, decodeNativeResponse, wireBound, nativeDeclarationDigest, checkNativeRelease, nativeJsonBytes, NATIVE_RESPONSE_ROUTES, NATIVE_RECORD_LIMIT } from './native-wire.mjs';

const OPTIONS=['directory','authMode','credential','declarationDigest','maxRequests','maxBytes','concurrency','deadline','requestTimeoutMs','reserve'];
const FORWARD_HEADERS=['session_id','conversation_id','x-codex-turn-state','x-codex-turn-metadata','openai-beta','originator'];
const failure=reason=>Object.assign(new Error(reason),{wireReason:reason});

export async function createNativeRecorder(options) {
  if(Object.keys(options).some(key=>!OPTIONS.includes(key))) throw new Error('unsupported option');
  const {authMode,credential,declarationDigest,maxRequests,maxBytes,concurrency,deadline,requestTimeoutMs,reserve}=options;
  if(maxRequests!==null) wireBound(maxRequests);
  for(const bound of [maxBytes,deadline,requestTimeoutMs]) wireBound(bound);
  if(concurrency!==1) throw new Error('single concurrency required');
  if(deadline<=Date.now()) throw new Error('future deadline bound required');
  if(typeof reserve!=='function') throw new Error('reservation callback required');
  if(!Object.hasOwn(NATIVE_RESPONSE_ROUTES,authMode)) throw new Error('unsupported auth mode');
  const header=value=>typeof value==='string'&&/^[\x21-\x7e]+$/.test(value);
  if(!credential||Array.isArray(credential)||typeof credential!=='object'
    ||Object.keys(credential).some(key=>!['bearer','accountId'].includes(key))||!header(credential.bearer)
    ||Object.hasOwn(credential,'accountId')&&(!header(credential.accountId)||authMode!=='chatgpt')) throw new Error('invalid credential');
  const bearer=credential.bearer,accountId=credential.accountId;
  const localToken=randomBytes(32).toString('hex'),localBytes=Buffer.from(localToken);
  const secrets=[Buffer.from(bearer),localBytes];
  const sensitive=bytes=>secrets.some(secret=>bytes.includes(secret));
  if(declarationDigest!==undefined&&(typeof declarationDigest!=='string'||!/^[a-f0-9]{64}$/.test(declarationDigest))) throw new Error('invalid declaration digest');
  const directory=join(realpathSync(dirname(options.directory)),basename(options.directory));
  mkdirSync(directory,{mode:0o700});
  const put=(name,value)=>writeFileSync(join(directory,name),Buffer.isBuffer(value)?value:nativeJsonBytes(value),{flag:'wx',mode:0o600});
  put('configuration.json',{version:1,authMode,upstream:NATIVE_RESPONSE_ROUTES[authMode],maxRequests,maxBytes,concurrency,deadline,requestTimeoutMs,
    declarationDigest:declarationDigest??null,claim:'Wire evidence only; no host qualification or campaign authority is conferred.'});
  let stopped=false,latched=null,ordinal=0,active=null,stopPromise=null;
  const tasks=new Set();
  function latch(reason) {
    if(latched) return;
    latched=reason;
    try {put('refusal.json',{version:1,reason,at:Date.now()});}
    catch {latched='refusal-publication-failed';}
  }
  const available=()=>!stopped&&!latched&&Date.now()<deadline;
  const check=()=>{if(!available())throw failure(stopped?'collector-stopped':latched??'collector-deadline');};
  const reply=(res,status,body)=>{if(!res.destroyed&&!res.writableEnded){res.writeHead(status,{'content-type':status===200?'text/event-stream':'application/json'});res.end(body);}};
  function read(stream,context,field) {
    return new Promise((resolve,reject)=>{
      stream.on('data',chunk=>{
        context[`${field}Count`]+=chunk.length;
        const left=Math.max(0,maxBytes-context[field].length);
        context[field]=Buffer.concat([context[field],chunk.subarray(0,left)]);
        if(context[`${field}Count`]>maxBytes) reject(failure(`${field}-byte-limit`));
      });
      stream.once('end',()=>{context[`${field}Complete`]=context[`${field}Count`]<=maxBytes;resolve(context[field]);});
      stream.once('aborted',()=>reject(failure(`${field}-aborted`)));
      stream.once('error',()=>reject(failure(`${field}-transport-error`)));
    });
  }
  async function handle(req,res) {
    if(!available()||active||ordinal>=NATIVE_RECORD_LIMIT||maxRequests!==null&&ordinal>=maxRequests) {
      const reason=stopped?'collector-stopped':latched??(active?'concurrent-request':ordinal>=NATIVE_RECORD_LIMIT?'record-count-limit':'request-limit');
      latch(reason);req.resume();reply(res,409,JSON.stringify({error:reason}));return;
    }
    const id=String(++ordinal).padStart(6,'0');
    let abort;
    const cancelled=new Promise((resolve,reject)=>{abort=reason=>{latch(reason);reject(failure(reason));};});
    const context={id,input:Buffer.alloc(0),output:Buffer.alloc(0),inputCount:0,outputCount:0,inputComplete:false,outputComplete:false,
      inputPublished:false,outputPublished:false,credential:null,forwarded:false,upstream:null,
      reservation:null,observation:null,release:null,status:null,responseMetadata:null,reason:null,request:null,cancel:abort};
    active=context;
    const timer=setTimeout(()=>abort('request-timeout'),Math.min(requestTimeoutMs,deadline-Date.now()));
    req.once('aborted',()=>abort('client-disconnected'));
    res.once('close',()=>{if(!res.writableEnded)abort('client-disconnected');});
    let responseBody;
    try {
      put(`${id}-started.json`,{version:1,ordinal,startedAt:Date.now()});
      responseBody=await Promise.race([cancelled,(async()=>{
        const expected=new URL(NATIVE_RESPONSE_ROUTES[authMode]).pathname;
        if(req.method!=='POST'||req.url!==expected||req.headers['content-encoding']&&req.headers['content-encoding']!=='identity'
          ||!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')) throw failure('unsupported-request');
        if(typeof req.headers.authorization!=='string'||!/^Bearer \S+$/.test(req.headers.authorization)) throw failure('authentication-missing');
        const token=req.headers.authorization.slice(7);
        const received=Buffer.from(token);
        if(received.length!==localBytes.length||!timingSafeEqual(received,localBytes)) throw failure('authentication-invalid');
        context.credential=token;
        const bytes=await read(req,context,'input');check();
        if(sensitive(bytes)) throw failure('credential-in-body');
        const decoded=decodeNativeRequest(bytes,{maxBytes});
        if(decoded.status!=='observed') throw failure('request-uninterpretable');
        context.request=decoded;
        if(declarationDigest!==undefined){
          let observed;try{observed=nativeDeclarationDigest(decoded);}catch{throw failure('declaration-mismatch');}
          if(observed!==declarationDigest)throw failure('declaration-mismatch');
        }
        put(`${id}-request.json`,bytes);context.inputPublished=true;
        try {context.reservation=await reserve({ordinal:Number(id),model:decoded.model,requestDigest:digestBytes(bytes),startedAt:Date.now()});}
        catch {throw failure('reservation-failed');}
        check();
        if(!context.reservation||typeof context.reservation.id!=='string'||!/^[a-zA-Z0-9._-]{1,100}$/.test(context.reservation.id)) throw failure('reservation-invalid');
        put(`${id}-dispatch.json`,{reservationId:context.reservation.id,requestDigest:digestBytes(bytes),at:Date.now()});
        check();
        const headers={'content-type':'application/json','content-length':String(bytes.length),'accept':'text/event-stream','accept-encoding':'identity'};
        headers.authorization=`Bearer ${bearer}`;
        if(accountId!==undefined)headers['chatgpt-account-id']=accountId;
        for(const name of FORWARD_HEADERS) if(typeof req.headers[name]==='string') headers[name]=req.headers[name];
        context.forwarded=true;
        const incoming=await new Promise((resolve,reject)=>{
          const upstream=https.request(NATIVE_RESPONSE_ROUTES[authMode],{method:'POST',headers},resolve);context.upstream=upstream;
          upstream.once('error',()=>reject(failure('upstream-transport-error')));upstream.end(bytes);
        });
        check();context.status=incoming.statusCode;
        const metadata={contentType:incoming.headers['content-type']??null,contentEncoding:incoming.headers['content-encoding']??null};
        if(sensitive(Buffer.from(nativeJsonBytes(metadata))))throw failure('credential-in-response-metadata');
        context.responseMetadata=metadata;
        const responseBytes=await read(incoming,context,'output');check();
        if(sensitive(responseBytes)) throw failure('credential-in-body');
        put(`${id}-response.body`,responseBytes);context.outputPublished=true;
        if(incoming.statusCode!==200) throw failure('upstream-status');
        if(incoming.headers['content-encoding']&&incoming.headers['content-encoding']!=='identity') throw failure('unsupported-response-encoding');
        context.observation=decodeNativeResponse(responseBytes,{maxBytes,responseMetadata:context.responseMetadata,transport:{upstream:NATIVE_RESPONSE_ROUTES[authMode],status:context.status},requestedModel:decoded.model});
        if(context.observation.status!=='observed') throw failure('response-uninterpretable');
        if(declarationDigest!==undefined){
          context.release=checkNativeRelease(context.observation,decoded);
          if(!context.release.allowed)throw failure('response-policy-denied');
        }
        return responseBytes;
      })()]);
    } catch(error) {
      context.reason=error.wireReason??'collector-io-error';latch(context.reason);
      context.upstream?.destroy();req.resume();
    } finally {
      clearTimeout(timer);
      try {
        for(const [field,name] of [['input','request'],['output','response']]) {
          if(context[field].length&&!context[`${field}Published`]&&context.credential&&!sensitive(context[field])) {
            put(`${id}-${name}.partial`,context[field]);
          }
        }
        put(`${id}-terminal.json`,{version:2,ordinal:Number(id),forwarded:context.forwarded,status:context.status,responseMetadata:context.responseMetadata,reason:context.reason,
          requestDigest:context.input.length?digestBytes(context.input):null,responseDigest:context.output.length?digestBytes(context.output):null,
          inputBytes:context.inputCount,outputBytes:context.outputCount,inputIncomplete:!context.inputComplete,outputIncomplete:!context.outputComplete,
          observation:context.observation,release:context.release,finishedAt:Date.now()});
      } catch {latch('terminal-publication-failed');context.reason??='terminal-publication-failed';}
      active=null;
    }
    if(context.reason) reply(res,context.forwarded||context.reservation||!['unsupported-request','authentication-missing','authentication-invalid','declaration-mismatch','input-byte-limit','request-uninterpretable','credential-in-body'].includes(context.reason)?502:400,JSON.stringify({error:context.reason}));
    else reply(res,200,responseBody);
  }
  const server=http.createServer((req,res)=>{
    const task=handle(req,res);tasks.add(task);task.catch(()=>{latch('unhandled-collector-error');res.destroy();}).finally(()=>tasks.delete(task));
  });
  server.on('upgrade',(req,socket)=>{latch('unsupported-upgrade');socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
  server.on('clientError',(error,socket)=>{latch('malformed-http');socket.destroy();});
  server.requestTimeout=Math.min(requestTimeoutMs,deadline-Date.now());
  server.headersTimeout=server.requestTimeout;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  let deadlineTimer;
  function stop() {
    if(stopPromise) return stopPromise;
    stopped=true;clearTimeout(deadlineTimer);active?.cancel('collector-stopped');active?.upstream?.destroy();
    stopPromise=(async()=>{
      const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();
      await Promise.allSettled([...tasks]);await closed;
      try{put('stopped.json',{version:1,requests:ordinal,reason:latched,stoppedAt:Date.now()});}
      catch{latch('stop-publication-failed');throw failure('stop-publication-failed');}
    })();return stopPromise;
  }
  deadlineTimer=setTimeout(()=>{latch('collector-deadline');void stop().catch(()=>latch('stop-publication-failed'));},deadline-Date.now());
  const path=new URL(NATIVE_RESPONSE_ROUTES[authMode]).pathname;
  return {url:`http://127.0.0.1:${server.address().port}${path}`,localToken,directory,stop};
}
