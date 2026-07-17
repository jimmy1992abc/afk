// The debate rules are prose executed by an agent — nothing here can enforce
// them, and a test asserting a sentence exists would be pinning the wrong
// object. What IS worth pinning: the rules that were wrong in an earlier draft
// must not creep back, because each was refuted for a concrete reason.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { test } from 'node:test';

const afkSkill = readFileSync(new URL('../skills/afk/SKILL.md', import.meta.url), 'utf8');
const planner = readFileSync(new URL('../skills/afk-spec-planner/SKILL.md', import.meta.url), 'utf8');

test('the debate has exit criteria, so the cap cannot pass a P1 by running out', () => {
  // The gap this closes: a round cap bounds spend, not correctness. Without
  // this, round 3 ending on an unresolved P1 let the pipeline proceed with
  // known uncertainty and no record.
  assert.match(afkSkill, /Exit criteria/);
  assert.match(afkSkill, /\*\*do\s*\n?\s*not start implementing\*\*/);
  assert.match(afkSkill, /Never proceed past a P1 because the rounds ran out/);
  assert.match(afkSkill, /a risk you accept explicitly and record\s*\n?\s*in the ledger/);
});

test('the exit criteria are stated as doctrine, not as a mechanism', () => {
  // An earlier draft said an unresolved P1 "blocks implementation". Nothing in a
  // markdown file blocks anything — the driver being governed is the same agent
  // that would skip the step. Overclaiming here is the defect this repo keeps
  // finding in its own designs, so the refuted wording gets a guard.
  assert.doesNotMatch(afkSkill, /blocks\s*\n?\s*implementation/);
  assert.match(afkSkill, /doctrine, not a guarantee/);
});

test('the critic gets a posture, never a predetermined verdict', () => {
  // A critic told the answer is "refuted" invents objections and can never
  // return a clean pass on a sound design.
  assert.match(afkSkill, /Posture, not verdict/);
  assert.match(afkSkill, /`supported`, `refuted`, or `unverified`/);
  assert.match(afkSkill, /"No\s*\n?finding" is a valid, reportable result/);
  assert.doesNotMatch(afkSkill, /default(s)? to (a verdict of )?refuted/i);
});

test('verification is bounded by safety, not mandated unconditionally', () => {
  // "Execute every claim" is unsafe: production, destructive actions, and
  // credentials are all reachable from a naive reading.
  assert.match(afkSkill, /cheapest SAFE means/);
  assert.match(afkSkill, /never mutate production/);
  assert.match(afkSkill, /destructive action outside a disposable workspace/);
  assert.match(afkSkill, /credentials or\s*\n?secrets/);
  assert.match(afkSkill, /assumption and its risk/);
  assert.match(afkSkill, /never promoted to fact/);
});

test('the debate is named as a claims check, not a completeness proof', () => {
  // Same-model critics test what they notice; they share the author's blind spot
  // about what was never considered. Overclaiming here is what made "replace the
  // external design gate with a better debate" look reasonable when it was not.
  assert.match(afkSkill, /only test claims it \*notices\*/);
  assert.match(afkSkill, /not proof of the design's\s*\n?\*\*completeness\*\*/);
});

test('a refuted-claims record must link to what prevents it', () => {
  assert.match(afkSkill, /is a diary; either give it a consumer or leave it out/);
});

test('the planner treats an unverified external claim as an assumption', () => {
  // The debate can only check facts-vs-assumptions if the artifact distinguishes
  // them in the first place.
  assert.match(planner, /every\s*\n?\s*claim about an external system you did not verify/);
  assert.match(planner, /never a statement of fact/);
});

test('the round-cap concept stays out of the planner, which has no such step', () => {
  // afk owns the debate; the planner produces the plan and stops.
  assert.doesNotMatch(planner, /debate|round cap|external gate/i);
});
