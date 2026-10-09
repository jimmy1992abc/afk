// Detection logic for the SessionStart auto-resume hook: parse afk run ledgers,
// select stale or deliberately yielded active runs, and turn them into the context
// string the hook injects. Pure and file-reading helpers only — the hook script
// owns stdin/stdout and process exit. See
// docs/designs/specs/2026-07-18-session-start-auto-resume.md and
// docs/designs/specs/issue-128-proactive-session-handoff.md.

import {
  closeSync, openSync, readSync, readdirSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';

// A fresh heartbeat retains ownership unless its writer deliberately yielded.
// This is the same ~20-min overlap guard continuity.md applies.
export const STALE_MINUTES = 20;

// Bound display-only ledger fields so they cannot flood the session context.
export const SCOPE_MAX = 500;

// Read only this many bytes from the top of each ledger. The header (run-id,
// state, heartbeat, and a `scope:` line) lives there, so a bounded read keeps the
// per-ledger cost small. A `## scope` block past this bound is missed, but scope
// is cosmetic. A Handoff block past this bound cannot bypass the stale guard.
//
// Note on total cost: the scan is O(number of run directories), because a run's
// resumability lives in its ledger and can only be known by reading it — so no
// pre-read cap (by count or mtime) is safe; it would drop exactly the abandoned
// run this hook exists to recover. The bound here keeps each read cheap, and the
// host-side hook timeout caps the worst case. Making it sub-linear needs an
// active-run index maintained by the afk skill (a second source of truth, prone
// to drift) — afk-lifecycle scope, deliberately not added to a read-only hook.
export const LEDGER_READ_BYTES = 16 * 1024;

function readPrefix(path, maxBytes) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    closeSync(fd);
  }
}

// Clock-jitter tolerance for a heartbeat slightly ahead of `now`. Within this it
// is still a live tick (just skewed); beyond it the timestamp is implausible.
export const FUTURE_SKEW_MINUTES = 5;

export const MODES = ['off', 'notify', 'auto'];

// Absent, blank, or unrecognized config resolves to the safe default.
export function normalizeMode(raw) {
  const value = (raw || '').trim().toLowerCase();
  return MODES.includes(value) ? value : 'notify';
}

function matchField(text, key) {
  const match = text.match(new RegExp(`^${key}:[ \\t]*([^\\r\\n]*)`, 'im'));
  return match ? match[1].trim() : '';
}

