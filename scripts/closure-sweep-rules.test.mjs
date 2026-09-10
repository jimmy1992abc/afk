// The closure sweep is prose executed by an agent — nothing here can make it
// run. These are presence pins on the sentences the sweep turns on, so silent
// deletion or rewording fails, plus doesNotMatch guards on the wordings two
// review rounds refuted, each for a concrete reason recorded in
// docs/designs/specs/2026-08-18-requirement-closure-sweep.md. The strings
// debate-rules.test.mjs already forbids in this file are not re-asserted here.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { test } from 'node:test';

const planner = readFileSync(
  new URL('../skills/afk-spec-planner/SKILL.md', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

const countMatches = (text, re) => (text.match(new RegExp(re, 'g')) ?? []).length;

test('the sweep exists as its own step, ahead of the clarify budget', () => {
  // It runs after the code read because separating "the repository settles
  // this" from "nobody decided this" is a claim about the repository, and
  // before Clarify because it is what earns a question a place in that budget.
  assert.match(planner, /### 3 — Close the requirement set/);
  assert.match(planner, /### 4 — Clarify \(last resort\)/);
  assert.match(planner, /### 5 — Produce the plan/);
  assert.ok(
    planner.indexOf('### 2 — Read the code')
      < planner.indexOf('### 3 — Close the requirement set'),
    'the sweep must follow the code read',
  );
});

test('the sweep is keyed to what the issue must decide, not what the code must do', () => {
  // The altitude line is the whole defence against this step collapsing into a
  // requirement-altitude restatement of afk-internal-review's diff dimensions.
  assert.match(
    planner,
    /ask what the issue must decide, not\s+what the implementation must do/,
  );
});

test('the four axes are present, each exactly once', () => {
  for (const axis of [
    /- \*\*Authority\*\* —/,
    /- \*\*Lifecycle\*\* —/,
    /- \*\*Outcome set\*\* —/,
    /- \*\*Consumers\*\* —/,
  ]) {
    assert.equal(
      countMatches(planner, axis.source),
      1,
      `expected exactly one ${axis} entry`,
    );
  }
});

test('the two stateful axes name their own precondition', () => {
  // Ungated, both are dead text for a pure transform, a docs change, or a
  // config edit — the issues this planner also receives. The precondition is
  // what lets the axis null out instead of being answered vacuously.
  assert.match(planner, /wherever a use leaves state behind or repeats against it/);
  assert.match(planner, /each consumer the issue never names/);
});

test('the sweep is selective and each gap lands once', () => {
  // Padding the list buries the entries that matter, and an item written into
  // two sections of one plan is the double-write the first draft created.
  assert.match(planner, /Record only an axis that both applies and the issue\s+leaves open/);
  assert.match(planner, /Only a gap the repository settles becomes an acceptance\s+criterion/);
  assert.match(planner, /Each lands once\./);
});

test('an unsettled gap reaches Clarify rather than a settled criterion', () => {
  // Clarify already routes what it cannot resolve into Assumptions, so the
  // sweep adds no second routing rule.
  assert.match(planner, /the rest go to\s+Clarify/);
  assert.match(planner, /Record every assumption you make in lieu of asking/);
});

test('magnitude is sharpened into step 1, never added as a fifth axis', () => {
  // The one upheld duplication charge: step 1 already asks the same reader for
  // the same constraints over the same subject, so a parallel sweep would
  // layer a superseding instruction on a live one.
  assert.match(planner, /hard constraints \(performance, compatibility, security\) with the bar/);
  assert.match(planner, /a constraint with no bar is one/);
  assert.doesNotMatch(planner, /- \*\*Magnitude\*\*/);
});

test('the spec review bullet does not re-enumerate what the sweep routes', () => {
  // An earlier draft had Spec review list every unbound axis while the routing
  // rule sent each to exactly one other section — writing each of them twice.
  assert.match(
    planner,
    /- \*\*Spec review\*\* — restate the ask in your own words; name the core need and any\n {2}ambiguity\./,
  );
  assert.doesNotMatch(planner, /axis left unbound/);
});

test('the sweep claims no authority it does not have', () => {
  // Level 1: prose and evaluation only. A planning step that called itself
  // enforcing would be the overclaim this repo keeps finding in its own work.
  const start = planner.indexOf('### 3 — Close the requirement set');
  const end = planner.indexOf('### 4 — Clarify (last resort)');
  // Fail closed: a renamed heading slices to '' and every guard below would
  // pass on the empty string instead of on the step it is meant to bound.
  assert.ok(start !== -1 && end > start, 'the sweep must be bounded by both headings');
  const sweep = planner.slice(start, end);
  assert.doesNotMatch(sweep, /enforced|blocked|guaranteed/i);
  assert.doesNotMatch(sweep, /\bP1\b|\bP2\b|severity|finding/i);
});
