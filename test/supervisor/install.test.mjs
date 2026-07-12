import assert from 'node:assert/strict';
import test from 'node:test';

import {
  installSupervisor,
  patchStatuslineSettings,
  restoreStatuslineSettings,
  uninstallSupervisor,
} from '../../scripts/supervisor/install.mjs';

test('status-line patch is idempotent and preserves previous configuration', () => {
  const original = { permissions: {}, statusLine: { type: 'command', command: 'user-status', padding: 2 } };
  const first = patchStatuslineSettings(original, 'node wrapper.mjs');
  const second = patchStatuslineSettings(first.settings, 'node wrapper.mjs');
  assert.equal(first.previous.command, 'user-status');
  assert.equal(second.changed, false);
  assert.equal(second.settings.statusLine.command.match(/afk-supervisor:/g).length, 1);
});

test('uninstall restores previous status line only while marker still matches', () => {
  const original = { statusLine: { type: 'command', command: 'user-status' } };
  const patched = patchStatuslineSettings(original, 'node wrapper.mjs');
  assert.equal(restoreStatuslineSettings(patched.settings, patched.previous).statusLine.command, 'user-status');
  const userChanged = { ...patched.settings, statusLine: { type: 'command', command: 'new-user-status' } };
  assert.equal(restoreStatuslineSettings(userChanged, patched.previous).statusLine.command, 'new-user-status');
});

test('repeated setup and uninstall are idempotent through injected platform operations', async () => {
  const calls = [];
  let settings = { statusLine: { type: 'command', command: 'user-status' } };
  const deps = {
    stableRoot: '/stable', sourceRoot: '/plugin', wrapperCommand: 'node wrapper.mjs',
    copyStable: async () => calls.push('copy'), verifyStable: async () => calls.push('verify'),
    installScheduler: async () => calls.push('install-scheduler'),
    uninstallScheduler: async () => calls.push('uninstall-scheduler'),
    readSettings: async () => settings,
    writeSettings: async (next) => { settings = next; calls.push('write-settings'); },
    readInstallRecord: async () => deps.record ?? null,
    writeInstallRecord: async (record) => { deps.record = record; calls.push('write-record'); },
    removeInstallRecord: async () => { deps.record = null; calls.push('remove-record'); },
  };
  await installSupervisor(deps);
  await installSupervisor(deps);
  assert.equal(settings.statusLine.command.match(/afk-supervisor:/g).length, 1);
  await uninstallSupervisor(deps);
  await uninstallSupervisor(deps);
  assert.equal(settings.statusLine.command, 'user-status');
  assert.ok(calls.includes('install-scheduler'));
  assert.ok(calls.includes('uninstall-scheduler'));
});
