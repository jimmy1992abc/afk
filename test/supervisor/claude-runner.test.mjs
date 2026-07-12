import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  ACTIVATION_PROMPT,
  DETACHED,
  buildResumeArgs,
  buildActivationArgs,
  classifyStreamFrame,
  runClaude,
  spawnClaude,
  startClaudeProcess,
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

test('a variadic flag cannot swallow the activation prompt', () => {
  // `--tools <tools...>` is variadic — it eats every following argument until an
  // end-of-options marker. With the prompt last, Claude parsed a tool list of
  // ["", "Reply exactly: ok"] and received NO prompt, and every activation died on
  // `Error: Input must be provided...`. Verified against the real CLI: exit 1, and
  // exit 0 once the prompt is fenced off. The old assertion only checked that the
  // flags were *present*, which is true of the broken order too.
  const args = buildActivationArgs();
  assert.equal(args.at(-2), '--', 'the prompt must be fenced off from the variadic flag');
  assert.equal(args.at(-1), ACTIVATION_PROMPT);
  assert.ok(args.indexOf('--tools') < args.indexOf('--'), 'and the fence must come after it');
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

test('a kill that did not take hold is reported, not assumed', async () => {
  // killTree only ASKS. POSIX sends SIGTERM, which a busy Claude need not honour at
  // once, and taskkill can fail to spawn at all — killTree resolves silently either
  // way. The two paths that kill (a quota rejection, an action timeout) returned
  // immediately, so a child that survived went on writing to the session while the
  // runner declared itself done and released the claim.
  const stubborn = {
    pid: 6666,
    lines: lines([{ type: 'system', subtype: 'api_retry', error: 'rate_limit', error_status: 429, attempt: 1, max_retries: 10 }]),
    completion: new Promise(() => {}),   // it never exits
    kill: async () => {},
  };
  const survived = await runClaude({ run }, { startClaude: () => stubborn, killGrace: () => Promise.resolve() });
  assert.equal(survived.kind, 'quota');
  assert.equal(survived.childExited, false, 'a child still running must be reported as still running');

  const obedient = {
    pid: 6666,
    lines: lines([{ type: 'system', subtype: 'api_retry', error: 'rate_limit', error_status: 429, attempt: 1, max_retries: 10 }]),
    completion: Promise.resolve({ code: 0 }),
    kill: async () => {},
  };
  const gone = await runClaude({ run }, { startClaude: () => obedient, killGrace: () => new Promise(() => {}) });
  assert.equal(gone.childExited, true);
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

test('the resumed session is told which recovery attempt it belongs to', () => {
  // `claude --resume` keeps the SAME session id, so the wedged session and the one
  // the supervisor spawns to replace it are indistinguishable by session identity.
  // The attempt id is the only thing that tells them apart — and it is what lets
  // the resumed session take its own tick guard while the recovery lease that
  // started it is still held, without letting the *original* session through.
  const calls = [];
  const attempt = { id: 'attempt-7', run: { sessionId: run.sessionId, cwd: process.cwd(), ledgerPath: join(process.cwd(), '.afk', 'afk-ledger.md') } };
  startClaudeProcess(attempt, {
    executable: '/usr/local/bin/claude',
    spawn: (file, args, options) => { calls.push(options); return { stdout: new PassThrough(), once() {} }; },
  });
  assert.equal(calls[0].env.AFK_SUPERVISOR_ATTEMPT, 'attempt-7');
  assert.equal(calls[0].env.PATH ?? calls[0].env.Path, process.env.PATH ?? process.env.Path,
    'the child still needs the environment it was going to get');
});

test('runClaude reports the child it started, while it is still running', async () => {
  // The claim has to learn the child's pid *during* the run, not after it: the whole
  // point is to identify a Claude that outlives its runner. Reported after the fact,
  // a runner killed mid-run would never have recorded it at all.
  const seen = [];
  const result = await runClaude({ run }, {
    startClaude: () => ({
      pid: 9001,
      lines: lines([{ type: 'result', subtype: 'success' }]),
      completion: Promise.resolve({ code: 0 }),
      kill: async () => {},
    }),
    onChildStarted: (pid) => { seen.push(pid); },
  });
  assert.equal(result.kind, 'success');
  assert.deepEqual(seen, [9001]);
});

test('a Claude child is never detached on Windows', () => {
  // detached exists for one reason: POSIX needs a process group so killTree can
  // signal the whole tree. Windows kills by pid with taskkill /t and needs no
  // group — and a detached child there gets a new console, so its stdout never
  // reaches our pipe. The runner then read ZERO frames from stream-json: it could
  // not see a success, could not see a quota rejection, and recorded every
  // recovery as a failure while Claude was in fact doing the work.
  assert.equal(DETACHED, process.platform !== 'win32');
});

test('an npm-installed Claude is a .cmd shim, which cannot be spawned directly', () => {
  // npm installs Claude Code on Windows as claude.cmd — there is no claude.exe —
  // and Node refuses to spawn a .cmd without a shell (EINVAL since Node 20). It
  // goes through cmd.exe with its arguments still an array: a shell string would
  // put a prompt and a path in a shell's hands.
  const calls = [];
  const fake = (file, args) => { calls.push({ file, args }); return {}; };
  const shim = String.raw`C:
pm\claude.cmd`;

  spawnClaude(shim, ['--print', 'hi'], { spawn: fake });
  assert.match(calls[0].file, /cmd\.exe$/i, 'a .cmd must go through cmd.exe');
  assert.ok(calls[0].args.includes(shim));
  assert.ok(calls[0].args.includes('--print'), 'and the arguments stay an array, never a shell string');

  calls.length = 0;
  spawnClaude('/usr/local/bin/claude', ['--print', 'hi'], { spawn: fake });
  assert.equal(calls[0].file, '/usr/local/bin/claude', 'a real executable is spawned directly');
  assert.deepEqual(calls[0].args, ['--print', 'hi']);
});
