// gemini-gate tests.
//
// Every case runs against a stub `agy` selected through GEMINI_GATE_BIN: a
// review is a metered call. The stub records its argv and stdin, then prints a
// scripted stream-json transcript shaped like the ones agy 1.5.5 produced in
// the probes recorded in docs/designs/specs/2026-11-11-gemini-agy-gate.md.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { createReviewFixture, gateTestEnv, spawnGate } from './gate-test-env.mjs';

const fixture = createReviewFixture();
after(fixture.cleanup);
const { cwd } = fixture;
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
writeFileSync(join(cwd, 'safe.txt'), 'Review fixture, revised\n');
git('commit', '-qam', 'small change');
const small = git('rev-parse', 'HEAD');
// Past the 64 KiB pipe buffer, so a stub that never reads stdin raises EPIPE.
writeFileSync(join(cwd, 'large.txt'), `${'gemini review fixture line\n'.repeat(8000)}`);
git('add', 'large.txt');
git('commit', '-qm', 'large change');
const large = git('rev-parse', 'HEAD');

const GATE = fileURLToPath(new URL('../skills/afk-gemini-review/gemini-gate.mjs', import.meta.url));
const capture = join(cwd, '..', `${cwd.split(/[\\/]/).pop()}-agy-capture.json`);
after(() => rmSync(capture, { force: true }));

const stubJs = join(cwd, '..', `${cwd.split(/[\\/]/).pop()}-agy-stub.cjs`);
const stubBin = join(cwd, '..', `${cwd.split(/[\\/]/).pop()}-agy-stub.${process.platform === 'win32' ? 'cmd' : 'sh'}`);
after(() => { rmSync(stubJs, { force: true }); rmSync(stubBin, { force: true }); });
writeFileSync(stubJs, `const fs = require('node:fs');
const args = process.argv.slice(2);
const scenario = process.env.AGY_STUB || 'success';
const model = args[args.indexOf('--model') + 1];
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const step = (step_type, extra = {}) => emit({ event: 'step_update', step_update: { conversation_id: 'c1', state: 'DONE', step_type, ...extra } });
const result = (fields) => emit({ event: 'result', result: { conversation_id: 'c1', usage: {}, ...fields } });
const finish = (code = 0) => process.stdout.write('', () => process.exit(code));
if (scenario.startsWith('early-')) {
  if (scenario === 'early-auth') result({ status: 'ERROR', response: '', error: 'authentication failed or timed out', finished_reason: 'error' });
  else result({ status: 'SUCCESS', response: 'Looks fine.\\nAPPROVE' });
  finish(scenario === 'early-auth' ? 1 : 0);
} else {
  const stdin = fs.readFileSync(0, 'utf8');
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, stdin }));
  if (scenario === 'auth') { result({ status: 'ERROR', response: '', error: 'authentication failed or timed out', finished_reason: 'error' }); finish(1); }
  else if (scenario === 'unknown-model') { result({ status: 'ERROR', response: '', error: 'invalid model selection: model ' + model + ' is not recognized as a known model or custom model in settings', finished_reason: 'error' }); finish(1); }
  else if (scenario === 'rate-limit') { result({ status: 'ERROR', response: '', error: 'RESOURCE_EXHAUSTED: quota exceeded (429)', finished_reason: 'error' }); finish(1); }
  else if (scenario === 'failed') { result({ status: 'ERROR', response: '', error: 'backend exploded', finished_reason: 'error' }); finish(1); }
  else {
    if (scenario !== 'no-init') emit({ event: 'init', init: { model: scenario === 'mismatch' ? 'claude-opus-5-5-high' : model, permission_mode: 'request-review', tools: ['read_file'] } });
    step('user_input');
    step('tool', { tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: 'safe.txt' } } });
    if (scenario === 'denied-read') step('tool', { state: 'ERROR', tool_name: 'grep_search' });
    if (scenario === 'subagent') step('subagent', { tool_name: 'invoke_subagent' });
    if (scenario === 'agent-tool') step('tool', { tool_name: 'browser_subagent' });
    if (scenario === 'unknown-step') step('checkpoint');
    step('agent_response', { text_delta: 'Looks fine.' });
    if (scenario === 'no-result') finish(0);
    else if (scenario === 'timeout') { result({ status: 'SUCCESS', response: 'partial', finished_reason: 'print_timeout' }); finish(3); }
    else if (scenario === 'nonzero-success') { result({ status: 'SUCCESS', response: 'Looks fine.\\nAPPROVE' }); finish(1); }
    else if (scenario === 'no-verdict') { result({ status: 'SUCCESS', response: 'I looked at it.' }); finish(0); }
    else if (scenario === 'empty') { result({ status: 'SUCCESS', response: '' }); finish(0); }
    else if (scenario === 'design') { result({ status: 'SUCCESS', response: 'Reasoning holds.\\nSOUND' }); finish(0); }
    else { result({ status: 'SUCCESS', response: 'Looks fine.\\n\\nVerdict: APPROVE' }); finish(0); }
  }
}
`);
writeFileSync(stubBin, process.platform === 'win32'
  ? `@echo off\r\n"${process.execPath}" "${stubJs}" %*\r\n`
  : `#!/bin/sh\nexec "${process.execPath}" "${stubJs}" "$@"\n`);
