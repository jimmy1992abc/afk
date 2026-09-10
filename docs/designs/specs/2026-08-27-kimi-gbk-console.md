# Kimi gate: a non-UTF-8 console must not silently destroy a paid review

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: #59. On a Windows console whose ANSI code page is not UTF-8, one
character outside that page in the model's answer crashes the CLI mid-write, and
the gate reports it as a reviewer that gave no verdict.

Depends on #58 (branch `fix/issue-58-kimi-cli-dialect`): until the dialect is
resolved, no review starts on the affected machine at all. This branch is cut
from it and must not regress it.

## Evidence

Reported, not reproducible here (no Windows, and the CLI is a frozen Python
executable that is not installable on this machine):

```text
'gbk' codec can't encode character '−' ... illegal multibyte sequence
→ the gate reports: ERROR: ... produced no verdict line
```

U+2212 is a typographic minus the model wrote unprompted; it is nowhere in the
reviewed diff. Code page 936 is the default on Chinese Windows, and 932/949/950
are the same class. The reporter ruled out `PYTHONUTF8=1`, `PYTHONIOENCODING`,
`chcp 65001` and forcing the PowerShell console encoding — a frozen executable
resolves its own output encoding — and verified the prompt-side mitigation over
several consecutive real reviews.

Verified **here**, by reading the code rather than by reproducing the crash:

- `kimi-gate.mjs` treats a non-zero exit with non-empty stdout as a review. The
  spawn-level guard at `:~400` catches `res.error` and `res.signal` only, so a
  CLI that printed half a review and then died with exit 1 reaches
  `emitVerifiedReview`, and `protocol.mjs:118` accepts it if a verdict word
  appears anywhere in that fragment. This is the mechanism that turns the crash
  into either "no verdict" or, worse, a truncated review presented as one.
- Nothing in the gate reads the encoding fault the transcript carries.

## Frozen issue contract

