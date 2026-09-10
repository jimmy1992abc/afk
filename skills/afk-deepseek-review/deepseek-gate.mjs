#!/usr/bin/env node

import { runOpenAiSnapshotGate } from '../../lib/gate/openai-snapshot-gate.mjs';
import { deepseekUsage, makeOpenAiProvider } from '../../lib/http/openai-provider.mjs';
import { isGateDisabled } from '../../lib/gate/env.mjs';

const provider = makeOpenAiProvider({
  name: 'DeepSeek',
  keyEnv: 'DEEPSEEK_REVIEW_API_KEY',
  modelEnv: 'DEEPSEEK_REVIEW_MODEL',
  modelDefault: 'deepseek-v4-pro',
  baseUrlEnv: 'DEEPSEEK_REVIEW_BASE_URL',
  baseUrlDefault: 'https://api.deepseek.com',
  tokenParam: 'max_tokens',
  tokenParamOverrideEnv: null,
  normalizeUsage: deepseekUsage,
  emptyHint: 'retry once after lowering DEEPSEEK_REVIEW_MAX_CTX_BYTES and/or raising DEEPSEEK_REVIEW_MAX_OUTPUT_TOKENS',
  buildExtraBody: (env) => ({
    thinking: { type: isGateDisabled('DEEPSEEK_REVIEW_THINKING', env) ? 'disabled' : 'enabled' },
  }),
});

await runOpenAiSnapshotGate({
  family: 'deepseek',
  label: 'DEEPSEEK',
  slug: 'deepseek-gate',
  disableEnv: 'DEEPSEEK_REVIEW_GATE',
  keyEnvs: ['DEEPSEEK_REVIEW_API_KEY', 'DEV_DEEPSEEK_API_KEY'],
  modelEnv: 'DEEPSEEK_REVIEW_MODEL',
  modelDefault: 'deepseek-v4-pro',
  baseUrlEnv: 'DEEPSEEK_REVIEW_BASE_URL',
  baseUrlDefault: 'https://api.deepseek.com',
  maxContextEnv: 'DEEPSEEK_REVIEW_MAX_CTX_BYTES',
  maxContextDefault: 160000,
  maxOutputEnv: 'DEEPSEEK_REVIEW_MAX_OUTPUT_TOKENS',
  maxOutputDefault: 65536,
  excludeGlobsEnv: 'DEEPSEEK_REVIEW_EXCLUDE_GLOBS',
  provider,
});
