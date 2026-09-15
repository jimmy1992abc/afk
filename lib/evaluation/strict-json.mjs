const requireObserved=(value,reason)=>{if(!value)throw new Error(`issue112 ${reason}`);};
export const EVALUATION_JSON_DEPTH=128;

export function strictEvaluationJson(bytes) {
  const text=typeof bytes==='string'?bytes:new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  const value=JSON.parse(text),tokens=text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)||[],stack=[];
  for(let n=0;n<tokens.length;n++) {
    if(tokens[n]==='{')stack.push(new Set());else if(tokens[n]==='[')stack.push(null);
    else if(tokens[n]==='}'||tokens[n]===']')stack.pop();
    else if(tokens[n+1]===':'&&stack.at(-1)){const key=JSON.parse(tokens[n]);requireObserved(!stack.at(-1).has(key),'duplicate JSON key');stack.at(-1).add(key);}
    requireObserved(stack.length<=EVALUATION_JSON_DEPTH,'JSON depth bound');
  }
  return value;
}
