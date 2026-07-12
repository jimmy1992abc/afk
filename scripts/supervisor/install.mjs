import { execFile as execFileCallback } from 'node:child_process';
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

import { platformAdapter } from './platform.mjs';

const execFileAsync = promisify(execFileCallback);
export const STATUSLINE_MARKER = '--afk-supervisor:1';

export function validateClaudeStatus(claudePath, statusJson) {
  if (!isAbsolute(claudePath) || !/^claude(?:\.exe)?$/i.test(basename(claudePath))) {
    throw new Error('standalone Claude CLI path invalid');
  }
  let status;
  try { status = JSON.parse(statusJson); } catch { throw new Error('Claude authentication status invalid'); }
  if (status.loggedIn !== true) throw new Error('Claude authentication missing');
  return { claudePath, authenticated: true };
}

export async function preflightClaude(platform = process.platform) {
  const locator = platform === 'win32' ? ['where.exe', ['claude.exe']] : ['which', ['claude']];
  const located = await execFileAsync(locator[0], locator[1], { windowsHide: true });
  const claudePath = located.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!claudePath) throw new Error('standalone Claude CLI missing');
  const status = await execFileAsync(claudePath, ['auth', 'status', '--json'], { windowsHide: true, maxBuffer: 1024 * 1024 });
  return validateClaudeStatus(claudePath, status.stdout);
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
  if (patched.changed) await deps.writeSettings(patched.settings);
  const record = existingRecord ?? { previousStatusLine: patched.previous, marker: STATUSLINE_MARKER };
  await deps.writeInstallRecord(record);
  await deps.installScheduler();
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

export async function repairSupervisor(deps) {
  return installSupervisor(deps);
}

export async function statusSupervisor(deps) {
  const record = await deps.readInstallRecord();
  return { installed: Boolean(record), scheduler: await deps.schedulerStatus(), record };
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
  await Promise.all([access(join(staged, 'supervisor.mjs')), access(join(staged, 'runner.mjs'))]);
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
      nodePath, workerPath,
      plistPath: join(homedir(), 'Library', 'LaunchAgents', 'com.afk.supervisor.plist'),
      stdoutPath: '/dev/null',
      stderrPath: '/dev/null',
    }
    : { nodePath, workerPath, taskXmlPath: join(dataRoot, 'afk-supervisor-task.xml') };
  const wrapperCommand = `${quote(nodePath)} ${quote(join(stableRoot, 'statusline-wrapper.mjs'))} --root ${quote(dataRoot)}`;

  return {
    dataRoot, stableRoot, sourceRoot: options.sourceRoot, wrapperCommand,
    copyStable: copyStableDirectory,
    verifyStable: async (root) => Promise.all([access(join(root, 'supervisor.mjs')), access(join(root, 'runner.mjs'))]),
    installScheduler: () => adapter.installScheduler(schedulerValues),
    uninstallScheduler: () => adapter.uninstallScheduler(schedulerValues),
    schedulerStatus: async () => ({ platform: adapter.name, intervalSeconds: adapter.intervalSeconds }),
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
