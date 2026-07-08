import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gate,
  parseArgs,
  validateBrief,
  validateScope,
  extractBlock,
  isOn,
  isOff,
  envInt,
} from '../lib/relay.mjs';

test('manual bypasses AGENT_RELAY_ENABLED', () => {
  assert.equal(gate({ manual: true }, {}).shouldSkip, false);
});

test('non-manual + disabled => skip', () => {
  assert.equal(gate({}, {}).shouldSkip, true);
});

test('non-manual + enabled => run', () => {
  assert.equal(gate({}, { AGENT_RELAY_ENABLED: 'on' }).shouldSkip, false);
});

test('strict reflects env', () => {
  assert.equal(gate({ manual: true }, { AGENT_RELAY_STRICT: '1' }).strict, true);
});

test('parseArgs handles multi-value and repeatable flags', () => {
  const a = parseArgs([
    '--manual', '--task', 'do x',
    '--files', 'a.py', 'b.py',
    '--issue', '5', '--issue', '6',
    '--diff',
  ]);
  assert.equal(a.manual, true);
  assert.equal(a.task, 'do x');
  assert.deepEqual(a.files, ['a.py', 'b.py']);
  assert.deepEqual(a.issue, ['5', '6']);
  assert.equal(a.diff, '');
});

test('parseArgs --diff with explicit base', () => {
  assert.equal(parseArgs(['--diff', 'master']).diff, 'master');
});

test('validateBrief accepts a full block, rejects a truncated one', () => {
  const good =
    '===== AGENT BRIEF =====\n1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n===== END AGENT BRIEF =====';
  assert.equal(validateBrief(good).ok, true);
  const bad = '===== AGENT BRIEF =====\n1. a\n2. b\n3. c';
  const v = validateBrief(bad);
  assert.equal(v.ok, false);
  assert.ok(v.missing.length > 0);
});

test('validateScope checks markers + Title + Acceptance', () => {
  const good =
    '===== AGENT SCOPE =====\nTitle: x\nAcceptance criteria:\n- y\n===== END AGENT SCOPE =====';
  assert.equal(validateScope(good).ok, true);
  assert.equal(
    validateScope('===== AGENT SCOPE =====\nfoo\n===== END AGENT SCOPE =====').ok,
    false,
  );
});

test('extractBlock trims surrounding prose', () => {
  const raw = 'preamble\n===== AGENT BRIEF =====\nbody\n===== END AGENT BRIEF =====\ntrailing';
  const b = extractBlock(raw, 'AGENT BRIEF');
  assert.match(b, /^===== AGENT BRIEF =====/);
  assert.doesNotMatch(b, /preamble|trailing/);
  assert.equal(extractBlock('no markers', 'AGENT BRIEF'), null);
});

test('isOn / isOff / envInt', () => {
  assert.ok(isOn('YES'));
  assert.ok(!isOn('off'));
  assert.ok(isOff('disabled'));
  assert.equal(envInt({ X: '50' }, 'X', 9), 50);
  assert.equal(envInt({}, 'X', 9), 9);
  assert.equal(envInt({ X: '-3' }, 'X', 9), 9);
});
