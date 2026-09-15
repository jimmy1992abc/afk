import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./direction-state.mjs', import.meta.url));
test('state CLI rejects missing, repeated and unknown options with structured failure', () => {
  for (const args of [[], ['check'], ['check', '--run-id', 'run', '--run-id', 'other', '--issue', '109'],
    ['apply', '--request'], ['check', '--run-id', 'run', '--issue', '109', '--publish'], ['probe']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1); const value = JSON.parse(result.stdout);
    assert.equal(value.version, 1); assert.ok(value.reasons.length); assert.equal(value.status, 'refused');
  }
});
