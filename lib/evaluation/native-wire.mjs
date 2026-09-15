import { digestBytes } from '../gate/review-receipt.mjs';
import { strictEvaluationJson } from './strict-json.mjs';

// Six-digit artifact names keep the retained request census unambiguous.
export const NATIVE_RECORD_LIMIT = 999999;

export const NATIVE_RESPONSE_ROUTES=Object.freeze({
  chatgpt:'https://chatgpt.com/backend-api/codex/responses',
  'api-key':'https://api.openai.com/v1/responses',
});

export function nativeJsonBytes(value) {
  return JSON.stringify(value,(_key,item)=>{
    if(typeof item==='number'&&!Number.isFinite(item))throw new Error('native JSON requires finite numbers');
    return item;
  });
}

export function resolveNativeCall(item,request) {
  const type=item.type==='custom_tool_call'?'custom':item.type==='function_call'?'function':null;
  if(!type||!nonempty(item.name))return null;
  const namespace=item.namespace??null;
  if(!request)return nonempty(namespace)?`${namespace}.${item.name}`:null;
  if(request.status!=='observed')return null;
  const matches=request.tools.filter(tool=>tool.type===type&&(namespace===null?tool.id.split('.').at(-1)===item.name:tool.id===`${namespace}.${item.name}`));
  return matches.length===1?matches[0].id:null;
}

export function wireBound(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('explicit positive wire bound required');
  return value;
}
function bodyText(bytes, maxBytes) {
  wireBound(maxBytes);
  if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes) throw new Error('wire body byte bound');
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const token = value => Number.isSafeInteger(value) && value >= 0;
const inertKeepalive = event => object(event) && event.type === 'keepalive' && token(event.sequence_number)
  && Object.keys(event).sort().join(',') === 'sequence_number,type';
const nonempty = value => typeof value === 'string' && value.length > 0;
const sourceDigest = value => digestBytes(JSON.stringify(value));
function requireWire(value, reason) { if (!value) throw new Error(reason); }

