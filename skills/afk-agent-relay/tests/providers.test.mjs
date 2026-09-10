import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRegistry, resolveProvider } from '../lib/providers.mjs';
import { deepseekUsage } from '../../../lib/http/openai-provider.mjs';

function mockFetch(captured, responseJson) {
  return async (url, opts) => {
    captured.url = url;
    captured.body = JSON.parse(opts.body);
    captured.auth = opts.headers.Authorization;
    captured.apiKey = opts.headers['api-key'];
    return { ok: true, async json() { return responseJson; } };
  };
}

test('resolveProvider throws on unknown provider', () => {
  assert.throws(() => resolveProvider(buildRegistry(), 'nope'), /unknown provider/);
});

test('deepseek sends thinking + bearer key and normalizes usage', async () => {
  const p = resolveProvider(buildRegistry(), 'deepseek');
  const captured = {};
  const res = await p.complete({
    system: 'sys',
    user: 'usr',
    model: 'deepseek-v4-pro',
    maxTokens: 100,
    env: { DEV_DEEPSEEK_API_KEY: 'k123' },
    fetchImpl: mockFetch(captured, {
      model: 'deepseek-v4-pro-20260801',
      choices: [{ finish_reason: 'stop', message: { content: 'hello' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 4 },
    }),
  });
  assert.equal(res.text, 'hello');
  assert.equal(res.reportedModel, 'deepseek-v4-pro-20260801');
  assert.equal(res.finishReason, 'stop');
  assert.deepEqual(res.usage, { input: 10, output: 5, cacheRead: 4 });
  assert.equal(captured.auth, 'Bearer k123');
  assert.deepEqual(captured.body.thinking, { type: 'enabled' });
  assert.equal(captured.body.max_tokens, 100);
  assert.equal(captured.body.max_completion_tokens, undefined);
  assert.match(captured.url, /api\.deepseek\.com\/chat\/completions/);
});

test('deepseek thinking can be disabled via env', async () => {
  const p = resolveProvider(buildRegistry(), 'deepseek');
  const captured = {};
  await p.complete({
    system: 's', user: 'u', model: 'm', maxTokens: 10,
    env: { DEV_DEEPSEEK_API_KEY: 'k', DEV_DEEPSEEK_THINKING: 'off' },
    fetchImpl: mockFetch(captured, { choices: [{ message: { content: 'x' } }], usage: {} }),
  });
  assert.deepEqual(captured.body.thinking, { type: 'disabled' });
});

test('mimo uses the Token Plan header and V2.5 token field', async () => {
  const p = resolveProvider(buildRegistry(), 'mimo');
  const captured = {};
  const res = await p.complete({
    system: 's', user: 'u', model: 'mimo-v2.5-pro', maxTokens: 50,
    env: { DEV_MIMO_API_KEY: 'mk' },
    fetchImpl: mockFetch(captured, {
      model: 'mimo-v2.5-pro',
      choices: [{ finish_reason: 'stop', message: { content: 'x' } }],
      usage: {},
    }),
  });
  assert.equal(captured.body.thinking, undefined);
  assert.equal(captured.auth, undefined);
  assert.equal(captured.apiKey, 'mk');
  assert.equal(captured.body.max_completion_tokens, 50);
  assert.equal(captured.body.max_tokens, undefined);
  assert.equal(res.reportedModel, 'mimo-v2.5-pro');
  assert.equal(res.finishReason, 'stop');
});

test('token-limit field is per-provider (DeepSeek V4/MiMo V2.5 vs Kimi)', async () => {
  const reg = buildRegistry();
  const capD = {};
  await resolveProvider(reg, 'deepseek').complete({
    system: 's', user: 'u', model: 'm', maxTokens: 42,
    env: { DEV_DEEPSEEK_API_KEY: 'k' },
    fetchImpl: mockFetch(capD, { choices: [{ message: { content: 'x' } }], usage: {} }),
  });
  assert.equal(capD.body.max_tokens, 42);
  assert.equal(capD.body.max_completion_tokens, undefined);

  const capM = {};
  await resolveProvider(reg, 'mimo').complete({
    system: 's', user: 'u', model: 'm', maxTokens: 11,
    env: { DEV_MIMO_API_KEY: 'k' },
    fetchImpl: mockFetch(capM, { choices: [{ message: { content: 'x' } }], usage: {} }),
  });
  assert.equal(capM.body.max_completion_tokens, 11);
  assert.equal(capM.body.max_tokens, undefined);

  const capK = {};
  await resolveProvider(reg, 'kimi').complete({
    system: 's', user: 'u', model: 'kimi-x', maxTokens: 7,
    env: { DEV_KIMI_API_KEY: 'k' },
    fetchImpl: mockFetch(capK, { choices: [{ message: { content: 'x' } }], usage: {} }),
  });
  assert.equal(capK.body.max_tokens, 7);
  assert.equal(capK.body.max_completion_tokens, undefined);

  const capO = {};
  await resolveProvider(reg, 'openai').complete({
    system: 's', user: 'u', model: 'gpt-5', maxTokens: 13,
    env: { DEV_OPENAI_API_KEY: 'k' },
    fetchImpl: mockFetch(capO, { choices: [{ message: { content: 'x' } }], usage: {} }),
  });
  assert.equal(capO.body.max_completion_tokens, 13);
  assert.equal(capO.body.max_tokens, undefined);
});

test('AGENT_RELAY_TOKEN_PARAM overrides the token field name', async () => {
  const cap = {};
  await resolveProvider(buildRegistry(), 'deepseek').complete({
    system: 's', user: 'u', model: 'm', maxTokens: 9,
    env: { DEV_DEEPSEEK_API_KEY: 'k', AGENT_RELAY_TOKEN_PARAM: 'max_tokens' },
    fetchImpl: mockFetch(cap, { choices: [{ message: { content: 'x' } }], usage: {} }),
  });
  assert.equal(cap.body.max_tokens, 9);
  assert.equal(cap.body.max_completion_tokens, undefined);
});

test('missing key throws no_key', async () => {
  const p = resolveProvider(buildRegistry(), 'deepseek');
  await assert.rejects(
    () => p.complete({ system: 's', user: 'u', model: 'm', maxTokens: 1, env: {}, fetchImpl: async () => ({}) }),
    (e) => e.code === 'no_key',
  );
});

test('HTTP 429 maps to rate_limit code', async () => {
  const p = resolveProvider(buildRegistry(), 'deepseek');
  const fetchImpl = async () => ({ ok: false, status: 429, async text() { return 'slow down'; } });
  await assert.rejects(
    () => p.complete({ system: 's', user: 'u', model: 'm', maxTokens: 1, env: { DEV_DEEPSEEK_API_KEY: 'k' }, fetchImpl }),
    (e) => e.code === 'rate_limit',
  );
});

test('HTTP error messages never retain the upstream response body', async () => {
  const p = resolveProvider(buildRegistry(), 'deepseek');
  const key = 'review-key-that-must-not-echo';
  const token = `tp-${'X7y'.repeat(12)}`;
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    async text() { return `upstream echoed ${key} and ${token}`; },
  });
  await assert.rejects(
    () => p.complete({
      system: 's', user: 'u', model: 'm', maxTokens: 1,
      env: { DEV_DEEPSEEK_API_KEY: key }, fetchImpl,
    }),
    (error) => {
      assert.equal(error.code, 'upstream');
      assert.doesNotMatch(error.message, new RegExp(key));
      assert.doesNotMatch(error.message, /tp-/);
      return true;
    },
  );
});

