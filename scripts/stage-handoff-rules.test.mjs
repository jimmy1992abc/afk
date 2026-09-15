import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readInstruction as read, section, assertRoute } from './instruction-test-helpers.mjs';

const ref = (name) => `skills/afk/references/${name}.md`;
const stage = (name) => read(`skills/afk-${name}/SKILL.md`);
const prose = (text) => text.replace(/\s+/g, ' ');

test('stage handoffs explicitly read the common output and continuity contracts', () => {
  for (const name of ['spec-planner', 'implementation-pilot', 'internal-review', 'agent-relay']) {
    const text = section(stage(name), 'Stage boundary');
    assertRoute(text, '../afk/references/output.md');
    assertRoute(text, '../afk/references/continuity.md');
    assert.match(text, /Before|before/);
    assert.match(text, /standalone/i);
    assert.match(text, /nested/i);
    assert.match(text, /driver/);
  }
  assertRoute(read('skills/afk/SKILL.md'), 'references/output.md');
});

test('each stage names its bounded result and concrete continuation', () => {
  const planner = prose(section(stage('spec-planner'), 'Stage boundary'));
  assert.match(planner, /plan-only.*ends.*plan/i);
  assertRoute(planner, '../afk/references/design-review.md');
  assert.match(planner, /no code/i);
  assert.match(prose(section(stage('implementation-pilot'), 'Stage boundary')), /nested.*return.*evidence.*driver.*internal review/i);
  assert.match(prose(section(stage('internal-review'), 'Stage boundary')), /standalone.*verdict.*nested.*driver.*external roles/i);
  assert.match(prose(section(stage('agent-relay'), 'Stage boundary')), /draft.*not.*approval/i);
  assert.match(prose(read('skills/afk/SKILL.md')), /child.*completion.*not.*queue/i);
});

test('handoff view reads source records instead of creating independent state', () => {
  const text = prose(section(read(ref('output')), 'Handoff view'));
  for (const pattern of [/run.*issue/i, /baseline/i, /target/i, /coverage/i, /stable.*IDs/i,
    /consumed.*reserved/i, /authority/i, /next action/i, /source/i]) assert.match(text, pattern);
  assert.match(text, /derived view/i);
  assert.match(text, /not.*second.*ledger/i);
  assert.match(text, /unknown.*not zero/i);
  assert.match(text, /standalone.*no run/i);
  assert.match(text, /#109/);
  assertRoute(text, 'direction-state.md');
});

test('authority and actual target reload before dependent resumed work', () => {
  const text = prose(section(read(ref('continuity')), 'Stage and session transitions'));
  for (const pattern of [/source authority/, /frozen issue contract/, /actual.*target/,
    /findings/, /consumed.*reserved/, /before.*dependent/i, /stale/i,
    /driver.*ledger/, /child.*return/, /compaction/, /in-session/]) assert.match(text, pattern);
  assert.match(text, /cannot expand/);
  assert.match(text, /already granted/i);
  assert.match(text, /same run/);
  assertRoute(text, 'review-convergence.md');
  assertRoute(text, 'review-evidence.md');
  const kickoff = prose(read(ref('kickoff')));
  assert.match(kickoff, /scope.*source.*publication.*source/i);
});

test('summaries retain complete command evidence and explicit limitations', () => {
  const text = prose(section(read(ref('output')), 'Command and review evidence'));
  for (const pattern of [/command/, /working directory/, /target/, /exit status/,
    /terminal/, /failure/, /stderr/, /complete.*log/, /timeout/, /skip/i,
    /unknown/, /missing/i, /stale/, /secrets/, /not.*replace.*packet/i]) assert.match(text, pattern);
  assertRoute(text, 'review-evidence.md');
  const relay = prose(section(stage('agent-relay'), 'Reading the result'));
  assert.match(relay, /original.*logs/i);
  assert.match(relay, /tails.*not.*complete/i);
});

test('new handoff checks reject absent routes and absent canonical sections', () => {
  assert.throws(() => assertRoute('Before returning, summarize.', '../afk/references/output.md'), /missing explicit route/);
  assert.throws(() => section('# Output\nSummary.', 'Handoff view'), /missing instruction section/);
});
