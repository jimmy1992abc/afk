import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVALUATOR_RUNTIME_FILES=Object.freeze([
  'lib/config.mjs','lib/direction/schema.mjs','lib/evaluation/host.mjs',
  'lib/evaluation/native-control.mjs','lib/evaluation/native-host.mjs','lib/evaluation/native-recorder.mjs',
  'lib/evaluation/native-witness.mjs','lib/evaluation/observed-execution.mjs','lib/evaluation/native-wire.mjs','lib/evaluation/runtime.mjs','lib/evaluation/scenarios.mjs','lib/evaluation/strict-json.mjs',
  'lib/gate/file-boundary.mjs','lib/gate/git.mjs','lib/gate/model-identity.mjs',
  'lib/gate/prompt.mjs','lib/gate/protocol.mjs','lib/gate/review-context.mjs',
  'lib/gate/review-receipt.mjs','lib/gate/target.mjs','lib/resume/detect.mjs',
  'lib/secret.mjs','lib/text-budget.mjs','scripts/evaluate-agent-behavior.mjs',
]);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function evaluatorRuntime(root=fileURLToPath(new URL('../..',import.meta.url))) {
  const files={};
  for(const path of EVALUATOR_RUNTIME_FILES){
    const parts=path.split('/');let current=root;
    if(!lstatSync(root).isDirectory()||lstatSync(root).isSymbolicLink())throw new Error('evaluator runtime root unavailable');
    for(const [index,part] of parts.entries()){
      current=join(current,part);const stat=lstatSync(current);
      if(stat.isSymbolicLink()||(index===parts.length-1?!stat.isFile():!stat.isDirectory()))throw new Error('evaluator runtime nonregular source');
    }
    files[path]=hash(readFileSync(current));
  }
  return {files,digest:hash(JSON.stringify(files))};
}
