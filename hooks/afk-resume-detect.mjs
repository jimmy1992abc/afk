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
// It also carries the stale-install notice. This hook fires before any skill is
// chosen, so it is the only place a direct satellite invocation — which never
// runs the afk driver's kickoff check — can see that its wrappers are old. The
// two signals are independent: `auto-resume: off` silences resume detection and
// not the notice, which has its own opt-out (AFK_UPDATE_CHECK).
//
// Contract: reads the hook JSON from stdin, writes at most one JSON object to
// stdout, and ALWAYS exits 0. It never blocks or crashes a session — any error
// emits a bounded stderr skip without session context. Pure no-op outside an afk repo.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function main() {
  // A partially upgraded install must not crash the host before the catch runs.
  const [{ readConfigValue }, { mainWorktree }, { buildContext, collectResumable, normalizeMode },
    { prepareGateProfileNotice }, { resolveUpdateNotice }] = await Promise.all([
    import('../lib/config.mjs'), import('../lib/gate/git.mjs'), import('../lib/resume/detect.mjs'),
    import('../scripts/gate-profile-notice.mjs'), import('../scripts/update-check.mjs'),
  ]);
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
  const afkDir = join(root, '.afk');

  // No .afk/ means no afk repo: the hook's no-op contract, unchanged by the
  // notice below.
  if (!existsSync(afkDir)) return;

  // Disabled → do not scan. The update notice is a different fact and is
  // resolved regardless, so this knob can no longer end the run early.
  const mode = normalizeMode(readConfigValue(join(afkDir, 'config.md'), 'auto-resume'));
  const runs = mode === 'off'
    ? []
    : collectResumable(join(afkDir, 'runs'), { root, now: new Date() });

  const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const notice = await resolveUpdateNotice({
    pluginRoot,
    cachePath: join(afkDir, 'update-check.json'),
  });
  const resumeContext = buildContext(runs, { mode });
  const profileNotice = prepareGateProfileNotice({ afkDir, pluginRoot });

  const context = [notice, profileNotice.notice, resumeContext].filter(Boolean).join('\n\n');
  if (!context) return; // nothing to say

  const payload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  });
  // Await the write: a forced process.exit() can truncate a still-pending pipe
  // write, which would silently drop the JSON the whole hook exists to emit.
  await new Promise((resolve, reject) => {
    process.stdout.write(payload, (error) => (error ? reject(error) : resolve()));
  });
  profileNotice.commit();
}

main()
  .catch((error) => {
    process.stderr.write(`[afk-resume-detect] SKIPPED: hook dependency or execution failure (${error.code || error.name || 'unknown'})\n`);
  })
  .finally(() => process.exit(0));
