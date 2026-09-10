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
  deepseek: read('../skills/afk-deepseek-review/SKILL.md'),
  mimo: read('../skills/afk-mimo-review/SKILL.md'),
};

// The exact stop sentence every gate skill carries, byte-identical. The driver
// holds the full rule; this summary must not drift the way the old per-gate
// stop rules did.
const STOP_SENTENCE = [
  'Stop when the loop-termination rule in `../afk/SKILL.md` ("External gate")',
  'holds: triage leaves no `UNTRIAGED`, `Contested`, or open admitted P1, and every',
  'lower-severity item has a recorded disposition that does not block the role stamp (a',
  'structural P2 may still bar auto-merge). That same verdict',
  'earns the role stamp only if it requires no content change; a content fix',
  'invalidates it and the role re-reviews the fixed revision.',
].join('\n');

const countMatches = (text, re) => (text.match(new RegExp(re, 'g')) ?? []).length;

test('the driver defines finding closure once, as recorded dispositions', () => {
  // The gate loop closed a prior finding by the next round's silence; the
  // driver now owns the one definition: every structural finding is named at
  // triage and closed by exactly one recorded disposition.
  for (const phrase of [
    /named at\s+triage/,
    /at most one \*\*current\*\* recorded\s+disposition/,
    /Silence closes nothing/,
    /run-scoped/,
    /the record is the closure, not the\s+future test/,
    /A structural P2 bars auto-merge until the\s+operator owns it at the merge boundary/,
  ]) {
    assert.equal(
      countMatches(afkSkill, phrase.source),
      1,
      `expected exactly one match for ${phrase} in skills/afk/SKILL.md`,
    );
  }
});

test('uncertainty receives investigation without speculative implementation', () => {
  assert.match(afkSkill, /neither confirm nor refute/);
  assert.match(afkSkill, /Do not add abstractions, switches, compatibility branches, or fallbacks/i);
  assert.match(afkSkill, /load-bearing.*OUTSTANDING/s);
});

test('all gate skills carry the identical stop sentence', () => {
  for (const [name, text] of Object.entries(gates)) {
    assert.equal(
      countMatches(text, STOP_SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      1,
      `expected exactly one copy of the stop sentence in ${name} gate skill`,
    );
  }
});

test('a finding-bearing verdict cannot stamp a revision changed after it', () => {
  assert.match(afkSkill, /only if that verdict requires no\s+content\s+change/i);
  assert.match(afkSkill, /content fix invalidates that verdict/i);
  assert.match(afkSkill, /role (?:must )?re-review\s+the fixed\s+revision/i);
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

test('every gate round ends in an affirmative report', () => {
  // An empty round must be an attested statement, not unattested absence; two
  // of the four gates previously ended a round with no report at all.
  for (const [name, text] of Object.entries(gates)) {
    assert.match(text, /`CLEAN`/, `CLEAN missing in ${name} gate skill`);
    assert.match(text, /`OUTSTANDING`/, `OUTSTANDING missing in ${name} gate skill`);
  }
});

test('the pilot uses one initial full review and focused closure thereafter', () => {
  assert.match(pilot, /initial review applies every lens/i);
  assert.match(pilot, /accepted findings, the intervening diff, and affected regression paths/i);
  assert.doesNotMatch(pilot, /two consecutive clean/i);
});

test('the pilot handoff records the lens results, not just round numbers', () => {
  assert.match(pilot, /lens-by-lens results/);
});

test('ordered external roles retain progress checks within the cycle allowance', () => {
  assert.match(afkSkill, /two consecutive unfinished rounds without material progress/i);
  assert.match(afkSkill, /automatic root-cause checkpoint/i);
  assert.match(afkSkill, /clean terminal round never counts as stalled/i);
  assert.match(afkSkill, /contract-mapped (RED test|implementation slice)/i);
  assert.match(afkSkill, /design version lands with its\s+frozen\s+contract/i);
  assert.match(afkSkill, /one transient retry/);
  assert.match(afkSkill, /crosses debate rounds, paid role verdicts, role\s+substitutions, and sequence restarts/i);
  assert.match(afkSkill, /unfinished only while/i);
  assert.match(afkSkill, /resets only on net material progress/i);
  assert.doesNotMatch(afkSkill, /four finding-bearing verdicts|refuses to start a fourth\s+sequence/i);
});

test('design progress is part of the canonical and debate material-progress definitions', () => {
  const debate = afkSkill.slice(
    afkSkill.indexOf('**Exit criteria — verified closure within the allowance.**'),
    afkSkill.indexOf('This is level 3 — doctrine'),
  );
  const external = afkSkill.slice(
    afkSkill.indexOf('Convergence requires net material progress'),
    afkSkill.indexOf('The no-progress streak crosses debate rounds'),
  );
  const autoPause = afkSkill.slice(
    afkSkill.indexOf('- **Auto-pause:**'),
    afkSkill.indexOf('## End-of-run report'),
  );

  assert.match(debate, /design version lands with its\s+frozen\s+contract/i);
  assert.match(external, /design version lands with its\s+frozen\s+contract/i);
  assert.match(autoPause, /use the External gate's one material-progress definition above/i);
  assert.doesNotMatch(autoPause, /admitted P1 closes/);
});

test('continuity counts barren ticks only while the current stage is unfinished', () => {
  assert.match(afkSkill, /Count a\s+barren tick only while the current stage is unfinished/i);
  assert.doesNotMatch(afkSkill, /intentional external waits are not stalled construction/i);
});
