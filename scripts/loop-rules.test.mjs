// The loop rules are prose executed by an agent — nothing here can enforce
// them. These are mostly presence pins on the load-bearing sentences of the
// gate-loop and pilot-loop terminations (they fail on silent deletion or
// rewording), plus doesNotMatch guards on the drifted stop-rule wordings this
// change retires. They are not proof the loops work.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { test } from 'node:test';

const read = (p) =>
  readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const afkSkill = read('../skills/afk/SKILL.md');
const pilot = read('../skills/afk-implementation-pilot/SKILL.md');
const gates = {
  codex: read('../skills/afk-codex-review/SKILL.md'),
  claude: read('../skills/afk-claude-review/SKILL.md'),
  kimi: read('../skills/afk-kimi-review/SKILL.md'),
  glm: read('../skills/afk-glm-review/SKILL.md'),
};

// The exact stop sentence every gate skill carries, byte-identical. The driver
// holds the full rule; this summary must not drift the way the old per-gate
// stop rules did.
const STOP_SENTENCE = [
  'Stop when the loop-termination rule in `../afk/SKILL.md` ("External gate")',
  'holds: a round with no new structural finding and every prior structural',
  'finding closed by a recorded disposition — a driver-verified fix, a',
  'refutation, or an accepted risk.',
].join('\n');

const countMatches = (text, re) => (text.match(new RegExp(re, 'g')) ?? []).length;

test('the driver defines finding closure once, as recorded dispositions', () => {
  // The gate loop closed a prior finding by the next round's silence; the
  // driver now owns the one definition: every structural finding is named at
  // triage and closed by exactly one recorded disposition.
  for (const phrase of [
    /named at triage/,
    /at most one \*\*current\*\* recorded\s+disposition/,
    /Silence closes nothing/,
    /run-scoped/,
    /the record is the closure, not the\s+future test/,
    /never auto-merged, whatever the merge\s+policy/,
  ]) {
    assert.equal(
      countMatches(afkSkill, phrase.source),
      1,
      `expected exactly one match for ${phrase} in skills/afk/SKILL.md`,
    );
  }
});

test('an unverifiable load-bearing finding escalates instead of looping', () => {
  assert.match(afkSkill, /neither confirm nor refute/);
  assert.match(afkSkill, /the loop does not end around it/);
});

test('all four gate skills carry the identical stop sentence', () => {
  for (const [name, text] of Object.entries(gates)) {
    assert.equal(
      countMatches(text, STOP_SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      1,
      `expected exactly one copy of the stop sentence in ${name} gate skill`,
    );
  }
});

test('the drifted stop-rule wordings do not return', () => {
  // Two gate skills carried differently-worded stop rules; both wordings were
  // retired for the single driver-owned definition.
  for (const text of [afkSkill, ...Object.values(gates)]) {
    assert.doesNotMatch(text, /no new blocker findings/);
  }
  assert.doesNotMatch(gates.codex, /whose remainder TDD will enforce/);
  assert.doesNotMatch(gates.kimi, /findings narrow to your own\s+last fix/);
});

test('every gate round ends in an affirmative report, in all four gates', () => {
  // An empty round must be an attested statement, not unattested absence; two
  // of the four gates previously ended a round with no report at all.
  for (const [name, text] of Object.entries(gates)) {
    assert.match(text, /`CLEAN`/, `CLEAN missing in ${name} gate skill`);
    assert.match(text, /`OUTSTANDING`/, `OUTSTANDING missing in ${name} gate skill`);
  }
});

test('the pilot defines the clean round its stop condition counts', () => {
  // "Two consecutive rounds produce no new findings" counted rounds where
  // lenses were skipped or a prior fix was never re-verified.
  assert.match(pilot, /A round is \*\*clean\*\* only if/);
  assert.match(pilot, /skipped or silent lens voids the\s+round/);
  assert.match(pilot, /verifies\s+nothing/);
  assert.match(pilot, /bound the \*\*effort\*\*, not correctness/);
  assert.doesNotMatch(pilot, /produce no new findings/);
});

test('the pilot handoff records the lens results, not just round numbers', () => {
  assert.match(pilot, /lens-by-lens results/);
});
