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
  deepseek: read('../skills/afk-deepseek-review/SKILL.md'),
  mimo: read('../skills/afk-mimo-review/SKILL.md'),
};

test('afk SKILL.md defines the design-stage gate step and its placement', () => {
  assert.match(afkSkill, /design-stage/i, 'the step must be named');
  // Placement: after the adversarial debate, before tests-first.
  assert.match(afkSkill, /--design/, 'the selector the step uses must appear');
});

test('design-stage review shares the issue allowance without a permission loop', () => {
  assert.match(afkSkill, /later evaluations share the issue's review-cycle allowance/i);
  assert.doesNotMatch(afkSkill, /hard cap 2 per\s+issue|cap(?:ped)?\s+(?:at|of)\s+2/i);
});

test('a clean debate and clean design gate advance without a false no-progress stop', () => {
  assert.match(afkSkill, /clean terminal round (advances the waterfall and )?never counts\s+as stalled/i);
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

test('design-stage finding vocabulary includes contested', () => {
  assert.match(afkSkill, /fixed \/ refuted \/ deferred \/ suppressed \/ contested/i);
});

// The `--implementer` rule is one doctrine with two modes (PR: code
// implementer; design: the design's author). The block is byte-identical in
// every gate skill so drift in any copy fails here, not in a review.
const IMPLEMENTER_RULE_RE = /Pass `--implementer <family>` when another model wrote the change\.[\s\S]*?the per-run flag outranks the\nconfig line\./;

test('every gate SKILL.md carries the identical implementer rule block', () => {
  const blocks = Object.entries(gates).map(([name, text]) => {
    const match = text.match(IMPLEMENTER_RULE_RE);
    assert.ok(match, `${name} SKILL.md must carry the implementer rule block`);
    return [name, match[0]];
  });
  const [refName, ref] = blocks[0];
  for (const [name, block] of blocks.slice(1)) {
    assert.equal(block, ref, `${name} implementer rule must be byte-identical to ${refName}'s`);
  }
});

test('the claude sample command does not hardcode the permitting flag', () => {
  // `--implementer` is the one flag that can PERMIT a run; a copy-paste sample
  // carrying it converts the intended self-skip into self-review.
  assert.doesNotMatch(gates.claude, /claude-gate\.mjs" --implementer/);
});

test('the kimi skill carries the requested-not-enforced read-only caveat', () => {
  assert.match(gates.kimi, /not enforced by construction/);
});