chmodSync(stubBin, 0o755);

function run({ args = ['--commit', small], scenario = 'success', env = {} } = {}) {
  rmSync(capture, { force: true });
  return spawnGate([GATE, ...args, '--implementer', 'claude'], {
    cwd,
    encoding: 'utf8',
    env: gateTestEnv({ GEMINI_GATE_BIN: stubBin, AGY_STUB: scenario, ...env }),
  });
}
const sent = () => JSON.parse(readFileSync(capture, 'utf8'));
const assertError = (result, pattern) => {
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ERROR: /m);
  if (pattern) assert.match(result.stdout, pattern);
  assert.doesNotMatch(result.stdout, /^(?:Verdict: )?APPROVE$/m);
};
const assertSkip = (result, pattern) => {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^SKIPPED: /m);
  if (pattern) assert.match(result.stdout, pattern);
};

test('a complete stream-json turn yields the verdict between markers', () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^===== GEMINI REVIEW \(final message\) =====\nLooks fine\.\n\nVerdict: APPROVE\n===== END GEMINI REVIEW =====\n$/);
});

test('argv is exactly the stream-json, plan-mode, sandboxed invocation with no prompt bytes', () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { args, stdin } = sent();
  assert.deepEqual(args, [
    '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--model', 'gemini-4-argon-high', '--mode', 'plan', '--sandbox', '--print-timeout', '900s',
  ]);
  assert.ok(!args.includes('--disable-slash-commands'), 'that flag switches plan mode off');
  assert.ok(args.every((arg) => arg !== ''), 'no empty-valued argument');
  const lines = stdin.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'one user turn');
  const message = JSON.parse(lines[0]);
  assert.equal(message.event, 'user');
  assert.match(message.message.content, /Review the single commit/);
  assert.match(message.message.content, /Review fixture, revised/);
  assert.match(message.message.content, /do not start subagents or swarms, and do not create plans or artifacts/);
  assert.ok(args.join(' ').length < 200, 'the prompt never travels on argv');
});

