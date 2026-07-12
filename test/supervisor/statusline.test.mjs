import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { installSupervisor } from '../../scripts/supervisor/install.mjs';
import { runBridge } from '../../scripts/supervisor/statusline-bridge.mjs';
import { runPrevious, runWrapper } from '../../scripts/supervisor/statusline-wrapper.mjs';

const SESSION = '00000000-0000-4000-8000-000000000001';
const PAYLOAD = JSON.stringify({
  session_id: SESSION,
  rate_limits: { five_hour: { used_percentage: 91, resets_at: 2_000_000_000 } },
});

function root() {
  return mkdtemp(join(tmpdir(), 'afk-statusline-'));
}

test('malformed status-line input is skipped', async () => {
  assert.equal((await runBridge({ root: await root(), raw: 'not json' })).code, 'skip:statusline-malformed');
});

test('a status-line payload carrying rate limits is published', async () => {
  const result = await runBridge({ root: await root(), raw: PAYLOAD, now: () => 1_999_999_000 });
  assert.equal(result.code, 'published');
});

test('a status-line payload without rate limits publishes no observation', async () => {
  const raw = JSON.stringify({ session_id: SESSION });
  const result = await runBridge({ root: await root(), raw, now: () => 1_000 });
  assert.notEqual(result.code, 'published');
});

test('the previous status line runs first and still runs when the AFK bridge throws', async () => {
  const order = [];
  const code = await runWrapper({
    root: 'unused', raw: PAYLOAD, previousCommand: 'previous',
    previous: async () => { order.push('previous'); return 0; },
    bridge: async () => { order.push('bridge'); throw new Error('disk full'); },
  });
  assert.deepEqual(order, ['previous', 'bridge']);
  assert.equal(code, 0);
});

test('the previous status line keeps its exit code', async () => {
  const script = join(await root(), 'exit3.mjs');
  await writeFile(script, 'process.exit(3);\n');
  assert.equal(await runPrevious(`"${process.execPath}" "${script}"`, PAYLOAD), 3);
});

test('a previous command that never drains stdin does not raise', async () => {
  const script = join(await root(), 'quiet.mjs');
  await writeFile(script, "process.stdout.write('ok');\n");
  assert.equal(await runPrevious(`"${process.execPath}" "${script}"`, 'x'.repeat(200_000)), 0);
});

test('the previous status line is recorded before settings are overwritten', async () => {
  const order = [];
  let settings = { statusLine: { type: 'command', command: 'ccusage' } };
  let record = null;
  await installSupervisor({
    sourceRoot: 'source', stableRoot: 'stable', wrapperCommand: 'node wrapper.mjs',
    copyStable: async () => {},
    verifyStable: async () => {},
    readInstallRecord: async () => record,
    readSettings: async () => settings,
    writeSettings: async (next) => { order.push('settings'); settings = next; },
    writeInstallRecord: async (next) => { order.push('record'); record = next; },
    installScheduler: async () => { order.push('scheduler'); },
  });
  assert.deepEqual(order, ['record', 'settings', 'scheduler']);
  assert.equal(record.previousStatusLine.command, 'ccusage');
});
