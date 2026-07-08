#!/usr/bin/env node
// precompress-hook.mjs — OPT-IN UserPromptSubmit hook (default OFF).
//
// Dormant unless BOTH AGENT_RELAY_ENABLED=on AND AGENT_RELAY_HOOK=on. When on,
// and the submitted prompt references an issue (#NNN), it runs brief.mjs and
// injects the brief as extra context. It NEVER blocks the prompt: any problem
// → exit 0 with no output (fail-soft).
//
// Wire it in .claude/settings.local.json (gitignored) — see SKILL.md.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isOn } from '../lib/relay.mjs';

async function main() {
  const env = process.env;
  // two-switch gate: master + hook must both be on
  if (!(isOn(env.AGENT_RELAY_ENABLED) && isOn(env.AGENT_RELAY_HOOK))) return;

  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let prompt = '';
  try {
    prompt = JSON.parse(raw).prompt || '';
  } catch {
    prompt = raw;
  }

  // heavy trigger: an explicit issue reference
  const m = prompt.match(/#(\d{1,6})\b/);
  if (!m) return;

  const here = dirname(fileURLToPath(import.meta.url));
  const brief = join(here, '..', 'brief.mjs');
  const r = spawnSync(
    process.execPath,
    [brief, '--manual', '--task', prompt.slice(0, 300), '--issue', m[1]],
    { encoding: 'utf8', timeout: 330000 },
  );

  // only inject a real brief — not a SKIPPED/ERROR block
  const out = r.stdout || '';
  if (r.status === 0 && /=====\s*AGENT BRIEF\s*=====/.test(out) && !/\b(SKIPPED|ERROR):/.test(out)) {
    process.stdout.write(out);
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
