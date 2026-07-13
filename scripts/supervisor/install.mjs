import { execFile as execFileCallback } from 'node:child_process';
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

import { claudeInvocation } from './claude-runner.mjs';
import { platformAdapter } from './platform.mjs';

const execFileAsync = promisify(execFileCallback);
export const STATUSLINE_MARKER = '--afk-supervisor:1';

// The CLI surfaces a thrown message as `error:<message>`, so these are the
// reason codes the design documents for a repairable setup failure.
export const CLI_MISSING = 'claude-cli-missing';
export const AUTH_MISSING = 'claude-auth-missing';

// npm installs Claude Code on Windows as `claude.cmd` — there is no `claude.exe`.
// Accepting only the native build silently locked every npm user out.
export const CLAUDE_EXECUTABLE = /^claude(?:\.(?:exe|cmd|bat))?$/i;

// Path checks follow the TARGET platform, not the host: preflight('win32') must
// judge a Windows path by Windows rules wherever the test happens to run.
function pathApi(platform) {
  return platform === 'win32' ? win32 : posix;
}

export function validateClaudeStatus(claudePath, statusJson, platform = process.platform) {
  const api = pathApi(platform);
  if (!api.isAbsolute(claudePath) || !CLAUDE_EXECUTABLE.test(api.basename(claudePath))) {
    throw new Error(CLI_MISSING);
  }
  let status;
  try { status = JSON.parse(statusJson); } catch { throw new Error(AUTH_MISSING); }
  if (status.loggedIn !== true) throw new Error(AUTH_MISSING);
  return { claudePath, authenticated: true };
}

export async function preflightClaude(platform = process.platform, deps = {}) {
  const execFile = deps.execFile ?? execFileAsync;
  // `where.exe claude` finds every shim on PATH: the native claude.exe, or the
  // claude.cmd that npm installs. Asking only for claude.exe found neither for an
  // npm user, and reported the CLI as missing when it was right there.
  const locator = platform === 'win32' ? ['where.exe', ['claude']] : ['which', ['claude']];
  let located;
  try {
    located = await execFile(locator[0], locator[1], { windowsHide: true });
  } catch {
    // A locator that exits non-zero means the CLI is not on PATH. Letting its
    // raw "Command failed" text through would report an unrepairable error for
    // a plainly repairable condition.
    throw new Error(CLI_MISSING);
  }
  // `where` lists every match on PATH. Keep only the ones that really are Claude,
  // and prefer a native executable over a script shim: an npm install puts
  // claude.cmd, claude.ps1 and a bare `claude` beside each other.
  const candidates = located.stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && CLAUDE_EXECUTABLE.test(pathApi(platform).basename(line)));
  const claudePath = candidates.find((line) => /\.exe$/i.test(line)) ?? candidates[0];
  if (!claudePath) throw new Error(CLI_MISSING);
  // Node cannot execute a .cmd directly, and the shim npm installs is exactly that.
  // Probing it straight from execFile threw, and setup blamed the user's login for
  // a CLI that was installed and logged in. The runner already knew this rule.
  const probe = claudeInvocation(claudePath, ['auth', 'status', '--json']);
  let status;
  try {
    status = await execFile(probe.file, probe.args, { windowsHide: true, maxBuffer: 1024 * 1024, ...probe.options });
  } catch {
    throw new Error(AUTH_MISSING);
  }
  return validateClaudeStatus(claudePath, status.stdout, platform);
}

export function patchStatuslineSettings(settings, wrapperCommand) {
  const current = structuredClone(settings ?? {});
  if (current.statusLine?.command?.includes(STATUSLINE_MARKER)) {
    return { settings: current, previous: null, changed: false };
  }
  const previous = current.statusLine ? structuredClone(current.statusLine) : null;
  current.statusLine = {
    ...(current.statusLine ?? {}),
    type: 'command',
    command: `${wrapperCommand} ${STATUSLINE_MARKER}`,
  };
  return { settings: current, previous, changed: true };
}

export function restoreStatuslineSettings(settings, previous) {
  const current = structuredClone(settings ?? {});
  if (!current.statusLine?.command?.includes(STATUSLINE_MARKER)) return current;
  if (previous) current.statusLine = structuredClone(previous);
  else delete current.statusLine;
  return current;
}

export async function installSupervisor(deps) {
  await deps.copyStable(deps.sourceRoot, deps.stableRoot);
  await deps.verifyStable(deps.stableRoot);
  const existingRecord = await deps.readInstallRecord();
  const settings = await deps.readSettings();
  const patched = patchStatuslineSettings(settings, deps.wrapperCommand);
  // The record is the only copy of the user's previous status line. Writing it
  // after the settings would lose that command for good if the process died in
  // between: a second setup then sees its own marker, records no previous
  // command, and uninstall would delete the status line outright.
  const record = existingRecord ?? { previousStatusLine: patched.previous, marker: STATUSLINE_MARKER };
  await deps.writeInstallRecord(record);
  if (patched.changed) await deps.writeSettings(patched.settings);
  try {
    await deps.installScheduler();
    // The scheduler is the whole supervisor. A setup that patched the settings
    // but registered no task must not look like a success.
    const scheduler = await deps.schedulerStatus();
    if (scheduler?.registered !== true) throw new Error('scheduler did not register');
  } catch (error) {
    // Otherwise the status line stays hijacked by a supervisor that will never
    // run, and the next setup would see its own marker and record no previous
    // command — losing the user's original status line for good.
    if (!existingRecord) {
      if (patched.changed) await deps.writeSettings(settings);
      await deps.removeInstallRecord();
    }
    throw error;
  }
  return { code: existingRecord ? 'action:supervisor-repaired' : 'action:supervisor-installed' };
}

