# Kimi gate: resolve the CLI dialect instead of assuming one product

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: #58. The gate pins one headless flag table and there are two different
CLIs named `kimi`; on one of them every review dies before the model call.

Revision 5 — corrected by the adversarial debate (round 1: C1, C2, C4 P1;
round 2: C13, C15 P1, C18; round 3: C22 P1; round 4: C25 — each later finding
introduced by the revision before it).

## Evidence

Verified here against installed CLIs. `@moonshot-ai/kimi-code` 0.38.0 (npm,
Node/commander):

```text
$ kimi --version                 → 0.38.0
$ kimi --help                    →   -p, --prompt <prompt>       Run one prompt non-interactively…
                                     --output-format <format>    (text | stream-json)
                                     (no --print, no --final-message-only)
$ kimi --print doctor            → error: unknown option '--print'
                                   (Did you mean --prompt?)
```

`claude` (same CLI family, used below as the hostile fixture):

```text
  -p, --print                             Print response and exit …      # line 139, boolean
                                        --print)                          # line 80, wrapped PROSE
                                        --output-format=stream-json)      # line 96, wrapped PROSE
```

Two facts follow, and Revision 1 got both wrong:

- **A `-p` token says nothing about arity.** kimi-code spells it
  `-p, --prompt <prompt>` (value-taking); claude spells it `-p, --print`
  (boolean, prompt arriving elsewhere — `claude-gate.mjs:222-231` sends a bare
  `-p` and puts the payload on stdin).
- **A line can start with a flag and be prose.** claude's option column is at
  indent 2 and its wrapped descriptions at indent 40, three of which begin with
  `--print)` or `--output-format=…)`.

Reported by a downstream operator, not reproducible here (that product is not
installed): MoonshotAI `kimi-cli` 1.43.0, a frozen Python executable, also named
`kimi`. There `--output-format` is rejected unless `--print` accompanies it —
`Invalid value for --output-format: Output format is only supported for print
UI` — and the operator ran many real reviews end to end with

```text
-p <prompt> --print --output-format text --final-message-only
```

That artifact is **ambiguous**: it is equally consistent with `-p` being a
value-taking prompt flag and with `-p` ≡ `--print` (boolean) plus a positional
prompt. D1 is designed so that **both readings produce a working argv**, which
is why the ambiguity does not have to be resolved to ship.

**Unverifiable here:** the exact layout and arity of `kimi-cli --help`. D1 reads
arity from the help text rather than assuming it, D3 fails visibly, and D5 gives
the operator an override that needs no code change.

## Frozen issue contract

