import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { prepareGateProfileNotice } from './gate-profile-notice.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'gate-profile-notice.mjs');
const PLUGIN_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

function withAfk(config, fn) {
  const root = mkdtempSync(join(tmpdir(), 'afk-gate-profile-'));
  const afkDir = join(root, '.afk');
  mkdirSync(afkDir, { recursive: true });
  if (config !== null) writeFileSync(join(afkDir, 'config.md'), config, 'utf8');
  try {
    return fn(afkDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('shared resolver emits and receipts a legacy-profile notice once', () => {
  withAfk('## external gate\nmin-pass: 1\n', (afkDir) => {
    const first = prepareGateProfileNotice({ afkDir, pluginRoot: ROOT, env: {} });
    assert.match(first.notice, /legacy gate profile/i);
    assert.throws(() => readFileSync(join(afkDir, 'gate-profile-notice.json'), 'utf8'));
    first.commit();
    assert.equal(prepareGateProfileNotice({ afkDir, pluginRoot: ROOT, env: {} }).notice, '');
    const receipt = JSON.parse(readFileSync(join(afkDir, 'gate-profile-notice.json'), 'utf8'));
    assert.equal(receipt.version, PLUGIN_VERSION);
    assert.match(receipt.signature, /^[a-f0-9]{64}$/);
  });
});

test('CLI and imported resolver honor the same receipt', () => {
  withAfk('## external gate\ndesign-gate: risky\n', (afkDir) => {
    const run = spawnSync(process.execPath, [CLI, '--afk-dir', afkDir, '--plugin-root', ROOT], {
      encoding: 'utf8',
      env: { ...process.env, AFK_GATE_PROFILE_NOTICE: '' },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /default single external review/i);
    assert.match(run.stdout, /`gates: codex`/);
    assert.match(run.stdout, /-codex -kimi/, 'the notice names the per-handoff opt-in channel');
    assert.doesNotMatch(run.stdout, /two sequential external reviews/i);
    assert.equal(prepareGateProfileNotice({ afkDir, pluginRoot: ROOT, env: {} }).notice, '');
  });
});

test('explicit gates and the opt-out stay silent without a receipt', () => {
  withAfk('## external gate\ngates: codex > kimi\n', (afkDir) => {
    assert.equal(prepareGateProfileNotice({ afkDir, pluginRoot: ROOT, env: {} }).notice, '');
  });
  withAfk('## external gate\nmin-pass: 1\n', (afkDir) => {
    assert.equal(prepareGateProfileNotice({
      afkDir,
      pluginRoot: ROOT,
      env: { AFK_GATE_PROFILE_NOTICE: 'off' },
    }).notice, '');
  });
});

test('hook, afk-init, and kickoff all name the shared implementation', () => {
  for (const relative of [
    '../hooks/afk-resume-detect.mjs',
    '../skills/afk-init/SKILL.md',
    '../skills/afk/SKILL.md',
  ]) {
    const text = readFileSync(join(ROOT, 'scripts', relative), 'utf8');
    assert.match(text, /gate-profile-notice\.mjs/, relative);
  }
});
