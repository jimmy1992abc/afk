// The invocation layer every gate launches through. These assertions exist
// because the failure they prevent is silent, environment-dependent, and reads
// like a broken CLI: cmd.exe tears an unquoted argument at its first space, and
// a Windows account named "First Last" puts a space in every temp path a gate
// passes with `-o`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { test } from 'node:test';

import {
  quoteForShell, resolveCliBin, spawnCli, spawnViaShell, UNSAFE_SHELL_ARG,
} from './spawn.mjs';

const isAbsoluteWin = (candidate) => win32.isAbsolute(candidate);

// A CLI that outlives the shell launched for it: every npm install of these
// tools is a script shim, so the real process tree is `cmd.exe -> node` and a
// kill aimed at the shim leaves the worker running.
function sleepingShim(dir) {
  return shim(dir, `process.on('SIGTERM', () => {}); setInterval(() => {}, 60000);\n`);
}

function echoingShim(dir) {
  return shim(dir, "let b = '';\n"
    + "process.stdin.setEncoding('utf8');\n"
    + "process.stdin.on('data', (c) => { b += c; });\n"
    + "process.stdin.on('end', () => process.stdout.write(b));\n");
}

function shim(dir, body) {
  const js = join(dir, 'worker.mjs');
  writeFileSync(js, body);
  const isWin = process.platform === 'win32';
  const path = join(dir, isWin ? 'shim.cmd' : 'shim.sh');
  // No `exec` on the POSIX side, deliberately: the worker must be a GRANDCHILD
  // on both platforms, which is the shape that strands the stdin pipe.
  writeFileSync(path, isWin
    ? `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`
    : `#!/bin/sh\n"${process.execPath}" "${js}" "$@"\n`);
  if (!isWin) chmodSync(path, 0o755);
  return path;
}

test('quoteForShell wraps exactly what a shell would split', () => {
  assert.equal(quoteForShell('--base'), '--base');
  assert.equal(quoteForShell('origin/main'), 'origin/main');
  assert.equal(quoteForShell('model=gpt-5.6-terra'), 'model=gpt-5.6-terra');
  assert.equal(
    quoteForShell('C:\\Users\\First Last\\AppData\\Local\\Temp\\g\\review.txt'),
    '"C:\\Users\\First Last\\AppData\\Local\\Temp\\g\\review.txt"',
  );
  // An empty value would vanish under a shell and let the NEXT flag become the
  // value — the flag silently changes meaning.
  assert.equal(quoteForShell(''), '""');
  for (const meta of ['a&b', 'a|b', 'a>b', 'a<b', 'a^b', 'a(b)']) {
    assert.equal(quoteForShell(meta), `"${meta}"`, meta);
  }
});

test('quoteForShell refuses a value it cannot quote safely', () => {
  // Paths and refs never contain a quote. One that does would be re-parsed by
  // cmd.exe, so fail loudly instead of shipping something that half-works.
  assert.throws(() => quoteForShell('say "hi" now'), /double quote/);

  // And a quote WITHOUT whitespace is the dangerous one, because it is the one
  // that looks safe: nothing else in it needs quoting, so an ordering that
  // checked NEEDS_QUOTES first returned it untouched and cmd.exe read the quote
  // as syntax — swallowing the arguments after it and silently changing which
  // target the gate reviewed.
  assert.throws(() => quoteForShell('feature/"test'), /double quote/);
  assert.throws(() => quoteForShell('a"b'), /double quote/);
  assert.throws(() => quoteForShell('"'), /double quote/);
});

test('quoteForShell refuses cmd variable expansion, which no quoting can stop', () => {
  // Quoting is the wrong tool: cmd.exe expands %NAME% inside double quotes too.
  assert.throws(() => quoteForShell('%PATH%'), /variable expansion/);
  assert.throws(() => quoteForShell('feature/%USERNAME%-x'), /variable expansion/);
  assert.throws(() => quoteForShell('%%PATH%%'), /variable expansion/);

  // A `%` that cannot name anything is left alone — refusing these would turn
  // ordinary refs and paths into errors for nothing.
  assert.equal(quoteForShell('a%b'), 'a%b');
  assert.equal(quoteForShell('50%'), '50%');
  assert.equal(quoteForShell('%%'), '%%');
});

