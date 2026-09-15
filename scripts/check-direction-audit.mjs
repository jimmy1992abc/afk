#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalBytes } from '../lib/gate/review-receipt.mjs';
import { loadDirectionInput, readDirectionState } from '../lib/direction/state.mjs';
import { requireValue } from '../lib/direction/schema.mjs';
import { prepareAudit, checkAudit, terminalRequest } from '../lib/direction/audit.mjs';

export function run(argv, cwd = process.cwd()) {
  const [command, ...args] = argv;
  const fields = { prepare: ['run-id', 'issue', 'input'], check: ['run-id', 'issue', 'audit', 'stage'],
    'terminal-request': ['run-id', 'issue', 'audit', 'operation-id'] }[command];
  requireValue(fields, 'invalid_command'); const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    requireValue(args[i].startsWith('--') && (fields.includes(key) || command === 'check' && key === 'endpoint')
      && !Object.hasOwn(options, key) && args[i + 1] && !args[i + 1].startsWith('--'), 'invalid_options');
    options[key] = args[i + 1];
  }
  requireValue(fields.every(key => options[key]), 'missing_options');
  requireValue(command !== 'check' || Boolean(options.endpoint) === (options.stage === 'endpoint'), 'endpoint_option');
  const where = { cwd, runId: options['run-id'], issueId: options.issue, auditId: options.audit };
  if (command === 'prepare') {
    const state = readDirectionState(where);
    if (state.status === 'off') return { version: 1, status: 'off', reasons: state.reasons };
    return prepareAudit({ ...where, input: loadDirectionInput({ cwd, path: options.input, runId: where.runId }) });
  }
  if (command === 'check') return checkAudit({ ...where, stage: options.stage, endpointId: options.endpoint });
  return terminalRequest({ ...where, operationId: options['operation-id'] });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try { result = run(process.argv.slice(2)); }
  catch (error) { result = { version: 1, status: 'invalid', reasons: [error.code || 'audit_unavailable'] }; }
  process.stdout.write(canonicalBytes(result));
  process.exitCode = ['valid', 'off', 'prepared'].includes(result.status) || result.operation === 'terminal' ? 0 : 1;
}
