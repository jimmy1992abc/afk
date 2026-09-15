#!/usr/bin/env node

import { canonicalBytes } from '../lib/gate/review-receipt.mjs';
import { readDirectionState, appendDirectionRecord, loadDirectionInput } from '../lib/direction/state.mjs';

let result;
try {
  const [command, ...argv] = process.argv.slice(2);
  if (!['check', 'apply'].includes(command)) throw new Error('invalid_command');
  const allowed = command === 'check' ? ['--run-id', '--issue', '--expected'] : ['--request'];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!allowed.includes(flag) || Object.hasOwn(options, flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('invalid_options');
    options[flag] = argv[++i];
  }
  if (command === 'check') {
    if (!options['--run-id'] || !options['--issue']) throw new Error('missing_identity');
    const expected = options['--expected'] ? loadDirectionInput({ path: options['--expected'], runId: options['--run-id'] }) : undefined;
    result = readDirectionState({ runId: options['--run-id'], issueId: options['--issue'], expected });
  } else {
    if (!options['--request']) throw new Error('request_required');
    result = appendDirectionRecord({ request: loadDirectionInput({ path: options['--request'] }) });
  }
} catch (error) {
  result = { version: 1, status: 'refused', reasons: [error.code || error.message || 'invalid_request'], record: null, state: null };
}
process.stdout.write(canonicalBytes(result));
process.exitCode = ['valid', 'off', 'published', 'already_recorded'].includes(result.status) ? 0 : 1;
