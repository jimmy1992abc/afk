import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import {
  createReviewFixture, gateTestEnv, pathKey, spawnGate, stubPath, tempEnv,
} from './gate-test-env.mjs';

const fixture = createReviewFixture();
after(fixture.cleanup);
const TEST_COMMIT = fixture.commit;

test('gate test environment removes ambient gate configuration', () => {
  const result = gateTestEnv({}, {
    KEEP: 'yes',
    AFK_REVIEW_TIMEOUT_MS: '1',
    CLAUDE_REVIEW_TIMEOUT_MS: '2',
    CODEX_REVIEW_TIMEOUT_MS: '3',
    DEEPSEEK_REVIEW_TIMEOUT_MS: '3',
    GLM_REVIEW_TIMEOUT_MS: '4',
    KIMI_REVIEW_TIMEOUT_MS: '5',
    MIMO_REVIEW_TIMEOUT_MS: '6',
    CODEX_REVIEW_MODEL: 'ambient-model',
    CODEX_REVIEW_GATE: 'off',
    CLAUDECODE: '1',
    DEEPSEEK_REVIEW_API_KEY: 'ambient-key',
    DEV_DEEPSEEK_API_KEY: 'ambient-key',
    DEV_MIMO_API_KEY: 'ambient-key',
    MIMO_REVIEW_API_KEY: 'ambient-key',
    ZAI_API_KEY: 'ambient-key',
  });
  assert.deepEqual(result, { KEEP: 'yes', AFK_GATE_NO_DOTENV: '1' });
});

test('explicit test overrides are applied after ambient cleanup', () => {
  const result = gateTestEnv(
    { KIMI_REVIEW_TIMEOUT_MS: '1234' },
    { KIMI_REVIEW_TIMEOUT_MS: '9999' },
  );
  assert.equal(result.KIMI_REVIEW_TIMEOUT_MS, '1234');
});

test('spawnGate names a gate that never exits instead of returning empty output', () => {
  // The failure this converts: a hung gate returned status null and stdout '',
  // every assertion then read as "the gate printed nothing", and the run itself
  // never finished so nothing was reported at all.
  assert.throws(
    () => spawnGate(['-e', 'setInterval(() => {}, 60000);'], { encoding: 'utf8', timeout: 300 }),
    /did not exit within 300ms/,
  );
});

test('spawnGate passes a normal gate result straight through', () => {
  const res = spawnGate(['-e', 'process.stdout.write("verdict");'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, 'verdict');
});

test('stubPath removes any directory that could resolve the CLI ahead of the stub', () => {
  // The Windows shim tests are only meaningful if the stub is the ONLY way to
  // resolve the name: `resolveCliBin` is extension-major, so a real `kimi.exe`
  // anywhere later on PATH correctly returns the bare name and the gate spawns
  // the real, metered CLI instead of the stub. That is the reference machine
  // from issue #12 ("that machine had a kimi.exe"), i.e. exactly where these
  // tests run.
  const stub = mkdtempSync(join(tmpdir(), 'stubpath-stub-'));
  const real = mkdtempSync(join(tmpdir(), 'stubpath-real-'));
  const other = mkdtempSync(join(tmpdir(), 'stubpath-other-'));
  try {
    writeFileSync(join(stub, 'kimi.cmd'), '');
    writeFileSync(join(real, 'kimi.exe'), '');
    writeFileSync(join(other, 'git'), '');

    const key = pathKey({ PATH: '' });
    const built = stubPath(stub, 'kimi', { PATH: [real, other].join(delimiter) });
    const entries = built[key].split(delimiter);

    assert.equal(entries[0], stub, 'the stub directory must come first');
    assert.ok(!entries.includes(real), 'a directory holding kimi.exe must be dropped');
    assert.ok(entries.includes(other), 'unrelated entries stay — the gates still need git');
  } finally {
    for (const dir of [stub, real, other]) rmSync(dir, { recursive: true, force: true });
  }
});

// ── every outcome is a parseable block, including a broken environment ───────

test('a gate whose temp root does not exist still emits a marker block', () => {
  // A stale TMPDIR export, a cleaned-up per-session temp dir, a locked-down CI
  // image: `mkdtempSync` throws ENOENT at module top level and the gate exits
  // with a raw stack. A driver parsing stdout gets silence, which it cannot
  // classify as a verdict, a skip, or an error — the one thing the marker
  // protocol exists to prevent.
  // Derived, never a fixed name: a leftover directory from an earlier probe
  // would make mkdtemp SUCCEED and the whole test measure nothing. Creating one
  // and removing it yields a path this run knows is absent.
  const missing = mkdtempSync(join(tmpdir(), 'afk-absent-temp-root-'));
  rmSync(missing, { recursive: true, force: true });
  // Every gate spawn in this suite must be unable to reach a metered review.
  // Here the ONLY thing standing between the test and three paid reviews would
  // be mkdtemp failing, so the bins are pinned too: a path that cannot exist
  // for the two gates that reach mkdtemp before any preflight, and node itself
  // for kimi, whose availability probe runs FIRST and would otherwise skip out
  // on a machine with no CLI installed — which is every CI runner.
  const unusable = join(missing, 'not-a-cli');
  const cases = [
    ['KIMI', 'skills/afk-kimi-review/kimi-gate.mjs', { KIMI_GATE_BIN: process.execPath }],
    ['CLAUDE', 'skills/afk-claude-review/claude-gate.mjs', { CLAUDE_GATE_BIN: unusable }],
    ['CODEX', 'skills/afk-codex-review/codex-gate.mjs', { CODEX_GATE_BIN: unusable }],
  ];
  for (const [label, gate, bin] of cases) {
    const gatePath = fileURLToPath(new URL(`../${gate}`, import.meta.url));
    const res = spawnGate([gatePath, '--commit', TEST_COMMIT, '--implementer', 'glm'], {
      cwd: fixture.cwd,
      encoding: 'utf8',
      // tempEnv, not literal keys: Windows spells these `Temp`, and gateTestEnv
      // merges by EXACT key, so an override would sit beside the inherited value
      // rather than replacing it — the hazard pathKey() already exists for.
      env: gateTestEnv({ ...tempEnv(missing), ...bin }),
    });

    // A SKIPPED block satisfies the marker assertions, so the ERROR is what
    // actually carries this test — a skip here would mean the gate never
    // reached the work directory at all.
    assert.match(res.stdout, new RegExp(`===== ${label} REVIEW`), `${label}: ${res.stderr}`);
    assert.match(res.stdout, /ERROR: /, `${label} must report, not throw`);
    assert.doesNotMatch(res.stdout, /SKIPPED/, `${label} must reach the work directory`);
    assert.match(res.stdout, /TMPDIR/, `${label} must name the variable to fix`);
    assert.match(res.stdout, new RegExp(`===== END ${label} REVIEW =====`), label);
    assert.doesNotMatch(res.stderr, /at mkdtempSync|node:fs:/, `${label} must not print a stack`);
    assert.notEqual(res.status, 0, label);
  }
});
