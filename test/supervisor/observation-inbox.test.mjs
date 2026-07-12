import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  commitObservationBatch,
  publishObservation,
  readObservationBatch,
} from '../../scripts/supervisor/observation-inbox.mjs';

async function root() {
  return mkdtemp(join(tmpdir(), 'afk-supervisor-observations-'));
}

function snapshot(overrides = {}) {
  return {
    sessionId: '00000000-0000-4000-8000-000000000001',
    fiveHourResetAt: 2_000,
    fiveHourUsedPercentage: 80.1,
    sevenDayResetAt: null,
    sevenDayUsedPercentage: null,
    observedAt: 1_000,
    source: 'statusline',
    confidence: 'exact',
    ...overrides,
  };
}

test('unchanged snapshots are throttled but reset changes publish immediately', async () => {
  const dir = await root();
  assert.equal((await publishObservation(dir, snapshot(), { now: () => 1_000 })).code, 'published');
  assert.equal((await publishObservation(dir, snapshot({ observedAt: 1_010 }), { now: () => 1_010 })).code, 'throttled');
  assert.equal((await publishObservation(dir, snapshot({ fiveHourResetAt: 3_000, observedAt: 1_011 }), { now: () => 1_011 })).code, 'published');
});

test('integer percentage bucket changes publish before the time limit', async () => {
  const dir = await root();
  await publishObservation(dir, snapshot(), { now: () => 1_000 });
  const result = await publishObservation(dir, snapshot({ fiveHourUsedPercentage: 81, observedAt: 1_001 }), { now: () => 1_001 });
  assert.equal(result.code, 'published');
});

test('batch is ordered and committed files are removed outside state updates', async () => {
  const dir = await root();
  await publishObservation(dir, snapshot({ observedAt: 1_100 }), { now: () => 1_100 });
  await publishObservation(dir, snapshot({ sessionId: '00000000-0000-4000-8000-000000000002', observedAt: 1_000 }), { now: () => 1_000 });
  const batch = await readObservationBatch(dir);
  assert.deepEqual(batch.map((item) => item.observation.observedAt), [1_000, 1_100]);
  await commitObservationBatch(batch);
  assert.deepEqual(await readObservationBatch(dir), []);
});

test('malformed inbox files are reported but never parsed as observations', async () => {
  const dir = await root();
  const result = await publishObservation(dir, { bad: true }, { now: () => 1_000 });
  assert.equal(result.code, 'skip:observation-invalid');
  assert.deepEqual(await readObservationBatch(dir), []);
});
