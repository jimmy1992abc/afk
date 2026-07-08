import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRegistry, resolveProvider } from '../lib/providers.mjs';
import { deepseekUsage } from '../lib/openai_provider.mjs';

function mockFetch(captured, responseJson) {
  return async (url, opts) => {
    captured.url = url;
    captured.body = JSON.parse(opts.body);
    captured.auth = opts.headers.Authorization;
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
      choices: [{ message: { content: 'hello' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 4 },
    }),
  });
  assert.equal(res.text, 'hello');
  assert.deepEqual(res.usage, { input: 10, output: 5, cacheRead: 4 });
  assert.equal(captured.auth, 'Bearer k123');
  assert.deepEqual(captured.body.thinking, { type: 'enabled' });
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

test('mimo does NOT send a thinking field (per-provider normalization)', async () => {
  const p = resolveProvider(buildRegistry(), 'mimo');
  const captured = {};
  await p.complete({
    system: 's', user: 'u', model: 'mimo-v2.5-pro', maxTokens: 50,
    env: { DEV_MIMO_API_KEY: 'mk' },
    fetchImpl: mockFetch(captured, { choices: [{ message: { content: 'x' } }], usage: {} }),
  });
  assert.equal(captured.body.thinking, undefined);
});

test('token-limit field is per-provider (deepseek vs kimi)', async () => {
  const reg = buildRegistry();
  const capD = {};
  await resolveProvider(reg, 'deepseek').complete({
    system: 's', user: 'u', model: 'm', maxTokens: 42,
    env: { DEV_DEEPSEEK_API_KEY: 'k' },
    fetchImpl: mockFetch(capD, { choices: [{ message: { content: 'x' } }], usage: {} }),
  });
  assert.equal(capD.body.max_completion_tokens, 42);
  assert.equal(capD.body.max_tokens, undefined);

  const capK = {};
  await resolveProvider(reg, 'kimi').complete({
    system: 's', user: 'u', model: 'kimi-x', maxTokens: 7,
    env: { DEV_KIMI_API_KEY: 'k' },
    fetchImpl: mockFetch(capK, { choices: [{ message: { content: 'x' } }], usage: {} }),
  });
  assert.equal(capK.body.max_tokens, 7);
  assert.equal(capK.body.max_completion_tokens, undefined);
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

test('empty completion is an error, not silent success', async () => {
  const p = resolveProvider(buildRegistry(), 'deepseek');
  const fetchImpl = async () => ({ ok: true, async json() { return { choices: [{ message: { content: '' } }], usage: {} }; } });
  await assert.rejects(
    () => p.complete({ system: 's', user: 'u', model: 'm', maxTokens: 1, env: { DEV_DEEPSEEK_API_KEY: 'k' }, fetchImpl }),
    (e) => e.code === 'empty',
  );
});

test('openai provider requires an explicit model (no wrong-guess default)', () => {
  const p = resolveProvider(buildRegistry(), 'openai');
  assert.throws(() => p.defaultModel({}), /no model configured/);
  assert.equal(p.defaultModel({ DEV_OPENAI_MODEL: 'gpt-x' }), 'gpt-x');
});

test('deepseekUsage prefers cached_tokens, falls back to prompt_cache_hit_tokens', () => {
  assert.equal(deepseekUsage({ usage: { prompt_tokens_details: { cached_tokens: 3 } } }).cacheRead, 3);
  assert.equal(deepseekUsage({ usage: { prompt_cache_hit_tokens: 7 } }).cacheRead, 7);
});
