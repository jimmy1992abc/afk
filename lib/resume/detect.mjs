// Detection logic for the SessionStart auto-resume hook: parse afk run ledgers,
// select the ones that are paused-and-resumable, and turn them into the context
// string the hook injects. Pure and file-reading helpers only — the hook script
// owns stdin/stdout and process exit. See
// docs/designs/specs/2026-07-18-session-start-auto-resume.md.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// A heartbeat fresher than this means a live tick still owns the run, so it is
// not surfaced — the same ~20-min overlap guard skills/afk/SKILL.md applies.
export const STALE_MINUTES = 20;

// Cap injected scope so a long ledger cannot flood the session context.
export const SCOPE_MAX = 500;

export const MODES = ['off', 'notify', 'auto'];

// Absent, blank, or unrecognized config resolves to the safe default.
export function normalizeMode(raw) {
  const value = (raw || '').trim().toLowerCase();
  return MODES.includes(value) ? value : 'notify';
}

function matchField(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*(\\S+)`, 'im'));
  return match ? match[1] : '';
}

// Scope from a `## scope` markdown block: everything between the heading and the
// next H2 (or end of file). Ledgers written by afk carry scope on a header line
// instead; this is the fallback for the block form the prototype used.
function scopeBlock(text) {
  const heading = /^##[ \t]*scope\b[^\n]*$/im.exec(text);
  if (!heading) return '';
  const after = text.slice(heading.index + heading[0].length);
  const next = /\n##[ \t]/.exec(after);
  return (next ? after.slice(0, next.index) : after).trim();
}

// Parse a ledger's header + scope. state is lower-cased; every field is a string
// ('' when absent). Scope prefers the single-line `scope:` header field that afk
// writes, falling back to a `## scope` block, truncated to SCOPE_MAX.
export function parseLedger(text) {
  const headerScope = text.match(/^scope:[ \t]*(.+)$/im);
  let scope = headerScope ? headerScope[1].trim() : scopeBlock(text);
  if (scope.length > SCOPE_MAX) scope = `${scope.slice(0, SCOPE_MAX)} ...`;
  return {
    runId: matchField(text, 'run-id'),
    state: matchField(text, 'state').toLowerCase(),
    heartbeat: matchField(text, 'heartbeat'),
    scope,
  };
}

// Milliseconds between `now` (a Date) and an ISO-8601 heartbeat, or null when the
// heartbeat is missing or unparseable — which the selector treats as stale. This
// is the exact quantity the 20-minute guard compares against: rounding first
// would surface a 19.5-min-old (still-live) run as if it were 20 min stale.
export function staleMsOf(heartbeat, now) {
  if (!heartbeat) return null;
  const t = Date.parse(heartbeat);
  if (Number.isNaN(t)) return null;
  return now.getTime() - t;
}

// Whole minutes stale, floored, for display only — never for the guard compare.
// null when the heartbeat is missing or unparseable.
export function staleMinutesOf(heartbeat, now) {
  const ms = staleMsOf(heartbeat, now);
  return ms === null ? null : Math.floor(ms / 60_000);
}

// Read `<runsDir>/*/ledger.md`, keep the runs that are `state: active` AND whose
// heartbeat is stale beyond `staleMinutes` (a missing/garbled heartbeat counts as
// stale — fail-safe: an active run no live tick owns must be surfaced, not hidden).
// relPath is relative to `root` (the main working tree), forward-slashed.
export function collectResumable(runsDir, { root, now, staleMinutes = STALE_MINUTES }) {
  let entries;
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return []; // no runs dir → nothing to resume
  }
  const selected = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const ledgerPath = join(runsDir, entry.name, 'ledger.md');
    let parsed;
    try {
      parsed = parseLedger(readFileSync(ledgerPath, 'utf8'));
    } catch {
      continue; // no ledger, or unreadable/garbled → skip this directory
    }
    if (parsed.state !== 'active') continue;
    const ms = staleMsOf(parsed.heartbeat, now);
    // Compare exact age, not rounded minutes: an age strictly under the guard is
    // fresh (a live tick owns it). null age (missing/garbled) is treated as stale.
    if (ms !== null && ms < staleMinutes * 60_000) continue;
    selected.push({
      runId: parsed.runId || entry.name,
      relPath: relative(root, ledgerPath).split('\\').join('/'),
      scope: parsed.scope,
      stale: ms === null ? null : Math.floor(ms / 60_000),
    });
  }
  return selected;
}

const staleLabel = (run) => (run.stale === null ? 'unknown' : `${run.stale} min`);

// The `additionalContext` string for the selected runs, or '' when there are
// none. One run in `auto` mode gets a conditional autonomous-resume directive;
// `notify` surfaces only; two or more runs are listed and none is driven (one
// session must not drive two runs).
export function buildContext(runs, { mode }) {
  if (!runs || runs.length === 0) return '';

  if (runs.length === 1) {
    const run = runs[0];
    const lines = [
      `Resumable afk run detected: **${run.runId}** (state: active, heartbeat stale ${staleLabel(run)} — paused, not being driven by a live tick).`,
      `Ledger: \`${run.relPath}\``,
    ];
    if (run.scope) lines.push('Scope (verbatim):', run.scope);
    lines.push('');
    if (mode === 'auto') {
      lines.push(
        "auto-resume is set to `auto`. Unless the operator's first message directs you "
        + 'elsewhere, resume this run autonomously per the afk skill: read the full ledger, '
        + 'refresh its UTC heartbeat first (overlap guard), then run the full waterfall to the '
        + "queue's end or the next auto-pause, honoring the run's merge policy. If a sibling "
        + "run's heartbeat is fresh, leave it alone. If the operator asks for something else, "
        + 'do that and note this run is resumable.',
      );
    } else {
      lines.push(
        'auto-resume is set to `notify` — surfacing only. Resume it per the afk skill only if '
        + 'you intend to (read the full ledger and refresh its UTC heartbeat first); otherwise '
        + 'carry on with whatever the operator asks.',
      );
    }
    return lines.join('\n');
  }

  const lines = [`${runs.length} resumable afk runs detected (state: active, stale heartbeat):`];
  for (const run of runs) lines.push(`  - **${run.runId}** — \`${run.relPath}\` (stale ${staleLabel(run)})`);
  lines.push('');
  lines.push(
    'Do NOT auto-drive more than one afk run in a single session (each needs its own '
    + 'worktree/session). Confirm with the operator which to resume, then follow the afk skill '
    + 'for that one.',
  );
  return lines.join('\n');
}
