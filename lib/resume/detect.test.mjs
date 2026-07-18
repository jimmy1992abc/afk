// Unit tests for the resume detector. collectResumable runs against real
// temporary `.afk/runs/` fixtures, never a stub: the whole point is to parse
// real ledger files the way the hook will in the field.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'node:test';

import {
  STALE_MINUTES,
  buildContext,
  collectResumable,
  normalizeMode,
  parseLedger,
  staleMinutesOf,
  staleMsOf,
} from './detect.mjs';

// ── fixtures ────────────────────────────────────────────────────────────────

const NOW = new Date('2026-07-18T12:00:00Z');
const iso = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'resume-detect-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Write a `.afk/runs/<id>/ledger.md` and return the runs dir.
function writeLedger(root, id, body) {
  const dir = join(root, '.afk', 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ledger.md'), body, 'utf8');
  return join(root, '.afk', 'runs');
}

const header = ({ runId = 'r', state = 'active', heartbeat, scope = 'do a thing' }) => `# afk run ledger

run-id: ${runId}
scope: ${scope}
state: ${state}
${heartbeat === undefined ? '' : `heartbeat: ${heartbeat}\n`}
## State

- working
`;

// ── normalizeMode ─────────────────────────────────────────────────────────────

test('normalizeMode accepts the three known modes', () => {
  assert.equal(normalizeMode('off'), 'off');
  assert.equal(normalizeMode('notify'), 'notify');
  assert.equal(normalizeMode('auto'), 'auto');
  assert.equal(normalizeMode(' AUTO '), 'auto');
});

test('normalizeMode defaults to notify for absent/blank/unknown', () => {
  for (const v of ['', '   ', undefined, null, 'on', 'yes', 'resume', 'garbage']) {
    assert.equal(normalizeMode(v), 'notify', JSON.stringify(v));
  }
});

// ── parseLedger ───────────────────────────────────────────────────────────────

test('parseLedger reads the header fields', () => {
  const p = parseLedger(header({ runId: 'x1', state: 'active', heartbeat: '2026-07-18T00:00:00Z', scope: 'ship X' }));
  assert.equal(p.runId, 'x1');
  assert.equal(p.state, 'active');
  assert.equal(p.heartbeat, '2026-07-18T00:00:00Z');
  assert.equal(p.scope, 'ship X');
});

test('parseLedger reads scope from a `## scope` block when no header line', () => {
  const body = `# afk run ledger

run-id: x2
state: active
heartbeat: 2026-07-18T00:00:00Z

## scope

Line one of scope.
Line two of scope.

## State
`;
  const p = parseLedger(body);
  assert.match(p.scope, /Line one of scope\./);
  assert.match(p.scope, /Line two of scope\./);
});

test('parseLedger prefers the `scope:` header line over a block', () => {
  const body = `# afk run ledger

run-id: x3
scope: header scope wins
state: active
heartbeat: 2026-07-18T00:00:00Z

## scope

block scope loses
`;
  assert.equal(parseLedger(body).scope, 'header scope wins');
});

test('parseLedger tolerates a missing heartbeat and missing scope', () => {
  const p = parseLedger('run-id: x4\nstate: active\n');
  assert.equal(p.heartbeat, '');
  assert.equal(p.scope, '');
});

// ── staleMinutesOf ────────────────────────────────────────────────────────────

test('staleMinutesOf floors to whole minutes for display', () => {
  assert.equal(staleMinutesOf(iso(30), NOW), 30);
  assert.equal(staleMinutesOf(iso(0), NOW), 0);
  // 19.5 min old floors to 19, not rounds to 20 — display must not overstate age.
  const hb = new Date(NOW.getTime() - (19 * 60_000 + 30_000)).toISOString();
  assert.equal(staleMinutesOf(hb, NOW), 19);
});

test('staleMinutesOf / staleMsOf return null for a missing or garbled heartbeat', () => {
  for (const v of ['', 'not-a-date', undefined]) {
    assert.equal(staleMinutesOf(v, NOW), null, JSON.stringify(v));
    assert.equal(staleMsOf(v, NOW), null, JSON.stringify(v));
  }
});

test('staleMsOf is the exact age the guard compares (no rounding)', () => {
  assert.equal(staleMsOf(iso(19.5), NOW), 19.5 * 60_000);
});

// ── collectResumable (against real tmp ledgers) ───────────────────────────────

test('collectResumable surfaces an active run with a stale heartbeat', () => {
  withRoot((root) => {
    const runs = writeLedger(root, 'stale-run', header({ runId: 'stale-run', heartbeat: iso(120) }));
    const found = collectResumable(runs, { root, now: NOW });
    assert.equal(found.length, 1);
    assert.equal(found[0].runId, 'stale-run');
    assert.equal(found[0].stale, 120);
    assert.match(found[0].relPath, /\.afk\/runs\/stale-run\/ledger\.md$/);
  });
});

test('collectResumable skips an active run with a fresh heartbeat', () => {
  withRoot((root) => {
    const runs = writeLedger(root, 'fresh-run', header({ heartbeat: iso(5) }));
    assert.deepEqual(collectResumable(runs, { root, now: NOW }), []);
  });
});

test('collectResumable skips a complete run even when very stale', () => {
  withRoot((root) => {
    const runs = writeLedger(root, 'done', header({ state: 'complete', heartbeat: iso(600) }));
    assert.deepEqual(collectResumable(runs, { root, now: NOW }), []);
  });
});

test('collectResumable surfaces an active run whose heartbeat is missing/garbled (fail-safe)', () => {
  withRoot((root) => {
    writeLedger(root, 'no-hb', header({ runId: 'no-hb', heartbeat: undefined }));
    const runs = writeLedger(root, 'bad-hb', header({ runId: 'bad-hb', heartbeat: 'garbage' }));
    const found = collectResumable(runs, { root, now: NOW });
    const ids = found.map((f) => f.runId).sort();
    assert.deepEqual(ids, ['bad-hb', 'no-hb']);
    for (const f of found) assert.equal(f.stale, null);
  });
});

test('collectResumable returns multiple stale runs', () => {
  withRoot((root) => {
    writeLedger(root, 'a', header({ runId: 'a', heartbeat: iso(30) }));
    const runs = writeLedger(root, 'b', header({ runId: 'b', heartbeat: iso(90) }));
    const found = collectResumable(runs, { root, now: NOW });
    assert.equal(found.length, 2);
  });
});

test('collectResumable falls back to the directory name when run-id is absent', () => {
  withRoot((root) => {
    const runs = writeLedger(root, 'dir-name', 'state: active\nheartbeat: ' + iso(60) + '\n');
    const found = collectResumable(runs, { root, now: NOW });
    assert.equal(found.length, 1);
    assert.equal(found[0].runId, 'dir-name');
  });
});

test('collectResumable returns [] when the runs dir is absent', () => {
  withRoot((root) => {
    assert.deepEqual(collectResumable(join(root, '.afk', 'runs'), { root, now: NOW }), []);
  });
});

test('collectResumable ignores a directory with no ledger and a stray file', () => {
  withRoot((root) => {
    const runs = writeLedger(root, 'real', header({ runId: 'real', heartbeat: iso(60) }));
    mkdirSync(join(runs, 'empty-dir'), { recursive: true });
    writeFileSync(join(runs, 'loose.txt'), 'not a run', 'utf8');
    const found = collectResumable(runs, { root, now: NOW });
    assert.equal(found.length, 1);
    assert.equal(found[0].runId, 'real');
  });
});

test('STALE_MINUTES is the documented 20-minute overlap guard', () => {
  assert.equal(STALE_MINUTES, 20);
  withRoot((root) => {
    // exactly at the threshold counts as stale (>=), just under does not.
    writeLedger(root, 'at', header({ runId: 'at', heartbeat: iso(20) }));
    const runsAt = writeLedger(root, 'under', header({ runId: 'under', heartbeat: iso(19) }));
    const found = collectResumable(runsAt, { root, now: NOW });
    assert.deepEqual(found.map((f) => f.runId), ['at']);
  });
});

test('collectResumable compares exact age: a sub-20-min run is skipped even if it rounds to 20', () => {
  withRoot((root) => {
    // 19.5 min old: strictly under the guard, must be skipped. A prior Math.round
    // would have mapped it to 20 and surfaced a still-live run (a second driver in auto mode).
    const hb = new Date(NOW.getTime() - (19 * 60_000 + 30_000)).toISOString();
    const runs = writeLedger(root, 'almost', header({ runId: 'almost', heartbeat: hb }));
    assert.deepEqual(collectResumable(runs, { root, now: NOW }), []);
  });
});

// ── buildContext ──────────────────────────────────────────────────────────────

const one = [{ runId: 'solo', relPath: '.afk/runs/solo/ledger.md', scope: 'ship the thing', stale: 45 }];
const many = [
  { runId: 'a', relPath: '.afk/runs/a/ledger.md', scope: 's', stale: 30 },
  { runId: 'b', relPath: '.afk/runs/b/ledger.md', scope: 's', stale: 90 },
];

test('buildContext returns empty string for no runs', () => {
  assert.equal(buildContext([], { mode: 'notify' }), '');
  assert.equal(buildContext([], { mode: 'auto' }), '');
});

test('buildContext notify+single surfaces the run but does NOT direct an autonomous drive', () => {
  const c = buildContext(one, { mode: 'notify' });
  assert.match(c, /solo/);
  assert.match(c, /\.afk\/runs\/solo\/ledger\.md/);
  assert.match(c, /ship the thing/);
  assert.doesNotMatch(c, /autonomously/i);
});

test('buildContext auto+single directs a conditional autonomous resume', () => {
  const c = buildContext(one, { mode: 'auto' });
  assert.match(c, /solo/);
  assert.match(c, /autonomously/i);
  assert.match(c, /refresh/i); // heartbeat refresh / overlap guard
  assert.match(c, /first message/i); // conditional on operator redirect
});

test('buildContext lists multiple runs and drives none, even in auto mode', () => {
  for (const mode of ['notify', 'auto']) {
    const c = buildContext(many, { mode });
    assert.match(c, /\*\*a\*\*/);
    assert.match(c, /\*\*b\*\*/);
    assert.match(c, /Do NOT auto-drive/i);
    assert.doesNotMatch(c, /resume this run autonomously/i);
  }
});

test('buildContext renders unknown staleness for a null heartbeat', () => {
  const c = buildContext([{ runId: 'u', relPath: '.afk/runs/u/ledger.md', scope: '', stale: null }], { mode: 'notify' });
  assert.match(c, /unknown/i);
});
