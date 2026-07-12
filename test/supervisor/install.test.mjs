import assert from 'node:assert/strict';
import test from 'node:test';

import {
  installSupervisor,
  patchStatuslineSettings,
  preflightClaude,
  repairSupervisor,
  restoreStatuslineSettings,
  statusSupervisor,
  uninstallSupervisor,
  validateClaudeStatus,
} from '../../scripts/supervisor/install.mjs';

function installDeps(overrides = {}) {
  const state = { record: null, settings: { statusLine: { type: 'command', command: 'user-status' } }, registered: false };
  return {
    state,
    stableRoot: '/stable', sourceRoot: '/plugin', wrapperCommand: 'node wrapper.mjs',
    copyStable: async () => {}, verifyStable: async () => {},
    installScheduler: async () => { state.registered = true; },
    uninstallScheduler: async () => { state.registered = false; },
    schedulerStatus: async () => ({ platform: 'test', intervalSeconds: 60, registered: state.registered }),
    readSettings: async () => state.settings,
    writeSettings: async (next) => { state.settings = next; },
    readInstallRecord: async () => state.record,
    writeInstallRecord: async (record) => { state.record = record; },
    removeInstallRecord: async () => { state.record = null; },
    ...overrides,
  };
}

test('setup fails loudly when the scheduler does not actually register', async () => {
  const deps = installDeps({ installScheduler: async () => {} });
  await assert.rejects(() => installSupervisor(deps), /scheduler/i);
});

test('status reports not-installed when the record survives but the task is gone', async () => {
  const deps = installDeps();
  await installSupervisor(deps);
  assert.equal((await statusSupervisor(deps)).installed, true);
  deps.state.registered = false;
  const status = await statusSupervisor(deps);
  assert.equal(status.installed, false);
  assert.equal(status.scheduler.registered, false);
});

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
  const deps = installDeps({
    copyStable: async () => calls.push('copy'), verifyStable: async () => calls.push('verify'),
  });
  const { state } = deps;
  deps.installScheduler = async () => { state.registered = true; calls.push('install-scheduler'); };
  deps.uninstallScheduler = async () => { state.registered = false; calls.push('uninstall-scheduler'); };
  await installSupervisor(deps);
  await installSupervisor(deps);
  assert.equal(state.settings.statusLine.command.match(/afk-supervisor:/g).length, 1);
  await uninstallSupervisor(deps);
  await uninstallSupervisor(deps);
  assert.equal(state.settings.statusLine.command, 'user-status');
  assert.ok(calls.includes('install-scheduler'));
  assert.ok(calls.includes('uninstall-scheduler'));
});

test('a missing Claude CLI reports the documented repairable reason', async () => {
  const notFound = async () => { throw Object.assign(new Error('Command failed: where.exe claude.exe'), { code: 1 }); };
  await assert.rejects(() => preflightClaude('win32', { execFile: notFound }), /claude-cli-missing/);

  const foundNothing = async () => ({ stdout: '\r\n' });
  await assert.rejects(() => preflightClaude('win32', { execFile: foundNothing }), /claude-cli-missing/);
});

test('an unauthenticated Claude CLI reports the documented repairable reason', async () => {
  const execFile = async (file) => (file === 'where.exe'
    ? { stdout: 'C:\\Tools\\claude.exe\r\n' }
    : { stdout: JSON.stringify({ loggedIn: false }) });
  await assert.rejects(() => preflightClaude('win32', { execFile }), /claude-auth-missing/);
});

test('preflight returns the located CLI when it is present and authenticated', async () => {
  const execFile = async (file) => (file === 'where.exe'
    ? { stdout: 'C:\\Tools\\claude.exe\r\n' }
    : { stdout: JSON.stringify({ loggedIn: true, subscriptionType: 'max' }) });
  assert.deepEqual(await preflightClaude('win32', { execFile }), {
    claudePath: 'C:\\Tools\\claude.exe', authenticated: true,
  });
});

test('repair refreshes the worker and scheduler without re-wrapping the status line', async () => {
  const calls = [];
  const deps = installDeps({ copyStable: async () => calls.push('copy') });
  const { state } = deps;
  await installSupervisor(deps);
  const original = state.record;
  state.registered = false;

  const result = await repairSupervisor(deps);
  assert.equal(result.code, 'action:supervisor-repaired');
  assert.equal(state.registered, true, 'repair must re-register a scheduler that went missing');
  assert.equal(calls.filter((c) => c === 'copy').length, 2, 'repair must refresh the stable worker copy');
  assert.deepEqual(state.record, original, 'repair must not overwrite the recorded previous status line');
  assert.equal(state.settings.statusLine.command.match(/afk-supervisor:/g).length, 1);
});

test('Claude preflight accepts authenticated status without retaining identity fields', () => {
  const claudePath = process.platform === 'win32' ? 'C:\\Tools\\claude.exe' : '/opt/claude';
  assert.deepEqual(validateClaudeStatus(claudePath, JSON.stringify({ loggedIn: true, identity: 'private-value', subscriptionType: 'max' })), {
    claudePath, authenticated: true,
  });
  assert.throws(() => validateClaudeStatus(claudePath, JSON.stringify({ loggedIn: false })), /claude-auth-missing/);
  assert.throws(() => validateClaudeStatus('claude.exe', '{}'), /claude-cli-missing/);
});
