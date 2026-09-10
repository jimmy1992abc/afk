import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config as briefConfig, run as runBrief } from '../brief.mjs';
import { config as scopeConfig, run as runScope } from '../scope.mjs';
import { relayError } from '../lib/relay.mjs';

// stub gather so entry tests never touch git/gh/rg
const fakeGather = () => ({ text: 'CTX', notes: [], bytes: 3 });

const GOOD_BRIEF =
  '===== AGENT BRIEF =====\n1. p\n2. f\n3. c\n4. t\n5. r\n6. n\n===== END AGENT BRIEF =====';
const GOOD_SCOPE =
  '===== AGENT SCOPE =====\nTitle: do thing\nAcceptance criteria:\n- works\n===== END AGENT SCOPE =====';

test('brief end-to-end with mocked fetch (deepseek)', async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return { choices: [{ message: { content: GOOD_BRIEF } }], usage: {} };
    },
  });
  const r = await runBrief({
    argv: ['--manual', '--task', 'fix x'],
    env: { DEV_DEEPSEEK_API_KEY: 'k' },
    fetchImpl,
    gather: fakeGather,
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /AGENT BRIEF/);
  assert.match(r.out, /6\. n/);
});

test('brief missing key => SKIPPED (graceful) by default', async () => {
  const r = await runBrief({
    argv: ['--manual', '--task', 't'],
    env: {},
    gather: fakeGather,
    fetchImpl: async () => ({}),
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /SKIPPED:/);
});

test('brief missing key => ERROR under AGENT_RELAY_STRICT', async () => {
  const r = await runBrief({
    argv: ['--manual', '--task', 't'],
    env: { AGENT_RELAY_STRICT: 'on' },
    gather: fakeGather,
    fetchImpl: async () => ({}),
  });
  assert.equal(r.code, 2);
  assert.match(r.out, /ERROR:/);
});

test('brief rejects malformed model output', async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return { choices: [{ message: { content: 'no markers here' } }], usage: {} };
    },
  });
  const r = await runBrief({
    argv: ['--manual', '--task', 't'],
    env: { DEV_DEEPSEEK_API_KEY: 'k' },
    fetchImpl,
    gather: fakeGather,
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /ERROR:[\s\S]*invalid/);
});

test('non-manual without ENABLED => SKIPPED', async () => {
  const r = await runBrief({
    argv: ['--task', 't'],
    env: { DEV_DEEPSEEK_API_KEY: 'k' },
    gather: fakeGather,
    fetchImpl: async () => ({}),
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /SKIPPED:/);
});

test('scope with mocked codex exec', async () => {
  const spawnImpl = (cmd, args) => {
    if (args.includes('status')) return { status: 0, stdout: 'Logged in', stderr: '' };
    // codex exec prints the model output (incl. marker block) to stdout;
    // wrap it in transcript chrome to prove extractBlock trims it.
    return { status: 0, stdout: `codex preamble noise\n${GOOD_SCOPE}\nthread complete`, stderr: '' };
  };
  const r = await runScope({
    argv: ['--manual', '--task', 'build a thing'],
    env: {},
    spawnImpl,
    gather: fakeGather,
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /AGENT SCOPE/);
  assert.match(r.out, /Acceptance/);
});

test('scope reports codex timeout as ERROR', async () => {
  const spawnImpl = (cmd, args) => {
    if (args.includes('status')) return { status: 0, stdout: 'Logged in', stderr: '' };
    return { error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) };
  };
  const r = await runScope({
    argv: ['--manual', '--task', 't'],
    env: {},
    spawnImpl,
    readFileImpl: () => null,
    gather: fakeGather,
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /ERROR:[\s\S]*timed out/);
});

test('scope skips when codex not logged in', async () => {
  const spawnImpl = () => ({ status: 1, stdout: 'Not logged in', stderr: '' });
  const r = await runScope({
    argv: ['--manual', '--task', 't'],
    env: {},
    spawnImpl,
    readFileImpl: () => null,
    gather: fakeGather,
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /SKIPPED:/);
});

test('unknown provider => ERROR', async () => {
  const r = await runBrief({
    argv: ['--manual', '--task', 't', '--provider', 'bogus'],
    env: {},
    gather: fakeGather,
    fetchImpl: async () => ({}),
  });
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown provider/);
});

test('HTTP message content stays inside the final input budget', async () => {
  const maxBytes = Buffer.byteLength(briefConfig.systemPrompt, 'utf8') + 800;
  let requestBody;
  const r = await runBrief({
    argv: ['--manual', '--task', 'bound the HTTP request'],
    env: { DEV_DEEPSEEK_API_KEY: 'k', AGENT_RELAY_MAX_INPUT_BYTES: String(maxBytes) },
    gather: () => ({
      text: 'context '.repeat(5000),
      notes: ['[kept note]', '[999 additional gather note(s) omitted]'],
      bytes: 40000,
    }),
    fetchImpl: async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: GOOD_BRIEF } }], usage: {} };
        },
      };
    },
  });
  assert.equal(r.code, 0, r.out);
  const inputBytes = requestBody.messages.reduce(
    (total, message) => total + Buffer.byteLength(message.content, 'utf8'),
    0,
  );
  assert.ok(inputBytes <= maxBytes, `${inputBytes} bytes exceeded ${maxBytes}`);
  const user = requestBody.messages.find((message) => message.role === 'user').content;
  assert.match(user, /kept note/);
  assert.match(user, /999 additional gather note/);
  assert.match(user, /context truncated by AGENT_RELAY_MAX_INPUT_BYTES/);
});