test('transport errors retain only a bounded diagnostic cause', async () => {
  const p = resolveProvider(buildRegistry(), 'deepseek');
  const fetchImpl = async () => {
    const error = new TypeError('request failed with sensitive implementation detail');
    error.cause = { code: 'ECONNREFUSED' };
    throw error;
  };
  await assert.rejects(
    () => p.complete({
      system: 's', user: 'u', model: 'm', maxTokens: 1,
      env: { DEV_DEEPSEEK_API_KEY: 'k' }, fetchImpl,
    }),
    (error) => {
      assert.equal(error.code, 'transport');
      assert.match(error.message, /TypeError\/ECONNREFUSED/);
      assert.doesNotMatch(error.message, /sensitive implementation detail/);
      return true;
    },
  );
});

test('transport diagnostics cannot echo the configured credential', async () => {
  const p = resolveProvider(buildRegistry(), 'deepseek');
  const key = 'ECONNREFUSED';
  const fetchImpl = async () => {
    const error = new TypeError('request failed');
    error.cause = { code: key };
    throw error;
  };
  await assert.rejects(
    () => p.complete({
      system: 's', user: 'u', model: 'm', maxTokens: 1,
      env: { DEV_DEEPSEEK_API_KEY: key }, fetchImpl,
    }),
    (error) => {
      assert.equal(error.code, 'transport');
      assert.doesNotMatch(error.message, new RegExp(key));
      assert.match(error.message, /TypeError/);
      return true;
    },
  );
});

