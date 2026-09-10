#!/usr/bin/env node

import { runOpenAiSnapshotGate } from '../../lib/gate/openai-snapshot-gate.mjs';
import { makeOpenAiProvider } from '../../lib/http/openai-provider.mjs';

const provider = makeOpenAiProvider({
  name: 'MiMo',
  keyEnv: 'MIMO_REVIEW_API_KEY',
  modelEnv: 'MIMO_REVIEW_MODEL',
  modelDefault: 'mimo-v2.5-pro',
  baseUrlEnv: 'MIMO_REVIEW_BASE_URL',
  baseUrlDefault: 'https://token-plan-cn.xiaomimimo.com/v1',
  tokenParam: 'max_completion_tokens',
  tokenParamOverrideEnv: null,
  buildHeaders: (key) => ({ 'api-key': key }),
});

await runOpenAiSnapshotGate({
  family: 'mimo',
  label: 'MIMO',
  slug: 'mimo-gate',
  disableEnv: 'MIMO_REVIEW_GATE',
  keyEnvs: ['MIMO_REVIEW_API_KEY', 'DEV_MIMO_API_KEY'],
  modelEnv: 'MIMO_REVIEW_MODEL',
  modelDefault: 'mimo-v2.5-pro',
  baseUrlEnv: 'MIMO_REVIEW_BASE_URL',
  baseUrlDefault: 'https://token-plan-cn.xiaomimimo.com/v1',
  maxContextEnv: 'MIMO_REVIEW_MAX_CTX_BYTES',
  maxOutputEnv: 'MIMO_REVIEW_MAX_OUTPUT_TOKENS',
  excludeGlobsEnv: 'MIMO_REVIEW_EXCLUDE_GLOBS',
  provider,
});