test('--print-args reports the resolved invocation without spawning agy', () => {
  const result = run({ args: ['--commit', small, '--print-args'] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.model, 'gemini-4-argon-high');
  assert.equal(parsed.promptOnStdin, true);
  assert.deepEqual(parsed.args.slice(-5), ['--mode', 'plan', '--sandbox', '--print-timeout', '900s']);
  assert.equal(existsSync(capture), false);
});

test('the print timeout rounds up with a one-second floor', () => {
  for (const [ms, expected] of [['1', '1s'], ['1500', '2s'], ['120000', '120s']]) {
    const result = run({ args: ['--commit', small, '--print-args'], env: { GEMINI_REVIEW_TIMEOUT_MS: ms } });
    assert.equal(JSON.parse(result.stdout).args.at(-1), expected, ms);
  }
});

test('only a versioned gemini-* model is accepted, before any spawn', () => {
  for (const bad of ['claude-opus-5-5-high', 'gpt-oss-120b-medium', 'gemini-argon', 'gemini-4 argon', 'models/gemini-4-argon-high']) {
    const result = run({ env: { GEMINI_REVIEW_MODEL: bad } });
    assertError(result, /not a versioned Gemini model ID/);
    assert.equal(existsSync(capture), false, `${bad} must not spawn agy`);
  }
  const medium = run({ env: { GEMINI_REVIEW_MODEL: 'gemini-4-argon-medium' } });
  assert.equal(medium.status, 0, medium.stdout + medium.stderr);
  assert.equal(sent().args[sent().args.indexOf('--model') + 1], 'gemini-4-argon-medium');
});

test('identity is verified from the init event', () => {
  assertError(run({ scenario: 'mismatch' }), /requested "gemini-4-argon-high" but the init event reports "claude-opus-5-5-high"/);
  assertError(run({ scenario: 'no-init' }), /no init event naming the session model/);
});

test('delegation is refused; denied read tools are not', () => {
  assertError(run({ scenario: 'subagent' }), /delegated work \(step "subagent"/);
  assertError(run({ scenario: 'agent-tool' }), /delegated work \(step "tool", tool "browser_subagent"\)/);
  assertError(run({ scenario: 'unknown-step' }), /delegated work \(step "checkpoint"/);
  const denied = run({ scenario: 'denied-read' });
  assert.equal(denied.status, 0, denied.stdout + denied.stderr);
  assert.match(denied.stdout, /APPROVE/);
});

test('unavailability reported by agy skips, even with a nonzero exit', () => {
  assertSkip(run({ scenario: 'auth' }), /agy is not signed in/);
  assertSkip(run({ scenario: 'unknown-model' }), /not offered to this agy account — run `agy models`/);
  assertSkip(run({ scenario: 'rate-limit' }), /rate-limited or out of quota/);
});

test('incomplete or failed turns are errors, never verdicts', () => {
  assertError(run({ scenario: 'failed' }), /Gemini review failed \(status "ERROR"\): backend exploded/);
  assertError(run({ scenario: 'timeout' }), /timed out after 900s/);
  assertError(run({ scenario: 'no-result' }), /without a result event/);
  assertError(run({ scenario: 'nonzero-success' }), /exited 1 after a successful result/);
  assertError(run({ scenario: 'no-verdict' }), /without the mandated verdict line/);
  assertError(run({ scenario: 'empty' }), /empty review/);
});

test('an early exit on a large prompt is classified from agy\'s own result', () => {
  assertSkip(run({ args: ['--commit', large], scenario: 'early-auth' }), /agy is not signed in/);
  // A stub that never read stdin cannot have reviewed it, whatever it prints.
  // Where the platform reports no EPIPE, the unread prompt still never yields a
  // verdict: the stub prints no init event, so identity fails closed.
  assertError(run({ args: ['--commit', large], scenario: 'early-success' }), /exited before reading the review prompt|no init event/);
});

test('a design target uses the design vocabulary', () => {
  writeFileSync(join(cwd, 'design.md'), '# Design\nThe gate refuses delegation.\n');
  try {
    const result = run({ args: ['--design', 'design.md'], scenario: 'design' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /SOUND/);
    assert.match(JSON.parse(sent().stdin.trim()).message.content, /The gate refuses delegation\./);
  } finally {
    rmSync(join(cwd, 'design.md'), { force: true });
  }
});

test('availability and independence skips', () => {
  assertSkip(run({ env: { GEMINI_REVIEW_GATE: 'off' } }), /disabled via GEMINI_REVIEW_GATE/);
  assertSkip(run({ env: { GEMINI_GATE_BIN: join(cwd, 'no-such-agy') } }), /Antigravity CLI \(agy\) not found/);
  const own = spawnGate([GATE, '--commit', small, '--implementer', 'gemini'], {
    cwd, encoding: 'utf8', env: gateTestEnv({ GEMINI_GATE_BIN: stubBin }),
  });
  assertSkip(own, /independence check/);
});

test('an oversized diff is an error, never truncated', () => {
  assertError(run({ args: ['--commit', large], env: { GEMINI_REVIEW_MAX_CTX_BYTES: '1000' } }), /over the 1000-byte budget/);
});