// Scope from a `## scope` markdown block: everything between the heading and the
// next H2 (or end of file). Ledgers written by afk carry scope on a header line
// instead; this is the fallback for the block form the prototype used.
function sectionBlock(text, pattern) {
  const heading = pattern.exec(text);
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
  let scope = headerScope ? headerScope[1].trim() : sectionBlock(text, /^##[ \t]*scope\b[^\n]*$/im);
  if (scope.length > SCOPE_MAX) scope = `${scope.slice(0, SCOPE_MAX)} ...`;
  return {
    runId: matchField(text, 'run-id'),
    state: matchField(text, 'state').toLowerCase(),
    heartbeat: matchField(text, 'heartbeat'),
    scope,
  };
}

// Milliseconds between `now` (a Date) and an ISO-8601 heartbeat, or null when the
// heartbeat is missing or unparseable — which remains notify-only. This
// is the exact quantity the 20-minute guard compares against: rounding first
// would surface a 19.5-min-old (still-live) run as if it were 20 min stale.
export function staleMsOf(heartbeat, now) {
  const parts = typeof heartbeat === 'string' && /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(heartbeat);
  if (!parts) return null;
  const [, y, m, d, h, minute, second, zone] = parts;
  const year = Number(y);
  const month = Number(m);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // Date.parse normalizes impossible calendar dates, which invents ownership age.
  if (year < 1 || month < 1 || month > 12 || Number(d) < 1 || Number(d) > days[month - 1]
    || Number(h) > 23 || Number(minute) > 59 || Number(second) > 59
    || (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) return null;
  const t = Date.parse(heartbeat.replace(' ', 'T'));
  if (Number.isNaN(t)) return null;
  const ms = now.getTime() - t;
  // A heartbeat implausibly far in the future (clock skew past tolerance, or a
  // bad write) is not a live tick. Treat it like a missing one — null — so the
  // run stays resumable rather than being hidden until wall time catches up.
  if (ms < -FUTURE_SKEW_MINUTES * 60_000) return null;
  return ms;
}

// Whole minutes stale, floored, for display only — never for the guard compare.
// null when the heartbeat is missing or unparseable.
export function staleMinutesOf(heartbeat, now) {
  const ms = staleMsOf(heartbeat, now);
  return ms === null ? null : Math.floor(ms / 60_000);
}

// Malformed markers must never hide runs that the heartbeat alone would surface.
// Primitive strings and the shared timestamp validator avoid coercion failures.
export function parseHandoff(text, now = new Date()) {
  if (typeof text !== 'string') return null;
  const block = sectionBlock(text, /^##[ \t]+Handoff[ \t]*\r?$/im);
  const reason = matchField(block, 'reason');
  const written = matchField(block, 'written');
  let nextAction = matchField(block, 'next-action');
  if (!['rotation', 'yield', 'compaction', 'auto-pause'].includes(reason)
    || staleMsOf(written, now) === null || !nextAction) return null;
  if (nextAction.length > SCOPE_MAX) nextAction = `${nextAction.slice(0, SCOPE_MAX)} ...`;
  return { reason, written, nextAction };
}

// Read `<runsDir>/*/ledger.md`, keep the runs that are `state: active` AND whose
// heartbeat is stale beyond `staleMinutes` or deliberately yielded. A missing/garbled heartbeat counts as
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
    let text;
    try {
      text = readPrefix(ledgerPath, LEDGER_READ_BYTES);
      parsed = parseLedger(text);
    } catch {
      continue; // no ledger, or unreadable/garbled → skip this directory
    }
    if (parsed.state !== 'active') continue;
    const ms = staleMsOf(parsed.heartbeat, now);
    const handoff = parseHandoff(text, now);
    const yielded = ms !== null && handoff !== null
      && (handoff.reason === 'rotation' || handoff.reason === 'yield')
      && staleMsOf(handoff.written, now) <= ms;
    // Compare exact age, not rounded minutes: an age strictly under the guard is
    // fresh (a live tick owns it). null age (missing/garbled) is treated as stale.
    if (ms !== null && ms < staleMinutes * 60_000 && !yielded) continue;
    selected.push({
      runId: parsed.runId || entry.name,
      relPath: relative(root, ledgerPath).split('\\').join('/'),
      ledgerPath: resolve(ledgerPath),
      scope: parsed.scope,
      stale: ms === null ? null : Math.max(0, Math.floor(ms / 60_000)),
      ...(yielded ? { yielded: true, handoff } : {}),
    });
  }
  return selected;
}

const staleLabel = (run) => (run.stale === null ? 'unknown' : `${run.stale} min`);
const yieldLabel = (run) => `Yielded deliberately at ${run.handoff.written}; next action recorded in the ledger (verbatim): ${run.handoff.nextAction}`;

// The `additionalContext` string for the selected runs, or '' when there are
// none. One run in `auto` mode gets a conditional autonomous-resume directive;
// `notify` surfaces only; two or more runs are listed and none is driven (one
// session must not drive two runs).
export function buildContext(runs, { mode }) {
  if (!runs || runs.length === 0) return '';

  if (runs.length === 1) {
    const run = runs[0];
    const lines = [
      `Resumable afk run detected: **${run.runId}** (state: active, heartbeat age ${staleLabel(run)}${run.stale === null ? ' — ownership unknown' : ' — revalidate ownership before resuming'}).`,
      `Ledger: \`${run.ledgerPath || run.relPath}\``,
    ];
    if (run.scope) lines.push('Scope (verbatim):', run.scope);
    if (run.yielded) lines.push(yieldLabel(run));
    lines.push('');
    if (run.stale === null) {
      lines.push('Heartbeat ownership is unknown: notify-only, surfacing only. Read the ledger and confirm ownership with the operator before resuming; do not auto-drive this run.');
    } else if (mode === 'auto') {
      lines.push(
        "auto-resume is set to `auto`. Unless the operator's first message directs you "
        + 'elsewhere, resume this run autonomously per the afk skill, starting with its '
        + "kickoff collision check: re-read this run's ledger and the other run ledgers, and "
        + 'do NOT drive if the run is now `complete`, if its heartbeat is fresh without a valid '
        + '`rotation` or `yield` marker whose `written` is at or after that heartbeat, '
        + 'or if another live run holds this scope — surface it instead. '
        + 'For other runs, a fresh heartbeat still means live regardless of any marker. '
        + 'Only when this run is still `state: active` with a stale heartbeat or valid deliberate '
        + "yield, refresh its UTC heartbeat and rewrite the marker's reason to `compaction` "
        + 'or clear the block in the same first takeover write to consume the marker '
        + "and run the full waterfall to the queue's end or the next auto-pause, "
        + "honoring the run's merge policy. This heartbeat check is advisory, not a hard lock, "
        + 'so when in doubt prefer surfacing over driving. If the operator asks for something '
        + 'else, do that and note this run is resumable.',
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

  const ownership = runs.some((run) => run.yielded)
    ? 'stale or unknown heartbeat, or deliberate yield' : 'stale or unknown heartbeat';
  const lines = [`${runs.length} resumable afk runs detected (state: active, ${ownership}):`];
  for (const run of runs) {
    lines.push(`  - **${run.runId}** — \`${run.ledgerPath || run.relPath}\` (age ${staleLabel(run)})`);
    if (run.scope) lines.push(`    scope: ${run.scope}`); // so the operator can tell the runs apart
    if (run.yielded) lines.push(`    ${yieldLabel(run)}`);
  }
  lines.push('');
  lines.push(
    'Do NOT auto-drive more than one afk run in a single session (each needs its own '
    + 'worktree/session). Confirm with the operator which to resume, then follow the afk skill '
    + 'for that one.',
  );
  return lines.join('\n');
}
