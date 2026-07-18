// The design-stage external gate is doctrine the driver follows — prose, not an
// enforceable mechanism (AGENTS.md level 3). These are presence pins on the
// load-bearing sentences: they fail on silent deletion or a reword that drops a
// rule, not proof the step runs. Paired with the mechanical gate tests (which do
// pin the argv/prompt shape), they keep the SKILL.md contract and the code from
// drifting apart.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { test } from 'node:test';

const read = (p) =>
  readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const afkSkill = read('../skills/afk/SKILL.md');
const config = read('../templates/afk-config.example.md');
const gates = {
  codex: read('../skills/afk-codex-review/SKILL.md'),
  claude: read('../skills/afk-claude-review/SKILL.md'),
  kimi: read('../skills/afk-kimi-review/SKILL.md'),
  glm: read('../skills/afk-glm-review/SKILL.md'),
};

test('afk SKILL.md defines the design-stage gate step and its placement', () => {
  assert.match(afkSkill, /design-stage/i, 'the step must be named');
  // Placement: after the adversarial debate, before tests-first.
  assert.match(afkSkill, /--design/, 'the selector the step uses must appear');
});

test('afk SKILL.md pins the one-round-per-version and cap-2 rule', () => {
  // Whitespace-tolerant: these phrases legitimately wrap across a line.
  assert.match(afkSkill, /one\s+(external\s+)?gate\s+per\s+design\s+version|one\s+round\s+per\s+design\s+version/i);
  assert.match(afkSkill, /2\s+per\s+issue|two\s+per\s+issue|cap(?:ped)?\s+(?:at|of)\s+2/i);
});

test('afk SKILL.md pins P1-escalate-at-cap for the design gate', () => {
  // At the cap a still-open design P1 escalates; only a P2 may be accept-recorded.
  assert.match(afkSkill, /P1/);
  assert.match(afkSkill, /escalate/i);
});

test('afk SKILL.md pins the baseline-before-gate rule', () => {
  // The debate's findings are pre-registered before the gate runs, so a gate
  // finding cannot be retro-labelled "the debate already had it".
  assert.match(afkSkill, /baseline|pre-register/i);
  assert.match(afkSkill, /before the (design )?gate (runs|is invoked)/i);
});

test('afk SKILL.md pins the distinct design-gate ledger section', () => {
  assert.match(afkSkill, /design-gate.*section|distinct.*section|separate.*section/i);
});

test('afk SKILL.md cross-references the merge bar as reading the PR-gate record only', () => {
  // A driver at the merge boundary reads the bar's own sentence, not the
  // design-gate section — so the carve-out must appear where the bar is defined.
  assert.match(afkSkill, /design-stage findings? (do not|does not|never)|not the design-stage|PR-gate (record|section)/i);
});

test('afk SKILL.md carves the design gate out of the SKIPPED-blocks-ready rule', () => {
  // A skipped design gate is recorded and the waterfall proceeds — unlike the PR
  // gate, whose SKIPPED round is not clean.
  assert.match(afkSkill, /skipped design gate|design gate.*skip|skip.*design gate/i);
});

test('afk SKILL.md keeps the design gate off the never-scale-down-gates rule', () => {
  // `risky` scales the design gate by blast radius; that is not the PR-gate
  // exemption.
  assert.match(afkSkill, /design-heavy|blast[- ]radius|scal/i);
});

test('the design-gate config knob is documented with its three values', () => {
  assert.match(config, /design-gate:/);
  for (const v of ['off', 'risky', 'on']) {
    assert.match(config, new RegExp(`\\b${v}\\b`), `config must document ${v}`);
  }
});

test('every gate SKILL.md documents design mode and the --design selector', () => {
  for (const [name, text] of Object.entries(gates)) {
    assert.match(text, /--design/, `${name} SKILL.md must document --design`);
  }
});