test('empty completion is an error, not silent success', async () => {
  const p = resolveProvider(buildRegistry(), 'deepseek');
  const fetchImpl = async () => ({ ok: true, async json() { return { choices: [{ message: { content: '' } }], usage: {} }; } });
  await assert.rejects(
    () => p.complete({ system: 's', user: 'u', model: 'm', maxTokens: 1, env: { DEV_DEEPSEEK_API_KEY: 'k' }, fetchImpl }),
    (error) => {
      assert.equal(error.code, 'empty');
      assert.equal(error.relay, true);
      assert.match(error.message, /AGENT_RELAY_MAX_OUTPUT_TOKENS/);
      return true;
    },
  );
});

test('openai provider requires an explicit model (no wrong-guess default)', () => {
  const p = resolveProvider(buildRegistry(), 'openai');
  assert.throws(() => p.defaultModel({}), /no model configured/);
  assert.equal(p.defaultModel({ DEV_OPENAI_MODEL: 'gpt-x' }), 'gpt-x');
});

test('codex provider omits -m by default and ignores another role\'s model env', () => {
  const p = resolveProvider(buildRegistry(), 'codex');
  assert.equal(p.defaultModel({}), null);
  assert.equal(p.defaultModel({ AGENT_RELAY_BRIEF_MODEL: 'deepseek-x' }), null);
});

test('deepseekUsage prefers cached_tokens, falls back to prompt_cache_hit_tokens', () => {
  assert.equal(deepseekUsage({ usage: { prompt_tokens_details: { cached_tokens: 3 } } }).cacheRead, 3);
  assert.equal(deepseekUsage({ usage: { prompt_cache_hit_tokens: 7 } }).cacheRead, 7);
});

test('a codex exec that exits non-zero is a failure, whatever it printed', async () => {
  // A well-formed marker block on stdout says nothing about whether the run
  // succeeded; accepting it let a failed invocation pass for a clean brief.
  const { buildRegistry, resolveProvider } = await import('../lib/providers.mjs');
  const provider = resolveProvider(buildRegistry(), 'codex');
  const spawnImpl = () => ({
    status: 1,
    stdout: '===== AGENT BRIEF =====\nbody\n===== END AGENT BRIEF =====',
    stderr: 'upstream refused',
    error: undefined,
    signal: null,
  });
  await assert.rejects(
    () => provider.complete({
      system: 's', user: 'u', model: 'm', maxTokens: 10,
      env: { PATH: process.env.PATH }, spawnImpl,
    }),
    (err) => /exited 1/.test(String(err.message)),
  );
});
