# Resolve a Bare CLI Name to a Concrete Windows Path

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

- **Issue:** [#12 — Windows: bare-name .cmd shim installs never reach the #10 shell fallback](https://github.com/AlvinShenSSW/afk/issues/12)
- **Status:** Revision 3 — after adversarial rounds 1-2 (G1–G15); converged on operator instruction
- **Author:** Claude (Opus 5)
- **Date:** 2026-08-04

## Problem

Since #10 the CLI gates spawn without a shell first and fall back to a quoted
shell only on `EINVAL`, which Node raises when the command string *literally
ends in* `.cmd`/`.bat`. A **bare name** never gets there: libuv's Windows PATH
search appends `.com` and `.exe` — and nothing else — so `kimi` on a machine
where npm installed only `kimi.cmd` fails with `ENOENT`, and every gate maps
`ENOENT` to `SKIPPED: … not installed`, a silent fallback trigger, while the
same command typed in a terminal works (cmd.exe applies `PATHEXT`).

The precise gap matters, and round 1 corrected an earlier overstatement here
(G1): libuv is not extension-blind. In-repo proof that it appends `.com`/`.exe`
on Windows: [`lib/gate/git.mjs:7`](../../../lib/gate/git.mjs) spawns bare `git`
with no shell on every platform and every gate depends on it, `git` being
`git.exe` there. The gap is exactly `.cmd`/`.bat` — the shape npm's global
installs produce.

Testable-here evidence: a hermetic probe (temp dir on `PATH` holding only
`probe.sh`) returns `ENOENT` for `spawnSync('probe', {shell: false})` and
succeeds for `spawnSync('probe.sh')` — libuv appends nothing outside its two
hardcoded Windows extensions. The Windows-specific halves (`PATHEXT` in
cmd.exe, `EINVAL` for a shell-less `.cmd` since Node 18.20/20.12,
CVE-2024-27980) are **assumptions carried from #10's Windows evidence** and
this repo's existing `lib/gate/spawn.mjs` comments; they are not re-testable on
this host.

## Frozen issue contract

Acceptance criteria:

1. On Windows, a gate whose CLI is reachable only as `<name>.cmd` (or `.bat`)
   under a bare name resolves to that concrete path, so the existing
   `EINVAL` → `spawnViaShell` fallback fires instead of `ENOENT` → `SKIPPED`.
2. **Additive for every absolute-`PATH` setup.** Any setup whose current
   resolution comes from an absolute `PATH` entry keeps resolving to the *same*
   binary: if libuv can find the name (a `.com`/`.exe` anywhere on such an
   entry), the resolver returns it unchanged (G3). A machine resolving today
   only via a *relative* `PATH` entry (`.\tools`) may move to a `PATH`-sourced
   shim, which is the safe direction and the point of AC6 (G14).
3. Nothing found → the bare name is returned unchanged, so a genuinely missing
   CLI still produces the honest `ENOENT` → "not installed" skip.
4. Non-Windows behavior is bit-for-bit unchanged.
5. `kimi`, `claude`, and `codex` gates all use the shared resolver; `codex`
   keeps its existing `%APPDATA%\npm\codex.cmd` probe at its existing
   precedence.
6. **No candidate outside `PATH`.** Any path the resolver *newly introduces* is
   absolute and comes from an absolute `PATH` entry; the working directory is
   never searched (G2). Every other branch returns the bare name, after which
   libuv's own search applies unchanged (G14).

Engineering invariants:

- **One implementation.** The resolver lives beside the spawn rules it exists
  to satisfy (`lib/gate/spawn.mjs`) and is imported, never copied.
- **Never substitute a different tool.** Resolution only concretizes a name the
  caller already chose; a value containing a path separator is returned as-is,
  and a `*_GATE_BIN` override is resolved but never overridden.
- **Testable off-Windows.** Platform, environment, and the existence check are
  injected, so the resolution rules are exercised on every OS; only the
  end-to-end gate behavior is Windows-gated.

Non-goals:

- No change to `spawnCli`/`spawnViaShell`/`quoteForShell` semantics, the
  fallback chain, gate protocols, or any skip/error classification.
- `skills/afk-agent-relay/lib/codex_provider.mjs` is **not** in scope: it
  spawns through `spawnViaShell` on Windows, so cmd.exe already resolves its
  bare name via `PATHEXT`. It has the same shape, not the same bug.
- No `where.exe`/`which` subprocess: an availability probe must not itself
  depend on another PATH lookup, and a spawn per gate startup is cost for
  nothing.

## Decisions

### D1 — `resolveCliBin(name, { env, isWin, exists })`

The resolver's whole job is to **cover the gap libuv leaves**, not to
re-implement PATH search. Exported from `lib/gate/spawn.mjs`:

1. Not Windows → return `name` unchanged (libuv's POSIX search is correct; AC4).
2. `name` contains `/` or `\`, or already carries an extension → return
   unchanged. A path is already a path; an extensioned bare name is either
   found by libuv (`.com`/`.exe`) or hits `EINVAL` and reaches cmd.exe through
   the existing fallback (`.cmd`/`.bat`).
3. Collect `PATH` entries: split on `;`, **drop empty entries**, strip
   surrounding double quotes, and keep only those that yield an **absolute**
   candidate (G2, G5). Empty entries are the security hazard: `win32.join('',
   'kimi.cmd')` is `'kimi.cmd'`, which `existsSync` resolves against the
   working directory — the repository under review — and cmd.exe then runs from
   the current directory. A gate that reviews untrusted branches must never
   take a candidate from one.
4. **Pass 1 — would libuv find it?** If any surviving directory holds
   `<name>.com` or `<name>.exe` (libuv's two hardcoded Windows extensions),
   return `name` unchanged. Today's resolution is preserved exactly, including
   which directory wins (AC2, G3).
5. **Pass 2 — the gap.** Otherwise return the first existing
   `<dir>\<name>.cmd` or `<dir>\<name>.bat` in `PATH` order, `.cmd` before
   `.bat` within a directory.
6. Nothing found → return `name` unchanged (AC3).

Extension-major rather than directory-major is the correction from round 1
(G3). Directory-major would have moved a machine whose earlier `PATH` entry
holds `kimi.cmd` and whose later entry holds `kimi.exe` off its working,
shell-free `.exe` and onto the shell path — a displacement, not a widening.
The cost is a deliberate divergence from cmd.exe on exactly that machine (the
terminal would run the `.cmd`, the gate runs the `.exe`); preserving a working
resolution outranks matching the shell, and the `.exe` is the safer transport.

`PATHEXT` is deliberately **not** consulted (G6): the gap is precisely the two
shim extensions npm produces, and hardcoding them keeps the candidate set —
and therefore the tests — free of a user-configurable variable that neither
libuv nor this fix actually depends on. Candidates are built with the **host's**
`join`/`isAbsolute` — which *is* win32 on Windows, where it matters — rather
than a hardcoded `path.win32`: pinning win32 would make an injected-platform
test on macOS build `\var\folders\…` candidates that cannot exist, testing a
fiction. Both modules reject the shapes AC6 excludes (`C:kimi.cmd`,
`.\tools\…`), so the security filter holds under either.

### D2 — Call sites

- `skills/afk-kimi-review/kimi-gate.mjs`: `resolveCliBin(KIMI_GATE_BIN || 'kimi')`.
- `skills/afk-claude-review/claude-gate.mjs`: same for `claude`.
- `skills/afk-codex-review/codex-gate.mjs` `resolveCodex()`: env override →
  existing `%APPDATA%\npm\codex.cmd` probe → `resolveCliBin('codex')`. The
  existing precedence is **kept** (G12): reordering PATH above the APPDATA
  probe would change which codex binary reviews on a machine holding both, and
  this issue is about machines where nothing resolves at all.

An override that is a bare name is resolved too — it hits the same bug
otherwise, and resolution can only concretize the name given, never swap it.

### D3 — Tests

Platform-injected unit tests in `lib/gate/spawn.test.mjs`, running on every OS
via `isWin: true` and a synthesized `PATH` over real temp files: `.cmd`-only
resolves to the `.cmd`; a `.exe` anywhere on `PATH` returns the bare name
unchanged **even when an earlier directory holds a `.cmd`** (the G3
regression); empty `PATH` entries never produce a candidate even when the
working directory holds a matching `.cmd` (the G2 hazard, asserted with `cwd`
set to that directory); quoted entries; a path-bearing name; an
already-extensioned name; a miss; and the non-Windows no-op.

End-to-end (AC1), Windows-gated and skipped elsewhere (G12): extend the
existing stub-reviewer test in `scripts/kimi-gate.test.mjs` so the stub is
named `kimi.cmd` and reached through `PATH` with **no** `KIMI_GATE_BIN` — the
one test that drives resolution → `EINVAL` → `spawnViaShell` → a completed
review. The test overrides whichever `PATH`/`Path` key the inherited
environment already uses, case-insensitively (G11). A matching Windows-gated
`--print-args` assertion covers the codex and claude call sites (AC5).

## Files to change

| File | Change |
|---|---|
| `lib/gate/spawn.mjs` | Add and export `resolveCliBin`. |
| `lib/gate/spawn.test.mjs` | Resolution rules, platform-injected. |
| `skills/afk-kimi-review/kimi-gate.mjs` | Resolve the bin (bare `kimi` or override). |
| `skills/afk-claude-review/claude-gate.mjs` | Same for `claude`. |
| `skills/afk-codex-review/codex-gate.mjs` | `resolveCodex()` gains `resolveCliBin('codex')` **below** the existing `%APPDATA%` probe; precedence unchanged (G13). |
| `scripts/kimi-gate.test.mjs` | Windows-gated end-to-end resolution test (AC1). |
| `scripts/codex-gate.test.mjs`, `scripts/claude-gate.test.mjs` | Windows-gated `--print-args` call-site tests (AC5). |
| `scripts/gate-test-env.mjs` | `pathKey()` — override `PATH`/`Path` by the inherited key's case (G11). |
| `package.json` + manifests | Patch bump via `scripts/sync-marketplace.mjs`. |

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| The Windows halves (cmd.exe `PATHEXT`, `EINVAL`) cannot be re-tested on this host | A wrong assumption ships | Both are load-bearing in shipped code and were exercised by #10's Windows run. Pass 1 makes the change **additive by construction** (AC2): a machine that resolves today resolves identically after, so a wrong assumption about the `.cmd` path costs at most today's `ENOENT` → skip on machines that already fail. |
| Resolution diverges from the terminal when an earlier `PATH` entry holds `.cmd` and a later one `.exe` | The gate reviews with the `.exe`, the terminal runs the `.cmd` | Deliberate (G3): preserving a working, shell-free resolution outranks matching cmd.exe, and no machine's current reviewer changes. Stated in D1 and pinned by a test. |
| On a `.cmd`-only machine kimi always takes the stdin path, where a non-ASCII path or branch name is a hard `ERROR` | A previously "unavailable → fall back" machine now fails the round instead of skipping (G7) | Correct direction — the reviewer really is available and really cannot carry that payload (#10's deliberate choice); the gate's error already names the cause and the fix. Bounded to non-ASCII operator data on machines with no `.exe`. |
| Claude on a `.cmd`-only machine now runs, and the shell path drops `--setting-sources ""` | The reviewer loads the operator's own settings (G8) | Pre-existing #10 behavior on the shell path; the read-only boundary is `--tools Read,Grep,Glob` plus safe mode, which is unaffected. Newly *reachable*, not newly permissive. |
| A resolved path contains `%` or `"` | `quoteForShell` refuses it, gate ERRORs | Existing, deliberate behavior (#10): a clear error beats a mangled invocation. |
| Extra `existsSync` calls at startup | Negligible | Bounded by `PATH` entries × 4 extensions, only on Windows, only for bare names. |

## Adversarial review outcome

**Round 1** (same-model critic; lenses: resolver correctness, does-the-fix-reach-
the-fallback, relay scope claim, regression surface, test adequacy) reported
G1–G12. Two were admitted P1 and both are fixed by the same simplification:

- **G2 (P1, security):** rule 4 admitted empty `PATH` entries, whose join is a
  *relative* name resolved against the working directory — the repository under
  review — after which cmd.exe's current-directory-first search executes it. A
  hostile branch adding `kimi.cmd` at repo root would have run on the review
  machine. Fixed: empty entries dropped, quotes stripped, absolute-only
  candidates, and a test that asserts a matching `.cmd` in `cwd` is never
  chosen.
- **G3 (P1):** the Risks table claimed the change "only widens"; directory-major
  resolution in fact *displaces* a working later-`PATH` `.exe` with an earlier
  `.cmd`. Fixed by extension-major resolution (pass 1 returns the name
  unchanged whenever libuv could find it), which makes the claim true by
  construction.
- **G1 (P2, fixed):** the stated mechanism ("appends no extension") was wrong —
  libuv appends `.com`/`.exe`; the gap is exactly `.cmd`/`.bat`. Corrected with
  in-repo proof (`lib/gate/git.mjs:7`).
- **G4 (P2, fixed):** AC2 no longer claims to mirror cmd.exe; excluding the
  working directory is now a stated decision rather than an omission.
- **G5 (minor), G6 (P2), G11 (P2) fixed:** quoted `PATH` entries stripped;
  the join module pinned to the HOST's (win32 where it matters) so
  injected-platform tests build candidates that can exist; `PATHEXT` dropped from the design entirely; the Windows test
  overrides `PATH`/`Path` case-insensitively.
- **G12 (P2, fixed):** AC1 gains a real end-to-end test (stub named `kimi.cmd`,
  reached through `PATH`, driven to a completed review), AC5 gains codex/claude
  call-site coverage, and `resolveCodex()` keeps its existing precedence so no
  machine's codex binary changes.
- **G7, G8 (P2/minor, fixed as declared risks):** both consequences of the
  gate now actually running are recorded in the Risks table above.
- **G9, G10 (no finding):** the resolved value reaches every spawn and error
  branch in all three gates, and the relay's out-of-scope claim was verified
  correct (it shells on Windows, so cmd.exe resolves its bare name).

Round 2 revalidates G1–G12 against this revision by name before implementation.

**Round 2** (same critic, against Revision 2) resolved G1–G12 by name — both
round-1 P1s structurally, not by patch — and reported three findings in the
revision's own text:

- **G13 (P2, fixed):** the Files-to-change row still carried Revision 1's
  "PATH×PATHEXT above the APPDATA probe", contradicting AC5, D2, and the G12
  resolution in three other places. An implementer following the work list
  would have shipped the exact codex precedence change this revision withdrew.
  The row now says `resolveCliBin('codex')` **below** the APPDATA probe, and
  the missing test-file rows are added.
- **G14 (minor, fixed):** AC2 and AC6 were absolute where the algorithm is
  conditional. A machine resolving today only through a *relative* `PATH`
  entry may move to a `PATH`-sourced shim — the safe direction, and the point
  of AC6 — and four of six branches return the bare name rather than a path.
  Both criteria are scoped accordingly; the surviving root-relative `\tools`
  case is noted in code as a `PATH` directory, not repository content.
- **G15 (minor, fixed):** "already carries an extension" now means one of the
  four extensions this module reasons about, so a versioned bare name
  (`codex-0.144`) is not excluded from the shim search; and the existence
  predicate is "is an existing **file**", so a directory named `kimi.exe`
  cannot give pass 1 a false positive that hides the real shim.

Debate closed here on the operator's convergence instruction: both P1s are
resolved and stable, G13–G15 were fixed directly and verified by reading the
artifacts they name, and no load-bearing claim remains unverified beyond the
Windows assumptions declared in Problem and Risks. Any further non-P1 finding
is recorded with a Deferred disposition rather than opening another round.
