// spawn.mjs — the one safe way for a gate to launch a CLI.
//
// Node concatenates argv UNESCAPED when `shell: true` (it warns about it,
// DEP0190), and `shell: true` is unavoidable on Windows for a `.cmd`/`.bat`
// shim — which is how npm installs every one of these CLIs. Anything in argv
// that contains a space is therefore torn in half by cmd.exe, and every temp
// path a gate passes runs through the Windows profile directory, so an account
// named "First Last" splits all of them:
//
//   -o ...\First Last\AppData\Local\Temp\gate-x\review.txt
//     -> ['-o', '...\\First', 'Last\\AppData\\...\\review.txt']
//
// which is silent, environment-dependent, and reads like a broken CLI rather
// than a broken invocation. Three rules follow, and this module is where they
// live:
//
//   1. Prefer NO shell. Spawned directly, argv reaches the child verbatim.
//   2. When a shell is unavoidable, quote the command and every argument that
//      needs it. A PAYLOAD (a prompt, a diff, a doc) must never be there at
//      all — quoting cannot save a multi-line string from cmd.exe — so callers
//      put payloads on stdin and keep argv to flags, paths, and refs.
//   3. Under a shell, a payload goes on an INHERITED DESCRIPTOR, never Node's
//      `input`. `input` there is a deadlock: a shim is `cmd.exe -> node`, so a
//      timeout kills cmd.exe while the grandchild lives on holding the stdin
//      pipe, and spawnSync waits on that write forever. A review that overran
//      its timeout hung the gate outright instead of reporting a timeout, and
//      because spawnSync blocks the loop no test-level timeout can cut it.

