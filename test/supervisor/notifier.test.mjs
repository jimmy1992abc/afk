import assert from 'node:assert/strict';
import test from 'node:test';

import { createNotifier } from '../../scripts/supervisor/notifier.mjs';

test('notifier sends quota escalation through the platform adapter', async () => {
  const calls = [];
  const notify = createNotifier({
    platform: 'win32', root: 'C:\\supervisor',
    adapter: { notify: async (...args) => calls.push(args) },
  });
  await notify({ runId: 'run-1', quotaRejections: { nextProbeAt: 123 } });
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /run-1/);
  assert.equal(calls[0][2].notifyScript, 'C:\\supervisor\\worker\\notify-windows.ps1');
});
