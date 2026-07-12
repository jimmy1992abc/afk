import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseObservation, runWrapper } from '../../scripts/supervisor/statusline-wrapper.mjs';
import { paths } from '../../scripts/supervisor/state.mjs';

const NOW = 1_800_000_000;

test('parseObservation records only sane rate-limit data', () => {
  const good = parseObservation({ rate_limits: { five_hour: { resets_at: NOW + 900, used_percentage: 97 } } }, NOW);
  assert.deepEqual(good, { fiveHourResetAt: NOW + 900, fiveHourUsedPercentage: 97, observedAt: NOW });

  // Absent fields observe nothing: API-key sessions and the first moments of a
  // session have no rate_limits, and that must never erase a previous reading.
  assert.equal(parseObservation({ session_id: 'x' }, NOW), null);
  // A reset more than one window ahead is a broken clock, not a schedule —
  // recording it would park the activator on a reset that never comes.
  assert.equal(parseObservation({ rate_limits: { five_hour: { resets_at: NOW + 19_000 } } }, NOW), null);
  assert.equal(parseObservation({ rate_limits: { five_hour: { resets_at: 'soon' } } }, NOW), null);
  // Usage outside 0..100 is garbage, but the exact reset is still worth keeping.
  assert.equal(parseObservation({ rate_limits: { five_hour: { resets_at: NOW + 900, used_percentage: 250 } } }, NOW).fiveHourUsedPercentage, null);
});

test('the wrapper runs the previous status line first and observes best-effort', async () => {
  const root = await mkdtemp(join(tmpdir(), 'afk-wrapper-'));
  await writeFile(join(root, 'statusline-chain.json'), JSON.stringify({ previousCommand: 'user-status' }));
  const ran = [];
  const raw = JSON.stringify({ rate_limits: { five_hour: { resets_at: NOW + 900, used_percentage: 99 } } });

  const code = await runWrapper({
    root, raw, now: () => NOW,
    previous: async (command, input) => { ran.push({ command, input }); return 7; },
  });

  assert.equal(code, 7, "the user's status line owns the exit code");
  assert.deepEqual(ran, [{ command: 'user-status', input: raw }]);
  const written = JSON.parse(await readFile(paths(root).observation, 'utf8'));
  assert.equal(written.fiveHourResetAt, NOW + 900);
});

test('malformed input still renders the previous status line and writes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'afk-wrapper-'));
  const code = await runWrapper({ root, raw: 'not json {', now: () => NOW, previous: async () => 0 });
  assert.equal(code, 0);
  await assert.rejects(() => readFile(paths(root).observation, 'utf8'), /ENOENT/);
});
