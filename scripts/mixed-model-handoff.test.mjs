import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const afk = read('../skills/afk/SKILL.md');
const pilot = read('../skills/afk-implementation-pilot/SKILL.md');
const planner = read('../skills/afk-spec-planner/SKILL.md');
const prose = (text) => text.replace(/\s+/g, ' ');

test('a restricted executor hands commit authority back to the driver', () => {
  for (const source of [afk, pilot]) {
    const text = prose(source);
    assert.match(text, /linked-worktree Git metadata/i);
    assert.match(text, /driver.*inspect.*diff/is);
    assert.match(text, /rerun.*declared checks/is);
    assert.match(text, /push.*PR.*merge.*separate/i);
  }
});

test('environment refusal is neither RED nor green until an unchanged rerun', () => {
  for (const source of [afk, pilot]) {
    const text = prose(source);
    assert.match(text, /`ENVIRONMENT-BLOCKED`/);
    assert.match(text, /before.*assertion|before.*contract behavior/is);
    assert.match(text, /unchanged command/is);
    assert.match(text, /authorized environment/i);
    assert.match(text, /neither RED nor green/i);
  }
});

test('the planner closes generated-artifact execution surfaces without granting writes', () => {
  const text = prose(planner);
  assert.match(text, /\*\*Execution surface\*\*/);
  assert.match(text, /generated outputs?/i);
  assert.match(text, /generator/i);
  assert.match(text, /inputs.*configuration/i);
  assert.match(text, /side effects/i);
  assert.match(text, /read.*execute.*write/i);
  assert.match(text, /does not authorize/i);
});

test('stable finding identity remains while a fixed round exit stays absent', () => {
  assert.match(afk, /stable ID/);
  assert.match(afk, /two consecutive unfinished rounds without material progress/i);
  assert.doesNotMatch(afk, /four[- ]round (cap|limit)|stop after four rounds/i);
});
