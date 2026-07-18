#!/usr/bin/env node
// afk-resume-detect.mjs — plugin-level SessionStart hook.
//
// When a window (re)opens against a repo, detect any afk run that is paused and
// resumable (state: active, heartbeat stale beyond the overlap guard) and inject
// it as SessionStart context so the operator does not have to hunt down the
// ledger. Behaviour is set by the `auto-resume` knob in .afk/config.md
// (off | notify | auto; default notify). See
// docs/designs/specs/2026-07-18-session-start-auto-resume.md.
//
// Contract: reads the hook JSON from stdin, writes at most one JSON object to
// stdout, and ALWAYS exits 0. It never blocks or crashes a session — any error
// is swallowed and produces no output. Pure no-op outside an afk repo.

import { join } from 'node:path';

import { readConfigValue } from '../lib/config.mjs';
import { mainWorktree } from '../lib/gate/git.mjs';
import { buildContext, collectResumable, normalizeMode } from '../lib/resume/detect.mjs';

async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function main() {
  let data = {};
  try {
    data = JSON.parse(await readStdin()) || {};
  } catch {
    return; // no/garbled input → nothing to do
  }

  // Act only on a real window (re)start, never on clear/compact.
  if (data.source !== 'startup' && data.source !== 'resume') return;

  const cwd = (typeof data.cwd === 'string' && data.cwd) || process.cwd();
  const root = mainWorktree({ cwd }) || cwd;

  // Disabled → stay silent without even scanning.
  const mode = normalizeMode(readConfigValue(join(root, '.afk', 'config.md'), 'auto-resume'));
  if (mode === 'off') return;

  const runs = collectResumable(join(root, '.afk', 'runs'), { root, now: new Date() });
  const context = buildContext(runs, { mode });
  if (!context) return; // no resumable run

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  }));
}

main()
  .catch(() => {}) // never crash a session
  .finally(() => process.exit(0));
