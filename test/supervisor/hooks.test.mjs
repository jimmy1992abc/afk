import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { handleHook } from '../../scripts/supervisor/hook-handler.mjs';
import { paths } from '../../scripts/supervisor/state.mjs';

const NOW = 1_800_000_000;

test('a rate-limit StopFailure is recorded; everything else observes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'afk-hook-'));

  // hooks.json already matches rate_limit, but the input is re-checked: a
  // matcher change must not turn every StopFailure into limit evidence.
  const other = await handleHook({ hook_event_name: 'StopFailure', error: 'overloaded' }, { root, now: () => NOW });
  assert.equal(other.code, 'skip:not-rate-limit');
  await assert.rejects(() => readFile(paths(root).stopFailure, 'utf8'), /ENOENT/);

  const recorded = await handleHook({ hook_event_name: 'StopFailure', error: 'rate_limit', error_details: '429' }, { root, now: () => NOW });
  assert.equal(recorded.code, 'action:rate-limit-recorded');
  assert.equal(JSON.parse(await readFile(paths(root).stopFailure, 'utf8')).limitedAt, NOW);
});
