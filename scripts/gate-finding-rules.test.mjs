// The triage rules are prose executed by an agent — nothing here can enforce
// them. These are presence pins on the load-bearing sentences of the
// demonstrated-consequence and accounted-reach rules (they fail on silent
// deletion or rewording), plus doesNotMatch guards on the shape-only
// verification standard this change retires. They are not proof a driver
// applies the rules.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { test } from 'node:test';

const read = (p) =>
  readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const afkSkill = read('../skills/afk/SKILL.md');
const gates = {
  codex: read('../skills/afk-codex-review/SKILL.md'),
  claude: read('../skills/afk-claude-review/SKILL.md'),
  kimi: read('../skills/afk-kimi-review/SKILL.md'),
  glm: read('../skills/afk-glm-review/SKILL.md'),
};

// The summary every gate skill carries, byte-identical. The driver holds the
// full rules; a gate skill is loadable standalone, so the summary sits where
// findings are handled and must not drift the way the old stop rules did.
const TRIAGE_SENTENCE = [
  'A structural finding claims both that the code is as described and that it goes',
  'wrong; reading the cited `file:line` settles only the first. Demonstrate the',
  'consequence before fixing, and account for every consumer of what you change',
  'that lives outside the diff — `../afk/SKILL.md` ("External gate") holds both',
  'rules.',
].join('\n');

const countMatches = (text, re) => (text.match(new RegExp(re, 'g')) ?? []).length;

test('the driver states each triage rule exactly once', () => {
  for (const phrase of [
    /A finding asserts two things; reading settles one/,
    /restating the finding is not a\s+demonstration/,
    /Account for the fix's reach before it lands/,
    /consumers outside it are invisible to\s+every reviewer in the loop/,
  ]) {
    assert.equal(
      countMatches(afkSkill, phrase.source),
      1,
      `expected exactly one match for ${phrase} in skills/afk/SKILL.md`,
    );
  }
});

test('an undemonstrated consequence is recorded, not fixed', () => {
  // The incident this rule answers: the shape was confirmed, the asserted
  // consequence never was, and the fix landed anyway.
  assert.match(afkSkill, /evidence against the finding, not\s+licence to fix it anyway/);
  assert.match(afkSkill, /leave the code as it is/);
  // Refuted is closed by a recorded disproof, so failing to demonstrate must
  // not reach it — that exit would close a load-bearing finding without the
  // operator escalation the unverified path carries.
  assert.match(afkSkill, /An affirmative disproof records it Refuted/);
  assert.match(afkSkill, /keeps\s+a load-bearing finding on the escalation path/);
});

test('an unaccountable consumer narrows or defers the fix, and never blocks', () => {
  assert.match(afkSkill, /not licence to\s+proceed/);
  assert.match(afkSkill, /narrow the fix to the caller inside the diff/);
  assert.match(afkSkill, /record the finding\s+Accepted with a follow-up issue/);
});

test('all four gate skills carry the identical triage sentence', () => {
  for (const [name, text] of Object.entries(gates)) {
    assert.equal(
      countMatches(text, TRIAGE_SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      1,
      `expected exactly one copy of the triage sentence in ${name} gate skill`,
    );
  }
});

test('the retired shape-only verification standard does not return', () => {
  // "Verify against the cited file:line" settles that the code is as
  // described and nothing about the defect; it is what let the incident
  // through. Note "reading the cited" in the pinned sentence is deliberately
  // not matched by these guards.
  for (const [name, text] of Object.entries(gates)) {
    assert.doesNotMatch(text, /against the cited/, `shape-only standard back in ${name}`);
    assert.doesNotMatch(text, /read the cited/, `shape-only standard back in ${name}`);
    // The summary sits under a list that sorts minor items out and defers
    // them; an unscoped opener would demand a demonstrated consequence for a
    // cosmetic item, which no such item can supply.
    assert.doesNotMatch(text, /^A finding claims both/m, `unscoped opener back in ${name}`);
  }
});
