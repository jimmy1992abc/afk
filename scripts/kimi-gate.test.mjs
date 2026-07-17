// Characterization tests: pin kimi-gate's observable contract BEFORE the shared
// lib extraction, so the migration is verified behaviour-preserving rather than
// believed to be. Assertions here must survive the refactor unchanged.
//
// Every test terminates at a local check; none may reach the real `kimi` binary.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { test } from 'node:test';

const repoRoot = new URL('..', import.meta.url);
const GATE = 'skills/afk-kimi-review/kimi-gate.mjs';

function runGate({ args = [], env = {} } = {}) {
  return spawnSync(process.execPath, [GATE, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('kimi gate disabled flag emits a clean skipped review', () => {
  const result = runGate({ args: ['--base', 'main'], env: { KIMI_REVIEW_GATE: 'off' } });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /===== KIMI REVIEW \(final message\) =====/);
  assert.match(result.stdout, /SKIPPED: Kimi gate disabled via KIMI_REVIEW_GATE\./);
  assert.match(result.stdout, /===== END KIMI REVIEW =====/);
});

test('kimi gate honours every documented opt-out spelling', () => {
  for (const value of ['off', '0', 'false', 'no', 'disabled', 'OFF', ' Off ']) {
    const result = runGate({ args: ['--base', 'main'], env: { KIMI_REVIEW_GATE: value } });
    assert.equal(result.status, 0, `${value}: ${result.stderr}`);
    assert.match(result.stdout, /SKIPPED: Kimi gate disabled/, `value ${JSON.stringify(value)}`);
  }
});

// The tests above pin early-exit paths only and could not catch a regression in
// the extracted target/base code. --print-args makes that surface observable.

test('kimi gate resolves the default base to its promoted remote ref', () => {
  const result = runGate({ args: ['--print-args'] });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.kind, 'branch');
  // Previously kimi diffed the bare local ref, so a stale local main made it
  // review the wrong commit range. This PR promotes it.
  assert.equal(parsed.base, 'origin/main');
  assert.equal(parsed.command, 'git diff origin/main...HEAD');
});

test('kimi gate tells its reviewer to go looking, unlike the tool-less gate', () => {
  // kimi HAS tools; glm does not. The context clause is per-gate for exactly
  // this reason, so a shared prompt must never flatten the difference.
  const result = runGate({ args: ['--commit', 'HEAD', '--print-args'] });
  const { promptBytes, command } = JSON.parse(result.stdout);
  assert.ok(promptBytes > 0);
  assert.equal(command, 'git show HEAD');
});

test('kimi gate opt-out short-circuits before any target resolution', () => {
  // An unresolvable target must not turn a disabled gate into an error: the
  // opt-out is checked first, so the operator pays nothing.
  const result = runGate({
    args: ['--base', 'no-such-branch-xyz'],
    env: { KIMI_REVIEW_GATE: 'off' },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SKIPPED: Kimi gate disabled/);
});
