// openai_provider.mjs — adapter FACTORY for OpenAI-compatible chat-completions
// providers (DeepSeek, Mimo, Kimi, OpenAI).
//
// Providers are not assumed identical: the factory takes per-provider hooks for
// request shaping (`buildExtraBody`), text extraction (`extractText`), usage
// mapping (`normalizeUsage`), and error mapping — each provider's quirks (e.g.
// DeepSeek's `thinking` toggle and `prompt_cache_hit_tokens`) live with that
// provider.
//
// Raw `fetch` (built-in) — zero npm deps, matching codex-gate.mjs. `fetchImpl`
// is injectable for tests.

import { relayError } from './relay.mjs';

function mapHttp(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'upstream';
  return 'http_error';
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}

export function defaultUsage(json) {
  const u = json?.usage || {};
  return {
    input: u.prompt_tokens || 0,
    output: u.completion_tokens || 0,
    cacheRead: u?.prompt_tokens_details?.cached_tokens || 0,
  };
}

// DeepSeek: prefer the OpenAI-compatible cached-token field, fall back to
// DeepSeek's native top-level `prompt_cache_hit_tokens`.
export function deepseekUsage(json) {
  const u = json?.usage || {};
  let cached = u?.prompt_tokens_details?.cached_tokens || 0;
  if (!cached) cached = u?.prompt_cache_hit_tokens || 0;
  return { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cacheRead: cached };
}

export function makeOpenAiProvider(cfg) {
  return {
    name: cfg.name,
    kind: 'openai',
    keyEnv: cfg.keyEnv,

    hasKey(env) {
      return !!String(env?.[cfg.keyEnv] ?? '').trim();
    },
    // Uniform availability shape with the codex adapter so callers don't branch.
    available(env) {
      return this.hasKey(env)
        ? { ok: true }
        : { ok: false, reason: `${cfg.keyEnv} not set` };
    },
    defaultModel(env) {
      const m = String(env?.[cfg.modelEnv] ?? '').trim();
      if (m) return m;
      if (cfg.modelDefault) return cfg.modelDefault;
      throw relayError(
        'no_model',
        `${cfg.name}: no model configured — set AGENT_RELAY_*_MODEL or ${cfg.modelEnv}`,
      );
    },

    async complete({ system, user, model, maxTokens, env, fetchImpl, httpTimeoutMs = 120000 }) {
      const key = String(env?.[cfg.keyEnv] ?? '').trim();
      if (!key) throw relayError('no_key', `${cfg.keyEnv} not set`);

      const baseUrl = (
        String(env?.[cfg.baseUrlEnv] ?? '').trim() || cfg.baseUrlDefault
      ).replace(/\/+$/, '');
      const url = `${baseUrl}/chat/completions`;

      // Token-limit field name varies across OpenAI-compatible APIs: reasoning
      // models (DeepSeek V4 Pro, OpenAI reasoning) take `max_completion_tokens`;
      // many classic endpoints (e.g. Moonshot/Kimi) take `max_tokens`. Per
      // provider via cfg.tokenParam, with AGENT_RELAY_TOKEN_PARAM as a global
      // escape hatch if a swapped provider rejects the default.
      const tokenParam =
        String(env?.AGENT_RELAY_TOKEN_PARAM ?? '').trim() ||
        cfg.tokenParam ||
        'max_completion_tokens';
      const body = {
        model,
        [tokenParam]: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        ...(cfg.buildExtraBody ? cfg.buildExtraBody(env) : {}),
      };

      const f = fetchImpl || globalThis.fetch;
      // Hard request timeout (parity with the codex adapter) — a hung provider
      // must fail with a clear error, not wedge the script. Covers body read too.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), httpTimeoutMs);
      let resp;
      try {
        resp = await f(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        if (e && e.name === 'AbortError') {
          throw relayError('timeout', `${cfg.name} request timed out after ${httpTimeoutMs}ms`);
        }
        throw relayError('transport', `${cfg.name} transport error: ${e.message}`);
      }

      try {
        if (!resp.ok) {
          const eb = await safeText(resp);
          const code = cfg.normalizeError
            ? cfg.normalizeError(resp.status, eb)
            : mapHttp(resp.status);
          throw relayError(code, `${cfg.name} HTTP ${resp.status}: ${String(eb).slice(0, 300)}`);
        }

        let json;
        try {
          json = await resp.json();
        } catch {
          throw relayError('bad_json', `${cfg.name}: response was not valid JSON`);
        }

        const text =
          (cfg.extractText ? cfg.extractText(json) : json?.choices?.[0]?.message?.content) || '';
        if (!String(text).trim()) {
          throw relayError(
            'empty',
            `${cfg.name}: empty completion (raise AGENT_RELAY_MAX_OUTPUT_TOKENS or disable thinking)`,
          );
        }
        const usage = cfg.normalizeUsage ? cfg.normalizeUsage(json) : defaultUsage(json);
        return { text, usage };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
