import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  installSupervisor,
  patchStatuslineSettings,
  preflightClaude,
  restoreStatuslineSettings,
  statusSupervisor,
  uninstallSupervisor,
  validateClaudeStatus,
} from '../../scripts/supervisor/install.mjs';

const execFileAsync = promisify(execFileCallback);

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

test('a setup that cannot register a scheduler does not keep the status line', async () => {
  // A failed setup used to leave the wrapper installed, so the user's status
  // line was hijacked by a supervisor that was never going to run.
  const deps = installDeps({ installScheduler: async () => {} });
  const { state } = deps;
  await assert.rejects(() => installSupervisor(deps), /scheduler/i);
  assert.equal(state.settings.statusLine.command, 'user-status');
  assert.equal(state.record, null);
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

// validateClaudeStatus resolves the located path with the host's path rules, so
// the fixture has to speak the host's dialect for the test to mean anything.
const HOST = process.platform === 'win32'
  ? { platform: 'win32', locator: 'where.exe', claudePath: 'C:\\Tools\\claude.exe' }
  : { platform: 'linux', locator: 'which', claudePath: '/opt/claude' };

function locate(stdout) {
  return async (file) => (file === HOST.locator
    ? { stdout: `${HOST.claudePath}\n` }
    : { stdout });
}

test('a missing Claude CLI reports the documented repairable reason', async () => {
  const notFound = async () => { throw Object.assign(new Error('Command failed'), { code: 1 }); };
  await assert.rejects(() => preflightClaude(HOST.platform, { execFile: notFound }), /claude-cli-missing/);

  const foundNothing = async () => ({ stdout: '\r\n' });
  await assert.rejects(() => preflightClaude(HOST.platform, { execFile: foundNothing }), /claude-cli-missing/);
});

test('an unauthenticated Claude CLI reports the documented repairable reason', async () => {
  const execFile = locate(JSON.stringify({ loggedIn: false }));
  await assert.rejects(() => preflightClaude(HOST.platform, { execFile }), /claude-auth-missing/);
});

test('preflight finds the shim npm actually installs on Windows', async () => {
  // npm installs Claude Code on Windows as claude.cmd — there is no claude.exe.
  // Asking `where.exe` for claude.exe found nothing and reported the CLI as
  // missing when it was sitting right there on PATH.
  const asked = [];
  const execFile = async (file, args) => {
    asked.push([file, ...args]);
    if (file === 'where.exe') return { stdout: String.raw`C:\npm\claude.cmd` + '\r\n' };
    return { stdout: JSON.stringify({ loggedIn: true }) };
  };
  const found = await preflightClaude('win32', { execFile });
  assert.deepEqual(asked[0], ['where.exe', 'claude'], 'ask for every shim, not only the native build');
  assert.equal(found.claudePath, String.raw`C:\npm\claude.cmd`);
});

test('preflight probes the shim through cmd.exe, as Node requires', async () => {
  // Finding the shim is not enough: Node cannot execute a .cmd directly (EINVAL
  // since Node 20). Calling it straight from execFile threw, preflight caught the
  // throw, and setup reported claude-auth-missing — locking out the very npm
  // install the locator was fixed to find, and blaming the user's login for it.
  const asked = [];
  const execFile = async (file, args) => {
    asked.push({ file, args });
    if (file === 'where.exe') return { stdout: String.raw`C:\npm\claude.cmd` + '\r\n' };
    return { stdout: JSON.stringify({ loggedIn: true }) };
  };
  const found = await preflightClaude('win32', { execFile });
  const probe = asked.at(-1);
  assert.match(probe.file, /cmd\.exe$/i, 'a .cmd must be probed through cmd.exe');
  assert.ok(probe.args.at(-1).includes(String.raw`"C:\npm\claude.cmd"`), 'the shim is quoted inside the payload');
  assert.ok(probe.args.at(-1).includes('"auth"'));
  assert.equal(found.claudePath, String.raw`C:\npm\claude.cmd`);
});

test('a real .cmd shim is executable by preflight on this machine', { skip: process.platform !== 'win32' }, async () => {
  // The fake execFile above cannot fail the way Node does, which is precisely how
  // the defect survived: every preflight test passed against a stub that would
  // happily "run" a .cmd. This one spawns a real shim with the real execFile —
  // and from a path WITH SPACES, because per-argument quoting under cmd's /s rule
  // cut such a path at its first space, and an ordinary Windows user profile is
  // exactly such a path. Both defects were invisible to every stubbed test.
  const root = await mkdtemp(join(tmpdir(), 'afk-preflight-'));
  const directory = join(root, 'space d');
  await mkdir(directory, { recursive: true });
  const shim = join(directory, 'claude.cmd');
  await writeFile(shim, '@echo off\r\necho {"loggedIn":true}\r\n');
  try {
    const execFile = async (file, args, options) => (file === 'where.exe'
      ? { stdout: `${shim}\r\n` }
      : execFileAsync(file, args, options));
    assert.deepEqual(await preflightClaude('win32', { execFile }), { claudePath: shim, authenticated: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preflight prefers a real executable over a script shim', async () => {
  const listed = [String.raw`C:\npm\claude.cmd`, String.raw`C:\native\claude.exe`].join('\r\n');
  const execFile = async (file) => (file === 'where.exe'
    ? { stdout: listed }
    : { stdout: JSON.stringify({ loggedIn: true }) });
  assert.equal((await preflightClaude('win32', { execFile })).claudePath, String.raw`C:\native\claude.exe`);
});

test('preflight returns the located CLI when it is present and authenticated', async () => {
  const execFile = locate(JSON.stringify({ loggedIn: true, subscriptionType: 'max' }));
  assert.deepEqual(await preflightClaude(HOST.platform, { execFile }), {
    claudePath: HOST.claudePath, authenticated: true,
  });
});


test('Claude preflight accepts authenticated status without retaining identity fields', () => {
  const claudePath = process.platform === 'win32' ? 'C:\\Tools\\claude.exe' : '/opt/claude';
  assert.deepEqual(validateClaudeStatus(claudePath, JSON.stringify({ loggedIn: true, identity: 'private-value', subscriptionType: 'max' })), {
    claudePath, authenticated: true,
  });
  assert.throws(() => validateClaudeStatus(claudePath, JSON.stringify({ loggedIn: false })), /claude-auth-missing/);
  assert.throws(() => validateClaudeStatus('claude.exe', '{}'), /claude-cli-missing/);
});
