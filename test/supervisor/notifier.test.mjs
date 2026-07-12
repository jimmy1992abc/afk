import assert from 'node:assert/strict';
import test from 'node:test';

import { createNotifier, createStuckNotifier } from '../../scripts/supervisor/notifier.mjs';

test('a notification never advises an action the CLI will refuse', async () => {
  // The stuck notification told the operator that `trigger-now --force` releases a
  // runner that had outlived its timeout. For a runner that is verifiably ALIVE that
  // is advice to corrupt the session — one Claude still writing to it, a second
  // started on top — and the command now refuses it. A live runner is ended by
  // ending it, so the message has to say that, and name the pid.
  const calls = [];
  const notify = createStuckNotifier({
    platform: 'win32', root: 'C:\\supervisor',
    adapter: { notify: async (...args) => calls.push(args) },
  });
  const run = { runId: 'run-1', recoveryLease: { pid: 4242 } };

  await notify(run, 'alive');
  assert.doesNotMatch(calls.at(-1)[1], /--force/, 'a live runner is not forceable');
  assert.match(calls.at(-1)[1], /4242/, 'and the operator needs the pid to stop it');

  // An unverifiable claim is exactly what --force is for, and it must still say so.
  await notify(run, 'unknown');
  assert.match(calls.at(-1)[1], /--force/);
});

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
