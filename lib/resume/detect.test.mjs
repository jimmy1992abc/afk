// Unit tests for the resume detector. collectResumable runs against real
// temporary `.afk/runs/` fixtures, never a stub: the whole point is to parse
// real ledger files the way the hook will in the field.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'node:test';

import {
  FUTURE_SKEW_MINUTES,
  LEDGER_READ_BYTES,
  STALE_MINUTES,
  SCOPE_MAX,
  buildContext,
  collectResumable,
  normalizeMode,
  parseLedger,
  staleMinutesOf,
  staleMsOf,
} from './detect.mjs';
import * as resume from './detect.mjs';

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

test('staleMsOf tolerates small future skew but rejects an implausible future timestamp', () => {
  // within skew: still a (skewed) live tick — a real negative age is returned.
  assert.equal(staleMsOf(iso(-2), NOW), -2 * 60_000);
  // beyond skew: bogus → null, so the run is treated as resumable, not hidden.
  assert.equal(staleMsOf(iso(-(FUTURE_SKEW_MINUTES + 10)), NOW), null);
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

test('collectResumable surfaces a run with an implausibly future heartbeat (fail-safe)', () => {
  withRoot((root) => {
    const future = header({ runId: 'future', heartbeat: iso(-(FUTURE_SKEW_MINUTES + 10)) });
    const runs = writeLedger(root, 'future', future);
    const found = collectResumable(runs, { root, now: NOW });
    assert.equal(found.length, 1);
    assert.equal(found[0].runId, 'future');
    assert.equal(found[0].stale, null); // hidden-forever bug avoided; shows as unknown
  });
});

test('collectResumable still skips a run whose heartbeat is only slightly ahead (skew)', () => {
  withRoot((root) => {
    // 2 min in the future: within skew → still a live tick → skipped, not surfaced.
    const runs = writeLedger(root, 'skewed', header({ runId: 'skewed', heartbeat: iso(-2) }));
    assert.deepEqual(collectResumable(runs, { root, now: NOW }), []);
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

test('collectResumable reads only a bounded prefix, so a huge ledger does not blow up startup', () => {
  withRoot((root) => {
    // valid header at the top, then a body far larger than the read bound. The
    // header must still drive selection; the trailing bulk is never read.
    const body = `${header({ runId: 'big', heartbeat: iso(60) })}\n${'x'.repeat(LEDGER_READ_BYTES * 2)}`;
    const runs = writeLedger(root, 'big', body);
    const found = collectResumable(runs, { root, now: NOW });
    assert.equal(found.length, 1);
    assert.equal(found[0].runId, 'big');
    assert.equal(found[0].stale, 60);
  });
});

test('collectResumable never drops a resumable run for recency (no pre-read cap)', () => {
  withRoot((root) => {
    // Many completed runs plus one long-abandoned active+stale run: the active
    // one must still surface. A recency/count cap would have hidden exactly it.
    let runs;
    for (let i = 0; i < 30; i += 1) {
      runs = writeLedger(root, `done-${i}`, header({ runId: `done-${i}`, state: 'complete', heartbeat: iso(1) }));
    }
    writeLedger(root, 'abandoned', header({ runId: 'abandoned', heartbeat: iso(9000) }));
    const found = collectResumable(runs, { root, now: NOW });
    assert.deepEqual(found.map((f) => f.runId), ['abandoned']);
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
  { runId: 'a', relPath: '.afk/runs/a/ledger.md', scope: 'ship alpha', stale: 30 },
  { runId: 'b', relPath: '.afk/runs/b/ledger.md', scope: 'ship beta', stale: 90 },
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

test('buildContext auto+single requires re-validation before claiming (no TOCTOU)', () => {
  // The directive must tell the agent to re-read and confirm the run is still
  // active+stale BEFORE refreshing the heartbeat — otherwise a run claimed by
  // another session between session start and the first turn gets a second driver.
  const c = buildContext(one, { mode: 'auto' });
  assert.match(c, /re-read/i);
  assert.match(c, /still `?state: active`?|still.{0,12}active/i);
  assert.match(c, /do NOT drive/i);
  // defers to afk's defined (advisory) collision procedure, and fails safe on doubt.
  assert.match(c, /kickoff collision/i);
  assert.match(c, /when in doubt|prefer surfacing/i);
});

test('buildContext lists multiple runs with scope and drives none, even in auto mode', () => {
  for (const mode of ['notify', 'auto']) {
    const c = buildContext(many, { mode });
    assert.match(c, /\*\*a\*\*/);
    assert.match(c, /\*\*b\*\*/);
    assert.match(c, /ship alpha/); // each run's scope is surfaced so they can be told apart
    assert.match(c, /ship beta/);
    assert.match(c, /Do NOT auto-drive/i);
    assert.doesNotMatch(c, /resume this run autonomously/i);
  }
});

test('buildContext renders unknown staleness for a null heartbeat', () => {
  const c = buildContext([{ runId: 'u', relPath: '.afk/runs/u/ledger.md', scope: '', stale: null }], { mode: 'notify' });
  assert.match(c, /unknown/i);
});

// ── deliberate handoff ────────────────────────────────────────────────────────

const handoff = ({ reason = 'yield', written = iso(1), nextAction = 'Run tests from plan.md' } = {}) => `
## Handoff
written: ${written}
reason: ${reason}
next-action: ${nextAction}
done:
- Implementation; source: plan.md
settled:
- Keep scope; source: plan.md
do-not-redo:
- Planning
open:
- Verification
`;

for (const reason of ['rotation', 'yield', 'compaction', 'auto-pause']) {
  test(`parseHandoff reads ${reason} with UTC written and a concrete next action`, () => {
    assert.deepEqual(resume.parseHandoff(handoff({ reason }), NOW), {
      reason, written: iso(1), nextAction: 'Run tests from plan.md',
    });
  });
}

const invalidHandoffs = [
  ['', 'absent'],
  [handoff({ reason: 'unknown' }), 'unknown reason'],
  [handoff().replace('reason: yield', ''), 'missing reason'],
  [handoff({ written: '' }), 'empty written'],
  [handoff().replace(`written: ${iso(1)}`, ''), 'missing written'],
  [handoff({ written: 'garbage' }), 'invalid timestamp'],
  [handoff({ written: '2026-02-30T12:00:00Z' }), 'impossible date'],
  [handoff({ written: iso(-FUTURE_SKEW_MINUTES - 1) }), 'future beyond skew'],
  [handoff({ nextAction: '   ' }), 'blank action'],
  [handoff().replace('next-action: Run tests from plan.md', ''), 'missing action'],
  [handoff().replace('## Handoff', '## Handoff-not-a-marker'), 'wrong heading'],
  ['## Handoff\nreason: yield\n## Other\nwritten: ' + iso(1) + '\nnext-action: elsewhere', 'fields in next section'],
  ['## Handoff\nreason: invalid\n' + handoff(), 'first invalid section wins'],
];

for (const [body, name] of invalidHandoffs) {
  test(`parseHandoff rejects ${name} without throwing`, () => {
    assert.equal(resume.parseHandoff(body, NOW), null);
  });
}

test('parseHandoff tolerates non-string input without coercion or exceptions', () => {
  for (const body of [null, undefined, 1, {}, { toString() { throw new Error('do not coerce'); } }]) {
    assert.equal(resume.parseHandoff(body, NOW), null);
  }
});

test('parseHandoff accepts CRLF, later sections and first-marker precedence', () => {
  const body = `## Earlier\nnotes\n${handoff()}\n## Later\nreason: rotation\n${handoff({ reason: 'rotation' })}`;
  assert.deepEqual(resume.parseHandoff(body.replaceAll('\n', '\r\n'), NOW), resume.parseHandoff(handoff(), NOW));
});

test('parseHandoff bounds display text with the existing scope limit', () => {
  assert.equal(resume.parseHandoff(handoff({ nextAction: 'x'.repeat(SCOPE_MAX + 20) }), NOW).nextAction,
    `${'x'.repeat(SCOPE_MAX)} ...`);
});

test('parseHandoff reuses heartbeat future-skew validation at the boundary', () => {
  assert.ok(resume.parseHandoff(handoff({ written: iso(-FUTURE_SKEW_MINUTES) }), NOW));
  assert.equal(resume.parseHandoff(handoff({ written: iso(-FUTURE_SKEW_MINUTES - 0.001) }), NOW), null);
});

for (const reason of ['rotation', 'yield']) {
  test(`collectResumable ${reason}: future-skewed yield displays zero age without changing eligibility`, () => {
    withRoot((root) => {
      const heartbeat = iso(-3);
      const runs = writeLedger(root, 'handoff', header({ heartbeat }) + handoff({ reason, written: heartbeat }));
      const found = collectResumable(runs, { root, now: NOW });
      assert.equal(found.length, 1);
      assert.equal(found[0].stale, 0);
      assert.equal(found[0].yielded, true);
      assert.equal(staleMsOf(heartbeat, NOW), -3 * 60_000);
      assert.match(buildContext(found, { mode: 'notify' }), /heartbeat age 0 min/);
      writeLedger(root, 'handoff', header({ heartbeat }) + handoff({ reason, written: iso(-2) }));
      assert.deepEqual(collectResumable(runs, { root, now: NOW }), []);
    });
  });

  test(`collectResumable ${reason}: same-instant takeover consumes a rewritten or cleared marker`, () => {
    withRoot((root) => {
      const heartbeat = iso(0);
      const runs = writeLedger(root, 'handoff', header({ heartbeat }) + handoff({ reason, written: heartbeat }));
      assert.equal(collectResumable(runs, { root, now: NOW }).length, 1);
      for (const block of [handoff({ reason: 'compaction', written: heartbeat }), '']) {
        writeLedger(root, 'handoff', header({ heartbeat }) + block);
        assert.deepEqual(collectResumable(runs, { root, now: NOW }), []);
      }
    });
  });

  for (const [name, heartbeat, written, expected] of [
    ['fresh', iso(5), iso(1), true],
    ['equal', iso(1), iso(1), true],
    ['consumed', iso(1), iso(2), false],
    ['stale', iso(60), iso(30), true],
  ]) {
    test(`collectResumable ${reason}: ${name} heartbeat`, () => {
      withRoot((root) => {
        const runs = writeLedger(root, 'handoff', header({ heartbeat }) + handoff({ reason, written }));
        const found = collectResumable(runs, { root, now: NOW });
        assert.equal(found.length, expected ? 1 : 0);
        if (expected) {
          assert.equal(found[0].yielded, true);
          assert.deepEqual(found[0].handoff, { reason, written, nextAction: 'Run tests from plan.md' });
        }
      });
    });
  }
}

for (const [body, name] of [...invalidHandoffs,
  [handoff({ reason: 'compaction' }), 'continuing compaction'],
  [handoff({ reason: 'auto-pause' }), 'no-progress stop'],
  [handoff({ written: iso(90) }), 'older marker'],
  ['## Handoff\n\0' + '\ufffd'.repeat(1000), 'adversarial body'],
]) {
  test(`collectResumable preserves baseline for ${name}`, () => {
    withRoot((root) => {
      for (const heartbeat of [iso(5), iso(60), undefined, 'invalid']) {
        const runs = writeLedger(root, 'r', header({ heartbeat }));
        const baseline = collectResumable(runs, { root, now: NOW });
        writeLedger(root, 'r', header({ heartbeat }) + body);
        assert.deepEqual(collectResumable(runs, { root, now: NOW }), baseline);
      }
    });
  });
}

test('a valid marker cannot upgrade unknown heartbeat ownership', () => {
  withRoot((root) => {
    for (const heartbeat of [undefined, 'garbage', iso(-FUTURE_SKEW_MINUTES - 1)]) {
      const runs = writeLedger(root, 'unknown', header({ heartbeat }) + handoff());
      const found = collectResumable(runs, { root, now: NOW });
      assert.equal(found.length, 1);
      assert.equal(found[0].stale, null);
      assert.ok(!found[0].yielded);
      const context = buildContext(found, { mode: 'auto' });
      assert.match(context, /notify-only/);
      assert.doesNotMatch(context, /resume this run autonomously/);
    }
  });
});

test('a completed run never surfaces with a valid marker', () => {
  withRoot((root) => {
    for (const heartbeat of [iso(1), iso(60), undefined]) {
      const runs = writeLedger(root, 'done', header({ state: 'complete', heartbeat }) + handoff());
      assert.deepEqual(collectResumable(runs, { root, now: NOW }), []);
    }
  });
});

test('a marker beyond the prefix cannot change baseline selection', () => {
  withRoot((root) => {
    for (const heartbeat of [iso(1), iso(60)]) {
      const body = header({ heartbeat }) + '\n' + 'x'.repeat(LEDGER_READ_BYTES);
      const runs = writeLedger(root, 'r', body);
      const baseline = collectResumable(runs, { root, now: NOW });
      writeLedger(root, 'r', body + handoff());
      assert.deepEqual(collectResumable(runs, { root, now: NOW }), baseline);
    }
  });
});

test('header-looking handoff content cannot override existing header fields', () => {
  withRoot((root) => {
    for (const state of ['active', 'complete']) {
      const body = header({ state, heartbeat: iso(60) }) + handoff();
      const runs = writeLedger(root, 'r', body);
      const baseline = collectResumable(runs, { root, now: NOW });
      writeLedger(root, 'r', body + `\nstate: active\nheartbeat: ${iso(0)}\nrun-id: impostor\nscope: impostor\n`);
      assert.deepEqual(collectResumable(runs, { root, now: NOW }), baseline);
    }
  });
});

for (const mode of ['notify', 'auto']) {
  test(`buildContext annotates deliberate yield in ${mode}`, () => {
    withRoot((root) => {
      const runs = writeLedger(root, 'r', header({ heartbeat: iso(1) }) + handoff());
      const c = buildContext(collectResumable(runs, { root, now: NOW }), { mode });
      assert.ok(c.split('\n').includes(`Yielded deliberately at ${iso(1)}; next action recorded in the ledger (verbatim): Run tests from plan.md`));
      if (mode === 'auto') {
        assert.match(c, /fresh.*valid.*rotation.*yield/);
        assert.match(c, /written.*at or after.*heartbeat/);
        assert.match(c, /refresh its UTC heartbeat and rewrite the marker's reason to `compaction` or clear the block in the same first takeover write/);
        // This existing other-run collision condition must survive byte-for-byte.
        assert.ok(c.includes('or if another live run holds this scope — surface it instead.'));
        assert.match(c, /other runs.*fresh heartbeat.*regardless.*marker/i);
      } else {
        assert.doesNotMatch(c, /autonomously/);
      }
    });
  });
}

test('a stale run and yielded run are both listed and neither is driven', () => {
  withRoot((root) => {
    writeLedger(root, 'stale', header({ runId: 'stale', heartbeat: iso(60) }));
    const runs = writeLedger(root, 'yielded', header({ runId: 'yielded', heartbeat: iso(1) }) + handoff());
    const found = collectResumable(runs, { root, now: NOW });
    assert.equal(found.length, 2);
    const c = buildContext(found, { mode: 'auto' });
    assert.match(c, /\*\*stale\*\*/);
    assert.match(c, /\*\*yielded\*\*/);
    assert.match(c, /Yielded deliberately at/);
    assert.match(c, /Do NOT auto-drive/);
    assert.doesNotMatch(c, /resume this run autonomously/);
  });
});
