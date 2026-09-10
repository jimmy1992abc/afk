// Unit contract of the Anthropic-protocol provider: text-block filtering,
// stop_reason mapping, usage, and classified failures — via injected fetch.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeAnthropicProvider } from './anthropic-provider.mjs';

const provider = makeAnthropicProvider({
  name: 'GLM',
  keyEnv: 'ZAI_API_KEY',
  baseUrlEnv: 'GLM_REVIEW_BASE_URL',
  baseUrlDefault: 'https://api.z.ai/api/anthropic',
  emptyHint: 'retry once with bounded knobs',
});

function fetchReturning(json, status = 200) {
  return async () => ({ ok: status < 400, status, json: async () => json });
}

function call(fetchImpl, env = { ZAI_API_KEY: 'k' }) {
  return provider.complete({
    system: 's', user: 'u', model: 'glm-5.2', maxTokens: 64, env, fetchImpl,
  });
}

test('only text blocks form the completion; thinking blocks are ignored', async () => {
  const result = await call(fetchReturning({
    model: 'glm-5.2',
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: 'internal reasoning' },
      { type: 'text', text: 'APPROVE' },
    ],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
  }));
  assert.equal(result.text, 'APPROVE');
  assert.deepEqual(result.usage, { input: 10, output: 5, cacheRead: 2 });
  assert.equal(result.reportedModel, 'glm-5.2');
  assert.equal(result.finishReason, 'stop');
});

test('a thinking-only response is an empty completion, not the string "undefined"', async () => {
  await assert.rejects(
    call(fetchReturning({
      model: 'glm-5.2',
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: 'only reasoning, no answer' }],
    })),
    (error) => error.code === 'empty'
      && /empty completion; retry once with bounded knobs/.test(error.message),
  );
});

test('a non-end_turn stop_reason passes through raw for the unsafe-finish check', async () => {
  const result = await call(fetchReturning({
    model: 'glm-5.2',
    stop_reason: 'max_tokens',
    content: [{ type: 'text', text: 'truncated…' }],
  }));
  assert.equal(result.finishReason, 'max_tokens');
});

test('a missing stop_reason surfaces as null, never a fabricated clean stop', async () => {
  const result = await call(fetchReturning({
    model: 'glm-5.2',
    content: [{ type: 'text', text: 'no finish info' }],
  }));
  assert.equal(result.finishReason, null);
});

test('http statuses classify through the shared table codes', async () => {
  for (const [status, code] of [[401, 'auth'], [404, 'model_unavailable'], [429, 'rate_limit'], [500, 'upstream']]) {
    await assert.rejects(
      call(fetchReturning({}, status)),
      (error) => error.code === code,
      `HTTP ${status} must classify as ${code}`,
    );
  }
});

test('a missing key fails as no_key before any request', async () => {
  let called = false;
  await assert.rejects(
    call(async () => { called = true; }, {}),
    (error) => error.code === 'no_key',
  );
  assert.equal(called, false);
});