export function decodeNativeRequest(bytes, {maxBytes}) {
  wireBound(maxBytes);
  const result={status:'unavailable',reason:null,bodyDigest:Buffer.isBuffer(bytes)?digestBytes(bytes):null,
    model:null,tools:[],declarationDigests:[],instructions:[],assistantMessages:[],calls:[],outputs:[],opaque:[],registryWitnesses:[],inventoryQualified:false};
  try {
    const body=strictEvaluationJson(bodyText(bytes,maxBytes));nativeJsonBytes(body);
    requireWire(object(body)&&nonempty(body.model),'request model missing'); result.model=body.model;
    const ids=new Set(),pendingCalls=[];
    function tools(rows,source,namespace='') {
      requireWire(Array.isArray(rows),'tool declaration array missing');
      for (const [index,row] of rows.entries()) {
        const path=`${source}/${index}`;
        requireWire(object(row)&&nonempty(row.type),'invalid tool declaration');
        if(row.type==='namespace') {
          requireWire(nonempty(row.name)&&!row.name.includes('.'),'invalid tool namespace');
          tools(row.tools,`${path}/tools`,`${namespace}${row.name}.`); continue;
        }
        requireWire(['function','custom'].includes(row.type)&&nonempty(row.name),'unsupported tool declaration');
        const id=namespace+row.name; requireWire(!ids.has(id),'duplicate tool declaration'); ids.add(id);
        result.tools.push({id,type:row.type,source:path,digest:sourceDigest(row)});
      }
    }
    function instruction(text,role,source) {
      requireWire(typeof text==='string','invalid instruction text');
      (role==='assistant'?result.assistantMessages:result.instructions).push({role,text,source,digest:digestBytes(text)});
    }
    if(body.tools!==undefined){result.declarationDigests.push(sourceDigest(body.tools));tools(body.tools,'/tools');}
    if(body.instructions!==undefined&&body.instructions!==null) instruction(body.instructions,'system','/instructions');
    if(typeof body.input==='string') instruction(body.input,'user','/input');
    else {
      requireWire(Array.isArray(body.input),'request input missing');
      for(const [index,item] of body.input.entries()) {
        const source=`/input/${index}`; requireWire(object(item),'invalid input item');
        if(item.type==='additional_tools'){result.declarationDigests.push(sourceDigest(item.tools));tools(item.tools,`${source}/tools`);}
        else if(['function_call','custom_tool_call'].includes(item.type)) {
          requireWire(nonempty(item.call_id)&&nonempty(item.name),'invalid tool call');
          requireWire(!result.calls.some(call=>call.callId===item.call_id),'duplicate tool call');
          result.calls.push({callId:item.call_id,name:item.name,namespace:item.namespace??null,input:item.input??item.arguments??null,source,digest:sourceDigest(item)});
          pendingCalls.push({item,call:result.calls.at(-1)});
        } else if(['function_call_output','custom_tool_call_output'].includes(item.type)) {
          requireWire(nonempty(item.call_id)&&item.output!==undefined,'invalid tool output');
          requireWire(!result.outputs.some(output=>output.callId===item.call_id),'duplicate tool output');
          result.outputs.push({callId:item.call_id,output:item.output,source,digest:sourceDigest(item)});
        } else if(['system','developer','user','assistant'].includes(item.role)&&(!item.type||item.type==='message')) {
          if(typeof item.content==='string') instruction(item.content,item.role,`${source}/content`);
          else {
            requireWire(Array.isArray(item.content),'message content missing');
            for(const [n,part] of item.content.entries()) {
              if(['input_text','output_text'].includes(part?.type)) instruction(part.text,item.role,`${source}/content/${n}`);
              else result.opaque.push({source:`${source}/content/${n}`,digest:sourceDigest(part),reason:'non-text message content'});
            }
          }
        } else result.opaque.push({source,digest:sourceDigest(item),reason:'uninterpreted input item'});
      }
    }
    for(const {item,call}of pendingCalls){
      const id=resolveNativeCall(item,{status:'observed',tools:result.tools});
      call.declarationQualified=id!==null;
      if(call.namespace===null&&id?.includes('.'))call.namespace=id.slice(0,id.lastIndexOf('.'));
    }
    for(const output of result.outputs) {
      const call=result.calls.find(call=>call.callId===output.callId);
      if(!call?.declarationQualified||call.namespace!=='functions'||call.name!=='exec'||call.input!=='text(ALL_TOOLS)') continue;
      const texts=typeof output.output==='string'?[output.output]:Array.isArray(output.output)?output.output.filter(p=>p.type==='input_text').map(p=>p.text):[];
      const candidates=[];
      for(const text of texts) {
        let entries; try { entries=JSON.parse(text); } catch { continue; }
        if(!Array.isArray(entries)||!entries.length||!entries.every(e=>object(e)&&nonempty(e.name)&&typeof e.description==='string')) continue;
        if(new Set(entries.map(e=>e.name)).size!==entries.length) continue;
        candidates.push(entries);
      }
      if(candidates.length===1) result.registryWitnesses.push({callId:call.callId,callSource:call.source,outputSource:output.source,entries:candidates[0],digest:output.digest});
    }
    result.status='observed';
  } catch(error) { result.reason=error.message; }
  return result;
}

const EVENT_TYPES=new Set(['response.created','response.in_progress','response.completed','response.failed','response.incomplete',
  'response.output_item.added','response.output_item.done','response.content_part.added','response.content_part.done',
  'response.output_text.delta','response.output_text.done','response.function_call_arguments.delta','response.function_call_arguments.done',
  'response.custom_tool_call_input.delta','response.custom_tool_call_input.done','response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done','response.reasoning_summary_text.delta','response.reasoning_summary_text.done',
  'response.reasoning_text.delta','response.reasoning_text.done','response.refusal.delta','response.refusal.done','error']);

