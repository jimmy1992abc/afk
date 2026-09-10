import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const validate = read('.github/workflows/validate.yml');
const owner = read('.github/workflows/require-owner-approval.yml');
const driver = read('skills/afk/SKILL.md');
const pilot = read('skills/afk-implementation-pilot/SKILL.md');

test('validation skips draft jobs while retaining main and manual validation', () => {
  assert.match(validate, /jobs:\n  checks:\n    if: github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.draft == false\n/);
  assert.match(validate, /  push:\n    branches: \[main\]/);
  assert.match(validate, /  workflow_dispatch:/);
});

test('ready transitions trigger validation and later commits keep revalidating', () => {
  const events = validate.match(/  pull_request:\n    types: \[([^\]]+)\]/)?.[1].split(',').map((value) => value.trim());
  assert.ok(events, 'PR activity types must be explicit');
  for (const event of ['opened', 'synchronize', 'reopened', 'ready_for_review']) assert.ok(events.includes(event), event);
  assert.match(validate, /group: validate-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/);
  assert.match(validate, /cancel-in-progress: true/);
});

test('owner approval waits for ready and still responds to review changes', () => {
  assert.match(owner, /jobs:\n  gate:\n    if: github\.event\.pull_request\.draft == false\n/);
  assert.match(owner, /types: \[[^\]]*ready_for_review[^\]]*\]/);
  assert.match(owner, /  pull_request_review:\n    types: \[submitted, dismissed\]/);
});

test('the waterfall finishes local review before promoting and reading CI', () => {
  const start = driver.indexOf('design doc with a frozen issue contract →');
  const end = driver.indexOf('- Scale design/debate', start);
  assert.ok(start >= 0 && end > start);
  const waterfall = driver.slice(start, end);
  const steps = ['open a Draft PR', '**internal review**', '**external gate(s)**', '**full test suite once**', 'mark Ready for review', 'read the final revision'];
  let previous = -1;
  for (const step of steps) {
    const position = waterfall.indexOf(step);
    assert.ok(position > previous, `${step} must follow the previous stage`);
    previous = position;
  }
});

test('draft deferral cannot deadlock expected CI or impersonate a passing run', () => {
  assert.match(driver, /Do not wait for intentionally deferred CI while the PR is Draft/);
  assert.match(driver, /Ready for review is a forge state, not a merge-ready verdict/);
  assert.match(driver, /Never reuse Draft-stage skipped checks as passing CI evidence/);
  assert.match(driver, /after the latest Ready transition/);
  assert.match(driver, /Return to Draft before pushing review-driven repairs/);
});

test('the implementation pilot preserves draft status and continues the handoff', () => {
  assert.match(pilot, /Open new PRs as Draft/);
  assert.match(pilot, /Do not wait for intentionally deferred CI/);
  assert.match(pilot, /driver owns the Ready transition/);
});
