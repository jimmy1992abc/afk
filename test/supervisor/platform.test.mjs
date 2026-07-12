import assert from 'node:assert/strict';
import test from 'node:test';

import { platformAdapter } from '../../scripts/supervisor/platform.mjs';
import { renderLaunchAgent } from '../../scripts/supervisor/platform-macos.mjs';
import { createWindowsAdapter, renderWindowsTask } from '../../scripts/supervisor/platform-windows.mjs';

test('LaunchAgent runs at load and every 60 seconds with escaped paths', () => {
  const plist = renderLaunchAgent({ nodePath: '/Library/Node & Tools/node', workerPath: '/User Data/supervisor.mjs', stdoutPath: '/Logs/out.log', stderrPath: '/Logs/error.log' });
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
  assert.match(plist, /Node &amp; Tools/);
});

test('Windows task quotes paths with spaces and ignores overlapping instances', () => {
  const xml = renderWindowsTask({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', workerPath: 'C:\\User Data\\supervisor.mjs' });
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /&quot;C:\\User Data\\supervisor\.mjs&quot;/);
  assert.match(xml, /<Interval>PT1M<\/Interval>/);
  assert.match(xml, /<LogonTrigger>/);
});

test('the Windows task keeps running on battery power', () => {
  const xml = renderWindowsTask({ nodePath: 'node.exe', workerPath: 'supervisor.mjs' });
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.doesNotMatch(xml, /<ExecutionTimeLimit>PT1M<\/ExecutionTimeLimit>/);
});

test('the Windows task document is written as UTF-16 with a byte-order mark', async () => {
  const written = [];
  const adapter = createWindowsAdapter({
    writeFile: async (path, content, encoding) => written.push({ path, content, encoding }),
    execFile: async () => ({}),
  });
  await adapter.installScheduler({ nodePath: 'node.exe', workerPath: 'supervisor.mjs', taskXmlPath: 'task.xml' });
  const bytes = Buffer.from(written[0].content, written[0].encoding);
  assert.equal(written[0].encoding, 'utf16le');
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xfe]);
});

test('a Windows notification is detached and never awaited by the caller', async () => {
  const spawned = [];
  const adapter = createWindowsAdapter({ spawnDetached: (file, args) => { spawned.push({ file, args }); return { pid: 1 }; } });
  await adapter.notify('title', 'message', { notifyScript: 'notify.ps1' });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].file, 'powershell.exe');
  assert.ok(spawned[0].args.includes('notify.ps1'));
});

test('platformAdapter rejects unsupported systems', () => {
  assert.equal(platformAdapter('darwin', {}).name, 'macos');
  assert.equal(platformAdapter('win32', {}).name, 'windows');
  assert.throws(() => platformAdapter('linux', {}), /unsupported platform/);
});
