import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseRoleQualifiers, resolveReviewSelection } from './model-select.mjs';

const select = (family, argv = [], env = {}) => resolveReviewSelection({ family, argv, env });

test('selection resolves fields independently and preserves current defaults', () => {
  assert.equal(select('codex').model, 'gpt-5.6-sol');
  assert.equal(select('claude').model, 'claude-opus-5');
  const r = select('codex', ['--model', 'astra'], { CODEX_REVIEW_REASONING: 'high' });
  assert.equal(r.model, 'gpt-6-astra');
  assert.equal(r.effort, 'high');
  assert.deepEqual(r.sources, { model: 'flag', effort: 'env' });
});

test('explicit aliases expand while environment aliases remain refused', () => {
  for (const [family, alias, model] of [
    ['codex', 'terra', 'gpt-5.6-terra'], ['codex', 'sol', 'gpt-5.6-sol'],
    ['codex', 'astra', 'gpt-6-astra'], ['codex', 'luna', 'gpt-5.6-luna'],
    ['claude', 'fable', 'claude-fable-5-1'],
    ['claude', 'opus', 'claude-opus-5'], ['claude', 'sonnet', 'claude-sonnet-5'],
    ['claude', 'haiku', 'claude-haiku-4-5-20251001'],
  ]) assert.equal(select(family, [`--model=${alias}`]).model, model);
  assert.throws(() => select('claude', [], { CLAUDE_REVIEW_MODEL: 'opus' }), /pinned model ID/);
  assert.equal(select('claude', ['--model=fable'], { CLAUDE_REVIEW_MODEL: 'bad' }).model, 'claude-fable-5-1');
});

test('selection flags are removed without consuming targets or unrelated options', () => {
  const r = select('codex', ['--base', 'main', '--model=astra', '--effort', 'max', '--print-args']);
  assert.deepEqual(r.argv, ['--base', 'main', '--print-args']);
  assert.equal(r.effort, 'max');
});

test('malformed, duplicated, and unknown explicit selections are errors', () => {
  for (const args of [
    ['--model'], ['--model='], ['--model', '--base', 'main'],
    ['--model=sol', '--model', 'astra'], ['--effort=high', '--effort=max'],
    ['--model=asrta'], ['--model=claude-opus-5'], ['--effort=extreme'],
    ['--model=astra', '--effort=minimal'], ['--effort=ultra'],
  ]) assert.throws(() => select('codex', args), /model|effort/);
  assert.equal(select('codex', ['--model=gpt-5.1', '--effort=minimal']).effort, 'minimal');
});

test('raw Codex config overrides preserve last-wins behavior and honest diagnostics', () => {
  const r = select('codex', ['--model=sol', '--effort=high', '-c', 'model="gpt-6-astra"', '-c', 'model_reasoning_effort="max"']);
  assert.equal(r.model, 'gpt-6-astra');
  assert.equal(r.effort, 'max');
  assert.deepEqual(r.sources, { model: 'config-flag', effort: 'config-flag' });
  assert.throws(() => select('codex', ['-c', 'model_reasoning_effort="wrong"']), /effort/);
});

test('Codex inheritance remains opt-in for every existing spelling', () => {
  for (const value of ['inherit', 'default', 'config', '', '  ', 'INHERIT']) {
    assert.equal(select('codex', [], { CODEX_REVIEW_MODEL: value }).model, null);
  }
  assert.equal(select('codex', ['--model=inherit']).model, null);
});

test('handoff qualifiers consume known adjacent tokens in either order', () => {
  for (const tokens of [['astra', 'high', 'fix', 'parser'], ['high', 'astra', 'fix', 'parser']]) {
    const r = parseRoleQualifiers('codex', tokens);
    assert.deepEqual(r.argv, ['--model', 'gpt-6-astra', '--effort', 'high']);
    assert.deepEqual(r.remaining, ['fix', 'parser']);
  }
  assert.deepEqual(parseRoleQualifiers('codex', ['fix', 'the', 'parser']).argv, []);
  assert.deepEqual(parseRoleQualifiers('codex', ['high', '-kimi']).remaining, ['-kimi']);
  assert.throws(() => parseRoleQualifiers('codex', ['sol', 'astra']), /model/);
  assert.throws(() => parseRoleQualifiers('codex', ['high', 'max']), /effort/);
});

test('the driver CLI returns executable helper flags and preserves following prose', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./model-select.mjs', import.meta.url)),
    '--family', 'codex', '--qualifiers', 'astra', 'high', 'fix', 'parser'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.deepEqual(result.argv, ['--model', 'gpt-6-astra', '--effort', 'high']);
  assert.deepEqual(result.remaining, ['fix', 'parser']);
});