test('cmd.exe really does expand a quoted %NAME% — the rule is not cargo-culted', {
  skip: process.platform === 'win32' ? false : 'cmd.exe-specific',
}, () => {
  // Pin the behaviour the refusal exists for, against the real shell. %USERNAME%
  // is defined on every Windows box, so this cannot silently become a no-op.
  const dir = mkdtempSync(join(tmpdir(), 'gate-pct-'));
  try {
    const echo = join(dir, 'echo-argv.mjs');
    writeFileSync(echo, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    const stub = join(dir, 'stub.cmd');
    writeFileSync(stub, `@echo off\r\n"${process.execPath}" "${echo}" %*\r\n`);

    // Quoted exactly as quoteForShell would have quoted a spaced value.
    const res = spawnSync(`"${stub}"`, ['"feature/%USERNAME%-x"'], {
      encoding: 'utf8', shell: true, timeout: 30000,
    });
    const seen = JSON.parse(res.stdout.trim())[0];

    assert.notEqual(seen, 'feature/%USERNAME%-x', 'quoting does NOT prevent expansion');
    assert.doesNotMatch(seen, /%USERNAME%/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawnCli delivers a spaced path verbatim, shim or not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate spawn '));  // a space, on purpose
  try {
    const echo = join(dir, 'echo-argv.mjs');
    writeFileSync(echo, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    const outFile = resolve(dir, 'sub dir', 'review.txt');

    let bin;
    let args;
    if (process.platform === 'win32') {
      // A `.cmd` shim is the install shape that forces the shell path — the one
      // Node cannot spawn directly (EINVAL).
      bin = join(dir, 'stub.cmd');
      writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${echo}" %*\r\n`);
      args = ['exec', 'review', '-o', outFile, '--base', 'origin/main'];
    } else {
      bin = process.execPath;
      args = [echo, 'exec', 'review', '-o', outFile, '--base', 'origin/main'];
    }

    const res = spawnCli(bin, args, { encoding: 'utf8', timeout: 30000 });

    assert.equal(res.status, 0, `${res.error?.code ?? ''} ${res.stderr ?? ''}`);
    const seen = JSON.parse(res.stdout.trim());
    assert.equal(seen[seen.indexOf('-o') + 1], outFile, 'the spaced path must arrive in one piece');
    assert.equal(seen.at(-1), 'origin/main', 'nothing after the spaced path may shift');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bare shelled spawn is what breaks — the regression this guards', {
  skip: process.platform === 'win32' ? false : 'cmd.exe-specific',
}, () => {
  // Pin the actual Node behaviour the module exists for, so a future "simplify"
  // back to `shell: true` fails here instead of in a customer's gate run.
  const dir = mkdtempSync(join(tmpdir(), 'gate-spawn-'));
  try {
    const echo = join(dir, 'echo-argv.mjs');
    writeFileSync(echo, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    const stub = join(dir, 'stub.cmd');
    writeFileSync(stub, `@echo off\r\n"${process.execPath}" "${echo}" %*\r\n`);
    const spaced = resolve(dir, 'sub dir', 'review.txt');

    const naive = spawnSync(stub, ['-o', spaced], { encoding: 'utf8', shell: true, timeout: 30000 });
    const seen = JSON.parse(naive.stdout.trim());

    assert.ok(seen.length > 2, 'unquoted, cmd.exe splits the spaced path into two argv elements');
    assert.notEqual(seen[1], spaced);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── rule 3: a payload under a shell must not be Node's `input` ──────────────

test('a shelled payload reaches the CLI verbatim, non-ASCII and newlines included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-stdin-'));
  try {
    const payload = '审查这个 diff\nline two\tand a tab\n'.repeat(50);
    const res = spawnViaShell(echoingShim(dir), [], {
      encoding: 'utf8',
      input: payload,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });

    assert.equal(res.status, 0, `${res.error?.code ?? ''} ${res.stderr ?? ''}`);
    // A gate that loses its prompt gets a review of nothing and cannot tell.
    assert.equal(res.stdout, payload);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the payload file does not outlive the call', () => {
  // The prompt carries the diff under review. It reaches disk only to get onto
  // an inherited descriptor, and must not still be there afterwards — including
  // on the path where the CLI failed.
  const dir = mkdtempSync(join(tmpdir(), 'gate-stdin-life-'));
  const before = new Set(readdirSync(tmpdir()).filter((e) => e.startsWith('afk-stdin-')));
  try {
    spawnViaShell(echoingShim(dir), [], {
      encoding: 'utf8', input: 'a prompt', timeout: 30000, killSignal: 'SIGKILL',
    });
    // And when the shim itself is not there to read it.
    spawnViaShell(join(dir, 'no-such-shim'), [], {
      encoding: 'utf8', input: 'a prompt', timeout: 30000, killSignal: 'SIGKILL',
    });

    const strays = readdirSync(tmpdir())
      .filter((e) => e.startsWith('afk-stdin-') && !before.has(e));
    assert.deepEqual(strays, [], `payload directories left behind: ${strays.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a shelled CLI that ignores its kill reports a timeout instead of hanging forever', () => {
  // THE regression this rule exists for. `input` under a shell strands the
  // stdin pipe in the surviving grandchild and spawnSync waits on that write
  // with no bound — the gate never reports the timeout it already detected.
  //
  // The bound has to come from OUTSIDE the process doing the spawn: a hang sits
  // inside a synchronous spawnSync, which blocks the event loop, so no
  // test-runner timeout can ever fire. The probe runs in a child, and this
  // test's own spawnSync is what cuts it off.
  const dir = mkdtempSync(join(tmpdir(), 'gate-stdin-hang-'));
  try {
    const probe = join(dir, 'probe.mjs');
    writeFileSync(probe, `import { spawnViaShell } from ${JSON.stringify(new URL('./spawn.mjs', import.meta.url).href)};\n`
      + `const r = spawnViaShell(${JSON.stringify(sleepingShim(dir))}, [], {\n`
      + `  encoding: 'utf8', input: 'a prompt', timeout: 500, killSignal: 'SIGKILL',\n`
      + `});\n`
      + `process.stdout.write(JSON.stringify({ code: r.error && r.error.code, signal: r.signal }));\n`);

    const res = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 30000 });

    assert.notEqual(res.error?.code, 'ETIMEDOUT',
      'spawnViaShell never returned — the stdin payload is deadlocking the shell path again');
    assert.equal(res.status, 0, `${res.error?.code ?? ''} ${res.stderr ?? ''}`);
    // And it must be reported as a timeout, not as a clean empty run.
    assert.deepEqual(JSON.parse(res.stdout), { code: 'ETIMEDOUT', signal: 'SIGKILL' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused argument comes back as a launch error, never as a throw', () => {
  // A gate's contract is that EVERY outcome is a parseable protocol block. An
  // exception escaping the spawn call exits with a stack trace instead, and the
  // driver cannot classify a review that never announced itself — so the refusal
  // rides the same channel ENOENT and ETIMEDOUT already use.
  for (const bad of ['%PATH%', 'a"b']) {
    let res;
    assert.doesNotThrow(() => {
      res = spawnViaShell('some-cli', ['--base', bad], { encoding: 'utf8' });
    }, `spawnViaShell must not throw for ${bad}`);
    assert.equal(res.error.code, UNSAFE_SHELL_ARG);
    assert.equal(res.status, null);
    assert.equal(res.stdout, '');
  }

  // Including when the refused value is the binary itself.
  const res = spawnViaShell('C:\tools\%TOOLDIR%\cli.cmd', [], { encoding: 'utf8' });
  assert.equal(res.error.code, UNSAFE_SHELL_ARG);
});

// ── resolveCliBin: the gap libuv leaves on Windows ──────────────────────────
//
// libuv's Windows PATH search appends `.com` and `.exe` and nothing else, so a
// CLI installed as a bare-named `.cmd` shim — what `npm i -g` produces — is
// ENOENT to a shell-less spawn and reads as "not installed" rather than
// reaching the EINVAL fallback. These tests inject the platform, so the
// Windows rules are exercised on every OS. Production joins with the HOST's
// `join`/`isAbsolute` — win32 on Windows, where it matters — precisely so an
// injected-platform run here builds candidates that can actually exist rather
// than `\var\folders\…` strings no machine would ever hold.

function pathEnv(entries, extra = {}) {
  return { PATH: entries.join(';'), ...extra };
}

function winDir(prefix, files) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const name of files) writeFileSync(join(dir, name), '');
  return dir;
}

test('a bare name libuv can already find is returned untouched', () => {
  // The regression this ordering exists for: resolving directory-major would
  // move a machine whose earlier PATH entry holds a `.cmd` and whose later one
  // holds a working `.exe` off its shell-free binary and onto the shell path.
  // Nothing that resolves today may resolve differently after this change.
  const shimDir = winDir('afk-res-cmd-', ['kimi.cmd']);
  const exeDir = winDir('afk-res-exe-', ['kimi.exe']);
  try {
    assert.equal(
      resolveCliBin('kimi', { env: pathEnv([shimDir, exeDir]), isWin: true }),
      'kimi',
      'a .exe anywhere on PATH means libuv resolves it — hands off',
    );
    assert.equal(resolveCliBin('kimi', { env: pathEnv([exeDir]), isWin: true }), 'kimi');
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(exeDir, { recursive: true, force: true });
  }
});

test('a bare name reachable only as a shim resolves to that concrete path', () => {
  const dirA = winDir('afk-res-a-', ['kimi.cmd']);
  const dirB = winDir('afk-res-b-', ['kimi.cmd', 'kimi.bat']);
  try {
    // The whole point: a concrete `.cmd` path is what makes Node raise EINVAL,
    // which is the only route to the quoted-shell fallback.
    assert.equal(
      resolveCliBin('kimi', { env: pathEnv([dirA]), isWin: true }),
      join(dirA, 'kimi.cmd'),
    );
    // PATH order decides between shims, and `.cmd` before `.bat` within a
    // directory — cmd.exe's own preference among the two.
    assert.equal(
      resolveCliBin('kimi', { env: pathEnv([dirB, dirA]), isWin: true }),
      join(dirB, 'kimi.cmd'),
    );
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('no candidate is ever taken from the working directory', () => {
  // THE security rule. A trailing or doubled `;` in PATH is routine on Windows
  // and yields an empty entry; joined with the name it is a RELATIVE candidate,
  // which resolves against the process's working directory — the repository
  // under review. cmd.exe then searches the current directory first, so a
  // hostile branch shipping `kimi.cmd` at its root would execute on the
  // reviewer's machine. Empty, quoted-empty, and relative entries must all be
  // unable to produce a candidate.
  const cwd = process.cwd();
  const repo = winDir('afk-res-hostile-', ['kimi.cmd']);
  const probed = [];
  try {
    process.chdir(repo);
    const seen = (candidate) => { probed.push(candidate); return existsSync(candidate); };
    for (const entries of [['', ''], ['""'], ['.'], ['.\\tools'], ['..\\bin'], ['C:kimi.cmd']]) {
      assert.equal(
        resolveCliBin('kimi', { env: pathEnv(entries), isWin: true, exists: seen }),
        'kimi',
        `PATH ${JSON.stringify(entries)} must not source a candidate`,
      );
    }
    // Windows-only reinforcement: off Windows the production filter drops every
    // win32-shaped entry before a candidate is built, so this loop runs zero
    // times. The equality assertions above are what carry the rule here.
    for (const candidate of probed) {
      assert.ok(
        isAbsoluteWin(candidate),
        `every probed candidate must be absolute; got ${JSON.stringify(candidate)}`,
      );
    }
  } finally {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a directory wearing an executable name is not a hit', () => {
  // Pass 1 asks "would libuv find this?" — and libuv checks the directory
  // attribute and walks past. A predicate that answered "exists" would return
  // the bare name here and hide the real shim pass 2 finds, turning a working
  // machine back into "not installed".
  const dir = winDir('afk-res-dirname-', []);
  mkdirSync(join(dir, 'kimi.exe'));
  writeFileSync(join(dir, 'kimi.cmd'), '');
  try {
    assert.equal(
      resolveCliBin('kimi', { env: pathEnv([dir]), isWin: true }),
      join(dir, 'kimi.cmd'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable PATH directory is not a candidate, and never a crash', (t) => {
  // `statSync({throwIfNoEntry:false})` suppresses ONLY ENOENT: an ACL-denied
  // directory throws EACCES. The resolver runs at module top level in every
  // gate, where an escaping exception exits with a stack trace and NO marker
  // block — strictly worse than the false skip this resolver exists to remove.
  // The real predicate is exercised here, not an injected stand-in, because the
  // partiality being guarded is a property of statSync itself.
  const locked = winDir('afk-res-locked-', ['kimi.cmd']);
  const open = winDir('afk-res-open-', ['kimi.cmd']);
  try {
    chmodSync(locked, 0o000);
    let denied = true;
    try { statSync(join(locked, 'kimi.cmd'), { throwIfNoEntry: false }); denied = false; } catch { /* expected */ }
    if (!denied) {
      // Never a bare return: node:test reports that as a PASS, so this guard
      // would look identical to one that ran — and on Windows, where B1 lives,
      // chmod cannot deny directory traversal at all, so it is ALWAYS off there.
      t.skip('cannot deny directory traversal here (root, Windows, or a filesystem without POSIX modes)');
      return;
    }

    let resolved;
    assert.doesNotThrow(() => {
      resolved = resolveCliBin('kimi', { env: pathEnv([locked, open]), isWin: true });
    }, 'an unreadable PATH entry must not escape as an exception');
    // And the search continues past it rather than stopping at the first denial.
    assert.equal(resolved, join(open, 'kimi.cmd'));
  } finally {
    chmodSync(locked, 0o755);
    rmSync(locked, { recursive: true, force: true });
    rmSync(open, { recursive: true, force: true });
  }
});

test('a dotted bare name is still a bare name', () => {
  // "Already carries an extension" means one of the four extensions this module
  // reasons about, not "contains a dot": a versioned CLI name would otherwise
  // be excluded from the shim search for nothing.
  const dir = winDir('afk-res-dotted-', ['codex-0.144.cmd']);
  try {
    assert.equal(
      resolveCliBin('codex-0.144', { env: pathEnv([dir]), isWin: true }),
      join(dir, 'codex-0.144.cmd'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a quoted PATH entry still resolves', () => {
  // Hand-edited PATHs quote entries with spaces; cmd.exe strips those quotes,
  // and a resolver that does not silently becomes a no-op for that directory.
  const dir = winDir('afk-res-quoted-', ['kimi.cmd']);
  try {
    // All three wrappings, because the trim/strip ORDER decides them and each
    // order drops a different one: strip-then-trim loses the space OUTSIDE the
    // quotes, trim-then-strip keeps a space INSIDE them, and a dropped entry is
    // a real PATH directory silently vanishing.
    for (const entry of [`"${dir}"`, ` "${dir}"`, `"${dir} "`, `\t"${dir}"  `]) {
      assert.equal(
        resolveCliBin('kimi', { env: pathEnv([entry]), isWin: true }),
        join(dir, 'kimi.cmd'),
        `PATH entry ${JSON.stringify(entry)} must resolve`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveCliBin declines every case that is not its gap', () => {
  const dir = winDir('afk-res-decline-', ['kimi.cmd', 'kimi.exe']);
  try {
    // Not Windows: libuv's POSIX search is correct, so this must be a no-op
    // even when a matching file is sitting right there.
    assert.equal(resolveCliBin('kimi', { env: pathEnv([dir]), isWin: false }), 'kimi');
    // Already a path — the caller chose it.
    const explicit = join(dir, 'kimi.cmd');
    assert.equal(resolveCliBin(explicit, { env: pathEnv([dir]), isWin: true }), explicit);
    // Already extensioned: libuv finds `.exe`, and `.cmd` reaches cmd.exe
    // through the existing EINVAL fallback. Nothing to add either way.
    assert.equal(resolveCliBin('kimi.cmd', { env: pathEnv([dir]), isWin: true }), 'kimi.cmd');
    // Nothing found anywhere -> unchanged, so the honest ENOENT -> "not
    // installed" skip still happens instead of a fabricated path.
    assert.equal(resolveCliBin('nope', { env: pathEnv([dir]), isWin: true }), 'nope');
    // No PATH at all.
    assert.equal(resolveCliBin('kimi', { env: {}, isWin: true }), 'kimi');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
