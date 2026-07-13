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

test('a platform with no notifier still runs the pass', async () => {
  // CI caught this: Linux is not an install target, but the pass runs there —
  // and an eagerly-constructed notification adapter threw "unsupported
  // platform" before the pass could do anything at all. A missing toast must
  // never be the reason a pass dies.
  const { createNotifier } = await import('../../scripts/supervisor/notifier.mjs');
  const notify = createNotifier({ platform: 'linux', root: '/tmp/afk' });
  await assert.doesNotReject(() => notify('title', 'message'));
});
