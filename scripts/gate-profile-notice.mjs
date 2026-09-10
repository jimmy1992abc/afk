#!/usr/bin/env node
// One implementation for the ordered-gate migration/cost notice. SessionStart,
// afk-init, and afk kickoff all use this resolver and receipt format.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { hasConfigKeyInSection, readConfigSectionValue } from '../lib/config.mjs';
import { isGateDisabled } from '../lib/gate/env.mjs';

const PROFILE_KEYS = ['priority', 'min-pass', 'mode', 'design-gate', 'implementer'];

function pluginVersion(pluginRoot) {
  try {
    return JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) return '';
  return String(argv[index + 1] || '').trim();
}

function noNotice() {
  return { notice: '', commit() {} };
}

export function prepareGateProfileNotice({
  afkDir,
  pluginRoot,
  env = process.env,
} = {}) {
  if (!afkDir || isGateDisabled('AFK_GATE_PROFILE_NOTICE', env)) return noNotice();

  const configPath = join(afkDir, 'config.md');
  const receiptPath = join(afkDir, 'gate-profile-notice.json');
  const section = 'external gate';
  if (hasConfigKeyInSection(configPath, section, 'gates')) return noNotice();

  const values = Object.fromEntries(
    PROFILE_KEYS.map((key) => [key, readConfigSectionValue(configPath, section, key)]),
  );
  const present = Object.fromEntries(
    PROFILE_KEYS.map((key) => [key, hasConfigKeyInSection(configPath, section, key)]),
  );
  const version = pluginVersion(pluginRoot);
  const signature = createHash('sha256')
    .update(JSON.stringify({ version, values, present }))
    .digest('hex');

  try {
    const prior = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (prior.signature === signature) return noNotice();
  } catch {
    // Missing/unreadable receipt means at-least-once notification.
  }

  const legacy = present.priority || present['min-pass'] || present.mode;
  const notice = legacy
    ? [
        `This AFK config uses a legacy gate profile (effective min-pass: ${values['min-pass'] || '1'}, mode: ${values.mode || 'waterfall'}).`,
        'Ordered roles are opt-in via a `gates:` profile at least as long as that effective min-pass:',
        '`gates: codex` (single) or `gates: codex > kimi` (ordered double).',
      ].join(' ')
    : [
        'This AFK config has no PR gate decision and uses the default single external review (`gates: codex`).',
        'For ordered double review (Codex outer + Kimi final), add `gates: codex > kimi` to .afk/config.md or pass -codex -kimi on one handoff.',
      ].join(' ');

  return {
    notice,
    commit() {
      try {
        mkdirSync(dirname(receiptPath), { recursive: true });
        const temp = `${receiptPath}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify({ signature, version }), 'utf8');
        renameSync(temp, receiptPath);
      } catch {
        // A lost receipt write costs at most one duplicate bounded notice.
      }
    },
  };
}

async function runCli(argv = process.argv.slice(2), env = process.env) {
  const pluginRoot = optionValue(argv, '--plugin-root')
    || join(dirname(fileURLToPath(import.meta.url)), '..');
  const pending = prepareGateProfileNotice({
    afkDir: optionValue(argv, '--afk-dir'),
    pluginRoot,
    env,
  });
  if (!pending.notice) return;
  await new Promise((resolve, reject) => {
    process.stdout.write(`${pending.notice}\n`, (error) => (error ? reject(error) : resolve()));
  });
  pending.commit();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runCli(); } catch { /* advisory notice never blocks AFK */ }
  process.exitCode = 0;
}
