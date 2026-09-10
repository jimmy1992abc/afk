#!/usr/bin/env node
// glm-gate.mjs — Z.ai GLM external review over the shared snapshot lifecycle.
//
// Usage:
//   node glm-gate.mjs                 # current branch vs default base
//   node glm-gate.mjs --base master   # vs an explicit base
//   node glm-gate.mjs --commit <sha>  # one commit
//   node glm-gate.mjs --uncommitted   # staged/unstaged/untracked
//   node glm-gate.mjs --design <path> # review a design doc (sends the doc text, not a diff)
//   node glm-gate.mjs --print-args    # resolve and print the target; no API call
//   node glm-gate.mjs --print-prompt  # print the exact prompts; no API call
//
// Opt out with GLM_REVIEW_GATE=off. Protocol selection is explicit because
// endpoint guessing can spend a metered call on the wrong transport.

import { runOpenAiSnapshotGate } from '../../lib/gate/openai-snapshot-gate.mjs';
import { createReceiptProtocol } from '../../lib/gate/review-receipt.mjs';
import { readCredential } from '../../lib/gate/credential.mjs';
import { makeAnthropicProvider } from '../../lib/http/anthropic-provider.mjs';
import { makeOpenAiProvider } from '../../lib/http/openai-provider.mjs';

const modelDefault = 'glm-5.3';
const keyEnvs = ['ZAI_API_KEY', 'GLM_API_KEY'];
const receiptContext = createReceiptProtocol({ label: 'GLM', slug: 'glm-gate', family: 'glm',
  argv: process.argv.slice(2), credential: readCredential(keyEnvs) });
const protocolName = String(process.env.GLM_REVIEW_PROTOCOL ?? '').trim().toLowerCase() || 'openai';
if (!['openai', 'anthropic'].includes(protocolName)) {
  receiptContext.protocol.emitError(
    'cannot review — GLM_REVIEW_PROTOCOL must be "openai" or "anthropic".',
    1,
  );
}

const baseUrlDefault = protocolName === 'anthropic'
  ? 'https://api.z.ai/api/anthropic'
  : 'https://api.z.ai/api/coding/paas/v4';

const provider = protocolName === 'anthropic'
  ? makeAnthropicProvider({
      name: 'GLM',
      keyEnv: 'ZAI_API_KEY',
      baseUrlEnv: 'GLM_REVIEW_BASE_URL',
      baseUrlDefault,
      emptyHint: 'retry once after lowering GLM_REVIEW_MAX_CTX_BYTES and/or raising GLM_REVIEW_MAX_OUTPUT_TOKENS',
    })
  : makeOpenAiProvider({
      name: 'GLM',
      keyEnv: 'ZAI_API_KEY',
      modelEnv: 'GLM_REVIEW_MODEL',
      modelDefault,
      baseUrlEnv: 'GLM_REVIEW_BASE_URL',
      baseUrlDefault,
      tokenParam: 'max_tokens',
      tokenParamOverrideEnv: null,
      buildExtraBody: () => ({
        thinking: { type: 'enabled' },
        reasoning_effort: 'max',
      }),
      emptyHint: 'retry once after lowering GLM_REVIEW_MAX_CTX_BYTES and/or raising GLM_REVIEW_MAX_OUTPUT_TOKENS',
    });

await runOpenAiSnapshotGate({
  family: 'glm',
  label: 'GLM',
  slug: 'glm-gate',
  disableEnv: 'GLM_REVIEW_GATE',
  keyEnvs,
  modelEnv: 'GLM_REVIEW_MODEL',
  modelDefault,
  baseUrlEnv: 'GLM_REVIEW_BASE_URL',
  baseUrlDefault,
  maxContextEnv: 'GLM_REVIEW_MAX_CTX_BYTES',
  maxContextDefault: 160000,
  maxOutputEnv: 'GLM_REVIEW_MAX_OUTPUT_TOKENS',
  maxOutputDefault: 65536,
  excludeGlobsEnv: 'GLM_REVIEW_EXCLUDE_GLOBS',
  provider,
}, { receiptContext });
