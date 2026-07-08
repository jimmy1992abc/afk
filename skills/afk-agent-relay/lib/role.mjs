// role.mjs — the one shared pipeline both entry scripts run. brief.mjs and
// scope.mjs differ only in a small config object (label, default provider,
// prompt, validator, user-message builder) — keeping the pipeline here means
// the two roles can't drift apart.
//
// Returns { code, out } and does NOT touch process.* — the entry bootstrap
// prints/exits. That keeps the whole pipeline unit-testable.

import {
  parseArgs,
  gate,
  isOff,
  envInt,
  skipBlock,
  errorBlock,
  extractBlock,
  parseExcludeList,
} from './relay.mjs';
import { buildRegistry, resolveProvider } from './providers.mjs';
import { gatherContext } from './gather.mjs';

export async function runRole(cfg, io) {
  const { argv, env, fetchImpl, spawnImpl, readFileImpl, gather } = io;
  const args = parseArgs(argv);

  // gating: manual bypasses AGENT_RELAY_ENABLED; automatic paths don't
  const g = gate(args, env);
  if (g.shouldSkip) return { code: 0, out: skipBlock(cfg.label, g.skipReason) };
  if (!args.task) return { code: 2, out: errorBlock(cfg.label, 'missing --task') };

  // provider resolution (role default, overridable by --provider or env)
  const providerName = String(args.provider || env[cfg.providerEnv] || cfg.defaultProvider).trim();
  let provider;
  try {
    provider = resolveProvider(buildRegistry(), providerName);
  } catch (e) {
    return { code: 2, out: errorBlock(cfg.label, e.message) };
  }

  // availability — graceful skip by default, hard fail under AGENT_RELAY_STRICT
  const avail =
    provider.kind === 'codex-cli' ? provider.available(env, spawnImpl) : provider.available(env);
  if (!avail.ok) {
    return g.strict
      ? { code: 2, out: errorBlock(cfg.label, avail.reason) }
      : { code: 0, out: skipBlock(cfg.label, avail.reason) };
  }

  // model: --model > role model env > provider default
  let model;
  try {
    model = String(args.model || env[cfg.modelEnv] || '').trim() || provider.defaultModel(env);
  } catch (e) {
    return { code: 2, out: errorBlock(cfg.label, e.message) };
  }

  // gather context out of process (excludes + redaction + loud byte cap)
  const gctx = (gather || gatherContext)(
    { diff: args.diff, issue: args.issue, files: args.files, logs: args.logs, grep: args.grep },
    {
      maxBytes: envInt(env, 'AGENT_RELAY_MAX_INPUT_BYTES', 400000),
      excludeGlobs: parseExcludeList(env.AGENT_RELAY_EXCLUDE),
      redact: !isOff(env.AGENT_RELAY_REDACT), // default on
    },
  );

  // one provider call
  let result;
  try {
    result = await provider.complete({
      system: cfg.systemPrompt,
      user: cfg.buildUser(args, gctx),
      model,
      // Headroom: with DeepSeek thinking ON, reasoning tokens are spent from the
      // output budget BEFORE content, so a ~6000-token brief (the prompt ceiling)
      // needs room for both reasoning AND content or the content truncates
      // (caught by marker validation). 10000 leaves ~4000 for reasoning above a
      // full brief; raise AGENT_RELAY_MAX_OUTPUT_TOKENS further if briefs
      // truncate.
      maxTokens: envInt(env, 'AGENT_RELAY_MAX_OUTPUT_TOKENS', 10000),
      env,
      fetchImpl,
      spawnImpl,
      readFileImpl,
      httpTimeoutMs: envInt(env, 'AGENT_RELAY_HTTP_TIMEOUT_MS', 120000),
      timeoutMs: envInt(env, 'AGENT_RELAY_CODEX_TIMEOUT_MS', 300000),
    });
  } catch (e) {
    return {
      code: 1,
      out: errorBlock(cfg.label, `${providerName}/${model || '(default)'}: ${e.message}`),
    };
  }

  // validate markers + required sections
  const block = extractBlock(result.text, cfg.label);
  const v = cfg.validate(block || result.text);
  if (!block || !v.ok) {
    return {
      code: 1,
      out: errorBlock(
        cfg.label,
        `output invalid (missing: ${v.missing.join(', ') || 'markers'}). ` +
          `Raw model output:\n${String(result.text).slice(0, 4000)}`,
      ),
    };
  }
  return { code: 0, out: block, usage: result.usage };
}
