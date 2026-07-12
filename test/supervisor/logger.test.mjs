import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { appendBoundedLog } from '../../scripts/supervisor/logger.mjs';

test('bounded logger rotates before appending another event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'afk-log-'));
  const path = join(root, 'events.log');
  await appendBoundedLog(path, { code: 'first' }, { maxBytes: 1, copies: 2 });
  await appendBoundedLog(path, { code: 'second' }, { maxBytes: 1, copies: 2 });
  assert.match(await readFile(`${path}.1`, 'utf8'), /first/);
  assert.match(await readFile(path, 'utf8'), /second/);
});
