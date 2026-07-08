// providers.mjs — the swap point. Registry of name -> adapter.
//
// Provider credentials/endpoint/model use a DEDICATED `DEV_<PROVIDER>_*` env
// namespace, kept separate from any production key a consuming project may
// already define for the same provider — a dev key and a production key must
// never share a var name.
//
// Tool *behaviour* — which provider per role, timeouts, redaction — stays
// under the AGENT_RELAY_* namespace; only provider config lives under DEV_*.

import { makeOpenAiProvider, deepseekUsage } from './openai_provider.mjs';
import { makeCodexProvider } from './codex_provider.mjs';
import { isOff, relayError } from './relay.mjs';

export function buildRegistry() {
  return {
    deepseek: makeOpenAiProvider({
      name: 'deepseek',
      keyEnv: 'DEV_DEEPSEEK_API_KEY',
      baseUrlEnv: 'DEV_DEEPSEEK_BASE_URL',
      baseUrlDefault: 'https://api.deepseek.com',
      modelEnv: 'DEV_DEEPSEEK_MODEL',
      modelDefault: 'deepseek-v4-pro',
      // DeepSeek V4 Pro is a reasoning model — needs `max_completion_tokens`,
      // not `max_tokens`.
      tokenParam: 'max_completion_tokens',
      // DeepSeek dual-mode: send `thinking` explicitly (default enabled) so a
      // server-side default flip can't silently change behaviour. Disable via
      // DEV_DEEPSEEK_THINKING=off. Top-level field (raw HTTP, not SDK extra_body).
      buildExtraBody: (env) => ({
        thinking: { type: isOff(env.DEV_DEEPSEEK_THINKING) ? 'disabled' : 'enabled' },
      }),
      normalizeUsage: deepseekUsage,
    }),

    mimo: makeOpenAiProvider({
      name: 'mimo',
      keyEnv: 'DEV_MIMO_API_KEY',
      baseUrlEnv: 'DEV_MIMO_BASE_URL',
      baseUrlDefault: 'https://token-plan-cn.xiaomimimo.com/v1',
      modelEnv: 'DEV_MIMO_MODEL',
      modelDefault: 'mimo-v2.5-pro',
      // Classic OpenAI-compatible default; override with AGENT_RELAY_TOKEN_PARAM
      // if this endpoint wants max_completion_tokens.
      tokenParam: 'max_tokens',
    }),

    kimi: makeOpenAiProvider({
      name: 'kimi',
      keyEnv: 'DEV_KIMI_API_KEY', // Moonshot (Kimi) — uses the --provider name
      baseUrlEnv: 'DEV_KIMI_BASE_URL',
      baseUrlDefault: 'https://api.moonshot.cn/v1',
      modelEnv: 'DEV_KIMI_MODEL',
      // No hard-coded default — model id varies by account; require an explicit
      // AGENT_RELAY_*_MODEL / DEV_KIMI_MODEL rather than ship a wrong guess.
      modelDefault: null,
      tokenParam: 'max_tokens', // Moonshot/Kimi chat API uses max_tokens
    }),

    openai: makeOpenAiProvider({
      name: 'openai',
      keyEnv: 'DEV_OPENAI_API_KEY',
      baseUrlEnv: 'DEV_OPENAI_BASE_URL',
      baseUrlDefault: 'https://api.openai.com/v1',
      modelEnv: 'DEV_OPENAI_MODEL',
      modelDefault: null,
    }),

    codex: makeCodexProvider(),
  };
}

export function resolveProvider(registry, name) {
  const p = registry[name];
  if (!p) {
    throw relayError(
      'unknown_provider',
      `unknown provider '${name}' (known: ${Object.keys(registry).join(', ')})`,
    );
  }
  return p;
}
