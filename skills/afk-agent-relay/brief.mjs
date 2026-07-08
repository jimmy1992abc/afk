#!/usr/bin/env node
// brief.mjs — context COMPRESSOR. Default provider: deepseek.
//
// Reads raw bytes (issue text, diff, files, ripgrep hits, log tails) OUT OF
// PROCESS and returns a short 6-section brief. Only the brief re-enters
// Claude's window.
//
//   node brief.mjs --manual --task "<one line>" --issue 42 --diff main \
//        --files a.py b.py --logs app.log --grep "TODO"

import { fileURLToPath } from 'node:url';
import { runRole } from './lib/role.mjs';
import { validateBrief, errorBlock } from './lib/relay.mjs';

const LABEL = 'AGENT BRIEF';

const SYSTEM = `You are a senior engineer producing a COMPRESSED implementation brief for another engineer (Claude Code) who will do the actual coding. You receive raw context (issue text, a git diff, source files, ripgrep hits, log tails) that may be large. Distil it.

Rules:
- Output ONLY the block below — nothing before or after it.
- Summarise the context within a CEILING of ~6000 tokens — make the brief only as long as the task needs (a trivial task warrants a few short lines, a complex one more). The ceiling is a limit, not a target: do NOT pad to reach a length; shorter is better when the task is simple. Read more of the context than you emit — distil it, do not just truncate it. Cite real file paths and line numbers from the context. Do NOT invent files, functions, or APIs not present in the context.
- If the context is insufficient for a section, say so explicitly rather than guessing.

===== AGENT BRIEF =====
1. Problem: <one or two sentences>
2. Files involved: <paths, with line anchors where known>
3. Minimal safe change: <the smallest change that solves it>
4. Tests to run: <specific test files / commands>
5. Risks: <edge cases, fail-closed concerns, things to watch>
6. Do NOT touch: <files/areas that must stay unchanged>
===== END AGENT BRIEF =====`;

export const config = {
  label: LABEL,
  defaultProvider: 'deepseek',
  providerEnv: 'AGENT_RELAY_BRIEF_PROVIDER',
  modelEnv: 'AGENT_RELAY_BRIEF_MODEL',
  systemPrompt: SYSTEM,
  validate: validateBrief,
  buildUser: (args, gctx) =>
    `TASK: ${args.task}\n\nGATHER NOTES: ${gctx.notes.join(' ') || '(none)'}\n\n` +
    `=== CONTEXT ===\n${gctx.text || '(no context gathered)'}`,
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
