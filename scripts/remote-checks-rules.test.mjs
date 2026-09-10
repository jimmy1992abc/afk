// The check rule is prose an agent chooses to follow — nothing here makes it
// run. These pin the sentences three refutation rounds turned on, plus
// doesNotMatch guards on the wordings each round refuted, so a reworded
// regression fails rather than shipping. See
// docs/designs/specs/2026-08-18-remote-checks.md for what each guard cost.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { test } from 'node:test';

const read = (p) =>
  readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const afk = read('../skills/afk/SKILL.md');
const pilot = read('../skills/afk-implementation-pilot/SKILL.md');
const internal = read('../skills/afk-internal-review/SKILL.md');
const template = read('../templates/afk-config.example.md');

test('the checks are always read; only an empty reading is configurable', () => {
  // Making the read itself configurable would let a stale config hide a check
  // that a repository added after the key was written.
  assert.match(afk, /ask the forge which checks it required of the\s+final revision/);
  assert.match(afk, /`remote-ci`\s+governs only an empty or unanswered reading/);
  assert.match(afk, /adds no requirement of its own/);
});

test('classification never reads an exit code', () => {
  // gh pr checks exits non-zero for failing AND for pending, so classifying a
  // lookup failure by exit status misroutes the two most common answers.
  assert.match(afk, /Classify\s+by what the answer names, never by how the lookup exited/);
  assert.doesNotMatch(afk, /non-zero exit/);
});

test('no forge outcome vocabulary is restated in the prose', () => {
  // A third forge, or a sixth bucket on an existing one, must edit nothing
  // here. Naming a forge's own status words is what made rounds 1 and 2 wrong.
  // Scoped to a check: the driver has its own "queued work" for the run queue.
  for (const vocabulary of [
    /\bbucket\b/i,
    /notApplicable/,
    /check[^.]{0,20}\bqueued\b/i,
    /\bin_progress\b/i,
  ]) {
    assert.doesNotMatch(afk, vocabulary, `${vocabulary} is a forge's word`);
  }
});

test('an empty reading cannot satisfy the passing clause', () => {
  // "every required check passed" is vacuously true over an empty set, so the
  // reading nobody could take would have passed the bar by absence.
  assert.match(afk, /the answer names at least one required check and every one of them passed/);
  assert.doesNotMatch(afk, /every required check passed → \*\*resolved\*\*/);
  // A terminal non-passing outcome — cancelled, timed out — is neither failing
  // nor unfinished, and once fell through into the passing clause.
  assert.match(afk, /whether it ended without passing or has not\n  ended/);
  assert.doesNotMatch(afk, /none is failing or\s+unfinished/);
});

test('every unresolved reading has the same named exit', () => {
  // The `expected` branch once said only that it never settles, leaving the
  // one state with no next step at all.
  assert.match(afk, /`absent` settles it at once,\s+`detect` once the window closes, `expected` \(default\) never/);
  assert.match(afk, /blank or absent\s+is `expected`/);
  assert.match(afk, /a non-empty value outside those\s+three is a config error/);
  // Blank once read as `expected`, so a bootstrapped repo could never be ready.
  assert.doesNotMatch(afk, /blank included, is a config error/);
  assert.match(afk, /Unsettled, it takes the\s+same exit as a failing check/);
  assert.equal((afk.match(/OUTSTANDING`, take up other queued work/g) ?? []).length, 1);
});

test('the wait is bounded from a start stamped against the commit', () => {
  // A window with no durable start cannot tell a resumed tick that it is spent,
  // and one not keyed to the commit lets a new revision inherit a spent window.
  assert.match(afk, /attempt against that revision's commit/);
  assert.match(afk, /30 minutes of wall clock\s*\n?from that stamp/);
  assert.match(afk, /a new commit starts its own/);
});

test('a check never ends the waterfall anywhere but at its own step', () => {
  assert.match(afk, /This is the one step that may leave a PR not ready over\s+a check/);
  assert.match(afk, /a check read earlier never ends an issue's waterfall/);
});

test('every rule that turns on a check reads the same object', () => {
  // Green, the ready enumeration, the merge bar and the unfinished-stage rule
  // diverged across earlier drafts; each names the reading now.
  assert.match(afk, /full test\nsuite \+ the revision's check reading\)/);
  assert.match(afk, /that commit's\n  check reading resolved \("Remote checks"\)/);
  assert.match(afk, /an\nunresolved check reading \("Remote checks"\), or an unmet frozen-contract item/);
  assert.match(afk, /an open admitted P1, an unresolved check\nreading, or/);
  assert.doesNotMatch(afk, /deterministic CI green/);
  assert.doesNotMatch(afk, /remote CI not run/);
});

test('the tradeoff is stated in the driver and reaches the report', () => {
  // AGENTS.md's level table is the whole reason this feature is dangerous to
  // describe casually; silence about it is as bad as overclaiming.
  assert.match(afk, /one of the few control points outside this agent's authority/);
  assert.match(afk, /both are evaluation the driver performs on itself/);
  // A lookup that never answered establishes nothing about the forge, so the
  // report must not render it as "no check was required".
  assert.match(afk, /named no required check or never answered — which of the two it was/);
  assert.match(afk, /these are two different\n  facts/);
  const start = afk.indexOf('**Remote checks.**');
  const end = afk.indexOf('**Merge bar.**');
  // Fail closed: a renamed heading would slice to '' and pass every guard.
  assert.ok(start !== -1 && end > start, 'the rule must be bounded by both headings');
  // The AGENTS.md section is cited by its own title; only prose is guarded.
  const prose = afk.slice(start, end)
    .replace('"What this plugin can and cannot enforce"', '');
  assert.doesNotMatch(prose, /enforc|block|guarantee|\bbars\b/i);
});

test('the pilot and internal review defer to the driver rather than restating it', () => {
  assert.match(pilot, /for what counts as required/);
  assert.match(pilot, /an answer naming no required check at all is that condition/);
  assert.match(pilot, /Local green never sets the merge-ready bar/);
  assert.doesNotMatch(pilot, /CI green — not local green/);
  assert.match(internal, /Which readings permit ready is the driver's/);
  assert.doesNotMatch(internal, /CI hard gate/);
  // The retired framing survived here once; the driver-only guard missed it.
  assert.doesNotMatch(internal, /deterministic CI/);
  assert.doesNotMatch(pilot, /deterministic CI/);
});

test('a value outside the three is a config error, not a settled reading', () => {
  // A misspelling that fell through to no branch left an empty reading with no
  // resolution at all, and one that fell back to `detect` would settle it.
  assert.match(afk, /blank or absent\n  is `expected`, as every key here resolves/);
  assert.match(afk, /read it as `expected`/);
});

test('the rule adds no requirement of its own', () => {
  // "only the forge's own branch rule makes a check required" contradicted the
  // conservative fallback for a forge that draws no required/advisory line.
  assert.match(afk, /adds no requirement of its own/);
  assert.doesNotMatch(afk, /only the forge's own branch rule\nmakes a check required/);
});

test('the config key ships unset so a bootstrapped repo chooses nothing', () => {
  // A value written by the template is one the operator never chose, and it
  // would move the ready bar for every PR in the run.
  assert.match(template, /^## checks$/m);
  assert.match(template, /^# remote-ci:/m);
  assert.doesNotMatch(template, /^remote-ci:/m);
  // The template once contradicted the driver's conservative fallback.
  assert.doesNotMatch(template, /makes no check required/);
});
