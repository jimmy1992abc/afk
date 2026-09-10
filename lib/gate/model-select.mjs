// Shared selection keeps design and code review requests on the same model.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isPinnedModelId } from './model-identity.mjs';
import { readOption } from './target.mjs';

const DEFINITIONS = {
  codex: {
    modelEnv: 'CODEX_REVIEW_MODEL', modelDefault: 'gpt-5.6-sol',
    effortEnv: 'CODEX_REVIEW_REASONING', effortDefault: 'medium',
    aliases: { luna: 'gpt-5.6-luna', terra: 'gpt-5.6-terra', sol: 'gpt-5.6-sol', astra: 'gpt-6-astra' },
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    pinned: (value) => /^gpt-\d[A-Za-z0-9./_-]*$/.test(value),
  },
  claude: {
    modelEnv: 'CLAUDE_REVIEW_MODEL', modelDefault: 'claude-opus-5',
    effortEnv: 'CLAUDE_REVIEW_EFFORT', effortDefault: 'medium',
    aliases: {
      opus: 'claude-opus-5', fable: 'claude-fable-5-1', sonnet: 'claude-sonnet-5',
      haiku: 'claude-haiku-4-5-20251001',
    },
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    pinned: (value) => /^[A-Za-z0-9._-]+$/.test(value) && isPinnedModelId(value),
  },
};
const INHERIT = new Set(['inherit', 'default', 'config']);

function definition(family) {
  if (!Object.hasOwn(DEFINITIONS, family)) throw new Error(`unsupported reviewer family: ${family}`);
  return DEFINITIONS[family];
}

function option(argv, name) {
  const read = readOption(argv, name);
  if (read.duplicate || (read.supplied && (!read.value.trim() || read.value.startsWith('-')))) {
    throw new Error(`${name} requires exactly one nonempty value`);
  }
  return read;
}

function removeOptions(argv, names) {
  const remaining = [];
  for (let i = 0; i < argv.length; i++) {
    if (names.includes(argv[i])) { i++; continue; }
    if (names.some((name) => argv[i].startsWith(`${name}=`))) continue;
    remaining.push(argv[i]);
  }
  return remaining;
}

function configValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { throw new Error('invalid quoted model/effort config value'); }
  }
  return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;
}

function codexOverrides(argv) {
  const overrides = {};
  for (let i = 0; i < argv.length; i++) {
    let raw;
    if (argv[i] === '-c' || argv[i] === '--config') raw = argv[++i];
    else if (argv[i].startsWith('--config=')) raw = argv[i].slice('--config='.length);
    else if (argv[i].startsWith('-c') && argv[i].length > 2) raw = argv[i].slice(2);
    if (typeof raw !== 'string') continue;
    const match = raw.match(/^\s*(model|model_reasoning_effort)\s*=([\s\S]*)$/);
    if (match) overrides[match[1] === 'model' ? 'model' : 'effort'] = configValue(match[2]);
  }
  return overrides;
}

export function resolveReviewSelection({ family, argv = [], env = process.env }) {
  const d = definition(family);
  const modelFlag = option(argv, '--model');
  const effortFlag = option(argv, '--effort');
  const resolveField = (flag, key, fallback, allowBlank = false) => {
    if (flag.supplied) return { value: flag.value.trim(), source: 'flag' };
    if (env[key] !== undefined && (allowBlank || String(env[key]).trim())) {
      return { value: String(env[key]).trim(), source: 'env' };
    }
    return { value: fallback, source: 'default' };
  };
  const selectedModel = resolveField(modelFlag, d.modelEnv, d.modelDefault, family === 'codex');
  const selectedEffort = resolveField(effortFlag, d.effortEnv, d.effortDefault);
  const remaining = removeOptions(argv, ['--model', '--effort']);
  const overrides = family === 'codex' ? codexOverrides(remaining) : {};
  const sources = { model: selectedModel.source, effort: selectedEffort.source };
  let model = selectedModel.value;
  let effort = selectedEffort.value;
  const configModel = selectedModel.source === 'flag' && Object.hasOwn(d.aliases, String(model).toLowerCase())
    ? d.aliases[model.toLowerCase()] : model;
  if (Object.hasOwn(overrides, 'model')) { model = overrides.model; sources.model = 'config-flag'; }
  if (Object.hasOwn(overrides, 'effort')) { effort = overrides.effort; sources.effort = 'config-flag'; }
  if (sources.model === 'flag' && Object.hasOwn(d.aliases, String(model).toLowerCase())) {
    model = d.aliases[model.toLowerCase()];
  }
  if (family === 'codex' && sources.model !== 'config-flag'
    && (model === '' || INHERIT.has(String(model).toLowerCase()))) model = null;
  if (model !== null && (typeof model !== 'string' || !d.pinned(model))) {
    throw new Error(`${d.modelEnv}: model must be a pinned model ID such as ${d.modelDefault}; --model aliases: ${Object.keys(d.aliases).join(', ')}${family === 'codex' ? ', inherit' : ''}`);
  }
  if (!d.efforts.includes(effort)) {
    throw new Error(`${d.effortEnv}: effort must be one of ${d.efforts.join(', ')}`);
  }
  if (family === 'codex' && effort === 'minimal' && /^gpt-(?:5\.6|6)(?:[.-]|$)/.test(model || '')) {
    throw new Error(`${model} does not support minimal effort; select low, medium, high, xhigh, or max`);
  }
  return {
    model, effort, sources, argv: remaining,
    configModel: family === 'codex' && (configModel === '' || INHERIT.has(String(configModel).toLowerCase()))
      ? null : configModel,
    configEffort: selectedEffort.value,
  };
}

export function parseRoleQualifiers(family, tokens) {
  const d = definition(family);
  const selected = {};
  let consumed = 0;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    const model = Object.hasOwn(d.aliases, lower) ? d.aliases[lower]
      : d.pinned(token) || (family === 'codex' && INHERIT.has(lower)) ? token : undefined;
    const kind = d.efforts.includes(lower) ? 'effort' : model !== undefined ? 'model' : null;
    if (!kind) break;
    if (Object.hasOwn(selected, kind)) throw new Error(`duplicate ${kind} qualifier for ${family}`);
    selected[kind] = kind === 'effort' ? lower : model;
    consumed++;
  }
  const argv = ['model', 'effort'].flatMap((key) => (
    Object.hasOwn(selected, key) ? [`--${key}`, selected[key]] : []
  ));
  return { argv, remaining: tokens.slice(consumed) };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    const args = process.argv.slice(2);
    const family = option(args, '--family');
    if (!family.supplied) throw new Error('--family is required');
    const remaining = removeOptions(args, ['--family']);
    const handoff = remaining[0] === '--qualifiers'
      ? parseRoleQualifiers(family.value, remaining.slice(1)) : null;
    const resolved = resolveReviewSelection({ family: family.value, argv: handoff?.argv || remaining });
    process.stdout.write(`${JSON.stringify({ ...resolved, argv: handoff?.argv || resolved.argv, remaining: handoff?.remaining || [] }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}
