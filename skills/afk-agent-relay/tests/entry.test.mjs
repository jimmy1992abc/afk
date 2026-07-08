import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run as runBrief } from '../brief.mjs';
import { run as runScope } from '../scope.mjs';

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
