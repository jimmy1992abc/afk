import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildResumeArgs,
  buildActivationArgs,
  classifyStreamFrame,
  runClaude,
  validateRecoveryRun,
} from '../../scripts/supervisor/claude-runner.mjs';

const run = { sessionId: '00000000-0000-4000-8000-000000000001' };

async function* lines(values) {
  for (const value of values) yield typeof value === 'string' ? value : JSON.stringify(value);
}

test('resume arguments use verbose stream-json without shell interpolation', () => {
  assert.deepEqual(buildResumeArgs(run).slice(0, 6), [
    '--resume', run.sessionId, '--print', '--verbose', '--output-format', 'stream-json',
  ]);
});

test('activation is bounded and does not persist a session', () => {
  const args = buildActivationArgs();
  assert.deepEqual(args.slice(0, 7), ['--print', '--verbose', '--output-format', 'stream-json', '--no-session-persistence', '--max-turns', '1']);
  assert.ok(args.includes('--tools'));
});

test('recovery run rejects a ledger outside its working directory', () => {
  const cwd = process.platform === 'win32' ? 'C:\\repo' : '/repo';
  const ledgerPath = process.platform === 'win32' ? 'C:\\other\\afk-ledger.md' : '/other/afk-ledger.md';
  assert.throws(() => validateRecoveryRun({
    sessionId: run.sessionId, cwd, ledgerPath,
  }), /ledger path/);
});

test('recovery run rejects a session ID the rest of the supervisor would refuse', () => {
  const cwd = process.platform === 'win32' ? 'C:\\repo' : '/repo';
  const ledgerPath = process.platform === 'win32' ? 'C:\\repo\\.afk\\afk-ledger.md' : '/repo/.afk/afk-ledger.md';
  const refused = [
    '00000000-0-0-0-0-0-0-0-0-0-0-0-0-0-0',   // hyphens anywhere
    'deadbeef-aaaa-aaaa-aaaa-aaaaaaaaaaaa',   // no UUID version or variant
    '00000000-0000-0000-0000-000000000000',   // nil
  ];
  for (const sessionId of refused) {
    assert.throws(() => validateRecoveryRun({ sessionId, cwd, ledgerPath }), /session ID/, sessionId);
  }
  assert.doesNotThrow(() => validateRecoveryRun({ sessionId: run.sessionId, cwd, ledgerPath }));
});

test('classifies only the wire-visible quota retry frame', () => {
  assert.deepEqual(classifyStreamFrame({ type: 'system', subtype: 'api_retry', error: 'rate_limit', error_status: 429, attempt: 1, max_retries: 10 }), { kind: 'quota', status: 429 });
  assert.equal(classifyStreamFrame({ type: 'system', subtype: 'api_error', error: { rate_limits: { resets_at: 2_000 } } }), null);
  assert.equal(classifyStreamFrame({ type: 'system', subtype: 'api_retry', error: 'overloaded', error_status: 529 }), null);
});

test('quota frame kills the child immediately and does not await retries', async () => {
  let killed = 0;
  const result = await runClaude({ run }, {
    startClaude: () => ({
      lines: lines([{ type: 'system', subtype: 'api_retry', error: 'rate_limit', error_status: 429, attempt: 1, max_retries: 10 }]),
      completion: new Promise(() => {}),
      kill: async () => { killed += 1; },
    }),
  });
  assert.equal(result.kind, 'quota');
  assert.equal(killed, 1);
});

test('successful result is distinguished from malformed output and process failure', async () => {
  const success = await runClaude({ run }, {
    startClaude: () => ({ lines: lines(['bad', { type: 'result', subtype: 'success' }]), completion: Promise.resolve({ code: 0 }), kill: async () => {} }),
  });
  assert.equal(success.kind, 'success');
  const failed = await runClaude({ run }, {
    startClaude: () => ({ lines: lines([]), completion: Promise.resolve({ code: 1 }), kill: async () => {} }),
  });
  assert.equal(failed.kind, 'failure');
});

test('wall-clock timeout kills a child whose stream never completes', async () => {
  let killed = 0;
  async function* pendingLines() { await new Promise(() => {}); }
  const result = await runClaude({ run }, {
    startClaude: () => ({ lines: pendingLines(), completion: new Promise(() => {}), kill: async () => { killed += 1; } }),
    timeout: async () => {},
  });
  assert.equal(result.reason, 'action-timeout');
  assert.equal(killed, 1);
});
