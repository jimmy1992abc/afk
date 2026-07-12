import assert from 'node:assert/strict';
import test from 'node:test';

import { platformAdapter } from '../../scripts/supervisor/platform.mjs';
import { renderLaunchAgent } from '../../scripts/supervisor/platform-macos.mjs';
import { renderWindowsTask } from '../../scripts/supervisor/platform-windows.mjs';

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

test('platformAdapter rejects unsupported systems', () => {
  assert.equal(platformAdapter('darwin', {}).name, 'macos');
  assert.equal(platformAdapter('win32', {}).name, 'windows');
  assert.throws(() => platformAdapter('linux', {}), /unsupported platform/);
});
