// Anthropic-protocol sibling of makeOpenAiProvider: same provider contract
// ({ text, usage, reportedModel, finishReason } or a classified throw), the
// /v1/messages request shape. Z.ai's GLM endpoint accepts either auth header,
// so both are sent, matching the pre-fold gate.

import { postClassifiedJson, providerError } from './transport.mjs';

export function makeAnthropicProvider(cfg) {
  const fail = (code, message) => providerError(code, message, cfg.relayErrors === true);
  return {
    name: cfg.name,
    kind: 'anthropic',
    keyEnv: cfg.keyEnv,

    hasKey(env) {
      return Boolean(String(env?.[cfg.keyEnv] ?? '').trim());
    },

    available(env) {
      return this.hasKey(env)
        ? { ok: true }
        : { ok: false, reason: `${cfg.keyEnv} not set` };
    },

    async complete({ system, user, model, maxTokens, env, fetchImpl, httpTimeoutMs = 120000 }) {
      const key = String(env?.[cfg.keyEnv] ?? '').trim();
      if (!key) throw fail('no_key', `${cfg.keyEnv} not set`);

      const baseUrl = (
        String(env?.[cfg.baseUrlEnv] ?? '').trim() || cfg.baseUrlDefault
      ).replace(/\/+$/, '');
      const json = await postClassifiedJson({
        name: cfg.name,
        url: `${baseUrl}/v1/messages`,
        headers: {
          Authorization: `Bearer ${key}`,
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: {
          model,
          max_tokens: maxTokens,
          temperature: 0.2,
          system,
          messages: [{ role: 'user', content: user }],
        },
        httpTimeoutMs,
        fail,
        fetchImpl,
        credential: key,
      });

      // Only `type: 'text'` blocks are the answer: an unfiltered map would
      // turn a thinking-only response into the literal string "undefined",
      // defeating the empty check.
      const blocks = Array.isArray(json?.content) ? json.content : [];
      const completion = blocks
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('\n');
      if (!String(completion).trim()) {
        const hint = cfg.emptyHint ? `; ${cfg.emptyHint}` : '';
        throw fail('empty', `${cfg.name}: empty completion${hint}`);
      }
      const usage = json?.usage || {};
      return {
        text: String(completion),
        usage: {
          input: usage.input_tokens || 0,
          output: usage.output_tokens || 0,
          cacheRead: usage.cache_read_input_tokens || 0,
        },
        reportedModel: typeof json?.model === 'string' ? json.model.trim() : '',
        // `end_turn` is this protocol's clean stop; the lifecycle's clean
        // value is 'stop'. Anything else passes through raw so the
        // unsafe-finish error names it (`max_tokens` truncation included).
        finishReason: json?.stop_reason == null
          ? null
          : (json.stop_reason === 'end_turn' ? 'stop' : String(json.stop_reason)),
      };
    },
  };
}
