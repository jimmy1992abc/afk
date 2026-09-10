// Characterization tests: pin kimi-gate's observable contract BEFORE the shared
// lib extraction, so the migration is verified behaviour-preserving rather than
// believed to be. Assertions here must survive the refactor unchanged.
//
// Every test terminates at a local check; none may reach the real `kimi` binary.

import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { after, test } from 'node:test';

import { createReviewFixture, gateTestEnv, spawnGate, stubPath } from './gate-test-env.mjs';

const fixture = createReviewFixture();
after(fixture.cleanup);
const TEST_COMMIT = fixture.commit;

// `--print-args` now probes the installed CLI (the argv is a function of it), so
// a dry-run test that asserts the TARGET must still be hermetic: point the gate
// at a binary that is definitively absent rather than at whatever `kimi` the
// developer happens to have on PATH.
const NO_CLI = { KIMI_GATE_BIN: join(tmpdir(), 'kimi-gate-absent-binary') };

const repoRoot = fixture.cwd;
const GATE = fileURLToPath(new URL('../skills/afk-kimi-review/kimi-gate.mjs', import.meta.url));

function runGate({ args = [], env = {} } = {}) {
  return spawnGate([GATE, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: gateTestEnv(env),
  });
}

/** The smallest help text the gate can compose today's argv from. */
const MINIMAL_HELP = 'Usage: kimi [options]\n\nOptions:\n  -p, --prompt <p>      prompt\n  --output-format <f>   format\n';

/**
 * A POSIX stub answering the two local probes — `--version` and `--help` — and
 * then running `body`. Every stub must answer both: the gate reads its flag
 * list from `--help`, so a stub that ignores it has no dialect and the gate
 * (correctly) refuses to invent one.
 */
function probeAnsweringStub(dir, body) {
  const stub = join(dir, 'kimi-stub');
  writeFileSync(stub, [
    `#!${process.execPath}`,
    'const a = process.argv;',
    "if (a.includes('--version')) { process.stdout.write('stub'); process.exit(0); }",
    `if (a.includes('--help')) { process.stdout.write(${JSON.stringify(MINIMAL_HELP)}); process.exit(0); }`,
    body,
    '',
  ].join('\n'));
  chmodSync(stub, 0o755);
  return stub;
}

function withDesignDoc(text, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-design-'));
  try {
    const path = join(dir, 'spec.md');
    writeFileSync(path, text);
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  const result = runGate({ args: ['--print-args'], env: NO_CLI });

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
  const result = runGate({ args: ['--commit', TEST_COMMIT, '--print-args'], env: NO_CLI });
  const { promptBytes, command } = JSON.parse(result.stdout);
  assert.ok(promptBytes > 0);
  assert.equal(command, `git show ${TEST_COMMIT}`);
});

test('kimi gate never exits clean on a status it could not read', () => {
  // A null status means kimi died on a signal. `?? 0` there would report a
  // killed review as a clean one; the exit expression must fail closed.
  const src = readFileSync(new URL('../skills/afk-kimi-review/kimi-gate.mjs', import.meta.url), 'utf8');
  assert.match(src, /process\.exit\(res\.status \?\? 1\)/);
  assert.doesNotMatch(src, /process\.exit\(res\.status \?\? 0\)/);
});

// ── design mode ─────────────────────────────────────────────────────────────

test('kimi design mode resolves the design kind, not a diff selector', () => {
  withDesignDoc('# Spec\n', (path) => {
    const result = runGate({ args: ['--design', path, '--print-args'], env: NO_CLI });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.kind, 'design');
    assert.equal(parsed.base, null);
    assert.equal(parsed.commit, null);
  });
});

test('kimi design mode swaps the diff "Inspect the target" clause for a design one', () => {
  withDesignDoc('# Spec\n', (path) => {
    const result = runGate({ args: ['--design', path, '--print-prompt'] });
    assert.equal(result.status, 0, result.stderr);
    const prompt = result.stdout;
    // A design brief: design verdicts and no file:line locator.
    assert.match(prompt, /SOUND WITH CONCERNS/);
    assert.doesNotMatch(prompt, /file:line/);
    // kimi HAS tools, so it is pointed at the doc on disk (reading it itself
    // keeps the large doc off the argv, unlike the diff clause's `git show`).
    assert.match(prompt, new RegExp(path.replace(/[.\\/]/g, '\\$&')));
    assert.doesNotMatch(prompt, /Inspect the target with/);
  });
});

test('kimi design mode fails loudly on a missing doc, never a skip', () => {
  const missing = join(tmpdir(), 'kimi-gate-no-such-design-xyz.md');
  const result = runGate({ args: ['--design', missing] });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /ERROR: cannot review/);
  assert.match(result.stdout, /--design/);
  assert.doesNotMatch(result.stdout, /SKIPPED/);
});

