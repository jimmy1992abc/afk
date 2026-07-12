import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTIVATION_PROMPT,
  DETACHED,
  buildActivationArgs,
  classifyStreamFrame,
  runActivation,
  spawnClaude,
} from '../../scripts/supervisor/claude-runner.mjs';

async function* lines(values) {
  for (const value of values) yield typeof value === 'string' ? value : JSON.stringify(value);
}

test('a variadic flag cannot swallow the activation prompt', () => {
  // `--tools <tools...>` consumes every following argument until an
  // end-of-options marker. With the prompt last, Claude parsed a tool list of
  // ["", "Reply exactly: ok"] and received NO prompt: every activation exited 1
  // with "Input must be provided". Verified against the real CLI — exit 1
  // without the fence, exit 0 with it.
  const args = buildActivationArgs();
  assert.equal(args.at(-2), '--', 'the prompt must be fenced off from the variadic flag');
  assert.equal(args.at(-1), ACTIVATION_PROMPT);
  assert.ok(args.indexOf('--tools') < args.indexOf('--'));
  assert.ok(args.includes('--no-session-persistence'), 'an activation must never leave a session behind');
});

test('a Claude child is never detached on Windows', () => {
  // A detached child on Windows gets its own console: its stdout never reaches
  // our pipe, the stream reads zero frames, and every outcome looks like a
  // failure while Claude did the work.
  assert.equal(DETACHED, process.platform !== 'win32');
});

test('an npm-installed Claude is a .cmd shim, which cannot be spawned directly', () => {
  // Node refuses to spawn a .cmd without a shell (EINVAL since Node 20). It goes
  // through cmd.exe with the arguments still an ARRAY: a shell string would put
  // the prompt in a shell's hands.
  const calls = [];
  const fake = (file, args) => { calls.push({ file, args }); return {}; };
  const shim = String.raw`C:\npm\claude.cmd`;

  spawnClaude(shim, ['--print', 'hi'], { spawn: fake });
  assert.match(calls[0].file, /cmd\.exe$/i);
  assert.ok(calls[0].args.includes(shim));
  assert.ok(calls[0].args.includes('--print'));

  calls.length = 0;
  spawnClaude('/usr/local/bin/claude', ['--print', 'hi'], { spawn: fake });
  assert.equal(calls[0].file, '/usr/local/bin/claude');
  assert.deepEqual(calls[0].args, ['--print', 'hi']);
});

test('classifies only the wire-visible quota retry frame', () => {
  assert.deepEqual(
    classifyStreamFrame({ type: 'system', subtype: 'api_retry', error: 'rate_limit', error_status: 429, attempt: 1 }),
    { kind: 'quota', status: 429 },
  );
  assert.equal(classifyStreamFrame({ type: 'system', subtype: 'api_retry', error: 'overloaded', error_status: 529 }), null);
  assert.equal(classifyStreamFrame({ type: 'system', subtype: 'api_error', error: { rate_limits: { resets_at: 2_000 } } }), null);
});

test('a quota frame kills the child instead of waiting out its internal retries', async () => {
  let killed = 0;
  const result = await runActivation({
    startActivation: () => ({
      lines: lines([{ type: 'system', subtype: 'api_retry', error: 'rate_limit', error_status: 429, attempt: 1 }]),
      completion: new Promise(() => {}),
      kill: async () => { killed += 1; },
    }),
  });
  assert.equal(result.kind, 'quota');
  assert.equal(killed, 1);
});

test('success needs both a success frame and a clean exit', async () => {
  const success = await runActivation({
    startActivation: () => ({
      lines: lines(['not json', { type: 'result', subtype: 'success' }]),
      completion: Promise.resolve({ code: 0 }),
      kill: async () => {},
    }),
  });
  assert.equal(success.kind, 'success');
  assert.ok(Number.isFinite(success.startedAt), 'the window anchors at the request start');

  const failed = await runActivation({
    startActivation: () => ({ lines: lines([]), completion: Promise.resolve({ code: 1 }), kill: async () => {} }),
  });
  assert.equal(failed.kind, 'failure');
});

test('a hung activation is killed at the timeout', async () => {
  let killed = 0;
  async function* pending() { await new Promise(() => {}); }
  const result = await runActivation({
    startActivation: () => ({ lines: pending(), completion: new Promise(() => {}), kill: async () => { killed += 1; } }),
    timeout: async () => {},
  });
  assert.equal(result.kind, 'failure');
  assert.equal(result.reason, 'activation-timeout');
  assert.equal(killed, 1);
});