export function decodeNativeResponse(bytes, {maxBytes,contentType,requestedModel,responseMetadata,transport}) {
  wireBound(maxBytes);
  const result={status:'unavailable',reason:null,bodyDigest:Buffer.isBuffer(bytes)?digestBytes(bytes):null,
    interpretation:null,complete:false,observedModel:null,observedModels:[],usage:null,events:[],response:null};
  try {
    requireWire(nonempty(requestedModel),'requested model missing');
    if(responseMetadata!==undefined){
      requireWire(object(responseMetadata)&&Object.keys(responseMetadata).sort().join(',')==='contentEncoding,contentType','response metadata missing');
      requireWire(responseMetadata.contentType===null||typeof responseMetadata.contentType==='string','response content type shape');
      requireWire(responseMetadata.contentEncoding===null||responseMetadata.contentEncoding==='identity','unsupported response encoding');
      contentType=responseMetadata.contentType;
    }
    const missing=responseMetadata?.contentType===null;
    if(missing) requireWire(transport?.status===200&&Object.values(NATIVE_RESPONSE_ROUTES).includes(transport.upstream),'missing media transport unavailable');
    else requireWire(/^text\/event-stream(?:\s*;|$)/i.test(contentType??''),'unsupported response content type');
    const text=bodyText(bytes,maxBytes).replaceAll('\r\n','\n');
    requireWire(text.endsWith('\n\n'),'incomplete SSE framing');
    const models=new Set(),identities=new Set(); let terminal=null,ended=false;
    for(const block of text.split('\n\n').slice(0,-1)) {
      if(!block) continue;
      const data=[]; let name=null;
      for(const line of block.split('\n')) {
        if(line.startsWith(':')) continue;
        const match=/^(event|data|id|retry): ?(.*)$/.exec(line);
        requireWire(match,'unsupported SSE field');
        if(match[1]==='event') {requireWire(name===null,'duplicate SSE event field');name=match[2];}
        if(match[1]==='data') data.push(match[2]);
      }
      if(!data.length) continue;
      if(data.join('\n')==='[DONE]') {requireWire(terminal&&!ended,'unexpected SSE done');ended=true;continue;}
      requireWire(!terminal&&!ended,'event after terminal');
      const event=strictEvaluationJson(data.join('\n'));nativeJsonBytes(event);
      requireWire(object(event)&&(EVENT_TYPES.has(event.type)||inertKeepalive(event)),'unsupported SSE event');
      requireWire(name===null||name===event.type,'SSE event name mismatch'); result.events.push(event);
      if(nonempty(event.response?.model)) models.add(event.response.model);
      if(nonempty(event.response?.id)) identities.add(event.response.id);
      result.observedModels=[...models];
      if(['response.failed','response.incomplete','error'].includes(event.type)) throw new Error('unsuccessful response terminal');
      if(event.type==='response.completed') terminal=event.response;
    }
    requireWire(object(terminal)&&terminal.status==='completed'&&nonempty(terminal.id),'complete response terminal missing');
    requireWire(identities.size===1&&identities.has(terminal.id),'response identity conflicting');
    requireWire(models.size===1&&models.has(requestedModel)&&terminal.model===requestedModel,'response model missing or conflicting');
    const usage=terminal.usage;
    requireWire(object(usage)&&token(usage.input_tokens)&&token(usage.output_tokens),'response usage unknown');
    const cached=usage.input_tokens_details?.cached_tokens;
    requireWire(cached===undefined||token(cached)&&cached<=usage.input_tokens,'invalid cached usage');
    result.usage={input_tokens:usage.input_tokens,output_tokens:usage.output_tokens,cached_input_tokens:cached??null};
    result.response=terminal; result.observedModel=requestedModel; result.complete=true; result.interpretation=missing?'body-validated-sse':'declared-sse'; result.status='observed';
  } catch(error) { result.reason=error.message; }
  return result;
}

export function nativeDeclarationDigest(decoded) {
  requireWire(decoded?.status==='observed'&&Array.isArray(decoded.tools)&&decoded.tools.length>0,'complete declaration set missing');
  requireWire(Array.isArray(decoded.declarationDigests)&&decoded.declarationDigests.length>0,'complete declaration roots missing');
  return sourceDigest({roots:decoded.declarationDigests,tools:decoded.tools.map(({id,type,digest})=>({id,type,digest}))});
}

export function nativeResponseItems(decoded) {
  requireWire(decoded?.status==='observed'&&decoded.complete&&Array.isArray(decoded.response?.output),'complete response unavailable');
  if(decoded.response.output.length)return decoded.response.output;
  const items=new Map();
  for(const event of decoded.events.filter(row=>row.type==='response.output_item.done')){
    requireWire(token(event.output_index)&&!items.has(event.output_index),'duplicate or invalid completed item index');
    items.set(event.output_index,event.item);
  }
  const indexes=[...items.keys()].sort((a,b)=>a-b);
  requireWire(indexes.every((index,n)=>index===n),'incomplete completed item census');
  return indexes.map(index=>items.get(index));
}

