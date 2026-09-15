import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixedExchange, normalizeUsage } from './transport.mjs';
import { envelopeObservation } from './audit.mjs';

test('missing usage remains unknown and cache never adds input', () => {
  assert.deepEqual(normalizeUsage({}), { input: null, output: null, cacheRead: null });
  assert.deepEqual(normalizeUsage({ usage: { prompt_tokens: 5, completion_tokens: 0, prompt_cache_hit_tokens: 7 } }),
    { input: 5, output: 0, cacheRead: null });
});

test('bounded exchange refuses an invalid packet before injected fetch', async () => {
  let calls = 0;
  await assert.rejects(fixedExchange({ packet: {}, request: '{}', env: { DEEPSEEK_API_KEY: 'fixture-key' },
    fetchImpl: async () => { calls++; throw new Error('must not run'); } }));
  assert.equal(calls, 0);
});

test('S111-1 shared envelope observation covers message and delta function/tool calls in every returned choice', () => {
  for (const container of ['message', 'delta']) for (const field of ['function_call', 'tool_calls']) {
    const envelope = { model: 'deepseek-flash', choices: [{ message: { content: 'text' } }, { [container]: { [field]: {} } }] };
    assert.equal(envelopeObservation(envelope).toolCallsPresent, true);
  }
});
