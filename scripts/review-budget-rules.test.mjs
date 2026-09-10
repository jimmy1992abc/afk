import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const afk = readFileSync(new URL('../skills/afk/SKILL.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
const config = readFileSync(new URL('../templates/afk-config.example.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');

test('the issue allowance persists across phases and resumes', () => {
  assert.match(afk, /no numeric repair cap by default/);
  assert.match(afk, /Initial implementation and initial reviews do not consume cycles/);
  assert.match(afk, /before the first review-driven content edit/);
  assert.match(afk, /provider changes, sequence restarts, scheduled ticks, and resumes/);
  assert.match(afk, /cannot increase its own allowance mid-run/);
  assert.match(afk, /cannot reconstruct.*OUTSTANDING/s);
  assert.match(config, /max-fix-cycles:/);
});

test('exhaustion completes current validation but never starts another repair', () => {
  assert.match(afk, /Complete the current cycle's checks/);
  assert.match(afk, /Do not start another automatic repair after an explicit limit is exhausted/);
  assert.match(afk, /not ready.*OUTSTANDING/s);
  assert.match(afk, /Never auto-merge or downgrade a verified blocker/);
  assert.match(afk, /no automatic approval request loop/);
});

test('net progress accounts for regression and boundary expansion', () => {
  assert.match(afk, /closed blockers, newly introduced blockers, acceptance-criterion coverage/);
  assert.match(afk, /expansion of the causal boundary/);
  assert.match(afk, /Closing one blocker alone is insufficient/);
  assert.match(afk, /regression\/churn/);
});
