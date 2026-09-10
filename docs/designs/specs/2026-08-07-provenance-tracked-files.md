# Provenance scan: tracked files only, exact self-exemption

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#27 (from the #19 audit; the always-red local scan was
verified by execution — 10 findings from gitignored `.afk/runs/**` on a clean
checkout, training operators to ignore the one scanner that must stay
credible). Mechanical scope; brief design per the scaling rule.

## Frozen issue contract

Acceptance criteria:

1. Candidates come from `git ls-files` (tracked files only), so local and CI
   scan the same set: gitignored operator state (`.afk/runs/**` ledgers,
   `.env`) is never scanned, and "local mirrors CI" becomes literally true.
2. The self-exemption matches exactly `scripts/scan-provenance.mjs` and
   `scripts/scan-provenance.test.mjs` — the basename-prefix rule was a
   tree-wide filename bypass of every rule.
3. Tests pin: an ignored/untracked file is not scanned; a
   `scan-provenance*`-named file anywhere else IS scanned; the two exact
   self paths are exempt.
4. Denylist decision, recorded: the `.afk-provenance-denylist.txt` loader is
   **removed** — the file has never existed (the rule checks nothing in CI),
   and committing it would publish the very terms it hides while flagging its
   own defining lines forever. The `extraTerms` mechanism stays and is fed
   from `AFK_PROVENANCE_DENYLIST` (comma/newline-separated, env-only) — the
   CI-secret-friendly source the audit suggested, with nothing committed.
   The env parser is exported as `parseDenylistEnv(value)` and unit-tested
   directly (R1-F6: the CLI hardcodes its own repo root, so the env path
   cannot be exercised against a fixture through it). No `#`-comment filter
   for the env source (R1-F7: comment lines were a file-format concept; in
   an env var they silently eat legitimate `#`-prefixed terms) — split on
   `/[\n,]/`, trim, drop empties.
5. Fail direction: `git ls-files` failing (not a repo, git absent) is a
   nonzero error with a distinct reason — a scanner that silently scans
   nothing and exits 0 is worse than none. The exported `scanProvenance`
   throws (the old `existsSync → return []` guard folds into the throw:
   a mistyped rootDir must not exit clean); the CLI catches and exits 2.
   A listed entry that cannot be read (`ENOENT` — a tracked file `rm`'d
   without `git rm`; its blob still ships) prints a stderr warning instead
   of being silently skipped (R1-F1); directories (gitlinks, a trailing-NUL
   empty entry resolved away before joining) are expected non-files and are
   dropped with a comment. Tracked **symlinks** are scanned as their link
   text via `readlinkSync` (R1-F2: a link whose target is a home-directory
   path ships that verbatim local path as its blob — bytes the
   target-following read, or CI's missing target, would never see; the new
   scanner caught this very spec's own literal example of one, proving the
   rule). Conflicted paths are deduped (`ls-files` lists one entry per
   merge stage).
6. Version bumped 0.4.10 → 0.4.11 (scripts/ ships) with manifests synced.

Engineering invariants: dependency-free; shell-less `execFileSync('git',
['ls-files', '-z'], { cwd: rootDir, … })` — the `cwd` is load-bearing
(R1-F3: without it, an invoker in any other repo enumerates THAT repo,
every join misses, and the scan silently exits 0 — the exact failure AC 5
forbids); binary-extension filter retained; no silent skips.

Non-goals: new rule classes (public-IP/IPv6 widening stays a separate
decision recorded in #19); the email/IP/path regexes; check-links (its own
audit item recommended the same move — out of scope here).

## Design

- `findTextFiles` (FS walker) is replaced by a `git ls-files -zs`
  enumeration (`{ cwd: rootDir }`; `-s` yields mode bits, so symlinks
  (120000 → scan link text) and gitlinks (160000 → drop, no spurious
  warning for uninitialized submodules — R2-N2) classify exactly, no lstat
  heuristics): NUL-split with empties dropped, Set-deduped, binary-ext
  filtered, exact-path self-exemption (`scripts/scan-provenance.mjs`,
  `scripts/scan-provenance.test.mjs`), resolved against `rootDir`. Per
  AC 5: ENOENT on a listed regular entry warns to stderr. The symlink
  fixture test is win32-skipped (R2-N1: symlinkSync needs developer mode
  there; the scanner itself is safe under core.symlinks=false — the link
  text materializes as a plain file and gets scanned as shipped bytes).
- `loadDenylist` and `DENYLIST_FILE` are deleted; the CLI reads
  `AFK_PROVENANCE_DENYLIST` through the exported `parseDenylistEnv`
  (split `/[\n,]/`, trim, drop empties — no comment filter, per AC 4).
- Tests migrate from the temp plain dir to a temp **git fixture repo**
  (R1-F4/F5, enumerated): `before()` does `git init -qb main`; the fixture
  helper becomes `writeTracked` = write + `git add -f --` (the `-f` guards
  against a dev machine's global `core.excludesFile` silently vacating a
  fixture — executed evidence; staging alone suffices, `ls-files` lists
  staged-but-uncommitted files, so no commits and no identity config);
  a separate `writeUntracked` writes without adding. Tests 1-7 migrate
  mechanically; the basename-exemption test INVERTS (a
  `scan-provenance-notes.md` elsewhere IS scanned) plus two fixtures at the
  exact self paths → exempt; the `.git` worktree-pointer test is DELETED
  with a rationale line (git refuses `.git` path components, and
  enumeration makes it structurally moot — `writeFixture` there would
  EISDIR-crash); the binary test stays tracked; a symlink fixture pins the
  link-text scan (merge-state fixtures are overkill — the dedupe is a
  one-line Set); not-a-repo dir (fresh mkdtemp, no init) → throws;
  `parseDenylistEnv` unit cases.

## Test plan

Per AC 3/4/5 above, plus: the CLI on this repo exits 0, verified as a
driver step, not a spawned suite test (R1-F8: an ambient
AFK_PROVENANCE_DENYLIST on a dev machine would turn a clean tree red —
the exact trains-you-to-ignore-red failure this issue kills). Full suite
green by exit code. Favorable property recorded (R1-F11): local scans
index ∪ working-copy content of tracked paths — a strict superset of CI's
HEAD checkout, diverging only in the fail-closed direction.

## Debate record

- R1 (6×P2 + 4 minor, all precision fixes; core moves survived): F1
  deleted-but-staged rationale refuted by execution (never listed) → ENOENT
  warning instead of silent skip; F2 symlink link-text blindness (CI-green
  on the exact leak class) → readlink scan; F3 cwd omission in the frozen
  invariant → written in; F4 unmigratable/inverting tests enumerated; F5
  global excludesFile fixture hazard → `git add -f --`; F6 env path
  untestable via the CLI → exported parser; F7 #-filter eats legitimate
  env terms → dropped; F8 ambient-env hermeticity → driver-step
  verification; F9 merge-stage triplication → Set dedupe; F10 trailing NUL
  → drop empties. F11 completeness clean.
- R2: F1-F10 resolved by name — clean round. Two sanctioned minors folded
  in: N1 win32 skip on the symlink fixture; N2 `ls-files -zs` mode bits
  replace lstat heuristics (exact symlink/gitlink classification).
  Implementation starts here.
