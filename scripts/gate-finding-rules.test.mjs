import { readInstruction, assertRoute, section } from './instruction-test-helpers.mjs';
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

const afkSkill = read('../skills/afk/references/review-convergence.md');
const internalReview = read('../skills/afk-internal-review/SKILL.md');
const pilot = read('../skills/afk-implementation-pilot/SKILL.md');
const gates = {
  codex: read('../skills/afk-codex-review/SKILL.md'),
  claude: read('../skills/afk-claude-review/SKILL.md'),
  kimi: read('../skills/afk-kimi-review/SKILL.md'),
  glm: read('../skills/afk-glm-review/SKILL.md'),
  deepseek: read('../skills/afk-deepseek-review/SKILL.md'),
  mimo: read('../skills/afk-mimo-review/SKILL.md'),
};

const countMatches = (text, re) => (text.match(new RegExp(re, 'g')) ?? []).length;

test('the driver states each triage rule exactly once', () => {
  for (const phrase of [
    /A finding asserts two things; reading settles one/,
    /Restating the finding is not a\s+demonstration/,
    /Account for the fix's reach before it lands/,
    /consumers outside it are invisible to\s+every\s+reviewer in the loop/,
  ]) {
    assert.equal(
      countMatches(afkSkill, phrase.source),
      1,
      `expected exactly one match for ${phrase} in skills/afk/references/review-convergence.md`,
    );
  }
});

test('an undemonstrated consequence is recorded, not fixed', () => {
  // The incident this rule answers: the shape was confirmed, the asserted
  // consequence never was, and the fix landed anyway.
  assert.match(afkSkill, /evidence against the\s+finding, not licence to fix it anyway/);
  assert.match(afkSkill, /leave the code as it is/);
  assert.match(afkSkill, /An affirmative disproof records it\s+Refuted/);
  assert.match(afkSkill, /untriaged claim never\s+authorizes a code change/);
});

test('an unaccountable consumer narrows or defers the fix without expanding scope', () => {
  assert.match(afkSkill, /not licence to\s+proceed/);
  assert.match(afkSkill, /narrow the fix to the caller inside the diff/);
  assert.match(afkSkill, /record the finding\s+Deferred/i);
  assert.match(afkSkill, /does not create a\s+follow-up issue automatically/i);
});

test('P1 admission is scope-anchored and evidence-complete', () => {
  for (const phrase of [
    /frozen issue\s+contract or an invariant/,
    /reachable (condition|trigger)/,
    /wrong (outcome|consequence)/,
    /cannot safely (enter|advance)/,
    /minimal causal fix/,
  ]) assert.match(afkSkill, phrase);
  assert.match(afkSkill, /unlabelled finding (starts|is) `UNTRIAGED`/i);
  assert.match(afkSkill, /never\s+authorizes a code change/i);
});

test('stable finding identity prevents evidence-free reopening and oscillation', () => {
  assert.match(afkSkill, /stable ID/);
  assert.match(afkSkill, /Rewording the same consequence is the same finding/i);
  assert.match(afkSkill, /new evidence or a different\s+observable\s+consequence/i);
  assert.match(afkSkill, /Suppressed/);
  assert.match(afkSkill, /Contested/);
  assert.match(afkSkill, /executable check|reproducible verification artifact/i);
  assert.match(afkSkill, /different (role|provider)/i);
  assert.match(afkSkill, /bars? (the role stamp and )?auto-merge/i);
  assert.match(afkSkill, /previous verification no longer applies/i);
  assert.match(afkSkill, /new evidence/i);
  assert.match(afkSkill, /A→B→A/);
});

test('structural P2 risk remains operator-owned at auto-merge', () => {
  assert.match(afkSkill, /structural P2/i);
  assert.match(afkSkill, /does not block the role stamp/i);
  assert.match(afkSkill, /bars auto-merge/i);
  assert.match(afkSkill, /operator[^.]*merge boundary/i);
  assert.match(afkSkill, /minor[^.]*out-of-scope[^.]*do not bar auto-merge/i);
  assert.match(internalReview, /operator merge decision pending/i);
  assert.match(internalReview, /operator owns that risk at the merge boundary/i);
});

test('all gate skills explicitly read common admission before triage', () => {
  for (const text of Object.values(gates)) assertRoute(text, '../afk/references/review-convergence.md');
});

test('confirmed structural P2 repairs remain in scope', () => {
  assert.match(afkSkill, /confirmed in-scope structural findings, including P2/i);
  assert.match(afkSkill, /one final pass after structural/i);
  assert.match(afkSkill, /Unverified or out-of-scope suggestions authorize no edits/i);
});

test('gate routes retain the common minimal batch boundary', () => {
  for (const text of Object.values(gates)) {
    assertRoute(text, '../afk/references/review-convergence.md');
    assert.doesNotMatch(text, /resolve minor items|Deferred pass once/i);
  }
});

test('implementation and internal review explicitly read the minimal-fix source', () => {
  for (const text of [pilot, internalReview]) assertRoute(text, '../afk/references/review-convergence.md');
});

test('evidence-free repeats stay closed across reviewer identities', () => {
  assert.match(afkSkill, /recorded `Suppressed` without reopening it/i);
  assert.match(afkSkill, /different role\/provider.*alone/s);
  assert.match(afkSkill, /no edit, reopening, or extra paid review/i);
});

test('structural P2 remains operator-owned', () => {
  assert.match(afkSkill, /structural P2 remains operator-owned/i);
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
