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
  // through cmd.exe as ONE verbatim, fully-quoted payload: per-argument quoting
  // composes badly with /s (cmd strips the first and last quote on the line), so
  // a shim under a path with spaces — an ordinary Windows user profile — was cut
  // at its first space and every setup and activation for that user failed.
  const calls = [];
  const fake = (file, args, options) => { calls.push({ file, args, options }); return {}; };
  const shim = String.raw`C:\Users\Jim my\npm\claude.cmd`;

  spawnClaude(shim, ['--print', 'hi'], { spawn: fake });
  assert.match(calls[0].file, /cmd\.exe$/i);
  assert.deepEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(calls[0].args[3], `""${shim}" "--print" "hi""`,
    'every element quoted, and the whole payload wrapped in the pair /s consumes');
  assert.equal(calls[0].options.windowsVerbatimArguments, true,
    'the payload must reach cmd.exe exactly as built');

  calls.length = 0;
  spawnClaude('/usr/local/bin/claude', ['--print', 'hi'], { spawn: fake });
  assert.equal(calls[0].file, '/usr/local/bin/claude');
  assert.deepEqual(calls[0].args, ['--print', 'hi']);

  // Every argument is a compile-time constant; a quote in one is a bug, and
  // mangling it quietly inside cmd's quoting rules would be worse than refusing.
  assert.throws(() => spawnClaude(shim, ['--print', 'say "hi"'], { spawn: fake }), /quotes/);
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

test('a child that will not exit after its stream ends cannot wedge the pass', async () => {
  // launchd has no execution time limit and will not start a new instance while
  // one runs: a child that half-closes stdout without exiting would silently
  // disable the supervisor until reboot. And a child that already printed its
  // success frame DID the work — killing the husk does not undo the request,
  // and calling it a failure would burn another one.
  let killed = 0;
  const hungAfterSuccess = await runActivation({
    startActivation: () => ({
      lines: lines([{ type: 'result', subtype: 'success' }]),
      completion: new Promise(() => {}),          // never exits
      kill: async () => { killed += 1; },
    }),
    exitGrace: async () => 'hung',
  });
  assert.equal(hungAfterSuccess.kind, 'success');
  assert.equal(killed, 1, 'the husk is killed, not waited on');

  const hungWithoutSuccess = await runActivation({
    startActivation: () => ({
      lines: lines(['garbage only']),
      completion: new Promise(() => {}),
      kill: async () => {},
    }),
    exitGrace: async () => 'hung',
  });
  assert.equal(hungWithoutSuccess.kind, 'failure');
  assert.equal(hungWithoutSuccess.reason, 'exit-hung');
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
