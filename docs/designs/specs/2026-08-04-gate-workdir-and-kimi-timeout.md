# A Gate's Temp Directory Is an Outcome, Not an Assumption

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

- **Issues:** [#16 — gates exit with a stack trace and no marker block when TMPDIR is
  missing](https://github.com/AlvinShenSSW/afk/issues/16),
  [#17 — raise the Kimi review timeout default to 45 minutes](https://github.com/AlvinShenSSW/afk/issues/17)
- **Status:** Revision 3 — after adversarial round 1 (W1–W10) and internal review (R1–R3)
- **Author:** Claude (Opus 5)
- **Date:** 2026-08-04

Two small, unrelated changes in one PR. **This deviates from a stated repo rule**
— `AGENTS.md`: "one topic per branch; squash-merge" — and the adversarial round
asserted no such rule existed, which was simply wrong (the same
unverified-claim failure this repo keeps finding). The deviation is declared
rather than quietly kept, and squash-merge means the "independently revertible"
claim an earlier revision made is false of the merged history: one revert takes
both. It is the operator's call at the merge boundary; splitting costs a second
review and gate cycle for two edits that touch disjoint lines
(`kimi-gate.mjs:49,130-136` for #17 vs `:224` for #16).

## Problem — #16

All three CLI gates create their transcript directory with a bare `mkdtempSync`
at module top level. A `TMPDIR` naming a directory that does not exist makes it
throw `ENOENT`, the exception escapes the module, and the gate exits with a raw
stack trace and **no marker block**. Reproduced at `feb3468`:

```text
$ TMPDIR=/nope/does/not/exist/ node skills/afk-kimi-review/kimi-gate.mjs --commit HEAD --implementer codex
Error: ENOENT: no such file or directory, mkdtemp '/nope/does/not/exist/kimi-gate-XXXXXX'
```

Every gate's contract is that every outcome is a parseable block
(`lib/gate/protocol.mjs:5-6`). A driver reading stdout gets silence and cannot
classify the round — the same "broke but does not look like a failure" family as
the two fixes that preceded this one.

## Problem — #17

`DEFAULT_KIMI_REVIEW_TIMEOUT_MS` is 30 minutes. Kimi is the one family that
drives git itself rather than receiving a pre-injected diff, so it does real
work before answering; a bound that kills a still-progressing review wastes the
whole paid call and spends the role's sticky retry, while a looser bound costs
only wall-clock on a review that was failing anyway.

## Frozen contract

1. A gate that cannot create its work directory emits a complete marker block
   with `ERROR`, names the directory it tried, and exits non-zero.
2. This holds for `kimi`, `claude`, and `codex` — the three that call
   `mkdtempSync` — with **one** implementation, not three copies.
3. Kimi's default review bound is 45 minutes; every **live** document and test
   stating the old value moves with it. Shipped design specs are historical
   records and stay as written (W5) — `2026-08-01-bounded-review-gates.md` keeps
   its 30-minute sentence, exactly as it kept a family list that predates
   DeepSeek and MiMo.
4. No other gate's default, the shared 15-minute default, and the 30-second
   preflight cap are unchanged.

Non-goals:

- `lib/gate/spawn.mjs`'s `afk-stdin-` payload directory. It throws the same way,
  but it sits inside `spawnViaShell` on the shell path only, its caller is a
  gate that has already emitted its banner, and wrapping it means inventing a
  second error channel in a function whose contract is "every failure comes back
  as `res.error`". Recorded as out of scope rather than fixed badly.
- The HTTP gates (`glm`, `deepseek`, `mimo`) — checked, they create no temp
  directory.

## Decisions

### D1 — `gateWorkDir(prefix)` → `{ path, error }`, in `lib/gate/workdir.mjs`

```js
const workDir = gateWorkDir('kimi-gate-');
if (workDir.error) emitError(workDir.error, 1);
const work = workDir.path;
```

A **returned result**, not an injected reporter (W1): no `lib/gate` helper
exits — `process.exit` there lives only in `protocol.mjs` (and, outside
`lib/gate`, in `plugin-root.mjs`'s CLI-entry guard) — and every other helper
here hands back a
value for the gate to route — `validateTarget` → `{ok, reason}`, `readDesign` →
`{text, error}`, `spawnViaShell` → `res.error`. A callback that exits would make
this the one exception, and would make its message assertable only by spawning a
gate binary; a result is unit-testable in-process, which is how `readDesign`'s
identical defect class is already covered.

The message names **both** spellings (W2): `os.tmpdir()` reads `TMPDIR` on POSIX
and `TEMP`/`TMP` on Windows, so naming one tells half the operators to change a
variable that is never read.

**Adjacent, closed in the same pass (W4):** `codex-gate.mjs`'s transcript
`openSync` is not a convenience like the other gates' — that fd *is* the child's
stdout and stderr — and it was unguarded two lines below this one. It now
reports instead of throwing.

### D2 — 45 minutes, in one constant

`DEFAULT_KIMI_REVIEW_TIMEOUT_MS = 45 * 60 * 1000`. The value already flows
through `reviewTimeoutMs('kimi')` to the gate, so the constant is the only
behavioural edit; the rest is documentation that currently states 30 minutes:
`kimi-gate.mjs`'s header, `skills/afk-kimi-review/SKILL.md`, `README.md`'s
"Review Timeouts", and the two `scripts/kimi-gate.test.mjs` pins plus
`lib/gate/gate.test.mjs`'s constant-based assertion.

### D3 — Tests

- A gate spawned with `TMPDIR`/`TMP`/`TEMP` pointed at a missing directory emits
  a complete block containing `ERROR`, names the variable to fix, does **not**
  skip, and exits non-zero — asserted for all three gates.
- That test pins every gate's binary (W8, W9). Kimi's availability preflight
  runs *before* `mkdtempSync`, so on a machine with no Kimi CLI — every CI
  runner — it would skip out and the test would fail forever; it gets
  `process.execPath`, whose `--version` satisfies the probe for free. Claude and
  Codex get a path that cannot exist. Without those pins the only thing between
  this test and **three metered reviews** is `mkdtemp` failing, which is
  fail-open on cost: the repo's other gate tests all use a stub or
  `--print-args` for exactly this reason.
- A hermetic unit test on the helper itself: a missing temp root returns an
  error naming the root and both variable spellings, and a good root returns a
  real directory.
- The existing timeout pins move to 45 minutes. The protection is the two
  **literal** pins in `scripts/kimi-gate.test.mjs`; `lib/gate/gate.test.mjs`
  asserts `reviewTimeoutMs('kimi') === DEFAULT_KIMI_REVIEW_TIMEOUT_MS`, which is
  self-referential and cannot detect a value change — an earlier revision
  credited the wrong test. Nothing mechanically ties the prose in README/SKILL
  to the constant; that gap pre-dates this change.
- The absent temp root is **derived per run** (create a temp dir, remove it),
  never a fixed name: a leftover directory from an earlier probe makes
  `mkdtemp` succeed and the test measure nothing. That happened during review.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| The work-dir failure is rare, so the new path is rarely exercised | A wrong error message ships | The test drives the real failure through each gate's real entry point with its binary pinned to something unpayable, so the assertion is real and the cost is not (W9). |
| A longer Kimi bound hides a hung reviewer for 15 more minutes | Wall-clock only | The bound still exists and still ERRORs; the operator can narrow it per run, and a hang was never mistaken for a verdict. |
| Batching two issues in one PR, against `AGENTS.md`'s "one topic per branch" | A single squashed revert takes both; the rule says do not | Declared in the PR and above rather than defended; operator owns it at the merge boundary. |
| `codex-gate.mjs`'s new transcript guard ships untested (R2) | A refactor could drop it unnoticed | Reverting it leaves the suite green — recorded, deferred: forcing an `openSync` failure *after* a successful `mkdtemp` needs an injection seam this script has no honest place for, and inventing a production env knob for one test is the defect the previous run's `KIMI_GATE_FORCE_SHIM` shipped. |

## Adversarial review outcome

**Round 1** (same-model critic) reported W1–W10. Two P1s, both in the test
design rather than the fix — the same blind spot as the last two runs:

- **W8 (P1, fixed):** kimi's availability preflight runs before `mkdtempSync`,
  so on any machine without the Kimi CLI the gate skips and the new test fails
  **on CI, permanently, even after the fix**. Verified by the critic under a
  CI-like `PATH`, and re-verified here with a `PATH` containing only `node`.
- **W9 (P1, fixed):** the test pinned no gate binary, so if the temp override
  ever failed to bite it would spend **three metered reviews** and then be
  killed at the 120s bound — fail-open on cost, against the repo's own rule that
  a test suite is not a place to spend a paid call.
- **W1 (P2, fixed):** the proposed `gateWorkDir(prefix, onError)` would have
  been the only `lib/gate` helper whose failure path is a process exit, and its
  message would have been untestable in-process. Now `{path, error}`.
- **W4 (P2, fixed):** `codex-gate.mjs`'s transcript `openSync` is load-bearing
  (it is the child's stdout and stderr) and was unguarded two lines from the
  site being fixed.
- **W2, W3, W5 (minor, fixed):** both variable spellings in the message; the
  version bump `lib/gate/env.mjs` requires; clause 3 narrowed to live docs.
- **W6, W7, W10 (no finding):** no other family's default or the preflight cap
  moves; the batching is not forbidden by any rule in this repo and the
  findings-batching rule does not apply either way; the three-variable temp
  override is correct on POSIX and sound on Windows.
