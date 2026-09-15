import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from './check-direction-audit.mjs';

for (const argv of [[], ['unknown'], ['check', '--run-id', 'run'],
  ['check', '--run-id', 'r', '--issue', 'i', '--audit', 'a', '--stage', 'result', '--endpoint', 'e'],
  ['check', '--run-id', 'r', '--issue', 'i', '--audit', 'a', '--stage', 'result', '--audit', 'b'],
  ['prepare', '--run-id', 'r', '--issue', 'i', '--input', 'a', '--provider', 'other']]) {
  test(`network-free CLI rejects ${JSON.stringify(argv)}`, () => assert.throws(() => run(argv)));
}