export function checkNativeRelease(decoded,request) {
  const result={allowed:false,reason:null};
  try {
    requireWire(decoded?.status==='observed'&&decoded.complete&&Array.isArray(decoded.response?.output),'complete response unavailable');
    const items=nativeResponseItems(decoded),ids=new Map(),calls=new Set(),stages=new Map();
    const executable=item=>['custom_tool_call','function_call'].includes(item.type);
    const field=item=>item.type==='custom_tool_call'?'input':'arguments';
    const identity=item=>[item.id,item.type,item.namespace??null,item.name??null,item.call_id??null];
    function supported(item) {
      requireWire(object(item)&&nonempty(item.id),'output identity missing');
      if(item.type==='custom_tool_call') requireWire(resolveNativeCall(item,request)==='functions.exec','direct custom call denied');
      else if(item.type==='function_call') requireWire(['functions.wait','clock.sleep'].includes(resolveNativeCall(item,request)),'direct function call denied');
      else requireWire(item.type==='reasoning'||item.type==='message'&&item.role==='assistant','unsupported output item');
      if(executable(item)) requireWire(nonempty(item.call_id)&&typeof item[field(item)]==='string','call fields missing');
    }
    for(const [index,item]of items.entries()){
      supported(item);requireWire(!ids.has(item.id),'duplicate output identity');ids.set(item.id,index);
      if(executable(item)){
        requireWire(!calls.has(item.call_id),'duplicate call identity');calls.add(item.call_id);
        if(item.type==='function_call') requireWire(object(JSON.parse(item.arguments)),'function arguments missing');
      }
    }
    function target(event,id=event.item_id){
      requireWire(ids.has(id),'stream item absent from terminal');
      const index=ids.get(id);requireWire(event.output_index===undefined||event.output_index===index,'stream index mismatch');
      return items[index];
    }
    for(const event of decoded.events){
      if(inertKeepalive(event))continue;
      if(['response.created','response.in_progress','response.completed'].includes(event.type)){
        if(event.type!=='response.completed')requireWire(event.response?.output===undefined||Array.isArray(event.response.output)&&!event.response.output.length,'unsupported intermediate output');
        continue;
      }
      if(['response.output_item.added','response.output_item.done'].includes(event.type)){
        supported(event.item);const item=target(event,event.item.id);
        requireWire(JSON.stringify(identity(event.item))===JSON.stringify(identity(item)),'stream call identity mismatch');
        if(event.type==='response.output_item.added'){
          requireWire(!stages.has(item.id),'duplicate streamed item');
          stages.set(item.id,{done:false,input:executable(item)?event.item[field(item)]:null,inputDone:false});
        }else{
          const stage=stages.get(item.id);requireWire(stage&&!stage.done,'stream item completion mismatch');
          if(executable(item))requireWire(event.item[field(item)]===item[field(item)]&&stage.input===item[field(item)],'streamed call input mismatch');
          stage.done=true;
        }
        continue;
      }
      const item=target(event),stage=stages.get(item.id);
      requireWire(stage&&!stage.done,'event outside active item');
      const family=item.type==='custom_tool_call'?'response.custom_tool_call_input.':'response.function_call_arguments.';
      if(event.type.startsWith('response.custom_tool_call_input.')||event.type.startsWith('response.function_call_arguments.')){
        requireWire(executable(item)&&event.type.startsWith(family)&&!stage.inputDone,'stream call family mismatch');
        if(event.type.endsWith('.delta')){requireWire(typeof event.delta==='string','stream delta missing');stage.input+=event.delta;}
        else {requireWire(event.type.endsWith('.done')&&event[field(item)]===item[field(item)]&&stage.input===item[field(item)],'stream input completion mismatch');stage.inputDone=true;}
      }else if(event.type.startsWith('response.reasoning_'))requireWire(item.type==='reasoning','reasoning event item mismatch');
      else if(event.type.startsWith('response.output_text.')||event.type.startsWith('response.refusal.'))requireWire(item.type==='message','message event item mismatch');
      else if(event.type.startsWith('response.content_part.'))requireWire(item.type==='message'&&['output_text','refusal'].includes(event.part?.type),'unsupported content part');
      else throw new Error('unsupported release event');
    }
    for(const item of items)requireWire(stages.get(item.id)?.done,'terminal output without complete streamed inventory');
    result.allowed=true;
  }catch(error){result.reason=error.message;}
  return result;
}