test('Codex stdin includes its separator inside the final input budget', async () => {
  const maxBytes = Buffer.byteLength(scopeConfig.systemPrompt, 'utf8') + 700;
  let prompt = '';
  const spawnImpl = (_cmd, args, opts) => {
    if (args.includes('status')) return { status: 0, stdout: 'Logged in', stderr: '' };
    prompt = opts.input;
    return { status: 0, stdout: GOOD_SCOPE, stderr: '', signal: null };
  };
  const r = await runScope({
    argv: ['--manual', '--task', 'bound the Codex request'],
    env: { AGENT_RELAY_MAX_INPUT_BYTES: String(maxBytes) },
    spawnImpl,
    gather: () => ({
      text: 'related context '.repeat(5000),
      notes: ['[kept note]', '[999 additional gather note(s) omitted]'],
      bytes: 80000,
    }),
  });
  assert.equal(r.code, 0, r.out);
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= maxBytes);
  assert.match(prompt, /kept note/);
  assert.match(prompt, /999 additional gather note/);
  assert.match(prompt, /context truncated by AGENT_RELAY_MAX_INPUT_BYTES/);
  assert.ok(prompt.indexOf('kept note') < prompt.indexOf('context truncated'));
});

test('a budget smaller than fixed messages stops before the provider', async () => {
  let called = false;
  const r = await runBrief({
    argv: ['--manual', '--task', 'must remain complete'],
    env: { DEV_DEEPSEEK_API_KEY: 'k', AGENT_RELAY_MAX_INPUT_BYTES: '32' },
    gather: fakeGather,
    fetchImpl: async () => {
      called = true;
      throw new Error('provider must not be called');
    },
  });
  assert.equal(called, false);
  assert.equal(r.code, 2);
  assert.match(r.out, /ERROR:[\s\S]*AGENT_RELAY_MAX_INPUT_BYTES/);
});

test('a classified gather failure becomes a role error without a provider call', async () => {
  let called = false;
  const r = await runBrief({
    argv: ['--manual', '--task', 'preserve omission evidence'],
    env: { DEV_DEEPSEEK_API_KEY: 'k' },
    gather: () => {
      throw relayError('notes_unreportable', 'gather notes cannot fit the input budget');
    },
    fetchImpl: async () => {
      called = true;
      throw new Error('provider must not be called');
    },
  });
  assert.equal(called, false);
  assert.equal(r.code, 2);
  assert.match(r.out, /ERROR:[\s\S]*gather notes cannot fit/);
});