Acceptance criteria (from #58):

1. Dialect resolved from evidence the installed CLI gives about itself, inside
   the existing local preflight — no paid round, no extra model call.
2. Both dialects work end to end; only flags that CLI's own `--help` documents
   are sent (D5's override is the one named exception); neither dialect's flags
   leak into the other's argv.
3. An unresolvable dialect is a named, stop-the-round `ERROR` — never a guess,
   never a `SKIP`. **Refined by D3** on repository evidence: this governs a CLI
   that *answered* and whose answer cannot be used. A CLI that never answered
   has not been read at all, and that is an availability fact, which the
   existing `--version` preflight already disposes of as a skip. The two are
   recorded distinctly and never as each other.
4. A rejected-argument failure is diagnosed as drift whatever wording the CLI
   used, a rejected *value* included. Version and exact argv stay in every
   no-output error.
5. `--print-args` reports the resolved dialect and that dialect's argv; the
   stderr banner prints the argv actually sent, with the prompt elided as today.
6. Tests: a stub per dialect rejecting anything outside its own allowlist in
   that product's real wording; argv asserted by exact composition per dialect;
   a value-shaped rejection diagnosed as drift.
7. Operator-facing text that names an install says which product it means.

Engineering invariants:

- Send only what `--help` documents, D5 excepted and named.
- No silent skip: every new exit states a distinct reason.
- Fail toward less exposure: an unusable answer errors; it never guesses.
- No duplication: the parser and the capability table each have one definition.

Non-goals: the review prompt's content, target resolution, timeouts, the Windows
shim transport itself — its file-on-disk shape, not its flags, which D1
recomposes — and the GBK crash (#59).

Allowed behaviour change: on a `kimi-cli` install the gate now runs where it
previously always errored. On a `kimi-code` install the argv is byte-identical
to today.

## Decisions

### D1 — Compose the argv from what `--help` documents, arity included

Preflight gains one local, free `--help` spawn beside the existing `--version`
one, run with `{ ...process.env, COLUMNS: '200', NO_COLOR: '1', TERM: 'dumb' }`.
The spread is load-bearing, not style: `spawnSync`'s `env` **replaces** the
environment, and a replaced env loses `PATH` — verified,
`spawnSync('kimi', ['--version'], { env: { COLUMNS: '200' } })` → `ENOENT`,
the same call spreading `process.env` → `0.38.0`. Composed with D3's split that
would be a silent, permanent skip of every kimi review on a healthy machine.
The three variables are set because Python help formatters wrap to `COLUMNS`
while commander does not (verified: `COLUMNS=40 kimi --help` is byte-identical
to `kimi --help`), so without them the same CLI parses differently on two
machines — and a narrower terminal produces exactly the wrapped prose lines the
parser must reject.

`documentedFlags(helpText)` returns each documented option with its arity:

1. Strip leading whitespace and box-drawing runes (`│ ┃ |`) together; keep the
   lines whose first character is then `-`. Record each line's indent as the
   **column of that first `-`** — the number of characters stripped, whitespace
   and box runes counted alike. Not the count of leading whitespace: inside a
   box every line's whitespace indent is 0, verified on a rich-style fixture
   where the option lines and a wrapped `--print   (see the print UI)`
   continuation all read 0, so step 5's anchor becomes a no-op and the prose
   flag is harvested. By first-dash column the same fixture reads 2, 2 and 17,
   and the continuation is dropped. Measured after stripping and discarded, the
   anchor is equally dead.
2. The leading run of `-x` / `--long` tokens is the option's spellings. A
   separator of `,` plus whitespace is consumed **by the run** (`-p, --prompt`
   is one option with two spellings); the prose test in step 3 applies only to
   punctuation glued to the end of the run. Reading the separator as prose
   first drops every `-x, --long` option on both real fixtures — including
   `-p, --prompt <prompt>` — which would `ERROR` 100% of installs.
3. A token whose end carries `)`, `.`, `:` or `=` ends the candidate as prose,
   not an option (`--print)`, `--output-format=stream-json)`).
4. The run must be terminated by two-or-more spaces, end of line, or a value
   placeholder (`<…>`, `[…]`, or an UPPERCASE metavar). A placeholder makes the
   option **value-taking**; otherwise it is **boolean**.
5. Anchor on the **option column**: among the lines that survived steps 2–4,
   only those at the minimum recorded indent are options. claude's prose
   continuations sit at indent 40 against an option column of 2. The anchor is
   computed after the token rules, not before, so one dash-leading noise line
   (an `-----` rule, a `- bullet`) above the options block cannot redefine the
   column and drop every option.

`documentedPositional(helpText)` reads the `Usage:` **block** — that line plus
its indented continuations to the first blank line, since argparse and click
wrap a long synopsis — for a prompt-shaped positional, matched
case-insensitively with an optional trailing `...`, over the same metavar
vocabulary step 4 already uses: `prompt`, `query`, `message`, `text`, `input`,
bracketed, angled, or bare uppercase. Lowercase-only would miss `[PROMPT]...`,
which is how Python CLIs render a positional — and the target product is the
Python one.

Bracket groups whose first character is `-` and `{a,b}` choice groups are
dropped **before** the match: argparse renders every option inline with its
metavar, so `[--message MESSAGE]`, `[--input INPUT]` and `[--text TEXT]` would
otherwise each read as a prompt positional and send the prompt into a slot that
holds a subcommand — a guess, where this design's invariant is that an unusable
answer errors. Executed over nine usage lines, the guard flips exactly those
three and leaves `[PROMPT]...`, a wrapped continuation, a `PROMPT` beside a
`--text TEXT` option, and both captured fixtures unchanged. Captured:

```text
Usage: kimi   [options] [command]            → no prompt positional
Usage: claude [options] [command] [prompt]   → a prompt positional
```

The headless argv is then composed from capabilities, not from a product table:

| capability | detected as | sent |
|---|---|---|
| prompt transport | a value-taking `-p` / `--prompt` | `-p <prompt>` |
| prompt transport | else a boolean `-p` / `--print` **and** a prompt-shaped positional in `Usage:` | the prompt as the final positional |
| prompt transport | neither | none — D3 `ERROR` |
| headless mode | `--print` documented | `--print` |
| output format | `--output-format` documented | `--output-format text` |
| final message | `--final-message-only` documented | `--final-message-only` |

The rows are independent and additive, and that is what makes the ambiguity in
the operator's report harmless:

- kimi-code → `-p <prompt> --output-format text`. Byte-identical to today.
- kimi-cli, if `-p` is value-taking → `-p <prompt> --print --output-format text
  --final-message-only` — the operator's verified line exactly.
- kimi-cli, if `-p` is boolean and its usage documents a prompt positional →
  `--print --output-format text --final-message-only <prompt>`.
- kimi-cli, if `-p` is boolean and its usage documents only `[command]` → no
  transport, D3 `ERROR`, D5 the remedy. Guessing here is the `No such command
  'are'` death this gate already shipped once: kimi-code's positional slot is a
  subcommand (`export`, `provider`, `login`, `doctor`, …), so a prompt appended
  there is read as a command, and **no** code in this repo has ever sent a
  positional prompt — `claude-gate.mjs:222-231` puts its payload on stdin, a
  transport this CLI does not have (`kimi-gate.mjs:28-30`).

The **shim path's argv is composed from the same capability set**, with the
one-line brief instruction taking the prompt's slot — flag value or final
positional. `kimi-gate.mjs:180` composes it separately today, and recomposing
only `promptArgs` would leave a kimi-cli reached through a `.cmd` shim
receiving kimi-code flags: the original bug, on the reporter's own platform.

**Why not swap the table to 1.x, or try-then-fall-back.** Swapping inverts who
is broken — `--print` is rejected outright by kimi-code, shown above. Trying a
dialect and falling back on rejection contradicts the rule that a rejected
argument is never retried, and spends a round to learn what `--help` states for
free.

### D2 — `dialect` is a label for the operator, never a branch

The resolution carries a label — `prompt`, `print`, `print-positional`, or
`print-no-final-message` — used in messages, the stderr banner, and
`--print-args`. Nothing branches on the label; argv comes from the capability
table. A label describes what was found; it is never a product identity the
gate then trusts.

### D3 — An answer that cannot be used stops the round; no answer is availability

- The CLI answered `--help` (text on stdout or stderr, whatever the exit code —
  a CLI that prints help and exits 1 has still answered) and the text documents
  **no prompt transport** → `ERROR`, non-zero, naming what was probed, what came
  back, and `KIMI_GATE_DIALECT`. Never a `SKIP`: the binary is present and
  answering, so this is drift, and a skip would hand the review to another
  family and hide it — the concealment #55 removed.
- The probe **timed out or could not spawn** → the same disposition the existing
  `--version` preflight already gives that fact: `SKIP`, this reviewer is
  unavailable, with its own distinct reason naming `--help` (not merely
  "preflight"). Erroring here would invent a new way to wedge a run on a
  first-run PyInstaller unpack or a virus scanner, on exactly the reporter's
  platform. This is a *stable-unavailable* skip in the driver's vocabulary, so
  it falls back to another family by design and keeps doing so — which is
  correct for a CLI that will not answer, and is why the reason string has to
  name the probe: a chronic hang must be visible in one transcript line.

The two are never recorded as each other. This is the distinction the repo's
remote-checks doctrine already draws between a forge's answer and never having
got one.

### D4 — One greppable non-retryable prefix, and a widened drift pattern

Every stop-the-round message from this gate is prefixed `not retryable —`:
the rejected-argument diagnosis, D3's unusable answer, D5's unrecognised
override, and anything added later that the same reasoning covers. `SKILL.md` keys its
"do not retry, do not fall back" rule on that prefix instead of on one exact
sentence, so a message added later cannot silently become retryable. Without
this the driver's default applies (`afk/SKILL.md`: transient `ERROR` → one
sticky retry → fallback), which is the concealment D3 rejects `SKIP` for; the
rule is doctrine the driver follows, not something the helper enforces.

The drift pattern gains the value-rejection dialects (`invalid value for …`,
`… is only supported …`, `unsupported option`). It stays an optimisation over
the mechanism #55 established — version plus exact argv in every no-output
error — and the message now also names the resolved dialect **and its source**,
probed or forced by `KIMI_GATE_DIALECT`. Naming the override unconditionally
would tell an operator whose forced dialect was just rejected to go set the
variable that caused it.

### D5 — `KIMI_GATE_DIALECT` selects a named capability set and replaces the probe

`prompt` (`-p <prompt> --output-format text`), `print` (`-p <prompt> --print
--output-format text --final-message-only`), or `print-positional` (`--print
--output-format text --final-message-only <prompt>`) — defined once beside the
capability table and consumed identically to a probed result. The third value
is not optional: the machine where the parser is defeated is the same machine
whose `-p` arity is unreadable, both facts coming from the same unreadable help
text, so an override missing that shape is missing on precisely the install it
exists for. Setting
it **replaces** the `--help` spawn — that is also the only escape from a CLI
that hangs on `--help`. Unset means probe. An unrecognised value is a config
error that stops the round, so a typo cannot silently restore old behaviour.

This is the named exception to "send only what `--help` documents", and it is
what makes D1's unverifiable-layout risk non-blocking on a machine this repo
cannot test.

### D6 — `--print-args` probes, and says so when it cannot

The argv is a function of the installed CLI, so a `--print-args` that answered
without probing would print a shape no run would send. It probes; with no CLI to
probe it reports `dialect: null`, `args: null`, `fallback: null`, and the
probe's reason, rather than inventing a table. Consequences, all in scope:
`scripts/kimi-gate.test.mjs:201` and `:511` must name a stub, and
`docs/designs/specs/2026-07-18-design-stage-gate.md`'s `--print-args` dry run
now requires an installed CLI.

### D7 — The banner prints what was sent, prompt elided

`kimi-gate.mjs:232-235` deliberately elides the prompt; that stays (a review
prompt on stderr is noise, and the payload is in the transcript). The banner
gains the resolved dialect and prints the composed flags rather than a hardcoded
string, and the shim path re-prints the argv it actually sent, since `sentArgs`
is rewritten at `:280` after the first banner.

### D8 — A CLI that would answer with a transcript is refused, not announced

Without `--final-message-only` a print-mode CLI prints its whole transcript, and
`protocol.mjs:118` accepts any answer containing a verdict *word* — which a
transcript does. So the marker block would carry a transcript as a verdict and
the round would read clean.

Revisions 3–5 handled this with a stderr label plus a reading rule in
`SKILL.md`. The Codex gate refuted that: `SKILL.md:39-41` tells the caller to
redirect **stdout** and read the marker block, so nothing consumes the stderr
line, and AGENTS.md's vocabulary rule forbids crediting a mechanism with a job
nothing performs. A control is available here and is therefore mandatory: the
dialect **resolves to nothing**, before the paid call, with the transcript
hazard named and `KIMI_GATE_DIALECT` as the remedy — every override set carries
`--final-message-only` wherever it carries `--print`, so the remedy cannot land
the operator back in the hazard.

This costs no working configuration: before this change the gate did not run on
a print-mode CLI at all.

**Precedence.** The refusal is emitted after the work directory is resolved:
availability -> environment -> CLI interface. An absent reviewer is a skip
whatever else is broken, and an environment that cannot hold a transcript is
the more fundamental failure — reporting a flag disagreement while the gate has
nowhere to write the evidence for it sends the operator after the wrong fault.
(Found by a cross-file test: a gate pointed at `node`, whose help documents
`-p, --print` and no `--final-message-only`, stopped reporting its missing
`TMPDIR`.)

## Files to change

| File | Change |
|---|---|
| `lib/gate/cli-dialect.mjs` | new: `documentedFlags`, `resolveDialect`, the capability table, D5's named sets (pure) |
| `lib/gate/cli-dialect.test.mjs` | new: parser units over the captured kimi-code and claude help texts |
| `skills/afk-kimi-review/kimi-gate.mjs` | probe in preflight; compose argv; D2–D8; skip message names the npm product |
| `skills/afk-kimi-review/SKILL.md` | dialect resolution, `KIMI_GATE_DIALECT`, the `not retryable —` prefix rule, product naming at `:3` and `:129`, the `:82` remedy (the flag list is derived now, not transcribed), and D8's refusal |
| `scripts/kimi-gate.test.mjs` | **every stub answers `--help` first** (it is now the first spawn); per-dialect stubs; exact-composition assertions; value-rejection drift; unresolvable-answer ERROR; probe-timeout SKIP; spawn count = 1 probe + 1 review |
| `package.json` + manifests | patch bump via `scripts/sync-marketplace.mjs` |

## Test plan

Parser (hermetic, real fixtures):

- kimi-code 0.38.0 help → `-p`/`--prompt` value-taking, `--output-format`
  value-taking, no `--print`, no `--final-message-only`.
- The comma in `-p, --prompt <prompt>` is a spelling separator, and it must be
  read as one **before** it is read as prose punctuation: a rule that checks
  `[),.:=]` first drops every short spelling on both fixtures (observed while
  validating this rule by hand — it yielded no `-p` at all until the order was
  swapped). Both spellings land with the same arity.
- claude help (hostile: boolean `-p, --print`, three wrapped prose lines
  beginning with a flag) → `-p`/`--print` **boolean**, and `--print` is NOT
  harvested from lines 80/96/99.
- A rich/box-drawing block whose wrapped description line begins `--print` →
  `--print` is **not** harvested (asserting "a column was found" passes under
  the broken reading too, so the assertion names the flag); the same for a
  `COLUMNS=40`-style wrapped block.
- `Usage: kimi [OPTIONS] [PROMPT]...` → a prompt positional; a usage block whose
  positional sits on a wrapped continuation line → likewise.
- `usage: kimi [-h] [-p] [--message MESSAGE] {doctor,login}` → **no** prompt
  positional (an option's inline metavar is not a positional), and the same for
  `[--input INPUT]` and `[--text TEXT]`; `usage: kimi [-h] [--text TEXT] PROMPT`
  → a prompt positional, so the guard cannot be a blanket refusal.

D1's rule was executed by hand over both captured fixtures before this revision
was accepted: kimi-code yields `-p`/`--prompt` value-taking with no `--print`
(so today's argv is unchanged), and claude yields `-p`/`--print` boolean with
`--print` **not** harvested from its three wrapped prose lines.

Gate (stubs that answer `--help` with the dialect they claim and reject anything
outside it, in that product's real wording):

- prompt dialect → argv is exactly `-p <prompt> --output-format text`.
- print dialect (value-taking `-p`) → exactly `-p <prompt> --print
  --output-format text --final-message-only`.
- print dialect (boolean `-p, --print`) → `--print --output-format text
  --final-message-only <prompt>`, prompt last, never attached to `--print`.
- help documenting no prompt transport → `ERROR`, non-zero, `not retryable —`,
  no `SKIPPED`, naming the probe and `KIMI_GATE_DIALECT`.
- a stub that hangs on `--help` → `SKIPPED`, and no ERROR.
- a stub rejecting `--output-format` by value, in 1.43.0's wording → drift
  `ERROR`, not "produced no final message".
- a print-mode stub whose help documents no `--final-message-only` → `ERROR`
  before any review spawn, and the review is never attempted (D8).
- `KIMI_GATE_DIALECT=print` against a kimi-code-shaped stub → the print group
  and **no `--help` spawn**; an unrecognised value → `not retryable —` ERROR.
- spawn accounting: exactly one probe and one review spawn, counted in the
  stub's `--help` branch and its review branch separately, so a probe that
  doubled the review cannot pass; and **zero** spawns when the gate is
  disabled, when the independence guard declines, and for `--print-prompt`.
  The probe runs after those exits and after the `--version` preflight, which
  keeps ownership of ENOENT and its product-naming install message.
- a stub reachable only through `PATH` (no `KIMI_GATE_BIN`) still resolves under
  the probe — the test that fails if the probe's env replaces the environment
  instead of extending it (C18).
- usage-line units: `kimi [options] [command]` → no prompt positional;
  `claude [options] [command] [prompt]` → a prompt positional. A boolean `-p`
  with the former → `ERROR`; with the latter → the positional row.
- the shim path (`KIMI_GATE_FORCE_SHIM=1`) against a print-dialect stub sends
  the print group, not kimi-code's flags.

The print-dialect fixtures are labelled **hypothetical** in the test file: their
help text is authored from this design, not captured from 1.43.0. AC2 is
therefore test-verified for kimi-code and report-verified for kimi-cli, and the
claude fixture is the one hostile shape that is real.

## Refuted claims from Revision 1

- *"The prompt transport `-p <prompt>` is common to both dialects."* Refuted by
  `claude --help` line 139 and `claude-gate.mjs:222-231`: `-p` is boolean there.
  Prevented by D1's arity rule and its boolean row, and pinned by the
  claude-fixture parser test.
- *"Prose mentions mid-sentence are therefore not flags"* — true but irrelevant:
  wrapped prose begins lines. Refuted by claude's lines 80/96/99; prevented by
  D1's option-column anchoring and pinned by the same fixture test.
- *(Revision 2) "the claude-shaped reading, which this repo already knows
  works for that shape"* — as a justification for appending a positional
  prompt. Refuted: `claude-gate.mjs:222-231` puts the payload on **stdin**, and
  `kimi --help`'s usage line documents its positional as a `[command]`.
  Prevented by D1's usage-line row and its explicit no-transport `ERROR`.
- *(Revision 2) "A token ending in `)`, `,`, `.`, `:` or `=` ends the candidate
  as prose."* Refuted by running it: the separator comma drops every `-x,
  --long` option on both fixtures. Prevented by step 2 consuming the separator
  before step 3 tests glued punctuation, and pinned by the fixture tests.
- *(Revision 2) "run with a normalised environment"* — read literally, a
  replaced env, which loses `PATH` and (with D3's split) silently skips every
  review. Refuted by experiment; prevented by the spread in D1 and the
  PATH-resolution test.
- *(Revision 3) "the indent is measured before stripping"* — the natural
  reading is leading whitespace, which is 0 for every line inside a box, so the
  anchor dies and prose returns. Refuted by executing both readings over a
  rich-style fixture; prevented by defining the indent as the first-dash column
  and by naming `--print` in that fixture's assertion.
- *(Revision 3) the positional vocabulary was lowercase-only* — it would have
  missed `[PROMPT]...`, the Python rendering, on the one product this row
  exists for. Prevented by reusing step 4's metavar vocabulary.
- *(Revision 4) the positional vocabulary applied to the raw usage line* —
  argparse renders options inline, so three of the five newly adopted words are
  ordinary option metavars. Refuted by executing it; prevented by dropping
  option and choice groups first, and pinned by three usage-line units.
- *(Revisions 3–5) a stderr label plus a `SKILL.md` reading rule is enough for
  the transcript hazard.* Refuted by the Codex gate: the caller is told to keep
  stdout and read the marker block, so nothing consumes the label, and a
  transcript carrying a verdict word would be emitted as a verdict. Prevented
  by D8's refusal, and pinned by a test asserting no review is even attempted.
- *"Unchanged: every existing kimi-gate test that does not assert argv."*
  Refuted: `--help` becomes the first spawn, so every stub that rejects unknown
  flags, hangs, or exits in a failure body changes disposition. The stub surface
  is now a listed change.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| The real `kimi-cli --help` layout defeats the parser | The reporter's machine fails — but with a named ERROR naming the probe and the override | D5, named in the message itself |
| `kimi-cli` takes its prompt on stdin rather than argv or positional | The review runs with an empty prompt | The verdict-line requirement (`protocol.mjs`) rejects an answer that did not follow the brief; the operator's own end-to-end runs are evidence against this shape |
| The extra `--help` spawn | one more local spawn, bounded per-spawn by `preflightTimeoutMs`, so worst-case local preflight is 2× that bound and never reaches a model | D3's skip disposition; D5 removes the spawn entirely |
| A CLI documents both a value-taking prompt flag and `--print`, but rejects them together | argv rejected before the model call | D4 names the argv and the dialect; D5 forces a group |
| `kimi-cli` has a boolean `-p` and documents no prompt positional | The reporter's install errors instead of reviewing | Named `ERROR` with the probe's evidence, and `KIMI_GATE_DIALECT=print`/`print-positional` needs no code change |
| A help text with no `Usage:` line at all | No positional evidence, so a boolean-only CLI errors | Fails closed, with D5 as the remedy |
| A positional named something outside the vocabulary (`[q]`, `[args]`) | Same fail-closed ERROR | D5; widening the list on evidence is a one-line change |