export async function uninstallSupervisor(deps) {
  await deps.uninstallScheduler();
  const record = await deps.readInstallRecord();
  if (!record) return { code: 'skip:supervisor-not-installed' };
  const settings = await deps.readSettings();
  const restored = restoreStatuslineSettings(settings, record.previousStatusLine);
  if (JSON.stringify(restored) !== JSON.stringify(settings)) await deps.writeSettings(restored);
  await deps.removeInstallRecord();
  return { code: 'action:supervisor-uninstalled' };
}

export async function statusSupervisor(deps) {
  const record = await deps.readInstallRecord();
  const scheduler = await deps.schedulerStatus();
  return { installed: Boolean(record) && scheduler?.registered === true, scheduler, record };
}

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomUUID()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

async function copyStableDirectory(source, target) {
  const staged = `${target}.tmp-${randomUUID()}`;
  const previous = `${target}.previous`;
  await rm(staged, { recursive: true, force: true });
  await cp(source, staged, { recursive: true, force: false, errorOnExist: true });
  await Promise.all([access(join(staged, 'supervisor.mjs')), access(join(staged, 'statusline-wrapper.mjs'))]);
  await rm(previous, { recursive: true, force: true });
  try { await rename(target, previous); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    await rename(staged, target);
  } catch (error) {
    try { await rename(previous, target); } catch {}
    throw error;
  }
  await rm(previous, { recursive: true, force: true });
}

function quote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

// The task is registered for one user, so the trigger and the principal need a
// name Task Scheduler can resolve. USERDOMAIN is absent on a workgroup machine,
// where the bare account name resolves.
function windowsUserId() {
  const name = process.env.USERNAME ?? userInfo().username;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${name}` : name;
}

export function createInstallDeps(options) {
  const dataRoot = options.dataRoot;
  const stableRoot = join(dataRoot, 'worker');
  const recordPath = join(dataRoot, 'install.json');
  const chainPath = join(dataRoot, 'statusline-chain.json');
  const settingsPath = options.settingsPath ?? join(homedir(), '.claude', 'settings.json');
  const platform = options.platform ?? process.platform;
  const adapter = platformAdapter(platform, {
    writeFile: async (path, content, encoding) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, encoding);
    },
    unlink: async (path) => rm(path, { force: true }),
    execFile: async (file, args, execOptions = {}) => {
      try { return await execFileAsync(file, args, { windowsHide: true }); } catch (error) {
        if (execOptions.allowFailure) return { error };
        throw error;
      }
    },
  });
  const nodePath = options.nodePath ?? process.execPath;
  const workerPath = join(stableRoot, 'supervisor.mjs');
  const schedulerValues = platform === 'darwin'
    ? {
      nodePath, workerPath, dataRoot,
      plistPath: join(homedir(), 'Library', 'LaunchAgents', 'com.afk.supervisor.plist'),
      stdoutPath: '/dev/null',
      stderrPath: '/dev/null',
    }
    : {
      nodePath, workerPath, dataRoot,
      userId: options.userId ?? windowsUserId(),
      taskXmlPath: join(dataRoot, 'afk-supervisor-task.xml'),
    };
  const wrapperCommand = `${quote(nodePath)} ${quote(join(stableRoot, 'statusline-wrapper.mjs'))} --root ${quote(dataRoot)}`;

  return {
    dataRoot, stableRoot, sourceRoot: options.sourceRoot, wrapperCommand,
    copyStable: copyStableDirectory,
    verifyStable: async (root) => Promise.all([access(join(root, 'supervisor.mjs')), access(join(root, 'statusline-wrapper.mjs'))]),
    installScheduler: () => adapter.installScheduler(schedulerValues),
    uninstallScheduler: () => adapter.uninstallScheduler(schedulerValues),
    schedulerStatus: () => adapter.queryScheduler(schedulerValues),
    readSettings: () => readJson(settingsPath, {}),
    writeSettings: (settings) => atomicJson(settingsPath, settings),
    readInstallRecord: () => readJson(recordPath, null),
    async writeInstallRecord(record) {
      await atomicJson(recordPath, record);
      await atomicJson(chainPath, { previousCommand: record.previousStatusLine?.command ?? null });
    },
    async removeInstallRecord() {
      await Promise.all([rm(recordPath, { force: true }), rm(chainPath, { force: true })]);
    },
  };
}