Acceptance criteria (from #59):

1. On win32 with a console code page that is not UTF-8, the review prompt
   carries an ASCII-punctuation output constraint, stated as a tooling limit,
   explicitly leaving CJK alone. Design mode gets it too — same transport.
2. The code page is probed, not assumed; undetermined on win32 → apply it
   anyway (the constraint costs punctuation, the alternative costs the round).
   Never off win32, never on a UTF-8 console.
3. No other gate's prompt changes by a byte; the shared brief stays
   transport-invariant.
4. A run that ends with no output, or output missing the verdict line, is
   inspected for an encoding-crash signature and names *that* as the cause.
   Platform-independent — not gated on the win32 branch.
5. The branch is testable off Windows: an environment seam, plus
   `--print-prompt` assertions.
6. Tests: a stub that writes a Python `UnicodeEncodeError` to stderr and exits
   non-zero with empty stdout; and the same with stdout truncated mid-review,
   which is the shape the reporter actually saw.

**Contract extension, admitted with its reason.** AC4 covers the empty and
no-verdict paths. The truncated-with-a-verdict-word path is the same defect —
the CLI died mid-write — and it fails *open*, which is strictly worse than the
reported symptom: it would present a fragment as a verdict. It is the same root
cause, the same touched surface, and needs no new dependency. So: **a non-zero
exit never lets stdout be emitted as a review** — scoped in D4, which does not
touch the empty-stdout paths.

Engineering invariants: fail toward less exposure; no silent skip; one
definition of the signature list; the shared prompt untouched.

Non-goals: fixing the CLI (writing stdout with `errors='replace'` belongs
upstream with Moonshot); any general output re-encoding layer; changing the
verdict vocabulary, the marker protocol, or what the review looks for.

Revision 4 — corrected by the adversarial debate (round 1, G1 P1: the design
probed the wrong quantity and failed **open** on the reporter's own
configuration; round 2, G13: the tables still handed an implementer the rejected
probe as the acceptance check; round 3, G15 P1: normalising the *composed*
prompt rewrites operator-supplied paths, and G16: the character set that
actually crashes cp936 is not the one "dashes and quotes" names; round 4, G18:
the placeholder scheme at argument granularity reaches nothing in diff mode, and
G19: the substitution step itself corrupts operands).

## Decisions

### D1 — Probe the ANSI code page — not the console's — and constrain the prompt when it bites

The best-supported quantity is the **ANSI code page (ACP)**, and it is
certainly not the console output code page. The review never touches a console: `spawnOpts`
(`kimi-gate.mjs:320-325`) sets no `stdio`, so stdout is a **pipe**, and a Python
child encoding a piped stdout uses the locale/ANSI page. This is not a
refinement — it is why #59 lists `chcp 65001` under "ruled out, do not
re-chase": `chcp` moves the console page and leaves the ACP at 936, so the crash
survives it.

Probing `chcp.com` would therefore read 65001 on a machine that had applied the
documented-ineffective workaround, withhold the constraint, and lose the review
exactly as reported — while the stderr line claimed the gate had checked. A
fail-open on the one configuration the issue documents.

**How well supported, stated to the same standard as D4.** Three independent
lines back the ACP: the review crosses a pipe in every transport, so the console
page is out of the loop; CPython writes a *console*-attached stdout through
`WriteConsoleW` in UTF-8, so this crash class cannot come from a console stream
at all; and the codec is named `gbk`, which is what CPython's alias table maps
`cp936` onto — the shape of a locale-derived lookup (`GetACP()`), not a literal
someone chose. Against proof, and inside this same document: the Evidence
section records `PYTHONUTF8`/`PYTHONIOENCODING` as ineffective, which stock
CPython would honour for a piped stdout. So this CLI does not take the stock
path, and the stock path is what makes the ACP load-bearing. It is therefore a
**well-corroborated proxy, not a proven mechanism** — strictly better than the
console page, and not the same thing as settled. The residual fail-open (ACP
reads 65001, the CLI crashes anyway) is named in the risks and answered by
`KIMI_GATE_CONSOLE=legacy`.

`lib/gate/console-encoding.mjs`:

- `ansiCodePage({ platform, probe })` → a number, or `null` when it cannot be
  determined. On win32 it reads the ACP from the registry —
  `reg query HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage /v ACP` —
  and takes the value token **only when it is all decimal digits** — `ACP
  REG_SZ 936` → 936. A `REG_DWORD` presentation prints `0x3a8`, which a base-10
  parse would silently read as code page 0: still fail-closed, but the ERROR
  would name a page that does not exist, so it resolves to `null` instead.
  Value names and type tokens are not localised; a denied key, an absent
  `reg.exe`, or any non-zero exit also gives `null`. It reads 65001 correctly
  when the operator has enabled Windows' "Beta: use Unicode UTF-8", which is
  the real remedy. Off win32 it returns `null` and spawns nothing.
- `needsAsciiPunctuation({ platform, codePage })` → true only on win32 when the
  page is not 65001, `null` included — the fail-closed direction: an undetected
  page costs punctuation, an undetected GBK costs the whole round.

### D1b — Which characters actually crash, and the two things built from that

Measured here with the codecs themselves, because the intuitive answer is wrong:

| code page | cannot encode |
|---|---|
| gbk / cp936 (the reporter's) | **U+2212 minus, U+00A0 nbsp** |
| cp932 | U+2013, U+2014, U+00A0 |
| cp949 | U+2010, U+2013, U+2014, U+2212, U+00A0 |
| cp950 | U+2010, U+2015, U+2212, U+00A0 |

On cp936 the em dash, en dash, curly quotes and ellipsis all encode **fine**.
The only two that kill it are the typographic minus — the exact character in the
bug report — and the no-break space. So a mitigation described as "dashes and
quotes" would plausibly omit both: U+2212 is a mathematical operator, not a
dash, and NBSP is neither. The character that produced the report would be
missed by the fix written to prevent it.

**`ASCII_PUNCTUATION_CONSTRAINT`** — the reporter's text verbatim, because it is
the artifact several consecutive real reviews were run through, and a re-invented
level-1 control carries none of that evidence. It names its own reason: a model
told to restrict punctuation for no reason drifts back.

```text
Output constraint (a tooling limit on this machine, not a style preference):
write the review using ASCII punctuation only - a plain hyphen rather than a
minus sign, en dash or em dash, and straight quotes rather than curly ones.
CJK text is fine. A single character outside this set aborts the run and the
entire review is lost.
```

One sentence is **added** to the verified text, marked here as an addition:
`Use ordinary spaces, never a no-break space.` NBSP encodes on none of the four
pages above and the verified text does not cover it; the alternative is to keep
the artifact pristine and knowingly leave a crasher unaddressed. That marking
**ships with the constant**: a comment beside it says which sentences carry the
several-real-reviews evidence and which one does not, or a future maintainer
reads the blob as uniformly verified and the only thing "verbatim" was
protecting is gone. And it is weaker cover than the dash clause either way — an
NBSP is invisible in the model's own output in a way an em dash is not, so D3
and D4 remain the net, not this sentence.

**`toAsciiPunctuation(text)`** — an explicit map, not a category, pinned by the
table above:

| from | to |
|---|---|
| U+2010 … U+2015, U+2212 | `-` |
| U+2018, U+2019 | `'` |
| U+201C, U+201D | `"` |
| U+00A0 | a space |
| U+2026 | `...` |

Anything unmapped is left alone — a review brief is not a transliteration, and
CJK, ASCII and every other character pass through untouched.

Two fidelity notes, since this section's authority is that it was measured.
First, the map is deliberately **broader** than the cannot-encode table: the
curly quotes and the ellipsis encode fine on all four pages, and they are mapped
for a different reason — the constraint text asks the model for straight quotes,
so a brief that itself contains curly ones contradicts its own instruction.
Second, the table lists punctuation only, but cp932, cp949 and cp950 cannot
encode a Chinese `设` either. "932/949/950 are the same class" is true of the
*defect*, not of what is safe to write, and the constraint's "CJK text is fine"
is verified for cp936 — the reporter's page — not universally. `toAsciiPunctuation`
must not try to fix that: transliterating CJK would destroy the review.

### D1c — Normalise the fixed prose, never the interpolated target

`toAsciiPunctuation` runs only when `needsAsciiPunctuation()` is true, and it
runs over the brief's **fixed prose only**. The prompt interpolates operator
input — `target.label`, `target.path`, `target.command` (`kimi-gate.mjs:140`,
`:143`) — and normalising the composed string would rewrite it: a design doc at
`…/规格 — v2.md` becomes `…/规格 - v2.md`, a path that does not exist, *after*
`validateTarget` (`:113-118`) confirmed the real one does. The reviewer then
reports it could not read the document and the gate blames the reviewer — this
issue's own theme, a transport mangling the payload while the reviewer wears the
blame, reintroduced by the fix for it.

So: compose with placeholders, normalise, then substitute the operands —
**per operand, not per argument**. `buildReviewPrompt({ scope, context })` takes
this gate's whole context clause as one argument, so a placeholder standing in
for the entire `context` protects that clause's prose along with its operands,
and the gate's own em dash (`kimi-gate.mjs:140`, `:143`) survives — in diff mode
that is the brief's only non-ASCII character, so the scheme would deliver
nothing at all on the common path. The gate therefore builds its own clause with
placeholders for `target.label`, `target.path` and `target.command`/`inspect`
individually, and passes that; its prose then normalises and its operands do
not.

**Substitute with `split`/`join`, never `String.replace`.** With a string
pattern, `replace` interprets `$&`, `` $` ``, `$'` and `$$` **in the
replacement**, so an operand containing one is silently mangled — and `$$` is a
routine temp-path idiom. Measured here: a label `feature/$&-fix` comes back as
`feature/AFK_SLOT-fix` (the placeholder re-inserted into the brief), a path
`/tmp/a$` + backtick + `b/spec.md` splices in preceding prompt text, and
`run-$$-tmp` collapses to `run-$-tmp`. That is exactly the corruption D1c
exists to prevent, reintroduced by the substitution step. The placeholders are
NUL-delimited, since NUL is the one byte no path or ref can contain, so an
operand can never collide with one.

**Verified implementable against the interfaces as they stand**, which was the
open question — `buildReviewPrompt`/`buildDesignReviewPrompt` interpolate
`scope` and `context` *inside* a module AC3 freezes, so the gate cannot
normalise around them from outside unless it controls what it passes in. It
does: the gate hands the builder slot tokens, normalises the returned brief, and
substitutes afterwards. Prototyped here against the real builder — fixed prose
came back with 0 mapped characters, both operands survived byte-exact (an em
dash inside a CJK path included), CJK untouched, and normalising the composed
string instead corrupted that path, as D1c predicts. `lib/gate/prompt.mjs` is
never imported differently, never edited, and no other gate's brief changes. The shared `DESIGN_FOCUS` em dashes are fixed prose and are still
normalised, so design mode is covered and `lib/gate/prompt.mjs` stays untouched
byte-for-byte — AC3 holds **at the module**; this gate's *delivered* copy of the
shared clauses differs from other gates' on the constrained path, which is the
point of a per-gate transport fix and is stated here rather than left implicit.

The append lands on the `reviewPrompt` binding **after `timeoutMs` is bound
(`kimi-gate.mjs:160`) and before the `--print-prompt` exit (`:168`)**: the probe
is bounded by `preflightTimeoutMs(timeoutMs)`, so wiring it at the composition
point (`:138-145`) would read `timeoutMs` in its temporal dead zone — a
`ReferenceError`, a stack trace, and **no marker block**, the one output shape
this protocol exists to guarantee. Nothing between `:160` and `:168` reads
`reviewPrompt`, and it is already `let`, so the later append is free. Composing
there also keeps `shown()`'s identity-based elision (`:249-250`), `promptBytes`,
and the shim brief consistent for free.

### D2 — `KIMI_GATE_CONSOLE` forces the branch, so it is testable off Windows

`utf8` / `legacy`, replacing the probe. An unrecognised value **stops the
round**, exactly as the sibling seam in this file does (`cli-dialect.mjs`,
`SKILL.md`): silently reverting to probing would discard an operator's explicit
instruction, which AGENTS.md forbids. Two Windows-only paths in this file have
already shipped having never executed anywhere, because the condition cannot be
produced on POSIX. `--print-prompt` then shows the composed brief with no model
call, so the assertion is on the real artifact rather than on a mock.

**What the seam does not prove.** It exercises the *branch*. Nothing off Windows
can show that the probed number is the number governing the child's stdout
encoding — that claim rests on G1's pipe/ACP reasoning and on the reporter's
report, and it stays unverified here. The seam is honesty about coverage, not a
substitute for it.

### D3 — An encoding crash is named, not read as a reviewer failure

One exported signature list — `UnicodeEncodeError`, `UnicodeDecodeError` (the
same crash on the shim path's brief read), `codec can't encode character`,
`illegal multibyte sequence`, `charmap' codec` — matched against the captured
**stderr and stdout**, stderr first, on every failure path: empty output,
missing verdict, and the non-zero exit of D4. AC4 says stdout/stderr and a CLI
that folds its traceback into its transcript stream must not escape the
diagnosis; the cost is that a review *about* encodings could match its own text,
on a path that is an `ERROR` either way. The message names the code page if known and the transcript; the **remedy
depends on which signature matched**, per the split below.

The missing-verdict message is **not the gate's to write** — `protocol.mjs`
owns it, and the gate's one lever, `missingVerdictMessage`, is already spent on
the shim path's "the brief was most likely never read" (`kimi-gate.mjs:487-493`).
So the gate composes that message conditionally, and the remedy is keyed on
**which signature matched**, not merely on whether one did:

- an **encode** failure (`UnicodeEncodeError`, `codec can't encode`) is the
  output-side crash this issue is about → name the ACP, the constraint, and the
  transcript;
- a **decode** failure (`UnicodeDecodeError`) on the shim path is the *same
  event* as a brief that was never read — the gate wrote that file as UTF-8 and
  the CLI could not decode it — so the shim conclusion is the true one and must
  be **kept**, not displaced: name the brief file the gate itself wrote, and
  point at a native executable. An output-punctuation constraint does nothing
  for a brief the CLI cannot read, so outranking blindly would replace a correct
  diagnosis with a misdirecting remedy.

Either way the composed message names the transcript — which today's non-shim
missing-verdict message does not, leaving the operator un-pointed at the log
holding the traceback. Platform-independent: the fault is diagnosable wherever it happens.

It is **not** prefixed `not retryable —`. Unlike a flag disagreement, a retry
can genuinely succeed — the crash depends on which characters the model chose —
so the driver's ordinary transient rule is the right one, and saying otherwise
would strand a reviewer that would work on the next attempt.

### D4 — A non-zero exit never lets stdout be emitted as a review

Scoped exactly, because the unqualified sentence would break two live paths that
also exit non-zero: a non-zero `res.status` **with non-empty stdout** ends as an
`ERROR` naming the exit code, the fact that stdout held a review-shaped
fragment, the transcript, and — when the signature matches — the encoding fault.
It is evaluated **after** the auth skip (`kimi-gate.mjs:434`) and after the
`not retryable —` drift diagnosis (`:460-473`), neither of which it may claim:

- a logged-out Kimi exits non-zero with empty stdout and must stay a `SKIPPED`,
  or the driver stops falling back to another family and burns a sticky retry on
  a round it can never pass;
- the drift diagnosis is #58's control, which this branch must not regress, and
  `SKILL.md` keys the driver's no-retry rule on its prefix.

Both get a regression assertion beside the new tests.

A fragment that happens to contain a verdict word must not be emitted as a
verdict; that is the fail-open half of this bug, and it is strictly worse than
the reported symptom. (A fragment truncated *before* its verdict already lands
on the missing-verdict path — D4 is for the one that got far enough to look
complete.)

**Unverified load-bearing assumption:** that a *successful* kimi review exits 0.
Nothing in this repo, #59, or #58's evidence establishes it, and today's code
never depended on it — `:497` passes `res.status` through only after emitting,
so a benign non-zero exit has been invisible all along. This CLI family is
recorded in this very file as one that "prints its help and exits non-zero"
(`:229-231`). It cannot be settled here: `kimi -p …` is a paid model call. If it
is wrong, every review on that install becomes an `ERROR`, retried once, then
handed to another family. The direction is still right under "fail toward less
exposure", so the mitigation is diagnosability: the `ERROR` says the CLI exited
non-zero *while stdout held a complete-looking review*, and `SKILL.md` says what
an operator seeing that on every review is looking at.

## Files to change

| File | Change |
|---|---|
| `lib/gate/console-encoding.mjs` | new: `ansiCodePage`, `needsAsciiPunctuation`, `ASCII_PUNCTUATION_CONSTRAINT`, `toAsciiPunctuation`, `encodingCrash` (pure but for the injected probe) |
| `lib/gate/console-encoding.test.mjs` | new: probe parsing, fail-closed direction, signature matching |
| `skills/afk-kimi-review/kimi-gate.mjs` | append the constraint and normalise the fixed prose into the `reviewPrompt` binding in both modes (D1c); conditional `missingVerdictMessage` keyed on encode-vs-decode; D3 on every failure path; D4 |
| `skills/afk-kimi-review/SKILL.md` | the constraint, `KIMI_GATE_CONSOLE`, and how to read an encoding ERROR |
| `scripts/kimi-gate.test.mjs` | crash stubs (empty and truncated), `--print-prompt` assertions under the seam, non-zero-exit-is-not-a-review, and the wording of the existing "spawns nothing at all" invariant (`:939-944`), which becomes "spawns no reviewed CLI" |
| `package.json` + manifests | patch bump via `sync-marketplace.mjs` — bump `.claude-plugin/marketplace.json`, the authoritative file, since sync mirrors it OUTWARD and a bump written anywhere else is overwritten by the sync run meant to propagate it |

## Test plan

- `ansiCodePage`, over `reg query` output — NOT `chcp`'s, which D1 rejects:
  a `REG_SZ` line whose value is `936` → 936; a `REG_DWORD` line printing
  `0x3a8` → `null`
  (a base-10 parse would call it code page 0); a non-zero `reg` exit → `null`;
  garbage → `null`; off win32 → `null` and the probe is never called.
- `needsAsciiPunctuation`: win32+936 → true; win32+65001 → false; win32+`null`
  → **true** (fail closed); darwin/linux with any page → false.
- `--print-prompt` under `KIMI_GATE_CONSOLE=legacy` → the constraint is present
  in diff mode and in `--design` mode, and the brief's **fixed prose** carries
  no character from D1b's map — stated that way, not as "the whole prompt is
  ASCII", which a CJK target path makes unsatisfiable and which would contradict
  the next bullet. Under `utf8` → absent and the prompt is byte-unchanged; unset
  off win32 → absent. An unrecognised value stops the round. No other gate's
  `--print-prompt` output changes (assert one, so a future shared-prompt edit is
  caught).
- **A target whose path or label contains a mapped character survives verbatim**
  — `--design '…/规格 — v2.md' --print-prompt` under `legacy` still names the
  real path, em dash intact. This is the regression D1c exists to prevent.
- `toAsciiPunctuation` maps exactly D1b's table and leaves CJK, ASCII and
  everything else untouched, U+2212 and U+00A0 included **because** they are the
  two that cp936 cannot encode.
- An operand containing `$&`, `` $` `` or `$$` survives substitution byte-exact
  — the `String.replace` trap, which corrupts all three.
- **The composed prompt contains no slot token**, asserted on `--print-prompt`
  in *both* modes. `spawnSync` THROWS on a NUL byte in argv rather than
  returning an error, and the gate calls it bare at module top level — so a
  leaked placeholder (a fourth operand added later, or `target.inspect` slotted
  while `target.command` is forgotten) exits with a stack trace and **no marker
  block**. `--print-prompt` prints a NUL harmlessly, so every existing prompt
  assertion would pass, and no `--design` test in the suite ever reaches a
  spawn — a design-mode leak would ship uncaught and surface as a stack trace
  on a paid round.
- In **diff** mode under `legacy`, the gate's own context clause is normalised
  too: the brief's fixed prose carries no mapped character, which per-argument
  placeholders would not achieve (G18).
- A stub emitting `UnicodeEncodeError` on stderr with empty stdout → `ERROR`
  naming the encoding fault, not "produced no final message".
- The same with stdout truncated mid-review **and a verdict word present** →
  `ERROR`, and the fragment is not emitted between the markers.
- A non-zero exit with a complete-looking review → `ERROR`, not a verdict.
  (This test passes whether or not D4's unverified assumption holds — it pins
  the direction, not the premise.)
- **Regressions D4 must not cause:** a logged-out CLI (non-zero, empty stdout,
  auth wording) is still `SKIPPED` and exit 0; a rejected flag (non-zero, empty
  stdout) is still the `not retryable —` drift `ERROR` — #58's control.
- An encoding signature on a **shim** run outranks the "brief was never read"
  message, and every missing-verdict message names the transcript.
- A **decode** signature on a shim run keeps the "brief was never read"
  conclusion and names the brief file, rather than being displaced by the
  output-constraint remedy.
- #58 unchanged: the dialect tests still pass, and the constraint rides inside
  the payload the composed argv carries, whichever transport that is.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| The constraint degrades review quality | Punctuation only; content untouched | It names the reason, so it reads as a tooling limit rather than a style rule |
| `reg` is absent, slow, or the key is missing | Probe returns `null` | Fail-closed to applying the constraint; bounded like the other preflight spawns |
| The probe spawns on the `--print-prompt` dry run, which pins "spawns nothing" | The invariant quietly changes meaning | Restated as "spawns no reviewed CLI"; silence here is how two prior Windows paths shipped broken |
| A successful review exits non-zero (D4's unverified assumption) | Every review on that install errors, retries once, falls back | Named in D4 and in `SKILL.md`, so one round of transcripts identifies it |
| A code page outside 65001 that *can* encode the characters | A needless constraint on that machine | Costs punctuation only; `KIMI_GATE_CONSOLE=utf8` opts out |
| The ACP reads 65001 but the CLI crashes anyway — it resolves its encoding some way this probe cannot observe (the `PYTHONIOENCODING` anomaly) | The constraint is withheld and the round is lost, the G1 shape but far narrower | Named, not assumed away; `KIMI_GATE_CONSOLE=legacy` forces it on, and D3 then names the true cause |
| The model ignores the constraint | The crash still happens | D3/D4 then name the true cause instead of blaming the reviewer — the two halves are independent on purpose |
| Windows-only paths that never execute here | The historic failure mode of this file | D2's seam, and the crash paths are platform-independent |