import { spawnSync } from 'node:child_process';
import {
  closeSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const isWin = process.platform === 'win32';

/** cmd.exe splits on these; a bare `"` we cannot quote safely. */
const NEEDS_QUOTES = /[\s&|<>^()]/;

// cmd.exe expands `%NAME%` BEFORE the child sees argv, and double quotes do not
// stop it — quoting is the wrong tool here, and there is no right one: `%%` is
// an escape inside a .bat FILE, not on a command line (pinned by experiment; it
// arrives as a literal `%%`). A lone `%`, and a pair naming nothing, are left
// alone, so only a `%NAME%` shape is refused. Whether NAME happens to be defined
// in the child's environment is not knowable here, and "undefined today" is not
// a property to build on.
const CMD_EXPANSION = /%[^%]+%/;

/**
 * `res.error.code` when an argument cannot be carried through a shell at all.
 * Gates map this to their protocol's ERROR — it is operator input the reviewer
 * cannot be asked about, not an unavailable reviewer to skip past.
 */
export const UNSAFE_SHELL_ARG = 'ERR_AFK_UNSAFE_SHELL_ARG';

export function quoteForShell(value) {
  const text = String(value);
  // FIRST, before any fast path: a quote is what we cannot quote around. A value
  // holding one is a caller bug we must not paper over by shipping something
  // cmd.exe will re-parse. Checking this after the NEEDS_QUOTES early return
  // covered only quotes that arrived WITH a space — `feature/"test` has no
  // whitespace, so it went out untouched and cmd.exe read the quote as syntax,
  // swallowing the arguments after it. The gate then reviews the wrong target.
  if (text.includes('"')) {
    throw new Error(`cannot pass an argument containing a double quote through a shell: ${text}`);
  }
  if (CMD_EXPANSION.test(text)) {
    // Worse than a mutation: the expansion happens after quoting, so a value
    // holding a space (%PATH% does) is then re-split, and the argument is
    // TRUNCATED at that space rather than merely rewritten.
    throw new Error(`cannot pass an argument containing cmd.exe variable expansion through a shell: ${text}`);
  }
  if (text === '') {
    // An empty arg vanishes under a shell and the NEXT flag silently becomes the
    // value. Callers that cannot tolerate that drop the flag instead.
    return '""';
  }
  if (!NEEDS_QUOTES.test(text)) {
    return text;
  }
  return `"${text}"`;
}

/** Put `fd` on stdin, leaving the caller's stdout/stderr wiring alone. */
function withStdin(stdio, fd) {
  const shared = typeof stdio === 'string' ? stdio : 'pipe';
  const next = Array.isArray(stdio) ? [...stdio] : [shared, shared, shared];
  next[0] = fd;
  while (next.length < 3) next.push('pipe');
  return next;
}

/**
 * Spawn through a shell, with the command and every argument quoted, and any
 * stdin payload handed over as an inherited descriptor rather than Node's
 * `input` (rule 3 above).
 *
 * The payload is spilled to a private temp file, read by the child, and removed
 * before this returns. That file is the same class of secret the caller already
 * writes to its transcript, and it is scoped to the shell path because that is
 * the only path where `input` deadlocks.
 *
 * `spawnImpl` exists for the relay's injected fake; it defaults to spawnSync.
 */
export function spawnViaShell(bin, args, options = {}) {
  const { input, spawnImpl = spawnSync, ...rest } = options;

  // A refusal is reported on the SAME channel as any other launch failure, not
  // thrown. A gate's contract is that every outcome is a parseable protocol
  // block; an exception escaping the spawn call exits with a stack trace
  // instead, and the driver cannot classify a review that never announced
  // itself. Callers already branch on `res.error.code`, so this lands where
  // ENOENT and ETIMEDOUT already do.
  let command;
  let argv;
  try {
    command = quoteForShell(bin);
    argv = args.map((arg) => quoteForShell(arg));
  } catch (err) {
    return {
      error: Object.assign(new Error(err.message), { code: UNSAFE_SHELL_ARG }),
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      pid: 0,
      output: [null, '', ''],
    };
  }

  if (input === undefined || input === null) {
    return spawnImpl(command, argv, { ...rest, shell: true });
  }

  const dir = mkdtempSync(join(tmpdir(), 'afk-stdin-'));
  let fd;
  try {
    const payload = join(dir, 'stdin');
    // spawnSync encodes a string `input` with `options.encoding`; the bytes the
    // CLI reads must not change just because they arrived by a different route.
    // (`encoding: 'buffer'` describes the OUTPUT and says nothing about input.)
    writeFileSync(payload, input, typeof input === 'string'
      ? { encoding: rest.encoding && rest.encoding !== 'buffer' ? rest.encoding : 'utf8' }
      : undefined);
    fd = openSync(payload, 'r');
    return spawnImpl(command, argv, { ...rest, stdio: withStdin(rest.stdio, fd), shell: true });
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── resolveCliBin: the one gap libuv leaves ────────────────────────────────
//
// libuv's Windows PATH search appends `.com` and `.exe` — and nothing else. A
// CLI installed as a bare-named `.cmd` shim, which is what `npm i -g` produces
// for every one of these tools, is therefore ENOENT to a shell-less spawn, and
// every gate reports ENOENT as "not installed": a silent SKIP that hands the
// review to another family while the CLI runs fine in any terminal. The EINVAL
// fallback below cannot help, because Node raises EINVAL only for a command
// string that literally ends in `.cmd`/`.bat` — which a bare name never does.
//
// This closes exactly that gap and nothing else. If libuv could already find
// the name, the name is returned untouched: no machine whose CLI resolves from
// an ABSOLUTE PATH entry may resolve to a different binary tomorrow, and a
// `.exe` that works shell-free must never be displaced by a `.cmd` that needs a
// shell. (libuv also searches the working directory and relative PATH entries,
// which this filter deliberately excludes — those machines do move, away from
// repository-sourced binaries, which is the point.)

/** What libuv itself appends on Windows. One of these exists -> hands off. */
const LIBUV_EXTS = ['.com', '.exe'];
/** The gap: script shims Node refuses to spawn without a shell. */
const SHIM_EXTS = ['.cmd', '.bat'];

/**
 * "Already carries an extension" means one of the four this module reasons
 * about, not "contains a dot" (G15): a versioned bare name like `codex-0.144`
 * is not an executable name, and treating it as one would exclude it from the
 * shim search for nothing.
 */
const RESOLVED_EXTS = [...LIBUV_EXTS, ...SHIM_EXTS];
const hasKnownExtension = (name) => {
  const lower = name.toLowerCase();
  return RESOLVED_EXTS.some((ext) => lower.endsWith(ext));
};

/**
 * A directory named `kimi.exe` is not a candidate: libuv checks the directory
 * attribute and walks past it, so treating it as a hit would hand pass 1 a
 * false positive and hide the real shim pass 2 would have found (G15).
 *
 * TOTAL, deliberately: `throwIfNoEntry: false` suppresses only ENOENT, so an
 * unreadable PATH directory (ACL-denied, a UNC share that refuses credentials)
 * throws EACCES — and this runs at module top level in every gate, where an
 * escaping exception exits with a stack trace and NO marker block, leaving the
 * driver a round it cannot classify. A probe that cannot answer means "not a
 * candidate", never "crash the review".
 */
const isExistingFile = (candidate) => {
  try {
    return statSync(candidate, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
};

/**
 * PATH entries that can safely produce a candidate.
 *
 * An empty entry — a trailing or doubled `;`, routine on Windows — joins to a
 * RELATIVE name, which resolves against the working directory: the repository
 * under review. cmd.exe searches the current directory first, so accepting one
 * would let a hostile branch shipping `kimi.cmd` at its root execute on the
 * reviewing machine. Relative and drive-relative entries are the same hazard,
 * so the filter is positive: absolute or nothing.
 */
export function normalizePathEntry(entry) {
  // trim BOTH sides of the quotes: a leading space before a quoted entry
  // (` "C:\native"`) leaves the quotes in place if stripped first, and an inner
  // trailing space (`"C:\tools "`) survives if trimmed only first. Either shape
  // then fails the absolute test and a real PATH directory silently vanishes.
  return entry.trim().replace(/^"(.*)"$/, '$1').trim();
}

function searchableDirs(env) {
  const raw = env.PATH || env.Path || env.path || '';
  return raw
    .split(';')
    .map(normalizePathEntry)
    // A root-relative `\tools` survives this check and resolves against the
    // current drive. That is a real PATH directory an attacker would need
    // write access to, not repository content — the hazard this filter closes
    // is the working directory, and it is closed (G14).
    .filter((entry) => entry && isAbsolute(entry));
}

/**
 * Resolve a bare CLI name to a concrete Windows shim path when — and only
 * when — libuv cannot find it itself. Returns `name` unchanged in every other
 * case, including a miss, so a genuinely missing CLI still produces the honest
 * ENOENT -> "not installed" skip rather than a fabricated path.
 *
 * `env`, `isWin`, and `exists` are injected so the Windows rules are testable
 * on every platform. Paths are built with the HOST's `join`/`isAbsolute` —
 * which is win32 on Windows, where it matters — rather than a hardcoded
 * `path.win32`, so an injected-platform test builds candidates that can
 * actually exist on the machine running it.
 */
export function resolveCliBin(name, options = {}) {
  const { env = process.env, isWin: onWindows = isWin, exists = isExistingFile } = options;
  if (!onWindows) return name;
  // Already a path, or already carrying an extension: the caller chose it, and
  // libuv (`.exe`) or the EINVAL fallback (`.cmd`) already handles it.
  if (name.includes('/') || name.includes('\\') || hasKnownExtension(name)) return name;

  const dirs = searchableDirs(env);
  for (const dir of dirs) {
    for (const ext of LIBUV_EXTS) {
      if (exists(join(dir, `${name}${ext}`))) return name;
    }
  }
  for (const dir of dirs) {
    for (const ext of SHIM_EXTS) {
      const candidate = join(dir, `${name}${ext}`);
      if (exists(candidate)) return candidate;
    }
  }
  return name;
}

/**
 * Spawn a CLI, preferring no shell and falling back to a quoted shell invocation
 * only when the platform forces it (a Windows script shim cannot start without
 * one — EINVAL since Node 18.20/20.12).
 *
 * Returns `{ ...spawnSyncResult, viaShell }` so a caller can report which path
 * ran without re-deriving it.
 */
export function spawnCli(bin, args, options = {}) {
  const { spawnImpl = spawnSync, ...rest } = options;
  const direct = spawnImpl(bin, args, { ...rest, shell: false });
  if (!(isWin && direct.error && direct.error.code === 'EINVAL')) {
    return { ...direct, viaShell: false };
  }
  return { ...spawnViaShell(bin, args, options), viaShell: true };
}