test('kimi design mode: an unavailable reviewer skips and proceeds (Decision 6 asymmetry)', () => {
  withDesignDoc('# Spec\n', (path) => {
    const result = runGate({ args: ['--design', path], env: { KIMI_REVIEW_GATE: 'off' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SKIPPED: Kimi gate disabled/);
    assert.doesNotMatch(result.stdout, /ERROR/);
  });
});

// ── review timeout ──────────────────────────────────────────────────────────
// Kimi is a general agentic CLI with no built-in bound on a turn, so a review
// that stops making progress hangs the whole run. The helper timeout is the
// only boundedness control this gate has.

test('kimi gate bounds a review by default', () => {
  const result = runGate({ args: ['--print-args'], env: NO_CLI });

  const { timeoutMs } = JSON.parse(result.stdout);
  assert.equal(timeoutMs, 45 * 60 * 1000);
});

test('kimi gate honours KIMI_REVIEW_TIMEOUT_MS', () => {
  const result = runGate({ args: ['--print-args'], env: { ...NO_CLI, KIMI_REVIEW_TIMEOUT_MS: '1000' } });

  const { timeoutMs } = JSON.parse(result.stdout);
  assert.equal(timeoutMs, 1000);
});

test('kimi gate inherits AFK_REVIEW_TIMEOUT_MS when no gate override exists', () => {
  const result = runGate({ args: ['--print-args'], env: { ...NO_CLI, AFK_REVIEW_TIMEOUT_MS: '1234' } });
  const { timeoutMs } = JSON.parse(result.stdout);
  assert.equal(timeoutMs, 1234);
});

test('kimi gate keeps the default bound when the override is unusable', () => {
  // `0` is the dangerous one: Node reads it as "no timeout", so a typo would
  // silently restore the unbounded hang this bound exists to prevent.
  for (const value of ['0', '-1', 'abc']) {
    const result = runGate({ args: ['--print-args'], env: { ...NO_CLI, KIMI_REVIEW_TIMEOUT_MS: value } });
    const { timeoutMs } = JSON.parse(result.stdout);
    assert.equal(timeoutMs, 45 * 60 * 1000, JSON.stringify(value));
    assert.match(result.stderr, /KIMI_REVIEW_TIMEOUT_MS/, JSON.stringify(value));
  }
});

test('a kimi review that never returns ends as a non-zero ERROR, not silence', {
  // A POSIX shebang stub; the Windows launcher path cannot run one.
  skip: process.platform === 'win32' ? 'needs a POSIX executable stub' : false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-hang-'));
  try {
    const stub = probeAnsweringStub(dir, "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000);");

    const result = runGate({
      args: ['--commit', TEST_COMMIT],
      env: { KIMI_GATE_BIN: stub, KIMI_REVIEW_TIMEOUT_MS: '2000' },
    });

    // A hang is transient, not a reviewer that is unavailable: it must not exit
    // 0 as a SKIPPED, which the driver reads as "fall back to another family"
    // rather than "retry this role once".
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /===== KIMI REVIEW \(final message\) =====/);
    assert.match(result.stdout, /ERROR: .*timed out after 2s/);
    assert.match(result.stdout, /KIMI_REVIEW_TIMEOUT_MS/);
    assert.doesNotMatch(result.stdout, /SKIPPED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the prompt never rides in argv under a shell', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  // The invariant behind three deaths, all verified against the real CLI:
  // (1) Node concatenates argv UNESCAPED under a shell (DEP0190), so cmd.exe
  // split the multi-word prompt and Kimi read its second word as a subcommand
  // (`No such command 'are'`, exit 2); (2) there is no stdin transport to move
  // it to (`--input-format` does not exist); (3) flags invented from a newer
  // build's help text are rejected outright. So: prompt in argv, no shell — and
  // under a shell, a file reference instead of the payload.
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-shape-'));
  const bin = posixStub(dir, strictStub(dir, {}));
  const result = runGate({ args: ['--print-args'], env: { KIMI_GATE_BIN: bin } });
  rmSync(dir, { recursive: true, force: true });

  const {
    transport, shell, args, fallback, promptBytes,
  } = JSON.parse(result.stdout);
  assert.equal(transport, 'argv');
  assert.equal(shell, false, 'a shell with a payload in argv is the bug itself');
  assert.ok(promptBytes > 100);
  assert.deepEqual(args.filter((a) => a.length < 40), ['-p', '--output-format', 'text']);

  // The shim fallback is the only shelled path. Its argv may carry a quotable
  // one-line instruction, but never the brief: cmd.exe cannot carry a multi-line
  // value even quoted, and this CLI has nowhere else to put it.
  assert.equal(fallback.transport, 'brief-file');
  assert.deepEqual(fallback.args.filter((a) => a.length < 40), ['-p', '--output-format', 'text']);
  const instruction = fallback.args[fallback.args.indexOf('-p') + 1];
  assert.doesNotMatch(instruction, /\n/, 'a multi-line argv element cannot survive cmd.exe');
  assert.ok(instruction.length < promptBytes / 2, 'the brief must not be in argv');
  assert.match(instruction, /review only/i, 'the read-only clause must not depend on the file being read');
});

test('the stub reviewer receives the whole prompt, verbatim', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-transport-'));
  try {
    const record = join(dir, 'record.json');
    const bin = posixStub(dir, strictStub(dir, { record }));

    const result = runGate({ args: ['--commit', TEST_COMMIT], env: { KIMI_GATE_BIN: bin } });

    assert.match(result.stdout, /STUB REVIEW: APPROVE — no findings/, result.stderr);
    const { argv } = JSON.parse(readFileSync(record, 'utf8'));
    const payload = argv[argv.indexOf('-p') + 1];
    assert.match(payload, /review/i);
    assert.ok(payload.length > 100, 'the whole prompt arrived, not its first word');
    assert.deepEqual(argv.slice(-2), ['--output-format', 'text']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shim fallback hands over a brief on disk and takes it back', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  // The path a Windows `.cmd` shim forces — and the reason it is forceable at
  // all: the last two Windows-only paths in this gate shipped having never
  // executed anywhere, because EINVAL cannot be produced off Windows. The
  // transport is forced here; the platform is not.
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-brief-'));
  try {
    const record = join(dir, 'record.json');
    const impl = strictStub(dir, { record });
    // The stub reads whatever file the instruction names, exactly as the real
    // CLI is asked to, so the assertion covers the file's existence AT SPAWN
    // TIME rather than after the gate has cleaned it up.
    writeFileSync(impl, readFileSync(impl, 'utf8').replace(
      "let stdin = '';",
      "const named = /brief at (\\S+) in full/.exec(argv.join(' '));\n"
      + "const brief = named ? readFileSync(named[1], 'utf8') : '';\n"
      + "let stdin = '';",
    ).replace('JSON.stringify({ argv, stdin })', 'JSON.stringify({ argv, stdin, brief })')
      .replace("process.stdout.write('STUB REVIEW: APPROVE — no findings\\nAPPROVE');",
        "process.stdout.write('STUB REVIEW: APPROVE — no findings\\nAPPROVE WITH COMMENTS');"));
    const bin = posixStub(dir, impl);

    const result = runGate({
      args: ['--commit', TEST_COMMIT],
      env: { KIMI_GATE_BIN: bin, KIMI_GATE_FORCE_SHIM: '1' },
    });

    assert.match(result.stdout, /STUB REVIEW: APPROVE — no findings/, `${result.stdout}\n${result.stderr}`);
    const { argv, brief } = JSON.parse(readFileSync(record, 'utf8'));
    assert.deepEqual(argv.filter((a) => a.length < 40), ['-p', '--output-format', 'text']);
    assert.ok(brief.length > 100, 'the brief must exist and be complete while the CLI runs');
    assert.match(brief, /review/i);

    // And it must not outlive the call: the brief holds the same content as the
    // transcript, but it exists only to be read during the spawn.
    const named = /brief at (\S+) in full/.exec(argv.join(' '));
    assert.ok(named, `no brief path in ${JSON.stringify(argv)}`);
    assert.equal(existsSync(named[1]), false, 'the brief must be removed after the call');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a shim answer with no verdict line is an error, never a review', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  // On the shim path the brief travels by reference, so a CLI that never read
  // it still exits 0 with fluent text — and that text would otherwise be
  // emitted as a verdict. The prompt mandates a verdict line; its absence means
  // the brief did not arrive.
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-unread-'));
  try {
    const bin = posixStub(dir, strictStub(dir, {
      body: "process.stdout.write('I could not find that file. What would you like me to review?');",
    }));

    const result = runGate({
      args: ['--commit', TEST_COMMIT],
      env: { KIMI_GATE_BIN: bin, KIMI_GATE_FORCE_SHIM: '1' },
    });

    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /ERROR: /);
    assert.match(result.stdout, /never read/i);
    assert.doesNotMatch(result.stdout, /What would you like me to review/, 'a non-review must not be emitted as a verdict');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('a bare-name .cmd shim on PATH is resolved and drives a completed review', {
  skip: process.platform === 'win32' ? false : 'the bare-name PATHEXT gap is Windows-only',
}, () => {
  // The end-to-end proof for issue #12, and the only test that exercises the
  // whole chain the gap broke: PATH resolution -> a concrete `.cmd` path ->
  // EINVAL -> spawnViaShell -> a review on stdout. Deliberately does NOT set
  // KIMI_GATE_BIN: an absolute override skips resolution entirely, which is
  // exactly how #10 shipped a gate that reported "not installed" on every
  // npm-installed Windows box.
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-path-'));
  try {
    const impl = join(dir, 'stub.mjs');
    writeFileSync(impl, [
      "const argv = process.argv.slice(2);",
      "if (argv.includes('--version')) { process.stdout.write('stub 1.0'); process.exit(0); }",
      "if (argv.includes('--help')) { process.stdout.write('Usage: kimi [options]\\n\\nOptions:\\n  -p, --prompt <p>  prompt\\n  --output-format <f>  fmt\\n'); process.exit(0); }",
      "process.stdout.write('STUB REVIEW: APPROVE — resolved via PATH\\nAPPROVE');",
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'kimi.cmd'), `@echo off\r\n"${process.execPath}" "${impl}" %*\r\n`);

    // stubPath, not a prepend: a real `kimi.exe` later on PATH would make
    // pass 1 return the bare name, and this gate would then spawn the REAL,
    // metered CLI instead of the stub.
    const result = runGate({ args: ['--commit', TEST_COMMIT], env: stubPath(dir, 'kimi') });

    assert.match(result.stdout, /STUB REVIEW: APPROVE — resolved via PATH/, result.stderr);
    assert.doesNotMatch(result.stdout, /SKIPPED/, 'a resolvable shim is not "not installed"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the argv the CLI actually accepts ───────────────────────────────────────
// Every stub above ignores its argv, which is exactly why a flag list the real
// CLI rejects rode a fully green suite: `--quiet` and `--input-format` are not
// in `kimi --help` for 0.29.1, so every review exited 1 with empty stdout and
// the gate reported "produced no final message" forever. A stub that accepts
// anything cannot catch a flag the CLI refuses, so this one refuses too.

// Each stub answers `--help` with ONE dialect and then accepts only that
// dialect's flags. The gate now derives its argv from that answer, so a stub
// that answered every flag list would make an invalid composition invisible —
// the same blindness that let `--quiet` ride a green suite, moved one level up.
//
// `prompt` is captured shape: @moonshot-ai/kimi-code, commander. The two print
// dialects are HYPOTHETICAL — kimi-cli 1.43.0 is not installable here, so their
// help layout is authored from the design and only their rejection wording is
// reported. What they pin is the composition, not the product.
const HELP = {
  prompt: [
    'Usage: kimi [options] [command]',
    '',
    'Options:',
    '  -V, --version                 output the version number',
    '  -p, --prompt <prompt>         Run one prompt non-interactively.',
    '  --output-format <format>      Output format for prompt mode.',
    '  -h, --help                    Show help.',
  ].join('\n'),
  print: [
    'Usage: kimi [OPTIONS] [PROMPT]...',
    '',
    'Options:',
    '  -p, --prompt TEXT           Run one prompt non-interactively.',
    '  --print                     Print the response and exit.',
    '  --output-format TEXT        Output format for print mode.',
    '  --final-message-only        Print only the final message.',
  ].join('\n'),
  'print-positional': [
    'Usage: kimi [OPTIONS] [PROMPT]...',
    '',
    'Options:',
    '  -p, --print                 Print the response and exit.',
    '  --output-format TEXT        Output format for print mode.',
    '  --final-message-only        Print only the final message.',
  ].join('\n'),
  // A CLI that documents a boolean print flag and a subcommand slot: there is
  // no way to hand it a brief, and guessing the positional is the death this
  // gate already died once.
  'no-transport': [
    'Usage: kimi [options] [command]',
    '',
    'Options:',
    '  -p, --print                   Print the response and exit.',
    '  --output-format <format>      Output format.',
  ].join('\n'),
};

const TAKES_VALUE = {
  prompt: ['-p', '--prompt', '--output-format'],
  print: ['-p', '--prompt', '--output-format'],
  'print-positional': ['--output-format'],
  'no-transport': ['--output-format'],
};

/**
 * A stub CLI that answers `--help` with `dialect` and refuses anything that
 * dialect does not document.
 *
 * `rejectOutputFormatWithoutPrint` reproduces kimi-cli 1.43.0's reported
 * behaviour — a rejected VALUE rather than an unknown option — which is the
 * wording the drift diagnosis has to recognise.
 */
function strictStub(dir, {
  record, body = "process.stdout.write('STUB REVIEW: APPROVE — no findings\\nAPPROVE');",
  dialect = 'prompt', version = '0.29.1', rejectOutputFormatWithoutPrint = false,
  rejectsDespiteDocumenting = [], help = HELP[dialect],
} = {}) {
  const impl = join(dir, 'strict-stub.mjs');
  writeFileSync(impl, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    'const argv = process.argv.slice(2);',
    `if (argv.includes('--version')) { process.stdout.write(${JSON.stringify(version)}); process.exit(0); }`,
    // The probe comes first now, and it must be answerable without the review
    // branch running at all.
    `if (argv.includes('--help')) { process.stdout.write(${JSON.stringify(help)}); process.exit(0); }`,
    `const TAKES_VALUE = new Set(${JSON.stringify(TAKES_VALUE[dialect])});`,
    'for (let i = 0; i < argv.length; i += 1) {',
    '  const arg = argv[i];',
    "  if (!arg.startsWith('-')) continue;",
    '  if (TAKES_VALUE.has(arg)) { i += 1; continue; }',
    `  if (${JSON.stringify(help)}.includes(arg)) continue;`,
    // Commander's own wording, so the gate's drift diagnosis is matched against
    // the string a real CLI emits rather than one invented here.
    "  process.stderr.write(`error: unknown option '${arg}'\\n`);",
    '  process.exit(1);',
    '}',
    ...rejectsDespiteDocumenting.map((flag) => `if (argv.includes(${JSON.stringify(flag)})) { process.stderr.write("error: unknown option '${flag}'\\n"); process.exit(1); }`),
    rejectOutputFormatWithoutPrint
      ? "if (argv.includes('--output-format') && !argv.includes('--print')) {\n"
        + "  process.stderr.write('Invalid value for --output-format: Output format is only supported for print UI\\n');\n"
        + '  process.exit(2);\n}'
      : '',
    "let stdin = '';",
    "try { stdin = readFileSync(0, 'utf8'); } catch {}",
    record ? `writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, stdin }));` : '',
    body,
    '',
  ].join('\n'));
  return impl;
}

function posixStub(dir, impl) {
  const bin = join(dir, 'kimi-strict');
  writeFileSync(bin, `#!${process.execPath}\nprocess.argv.splice(1, 1, ${JSON.stringify(impl)});\nawait import(${JSON.stringify(impl)});\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** Run the gate against a stub of `dialect` and return what it sent. */
function argvSentTo(dialect, { args = ['--commit', TEST_COMMIT], env = {}, stubOpts = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-dialect-'));
  try {
    const record = join(dir, 'record.json');
    const bin = posixStub(dir, strictStub(dir, { record, dialect, ...stubOpts }));
    const result = runGate({ args, env: { KIMI_GATE_BIN: bin, ...env } });
    const sent = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')).argv : null;
    return { result, argv: sent };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the gate passes only flags this CLI documents', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-flags-'));
  try {
    const record = join(dir, 'record.json');
    const bin = posixStub(dir, strictStub(dir, { record }));

    const result = runGate({ args: ['--commit', TEST_COMMIT], env: { KIMI_GATE_BIN: bin } });

    assert.match(result.stdout, /STUB REVIEW: APPROVE — no findings/, `${result.stdout}\n${result.stderr}`);
    const { argv } = JSON.parse(readFileSync(record, 'utf8'));
    assert.ok(argv.includes('-p'), `no -p in ${JSON.stringify(argv)}`);
    assert.equal(argv[argv.indexOf('--output-format') + 1], 'text');
    for (const gone of ['--quiet', '--input-format', '--print', '--final-message-only']) {
      assert.ok(!argv.includes(gone), `${gone} is not a flag this CLI accepts`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rejected flag is reported as CLI drift, not as an empty review', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  // The failure this whole change exists for: the gate said "kimi produced no
  // final message (exit 1)" on every single review, which reads as a broken
  // reviewer rather than a helper and a CLI that disagree about a flag name.
  // A CLI that documents a flag and rejects it anyway is the only way left to
  // reach this branch, now that the argv is derived from the help text.
  const { result } = argvSentTo('prompt', {
    stubOpts: { rejectsDespiteDocumenting: ['--output-format'] },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /ERROR: not retryable —/, 'the driver keys its no-retry rule on this prefix');
  assert.match(result.stdout, /--output-format/, 'the rejected flag must be named');
  assert.match(result.stdout, /0\.29\.1/, 'the CLI version must be named');
  assert.match(result.stdout, /dialect: prompt \(probe\)/i, 'and which dialect produced that argv');
  assert.doesNotMatch(result.stdout, /produced no final message/);
  assert.doesNotMatch(result.stdout, /SKIPPED/);
});

test('a rejected VALUE is drift too, and names the override that forced it', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  // kimi-cli 1.43.0 refuses `--output-format` unless `--print` accompanies it,
  // and says so as a rejected value — wording no unknown-option pattern
  // matches, so this arrived as a generic empty review and took a paid retry.
  // Reached here by forcing the wrong group, which is also the case where the
  // remedy must point at the variable rather than at `--help`.
  const { result } = argvSentTo('print', {
    env: { KIMI_GATE_DIALECT: 'prompt' },
    stubOpts: { rejectOutputFormatWithoutPrint: true },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /ERROR: not retryable —/);
  assert.match(result.stdout, /only supported for print UI/, 'the CLI\'s own words');
  assert.match(result.stdout, /dialect: prompt \(override\)/i);
  assert.match(result.stdout, /KIMI_GATE_DIALECT/, 'the remedy is the forced dialect, not `--help`');
  assert.doesNotMatch(result.stdout, /produced no final message/);
});

test('the forced shim transport replaces the primary spawn, never doubles it', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  // A seam that ran the primary spawn first and the shim second bought TWO
  // complete paid reviews and twice the documented bound, and discarded the
  // first outcome — a verdict, or a timeout — with no trace. Stubs made it
  // invisible: both spawns "succeed".
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-count-'));
  try {
    const counter = join(dir, 'spawns.log');
    const bin = posixStub(dir, strictStub(dir, {
      body: `import { appendFileSync } from 'node:fs';\n`
        + `appendFileSync(${JSON.stringify(counter)}, 'spawn\\n');\n`
        + "process.stdout.write('APPROVE\\nSTUB REVIEW: APPROVE — no findings\\nAPPROVE');",
    }));

    const result = runGate({
      args: ['--commit', TEST_COMMIT],
      env: { KIMI_GATE_BIN: bin, KIMI_GATE_FORCE_SHIM: '1' },
    });

    // Assert the review happened too: counting alone cannot tell one spawn from
    // none, and a gate that skipped would satisfy the count.
    assert.match(result.stdout, /STUB REVIEW: APPROVE — no findings/, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(counter, 'utf8').split('\n').filter(Boolean).length, 1,
      'the forced transport must REPLACE the primary spawn, not follow it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a no-output failure names the version and the argv, whatever the CLI said', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  // The mechanism behind the drift diagnosis, and the part that must not depend
  // on recognizing a dialect: this CLI has already emitted wording the pattern
  // would miss ("No such command 'are'"), so every empty-stdout failure carries
  // the version and the exact argv rather than only the ones a regex knows.
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-mystery-'));
  try {
    const bin = posixStub(dir, strictStub(dir, {
      body: "process.stderr.write('Segmentation fault: 11'); process.exit(139);",
    }));

    const result = runGate({ args: ['--commit', TEST_COMMIT], env: { KIMI_GATE_BIN: bin } });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /produced no final message/);
    assert.match(result.stdout, /0\.29\.1/, 'the CLI that answered must be named');
    assert.match(result.stdout, /--output-format/, 'the argv sent must be named');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the forced transport is observable, not silent', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  // The gate's own comment calls the invocation shape "part of the contract":
  // a seam that reported the primary shape while running the indirect one would
  // make every diagnosis of that path a guess.
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-forced-'));
  const bin = posixStub(dir, strictStub(dir, {}));
  const result = runGate({
    args: ['--print-args'],
    env: { KIMI_GATE_BIN: bin, KIMI_GATE_FORCE_SHIM: '1' },
  });
  rmSync(dir, { recursive: true, force: true });

  const { transport, shell, args } = JSON.parse(result.stdout);
  assert.equal(transport, 'brief-file');
  assert.equal(shell, true);
  const instruction = args[args.indexOf('-p') + 1];
  assert.match(instruction, /review only/i);
  assert.doesNotMatch(instruction, /[^\x00-\x7F]/, 'a shelled argv element stays ASCII');
});

test('a signal-killed kimi is an ERROR, never a partial verdict', {
  skip: process.platform === 'win32' ? 'needs a POSIX executable stub' : false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-sigkill-'));
  try {
    const stub = probeAnsweringStub(dir, "process.stdout.write('PARTIAL: the diff looks f'); process.kill(process.pid, 'SIGKILL');");

    const result = runGate({
      args: ['--commit', TEST_COMMIT],
      env: { KIMI_GATE_BIN: stub },
    });

    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /ERROR: kimi did not exit normally/);
    assert.match(result.stdout, /SIGKILL/);
    // The truncated transcript must not surface inside the marker block.
    assert.doesNotMatch(result.stdout, /PARTIAL: the diff/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('output past the buffer bound is an ERROR naming the knob, not a verdict', {
  skip: process.platform === 'win32' ? 'needs a POSIX executable stub' : false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-enobufs-'));
  try {
    const stub = probeAnsweringStub(dir, "process.stdout.write('x'.repeat(8192));");

    const result = runGate({
      args: ['--commit', TEST_COMMIT],
      env: { KIMI_GATE_BIN: stub, KIMI_REVIEW_MAX_BUFFER_BYTES: '1024' },
    });

    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /ERROR: kimi did not exit normally/);
    assert.match(result.stdout, /ENOBUFS/);
    assert.match(result.stdout, /KIMI_REVIEW_MAX_BUFFER_BYTES/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a direct-path kimi review without a verdict line is an error, not a verdict', {
  skip: process.platform === 'win32' ? 'needs a POSIX executable stub' : false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-no-verdict-'));
  try {
    const stub = probeAnsweringStub(dir, "process.stdout.write('fluent text with no verdict line');");
    const result = runGate({ args: ['--commit', TEST_COMMIT], env: { KIMI_GATE_BIN: stub } });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /ERROR: .*verdict/);
    assert.doesNotMatch(result.stdout, /fluent text/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── which CLI is installed decides the argv ─────────────────────────────────
// Two products install a binary named `kimi`. Pinning either flag table breaks
// the other install before the model call, and the version strings do not
// separate them — so the argv is derived, and these assert what each dialect
// composes, by exact composition rather than by the absence of a dead string.

test('a commander CLI still receives exactly the argv this gate always sent', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  const { result, argv } = argvSentTo('prompt');

  assert.match(result.stdout, /STUB REVIEW: APPROVE — no findings/, result.stderr);
  assert.equal(argv.length, 4, JSON.stringify(argv));
  assert.deepEqual([argv[0], argv[2], argv[3]], ['-p', '--output-format', 'text']);
  assert.ok(argv[1].length > 100, 'the whole prompt arrived, not its first word');
  for (const foreign of ['--print', '--final-message-only', '--quiet', '--input-format']) {
    assert.ok(!argv.includes(foreign), `${foreign} belongs to another CLI`);
  }
});

test('a print-mode CLI receives its own group, prompt still on the flag', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  const { result, argv } = argvSentTo('print');

  assert.match(result.stdout, /STUB REVIEW: APPROVE — no findings/, result.stderr);
  assert.deepEqual(argv.filter((a) => a.length < 40),
    ['-p', '--print', '--output-format', 'text', '--final-message-only']);
});

test('a boolean print flag puts the brief in the documented positional', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  // Never attached to the boolean flag: a CLI whose positional slot is a
  // subcommand would read the prompt's second word as one — the death this
  // gate already died once ("No such command 'are'").
  const { result, argv } = argvSentTo('print-positional');

  assert.match(result.stdout, /STUB REVIEW: APPROVE — no findings/, result.stderr);
  assert.deepEqual(argv.slice(0, 4), ['--print', '--output-format', 'text', '--final-message-only']);
  assert.equal(argv.length, 5);
  assert.ok(argv[4].length > 100, 'the prompt is the trailing positional');
});

test('a CLI with no way to receive a brief is a stop, not a skip', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  // Present and answering, so this reviewer is not unavailable: a SKIP would
  // hand the review to another family and hide the drift.
  const { result, argv } = argvSentTo('no-transport');

  assert.equal(argv, null, 'no review may be attempted');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /ERROR: not retryable —/);
  assert.match(result.stdout, /KIMI_GATE_DIALECT/, 'the message carries its own remedy');
  assert.doesNotMatch(result.stdout, /SKIPPED/);
});

test('a CLI that will not answer --help is unavailable, not drift', {
  skip: process.platform === 'win32' ? 'needs a POSIX executable stub' : false,
}, () => {
  // The other half of the split: nothing was read, which says nothing about
  // the flag list. Erroring here would wedge a run on a first-run unpack or a
  // virus scanner; skipping falls back to another family, by design.
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-probe-hang-'));
  try {
    const stub = join(dir, 'kimi-stub');
    writeFileSync(stub, [
      `#!${process.execPath}`,
      "if (process.argv.includes('--version')) { process.stdout.write('stub'); process.exit(0); }",
      'process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 60000);',
      '',
    ].join('\n'));
    chmodSync(stub, 0o755);

    const result = runGate({
      args: ['--commit', TEST_COMMIT],
      env: { KIMI_GATE_BIN: stub, KIMI_REVIEW_TIMEOUT_MS: '2000' },
    });

    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /SKIPPED: .*--help/, 'the reason names the probe, so a chronic hang is one line');
    assert.doesNotMatch(result.stdout, /ERROR/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a CLI that would answer with a transcript is refused, not warned about', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  // A print-mode CLI with no `--final-message-only` answers with its whole
  // transcript, and `emitVerifiedReview` accepts any answer carrying a verdict
  // word — which a transcript does. A stderr warning is not a control here:
  // the skill tells the caller to keep STDOUT and read the marker block, so
  // the transcript would arrive as a clean verdict. Refused before the call.
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-transcript-'));
  try {
    const record = join(dir, 'record.json');
    const impl = strictStub(dir, {
      record,
      dialect: 'print',
      help: HELP.print.split('\n').filter((line) => !line.includes('--final-message-only')).join('\n'),
    });
    const result = runGate({ args: ['--commit', TEST_COMMIT], env: { KIMI_GATE_BIN: posixStub(dir, impl) } });

    assert.equal(existsSync(record), false, 'no paid review may be attempted');
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /ERROR: not retryable —/);
    assert.match(result.stdout, /transcript/i);
    assert.doesNotMatch(result.stdout, /SKIPPED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the override ────────────────────────────────────────────────────────────

test('KIMI_GATE_DIALECT replaces the probe rather than seeding it', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  // It exists for a CLI whose help cannot be read at all, so it must not
  // depend on having read one — and it must outrank what the help says.
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-override-'));
  try {
    const record = join(dir, 'record.json');
    const probes = join(dir, 'probes.log');
    const impl = strictStub(dir, { record, dialect: 'print' });
    writeFileSync(impl, readFileSync(impl, 'utf8').replace(
      "if (argv.includes('--help'))",
      `import { appendFileSync } from 'node:fs';\nif (argv.includes('--help')) appendFileSync(${JSON.stringify(probes)}, 'help\\n');\nif (argv.includes('--help'))`,
    ));

    const result = runGate({
      args: ['--commit', TEST_COMMIT],
      env: { KIMI_GATE_BIN: posixStub(dir, impl), KIMI_GATE_DIALECT: 'print' },
    });

    assert.match(result.stdout, /STUB REVIEW: APPROVE — no findings/, result.stderr);
    assert.equal(existsSync(probes), false, 'a forced dialect must not spend a --help spawn');
    assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')).argv.filter((a) => a.length < 40),
      ['-p', '--print', '--output-format', 'text', '--final-message-only']);
    assert.match(result.stderr, /dialect -> print \(override\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unrecognised KIMI_GATE_DIALECT stops, never silently probes', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  const { result, argv } = argvSentTo('prompt', { env: { KIMI_GATE_DIALECT: 'prnt' } });

  assert.equal(argv, null);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /ERROR: not retryable —/);
  assert.match(result.stdout, /prnt/, 'the typo is quoted back');
  assert.doesNotMatch(result.stdout, /SKIPPED/);
});

// ── what the probe may and may not cost ─────────────────────────────────────

test('the probe resolves a CLI found only through PATH', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  // `env` REPLACES the environment in spawnSync, so a probe that passed a bare
  // `{ COLUMNS }` would lose PATH, ENOENT, and — classified as unavailability —
  // silently skip every review on a healthy machine.
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-probe-path-'));
  try {
    const impl = strictStub(dir, {});
    const bin = join(dir, 'kimi');
    writeFileSync(bin, `#!${process.execPath}\nprocess.argv.splice(1, 1, ${JSON.stringify(impl)});\nawait import(${JSON.stringify(impl)});\n`);
    chmodSync(bin, 0o755);

    const result = runGate({ args: ['--commit', TEST_COMMIT], env: stubPath(dir, 'kimi') });

    assert.match(result.stdout, /STUB REVIEW: APPROVE — no findings/, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /SKIPPED/, 'a CLI on PATH is not "not installed"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the probe costs one spawn, and the review one more', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-probe-count-'));
  try {
    const log = join(dir, 'calls.log');
    const impl = strictStub(dir, {
      body: `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, 'review\\n');\n`
        + "process.stdout.write('APPROVE\\nSTUB REVIEW: APPROVE — no findings\\nAPPROVE');",
    });
    // Counted in the probe branch itself, so a probe that also fell through to
    // the review branch cannot pass by counting once.
    writeFileSync(impl, readFileSync(impl, 'utf8').replace(
      "if (argv.includes('--help'))",
      `import { appendFileSync as append } from 'node:fs';\nif (argv.includes('--help')) append(${JSON.stringify(log)}, 'help\\n');\nif (argv.includes('--help'))`,
    ));

    const result = runGate({ args: ['--commit', TEST_COMMIT], env: { KIMI_GATE_BIN: posixStub(dir, impl) } });

    assert.match(result.stdout, /STUB REVIEW: APPROVE — no findings/, result.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').split('\n').filter(Boolean), ['help', 'review']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run that will not review spawns nothing at all', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  // The probe moved up the file, toward the exits that must stay free: a
  // disabled gate, a reviewer that declines on independence, and the dry run
  // that only prints the prompt.
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-nospawn-'));
  try {
    const log = join(dir, 'calls.log');
    const impl = strictStub(dir, {});
    writeFileSync(impl, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, 'spawn\\n');\n${readFileSync(impl, 'utf8')}`);
    const bin = posixStub(dir, impl);

    for (const [label, args, env] of [
      ['disabled', ['--commit', TEST_COMMIT], { KIMI_REVIEW_GATE: 'off' }],
      ['not independent', ['--commit', TEST_COMMIT, '--implementer', 'kimi'], {}],
      ['--print-prompt', ['--commit', TEST_COMMIT, '--print-prompt'], {}],
    ]) {
      const result = runGate({ args, env: { KIMI_GATE_BIN: bin, ...env } });
      assert.equal(result.status, 0, `${label}: ${result.stdout}`);
      assert.equal(existsSync(log), false, `${label} must not spawn the CLI`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the probe reads one stream, so a warning on the other cannot blind it', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  // Concatenated, a dash-leading warning line joins the option pool — and at
  // column 0 it redefines the option column and drops every real option, which
  // reads as "this CLI documents no prompt transport".
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-warned-'));
  try {
    const impl = strictStub(dir, {});
    writeFileSync(impl, readFileSync(impl, 'utf8').replace(
      "if (argv.includes('--help'))",
      "if (argv.includes('--help')) process.stderr.write('-Xss warning: deprecated flag\\n');\nif (argv.includes('--help'))",
    ));

    const result = runGate({ args: ['--commit', TEST_COMMIT], env: { KIMI_GATE_BIN: posixStub(dir, impl) } });

    assert.match(result.stdout, /STUB REVIEW: APPROVE — no findings/, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /dialect -> prompt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a CLI that prints its help to stderr is still read', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-help-stderr-'));
  try {
    const impl = strictStub(dir, {});
    writeFileSync(impl, readFileSync(impl, 'utf8').replace(
      'process.stdout.write(' + JSON.stringify(HELP.prompt) + '); process.exit(0);',
      'process.stderr.write(' + JSON.stringify(HELP.prompt) + '); process.exit(0);',
    ));

    const result = runGate({ args: ['--commit', TEST_COMMIT], env: { KIMI_GATE_BIN: posixStub(dir, impl) } });

    assert.match(result.stdout, /STUB REVIEW: APPROVE — no findings/, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── a non-UTF-8 console must not silently destroy a paid review ─────────────
// The reported failure: one character outside the machine's ANSI code page in
// the model's answer kills the CLI mid-write, and the gate reports a reviewer
// that gave no verdict. Forty minutes, paid, discarded, blamed on the reviewer.

const CRASH = "UnicodeEncodeError: 'gbk' codec can't encode character '−' in position 41: illegal multibyte sequence";
/** Every character measured as unencodable, plus the quotes the brief asks for. */
const MAPPED = /[‐-―−‘’“”\u00A0…]/g;
const SLOT_TOKEN = /\u0000/;

test('an encoding crash is named as itself, not as an absent verdict', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  const { result } = argvSentTo('prompt', {
    stubOpts: { body: `process.stderr.write(${JSON.stringify(CRASH)});\nprocess.exit(1);` },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /ERROR: kimi crashed while writing its answer/);
  assert.match(result.stdout, /gbk/, "the CLI's own words");
  assert.match(result.stdout, /NOT to a reviewer that failed to answer/);
  assert.doesNotMatch(result.stdout, /produced no final message/, 'the wrong face this issue is about');
});

test('a review truncated mid-write is not a verdict, however complete it looks', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  // The fail-open half: the protocol accepts any answer carrying a verdict
  // WORD, and a fragment can carry one.
  const { result } = argvSentTo('prompt', {
    stubOpts: {
      body: "process.stdout.write('P1 candidate: something\\nOverall verdict: REQUEST CHANGES\\n(truncated here');\n"
        + `process.stderr.write(${JSON.stringify(CRASH)});\nprocess.exit(1);`,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /fragment of an aborted run/);
  assert.match(result.stdout, /crashed while writing its answer/, 'and the true cause');
  assert.doesNotMatch(result.stdout, /truncated here/, 'a fragment must never be emitted as a review');
});

test('a non-zero exit is never a verdict, even with no crash to blame', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  const { result } = argvSentTo('prompt', {
    stubOpts: { body: "process.stdout.write('Looks fine.\\nOverall verdict: APPROVE');\nprocess.exit(3);" },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /ERROR: kimi exited 3/);
  assert.doesNotMatch(result.stdout, /Looks fine/);
});

test('the non-zero-exit rule does not swallow the auth skip or the drift stop', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  // Both exit non-zero with EMPTY stdout and must keep their own disposition:
  // a logged-out reviewer falls back to another family, and a rejected flag
  // stops the round (#58's control, which this branch must not regress).
  const loggedOut = argvSentTo('prompt', {
    stubOpts: { body: "process.stderr.write('No model configured. Please run kimi login.');\nprocess.exit(1);" },
  });
  assert.equal(loggedOut.result.status, 0, loggedOut.result.stdout);
  assert.match(loggedOut.result.stdout, /SKIPPED: Kimi not authenticated/);

  const drifted = argvSentTo('prompt', { stubOpts: { rejectsDespiteDocumenting: ['--output-format'] } });
  assert.notEqual(drifted.result.status, 0);
  assert.match(drifted.result.stdout, /ERROR: not retryable /);
});

test('a decode failure on the shim path keeps the "brief never arrived" conclusion', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  // The gate writes that brief as UTF-8 and the CLI reads it under the locale
  // encoding, so a decode error IS a brief that never arrived. Letting the
  // encoding diagnosis simply outrank the shim one would swap a correct
  // conclusion for a remedy that does nothing.
  const { result } = argvSentTo('prompt', {
    env: { KIMI_GATE_FORCE_SHIM: '1' },
    stubOpts: {
      body: 'process.stderr.write("UnicodeDecodeError: \'gbk\' codec can\'t decode byte 0xe2 in position 12");\nprocess.exit(1);',
    },
  });

  assert.match(result.stdout, /could not decode/);
  assert.match(result.stdout, /never arrived/);
  assert.match(result.stdout, /native executable/, 'the remedy that actually helps');
});

// ── the prompt-side mitigation ──────────────────────────────────────────────

const promptUnder = (env, args = ['--commit', TEST_COMMIT]) => runGate({
  args: [...args, '--print-prompt'],
  env: { ...NO_CLI, ...env },
}).stdout;

test('a constrained console adds the constraint and leaves the fixed prose ASCII', () => {
  const prompts = {
    diff: promptUnder({ KIMI_GATE_CONSOLE: 'legacy' }),
    design: withDesignDoc('# Spec\n', (path) => promptUnder({ KIMI_GATE_CONSOLE: 'legacy' }, ['--design', path])),
  };

  for (const [mode, prompt] of Object.entries(prompts)) {
    assert.match(prompt, /Output constraint \(a tooling limit on this machine/, mode);
    assert.match(prompt, /CJK text is fine/, mode);
    assert.match(prompt, /no-break space/, mode);
    // The brief must not model the character class that crashes the CLI, and
    // design mode is the hard case: three of its em dashes come from the
    // SHARED brief, which this gate may not edit.
    assert.deepEqual(prompt.match(MAPPED) || [], [], `${mode}: fixed prose still carries mapped characters`);
  }
});

test('an unconstrained console changes nothing at all', () => {
  const plain = promptUnder({});
  const forcedOff = promptUnder({ KIMI_GATE_CONSOLE: 'utf8' });

  assert.equal(plain, forcedOff, 'forcing utf8 off Windows is the same as not probing');
  assert.doesNotMatch(plain, /Output constraint/);
  assert.ok((plain.match(MAPPED) || []).length > 0, 'nothing is normalised when nothing needs to be');
});

test('the composed prompt never leaks a slot token', () => {
  // spawnSync THROWS on a NUL in argv rather than returning an error, and the
  // gate spawns at module top level - a leaked slot would exit with a stack
  // trace and NO marker block. --print-prompt prints a NUL harmlessly, so only
  // an explicit assertion catches it, and no --design test reaches a spawn.
  for (const env of [{ KIMI_GATE_CONSOLE: 'legacy' }, {}]) {
    assert.doesNotMatch(promptUnder(env), SLOT_TOKEN, JSON.stringify(env));
    withDesignDoc('# Spec\n', (path) => {
      assert.doesNotMatch(promptUnder(env, ['--design', path]), SLOT_TOKEN, JSON.stringify(env));
    });
  }
});

test('an operand survives normalisation and substitution byte-exact', () => {
  // The regression this design exists to prevent twice over: normalising the
  // composed prompt would rewrite a path AFTER validateTarget confirmed it, and
  // String.replace would mangle a `$&` in it. The reviewer would then report it
  // could not read the document, and the gate would blame the reviewer.
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gate-operand-'));
  try {
    const path = join(dir, 'spec — v2 $&.md');
    writeFileSync(path, '# Spec\n');

    const prompt = promptUnder({ KIMI_GATE_CONSOLE: 'legacy' }, ['--design', path]);

    assert.ok(prompt.includes(path), `the target was rewritten: ${prompt.split('\n')[1]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unrecognised KIMI_GATE_CONSOLE stops the round', () => {
  const result = runGate({
    args: ['--commit', TEST_COMMIT, '--print-prompt'],
    env: { ...NO_CLI, KIMI_GATE_CONSOLE: 'legasy' },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /ERROR: not retryable /);
  assert.match(result.stdout, /legasy/);
  assert.doesNotMatch(result.stdout, /SKIPPED/);
});


test('Kimi design review requires the design terminal vocabulary', {
  skip: process.platform === 'win32' ? 'the POSIX stub needs a shebang' : false,
}, () => {
  for (const word of ['SOUND', 'APPROVE']) {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-mode-'));
    try {
      const bin = posixStub(dir, strictStub(dir, { body: `process.stdout.write(${JSON.stringify(word)});` }));
      const result = withDesignDoc('# Design\n', (path) => runGate({ args: ['--design', path], env: { KIMI_GATE_BIN: bin } }));
      assert.equal(result.status, word === 'SOUND' ? 0 : 1, result.stderr);
      if (word === 'APPROVE') assert.match(result.stdout, /ERROR:.*verdict/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
