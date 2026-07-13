import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runOnce } from '../../scripts/supervisor/supervisor.mjs';

test('a pass that dies still names what happened, in the result and the log', async () => {
  // Letting the error escape gives an unhandled rejection with no log line,
  // and the scheduler reports success for ever while the activator does nothing.
  const root = await mkdtemp(join(tmpdir(), 'afk-entry-'));
  await writeFile(join(root, 'config.json'), JSON.stringify({ enabled: 'yes' }));   // invalid: must be boolean

  const result = await runOnce(root);
  assert.equal(result.code, 'error:pass-failed');
  assert.match(result.message, /enabled/);
  const log = await readFile(join(root, 'logs', 'supervisor.log'), 'utf8');
  assert.match(log, /error:pass-failed/, 'the failure reaches the log a human will read');
});

test('an idle pass runs end-to-end against real files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'afk-entry-'));
  const result = await runOnce(root);
  assert.equal(result.code, 'skip:no-limit-observed');
});
