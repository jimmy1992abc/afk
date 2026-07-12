import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConfigStore, defaultConfig, validateConfig } from '../../scripts/supervisor/config.mjs';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'afk-supervisor-config-'));
}

test('an absent config file yields the defaults', async () => {
  assert.deepEqual(await new ConfigStore(await tempRoot()).read(), defaultConfig());
});

test('validation fills unknown gaps from the defaults', () => {
  const config = validateConfig({ thresholdPercentage: 80 });
  assert.equal(config.thresholdPercentage, 80);
  assert.equal(config.pollIntervalSeconds, defaultConfig().pollIntervalSeconds);
});

test('every enumerated setting rejects a value outside its set', () => {
  assert.throws(() => validateConfig({ enabled: 'yes' }), /enabled must be boolean/);
  assert.throws(() => validateConfig({ claudePath: 7 }), /claudePath/);
  assert.throws(() => validateConfig({ windowMode: 'sometimes' }), /windowMode/);
  assert.throws(() => validateConfig({ catchUpMode: 'maybe' }), /catchUpMode/);
  assert.throws(() => validateConfig({ activeRunRecovery: 'partly' }), /activeRunRecovery/);
});

test('a null Claude path is accepted but a non-string one is not', () => {
  assert.equal(validateConfig({ claudePath: null }).claudePath, null);
  assert.equal(validateConfig({ claudePath: 'C:\\Tools\\claude.exe' }).claudePath, 'C:\\Tools\\claude.exe');
});

test('every numeric setting must be a positive integer', () => {
  const numeric = [
    'thresholdPercentage', 'thresholdJitterMinSeconds', 'thresholdJitterMaxSeconds',
    'graceSeconds', 'heartbeatStaleSeconds', 'overdueAutoActivationSeconds',
    'maxWindowActivationsPer24Hours', 'sevenDaySuppressionPercentage', 'maxRecoveryAttempts',
    'maxConsecutiveQuotaRejections', 'quotaEscalationBaseSeconds', 'quotaEscalationMaxSeconds',
    'recoveryAttemptTimeoutSeconds', 'leaseRenewalSeconds', 'leaseMissedRenewals',
    'maxConcurrentInvocations', 'pollIntervalSeconds', 'terminalRunRetentionSeconds',
    'registrationRecoveryMaxAgeSeconds',
  ];
  for (const key of numeric) {
    for (const bad of [0, -1, 1.5, '60', null]) {
      assert.throws(() => validateConfig({ [key]: bad }), new RegExp(key), `${key} accepted ${JSON.stringify(bad)}`);
    }
  }
});

test('percentages cannot exceed one hundred', () => {
  assert.throws(() => validateConfig({ thresholdPercentage: 101 }), /at most 100/);
  assert.throws(() => validateConfig({ sevenDaySuppressionPercentage: 101 }), /at most 100/);
});

test('an inverted range is rejected rather than silently swapped', () => {
  assert.throws(() => validateConfig({ thresholdJitterMinSeconds: 200, thresholdJitterMaxSeconds: 100 }), /jitter range/);
  assert.throws(() => validateConfig({ quotaEscalationBaseSeconds: 200, quotaEscalationMaxSeconds: 100 }), /escalation range/);
});

test('a written config round-trips and an invalid one is never persisted', async () => {
  const root = await tempRoot();
  const store = new ConfigStore(root);
  await store.write({ ...defaultConfig(), windowMode: 'auto' });
  assert.equal((await store.read()).windowMode, 'auto');
  await assert.rejects(() => store.write({ ...defaultConfig(), windowMode: 'nope' }), /windowMode/);
  assert.equal((await store.read()).windowMode, 'auto');
});

test('a corrupt config file surfaces rather than silently reverting to defaults', async () => {
  const root = await tempRoot();
  await writeFile(join(root, 'config.json'), '{ not json');
  await assert.rejects(() => new ConfigStore(root).read());
});

test('a config file is written without world-readable secrets in its path', async () => {
  const root = await tempRoot();
  const store = new ConfigStore(root);
  await store.write(defaultConfig());
  const raw = await readFile(join(root, 'config.json'), 'utf8');
  assert.deepEqual(JSON.parse(raw), defaultConfig());
});
