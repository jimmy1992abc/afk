// One client prevents relay and gate transports from disagreeing on failures.

import { postClassifiedJson, providerError } from './transport.mjs';

export function defaultUsage(json) {
  const usage = json?.usage || {};
  return {
    input: usage.prompt_tokens || 0,
    output: usage.completion_tokens || 0,
    cacheRead: usage?.prompt_tokens_details?.cached_tokens || 0,
  };
}

export function deepseekUsage(json) {
  const usage = json?.usage || {};
  let cached = usage?.prompt_tokens_details?.cached_tokens || 0;
  if (!cached) cached = usage?.prompt_cache_hit_tokens || 0;
  return {
    input: usage.prompt_tokens || 0,
    output: usage.completion_tokens || 0,
    cacheRead: cached,
  };
}

export function makeOpenAiProvider(cfg) {
  const fail = (code, message) => providerError(code, message, cfg.relayErrors === true);
  return {
    name: cfg.name,
    kind: 'openai',
    keyEnv: cfg.keyEnv,

    hasKey(env) {
      return Boolean(String(env?.[cfg.keyEnv] ?? '').trim());
    },

    available(env) {
      return this.hasKey(env)
        ? { ok: true }
        : { ok: false, reason: `${cfg.keyEnv} not set` };
    },

    defaultModel(env) {
      const model = String(env?.[cfg.modelEnv] ?? '').trim();
      if (model) return model;
      if (cfg.modelDefault) return cfg.modelDefault;
      throw fail(
        'no_model',
        `${cfg.name}: no model configured — set AGENT_RELAY_*_MODEL or ${cfg.modelEnv}`,
      );
    },

    async complete({ system, user, model, maxTokens, env, fetchImpl, httpTimeoutMs = 120000 }) {
      const key = String(env?.[cfg.keyEnv] ?? '').trim();
      if (!key) throw fail('no_key', `${cfg.keyEnv} not set`);

      const baseUrl = (
        String(env?.[cfg.baseUrlEnv] ?? '').trim() || cfg.baseUrlDefault
      ).replace(/\/+$/, '');
      const url = `${baseUrl}/chat/completions`;
      const overrideEnv = cfg.tokenParamOverrideEnv === undefined
        ? 'AGENT_RELAY_TOKEN_PARAM'
        : cfg.tokenParamOverrideEnv;
      const tokenOverride = overrideEnv ? String(env?.[overrideEnv] ?? '').trim() : '';
      const tokenParam = tokenOverride || cfg.tokenParam || 'max_tokens';
      const body = {
        model,
        [tokenParam]: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        ...(cfg.buildExtraBody ? cfg.buildExtraBody(env) : {}),
      };
      const headers = {
        ...(cfg.buildHeaders
          ? cfg.buildHeaders(key, env)
          : { Authorization: `Bearer ${key}` }),
        'Content-Type': 'application/json',
      };

      const json = await postClassifiedJson({
        name: cfg.name,
        url,
        headers,
        body,
        httpTimeoutMs,
        fail,
        fetchImpl,
        credential: key,
      });

      const choice = json?.choices?.[0];
      const completion = (cfg.extractText ? cfg.extractText(json) : choice?.message?.content) || '';
      if (!String(completion).trim()) {
        const hint = cfg.emptyHint ? `; ${cfg.emptyHint}` : '';
        throw fail('empty', `${cfg.name}: empty completion${hint}`);
      }
      const usage = cfg.normalizeUsage ? cfg.normalizeUsage(json) : defaultUsage(json);
      return {
        text: String(completion),
        usage,
        reportedModel: typeof json?.model === 'string' ? json.model.trim() : '',
        finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
      };
    },
  };
}
