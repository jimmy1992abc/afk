#!/usr/bin/env node
// scope.mjs — the FIRST gate: turn a raw request into a reviewable issue draft
// using an INDEPENDENT model. Default provider: codex.
//
// It does NOT create the issue — it prints a draft; you/Claude review, then
// `gh issue create`.
//
//   node scope.mjs --manual --task "<raw request>" [--files a.py] [--issue 12]

import { fileURLToPath } from 'node:url';
import { runRole } from './lib/role.mjs';
import { validateScope, errorBlock } from './lib/relay.mjs';

const LABEL = 'AGENT SCOPE';

const SYSTEM = `You are an independent reviewer turning a raw development request into a crisp, reviewable issue draft. A different model will implement it later, so the boundaries you set matter.

Rules:
- Output ONLY the block below — nothing before or after it.
- Be specific and testable. Prefer concrete acceptance criteria over vague goals.

===== AGENT SCOPE =====
Title: <under 70 chars>
Problem: <what's wrong / what's needed and why>
Acceptance criteria:
- <criterion 1>
- <criterion 2>
Non-goals:
- <explicitly out of scope>
What must NOT change: <existing behaviour/flows to preserve>
Suggested model tier: strong (default) or cheap (if the task is mechanical and well-specified) — <one-line reason>
===== END AGENT SCOPE =====`;

export const config = {
  label: LABEL,
  defaultProvider: 'codex',
  providerEnv: 'AGENT_RELAY_SCOPE_PROVIDER',
  modelEnv: 'AGENT_RELAY_SCOPE_MODEL',
  systemPrompt: SYSTEM,
  validate: validateScope,
  buildUser: (args, gctx) =>
    `REQUEST: ${args.task}` +
    (gctx.text ? `\n\n=== RELATED CONTEXT ===\n${gctx.text}` : '') +
    (gctx.notes.length ? `\n\nGATHER NOTES: ${gctx.notes.join(' ')}` : ''),
};

export function run(io) {
  return runRole(config, io);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run({ argv: process.argv.slice(2), env: process.env })
    .then((r) => {
      process.stdout.write(r.out);
      process.exit(r.code);
    })
    .catch((e) => {
      process.stdout.write(errorBlock(LABEL, e.message));
      process.exit(1);
    });
}
