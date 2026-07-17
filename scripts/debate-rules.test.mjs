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
  assert.match(afkSkill, /never implement a\s*\n?\s*revision the cap left unreviewed/);
});

test('the cap asks the clean-round question rather than a parallel one', () => {
  // The root of four gate rounds: the exit criteria restated the clean round's
  // condition as "unresolved findings" instead of referencing it, and the two
  // drifted every time the loop moved — undefined labels, then a P2 revision
  // exiting clean, then a P2 revision at the cap with no defined outcome. One
  // definition, referenced everywhere, has no seam to drift along.
  assert.match(afkSkill, /has the design in front of you had a clean\s*\n?\s*round/);
  assert.match(afkSkill, /revised after its last clean round/);
  assert.match(afkSkill, /the cap changes nothing/);
});

test('the exit criteria are stated as doctrine, not as a mechanism', () => {
  // An earlier draft said an unresolved P1 "blocks implementation". Nothing in a
  // markdown file blocks anything — the driver being governed is the same agent
  // that would skip the step. Overclaiming here is the defect this repo keeps
  // finding in its own designs, so the refuted wording gets a guard.
  assert.doesNotMatch(afkSkill, /blocks\s*\n?\s*implementation/);
  assert.match(afkSkill, /doctrine, not a guarantee/);
});

test('the severities the exit criteria turn on are actually defined', () => {
  // The exit criteria were written against P1/P2 while the critic was only ever
  // asked for supported/refuted/unverified — so the rule keyed on a label no
  // step produced, and each host was free to grade a defect its own way.
  assert.match(afkSkill, /Every finding carries a severity/);
  assert.match(afkSkill, /\*\*P1\*\* — the design is wrong/);
  assert.match(afkSkill, /\*\*P2\*\* — a real weakness the design survives/);
  assert.match(afkSkill, /unlabelled finding is a P1 until someone labels it/);
});

test('a supported P1 cannot end the debate before the cap is ever reached', () => {
  // The exit criteria only governed the cap, so a round-one supported P1 let a
  // compliant driver call the debate done and implement — the halt rule never
  // fired. The normal exit has to be the clean round, not the cap.
  assert.match(afkSkill, /A clean round ends the debate/);
  assert.match(afkSkill, /Implementation starts here\s*\n?\s*and nowhere earlier/);
  assert.match(afkSkill, /only by a round that no longer finds it/);
});

test('any revision gets another round, whatever severity prompted it', () => {
  // The loop said a revision is a new design carrying unchecked claims, then let
  // a round go clean on a supported P2 that had just been revised for — exiting
  // on exactly the unreviewed edit the next line warns about. A P2 is either
  // accepted without touching the design, or it is a revision like any other.
  assert.match(afkSkill, /no revision made this round/);
  assert.match(afkSkill, /accept it knowingly and record it in the ledger/);
  assert.match(afkSkill, /A revision is a new design/);
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

test('the planner and the debate accept the same evidence', () => {
  // The list is written out in both files, so it can drift — and it did: the
  // debate accepted a recorded fixture while the planner still demanded a run,
  // source, or docs, which marks a fixture-backed claim unverified and strands
  // the waterfall on a P1 that has evidence.
  for (const evidence of [/run it/, /source/, /docs/, /fixture/]) {
    assert.match(planner, evidence);
  }
  assert.match(afkSkill, /Source, official documentation, or a recorded fixture/);
});

test('the round-cap concept stays out of the planner, which has no such step', () => {
  // afk owns the debate; the planner produces the plan and stops.
  assert.doesNotMatch(planner, /debate|round cap|external gate/i);
});
