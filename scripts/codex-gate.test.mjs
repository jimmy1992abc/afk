// Characterization tests: pin codex-gate's observable contract BEFORE the shared
// lib extraction, so the migration is verified behaviour-preserving rather than
// believed to be. Assertions here must survive the refactor unchanged.
//
// Every test terminates at a local check. None may reach the real `codex`
// binary: that call is metered, and a test suite is not a place to spend it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'node:test';

const repoRoot = new URL('..', import.meta.url);
const GATE = 'skills/afk-codex-review/codex-gate.mjs';

function runGate({ args = [], env = {} } = {}) {
  return spawnSync(process.execPath, [GATE, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function withTempLock(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-gate-test-'));
  try {
    return fn(join(dir, 'probe.lock'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withDesignDoc(text, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-gate-design-'));
  try {
    const path = join(dir, 'spec.md');
    writeFileSync(path, text);
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('codex gate disabled flag emits a clean skipped review', () => {
  const result = runGate({ args: ['--base', 'main'], env: { CODEX_REVIEW_GATE: 'off' } });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /===== CODEX REVIEW \(final message\) =====/);
  assert.match(result.stdout, /SKIPPED: Codex gate disabled via CODEX_REVIEW_GATE\./);
  assert.match(result.stdout, /===== END CODEX REVIEW =====/);
});

test('codex gate honours every documented opt-out spelling', () => {
  for (const value of ['off', '0', 'false', 'no', 'disabled', 'OFF', ' Off ']) {
    const result = runGate({ args: ['--base', 'main'], env: { CODEX_REVIEW_GATE: value } });
    assert.equal(result.status, 0, `${value}: ${result.stderr}`);
    assert.match(result.stdout, /SKIPPED: Codex gate disabled/, `value ${JSON.stringify(value)}`);
  }
});

test('codex gate selftest acquires and releases its lock', () => {
  withTempLock((lockPath) => {
    const result = runGate({
      args: ['--selftest-lock'],
      env: { CODEX_GATE_LOCK_PATH: lockPath },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /selftest: acquired=true/);
    assert.match(result.stderr, /selftest: released/);
  });
});

test('codex gate lock can be disabled', () => {
  withTempLock((lockPath) => {
    const result = runGate({
      args: ['--selftest-lock'],
      env: { CODEX_GATE_LOCK_PATH: lockPath, CODEX_GATE_NO_LOCK: '1' },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /selftest: acquired=false/);
  });
});

// The tests above pin early-exit paths only: the disabled skip returns before
// the base is ever resolved, so none of them could catch a regression in the
// extracted target/base code. --print-args makes that surface observable
// without spending a metered call.

test('codex gate resolves and forwards a promoted base when none is given', () => {
  const result = runGate({ args: ['--print-args'] });

  assert.equal(result.status, 0, result.stderr);
  const { args, hasExplicitTarget } = JSON.parse(result.stdout);
  assert.equal(hasExplicitTarget, false);
  // This repo has origin/main, so the bare default must be promoted to it.
  // Diffing a possibly-stale local ref is the defect this PR fixes.
  assert.equal(args[args.indexOf('--base') + 1], 'origin/main');
});

test('codex gate leaves an explicit non-base target untouched', () => {
  const result = runGate({ args: ['--commit', 'HEAD', '--print-args'] });

  const { args, hasExplicitTarget } = JSON.parse(result.stdout);
  assert.equal(hasExplicitTarget, true);
  assert.equal(args.includes('--base'), false, 'must not add a base beside an explicit target');
  assert.equal(args[args.indexOf('--commit') + 1], 'HEAD');
});

test('codex gate promotes an operator-supplied base, not just the detected one', () => {
  // Promoting only the auto-detected default would leave `--base main` bare
  // here while the other three gates promote it — the same wrong-commit-range
  // defect, surviving on the explicit path.
  const result = runGate({ args: ['--base', 'main', '--print-args'] });

  const { args } = JSON.parse(result.stdout);
  assert.equal(args[args.indexOf('--base') + 1], 'origin/main');
});

test('codex gate keeps its lean-context overrides ahead of passthrough flags', () => {
  // Codex applies later -c overrides last, so an operator's own -c must win.
  const result = runGate({ args: ['--commit', 'HEAD', '-c', 'model_reasoning_effort=high', '--print-args'] });

  const { args } = JSON.parse(result.stdout);
  const efforts = args.filter((a) => String(a).startsWith('model_reasoning_effort='));
  assert.deepEqual(efforts, ['model_reasoning_effort=medium', 'model_reasoning_effort=high']);
});

test('codex gate does not forward --print-args to codex', () => {
  const result = runGate({ args: ['--commit', 'HEAD', '--print-args'] });
  const { args } = JSON.parse(result.stdout);
  assert.equal(args.includes('--print-args'), false);
});

// ── design mode ─────────────────────────────────────────────────────────────
// The read-only argv shape is the load-bearing invariant: `exec -s read-only`,
// never the `review`+bypass path (which has no `-s` and would run full-access on
// Windows). The runtime read-only sandbox is verified by hermetic probe, not
// here; this pins the argv it rests on.

test('codex design mode uses exec -s read-only, never review or the bypass', () => {
  withDesignDoc('# Spec\n\nA claim.\n', (path) => {
    const result = runGate({ args: ['--design', path, '--print-args'] });
    assert.equal(result.status, 0, result.stderr);
    const { args } = JSON.parse(result.stdout);

    assert.equal(args[0], 'exec');
    assert.equal(args[args.indexOf('-s') + 1], 'read-only', 'the read-only sandbox must be pinned');
    assert.equal(args.includes('review'), false, 'design mode must never take the review subcommand');
    assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false, 'design mode never bypasses the sandbox');
    // The payload rides on stdin (positional `-`), never as a diff selector.
    assert.equal(args.includes('-'), true, 'the stdin positional must be present');
    assert.equal(args.includes('--base'), false);
    assert.equal(args.includes('--commit'), false);
  });
});

test('codex design mode overrides any stray diff selector', () => {
  withDesignDoc('# Spec\n', (path) => {
    const result = runGate({ args: ['--design', path, '--base', 'main', '--commit', 'abc123', '--print-args'] });
    assert.equal(result.status, 0, result.stderr);
    const { args } = JSON.parse(result.stdout);
    assert.equal(args.includes('review'), false);
    assert.equal(args.includes('--base'), false, 'design overrides --base');
    assert.equal(args.includes('--commit'), false, 'design overrides --commit');
    assert.equal(args[args.indexOf('-s') + 1], 'read-only');
  });
});

test('codex design payload rides on stdin, not the argv — past the Windows limit', () => {
  // A real design doc is diff-sized or larger. Passed as an argv positional it
  // would hit the Windows ~8191-char command-line limit and fail the run; codex
  // reads the prompt from stdin when the positional is `-`.
  const marker = 'UNIQUE_DESIGN_MARKER_9c1f';
  const big = `# Spec\n\n${marker}\n${'x'.repeat(20000)}\n`;
  withDesignDoc(big, (path) => {
    const result = runGate({ args: ['--design', path, '--print-args'] });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.stdinBytes > 8191, `payload (${parsed.stdinBytes}B) must exceed the Windows argv limit`);
    assert.equal(parsed.promptOnStdin, true);
    // The doc content must NOT be anywhere in the argv.
    assert.equal(parsed.args.join(' ').includes(marker), false, 'the doc must not leak into argv');
    assert.equal(parsed.args.includes('-'), true);
  });
});

test('codex design mode fails loudly on a missing doc, never a skip', () => {
  const missing = join(tmpdir(), 'codex-gate-no-such-design-xyz.md');
  const result = runGate({ args: ['--design', missing] });
  assert.notEqual(result.status, 0, 'a typo\'d design path must fail, not skip');
  assert.match(result.stdout, /ERROR: cannot review/);
  assert.match(result.stdout, /--design/);
  assert.doesNotMatch(result.stdout, /SKIPPED/);
});

test('codex design mode: an unavailable reviewer skips and proceeds (Decision 6 asymmetry)', () => {
  // The other half of the asymmetry: a missing doc is operator error (fails
  // loud), but an unavailable reviewer degrades through — a skipped design gate
  // is recorded and the waterfall proceeds. A disabled gate is the deterministic
  // stand-in for "no qualifying reviewer".
  withDesignDoc('# Spec\n', (path) => {
    const result = runGate({ args: ['--design', path], env: { CODEX_REVIEW_GATE: 'off' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SKIPPED: Codex gate disabled/);
    assert.doesNotMatch(result.stdout, /ERROR/);
  });
});

test('codex gate opt-out is checked before the lock selftest', () => {
  // Pins the ordering: the disabled check short-circuits everything downstream,
  // so an operator who turned the gate off pays for nothing.
  withTempLock((lockPath) => {
    const result = runGate({
      args: ['--selftest-lock'],
      env: { CODEX_GATE_LOCK_PATH: lockPath, CODEX_REVIEW_GATE: 'off' },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SKIPPED: Codex gate disabled/);
    assert.doesNotMatch(result.stderr, /selftest: acquired/);
  });
});
