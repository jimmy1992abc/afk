# Ordered External Gate List

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

> **Superseded in part by
> [`2026-08-18-remote-checks.md`](2026-08-18-remote-checks.md).** The per-run
> remote-CI exception described below — `remote CI not run` with
> operator-authorized local gates — is retired. A revision's checks are now
> always read, and only `remote-ci` decides what an empty or unanswered reading
> means.

- **Issue:** [#1 — default double external gates: Codex outer, Kimi final](https://github.com/AlvinShenSSW/afk/issues/1)
- **Status:** Revision 14 — shared notice mechanism added after final-review P2
- **Author:** Codex
- **Date:** 2026-08-01

## Problem

AFK currently treats PR reviewers as an interchangeable pool selected by
`priority`, `min-pass`, and `mode`. Its default requires one gate. Raising only
`min-pass` to two does not express the product decision: Codex is the preferred
first reviewer, Kimi is the final reviewer after outer findings are resolved,
and both clean verdicts must cover the same final PR revision.

The repository ships workflow skills, not an orchestration runtime. Selection,
ordering, and restart behavior are level-3 driver doctrine. Artifact tests can
pin what active skills instruct; they cannot prove that every host obeys it.

## Goals

1. New/unconfigured AFK repositories default to Codex outer, then Kimi final.
2. The two roles are sequential and use model families distinct from each other
   and from the implementer.
3. Every required clean verdict covers the same clean `HEAD`, immutable base,
   and diff.
4. Existing configs with explicit external-gate fields keep their old reviewer
   count and ordering until the operator opts in. Existing configs with no gate
   decision receive the new default required by issue #1.
5. The opt-in design-stage gate remains separate, default-off, and one review
   per design version.

## Non-goals

- No changes to Codex, Kimi, Claude, or GLM provider invocation, implementer
  guard, read-only boundaries, authentication, binary overrides, model pins,
  marker protocol, or provider routing.
- No new model-family attestation system. Gate helper identity and the
  operator's installed local binaries/configuration remain trusted inputs, as
  they are now. Where a helper already emits model-identity evidence (currently
  Claude), the ledger preserves it; this issue does not generalize that
  mechanism to every provider.
- No drift sandbox, content-manifest runtime, target-echo protocol, or new
  selector executable. Issue #1 explicitly defines role orchestration as AFK
  driver doctrine rather than an external non-bypassable control point; adding
  unused runtime-looking modules would not change that authority boundary.
- No automatic provider installation, deployment, or rewrite of historical
  design documents.

## Decisions

### D1 — One ordered `gates` field expresses roles and count

The new active configuration example is:

```markdown
## external gate
gates:    codex > kimi
priority: codex > claude > kimi > glm
```

`gates` is an ordered list of preferred required roles:

- the first item is `outer`;
- the last item is `final` when the list has at least two items;
- items between them are stable `intermediate-1`, `intermediate-2`, … roles;
- a one-item list is an explicit single outer gate;
- roles always run in order, so final is never parallelized.

The list length is the required count. This avoids a three-field interaction
between `outer`, `final`, and `min-pass`: count and order cannot disagree.
`priority` remains the ordered fallback pool for an ineligible or unavailable
preferred provider; it does not add required roles.

Grammar is one logical line: ASCII `>` separators, optional surrounding
whitespace, case-insensitive tokens normalized to lowercase, and an optional
trailing `#` comment stripped before parsing. The valid gate-family vocabulary
is defined in D2; other nonempty tokens parse but are recorded as ineligible
preferences so fallback can recover. Empty segments (including leading,
trailing, or doubled separators) are syntax errors.

The legacy `min-pass` and `mode` fields remain supported only when `gates` is
absent. When `gates` is present, the driver records that legacy `min-pass`/`mode`
are ignored. The new template omits both fields. Ordered roles are deliberately
waterfall-only; there is no misleading `parallel` option whose default two-role
profile could not use.

### D2 — Compatibility is based on whether `gates` exists

Configuration precedence is deterministic:

1. No config file: use built-in `gates: codex > kimi` plus built-in priority and
   emit D6's bounded existing/unconfigured cost notice at first AFK entry. A
   newly bootstrapped config already contains the same explicit `gates` value.
2. A config containing `gates`: use that ordered role list. If legacy
   `min-pass` or `mode` also exists, preserve the file but ignore those fields
   for PR roles and record a compatibility notice.
3. An existing config without `gates` but with at least one legacy external-gate
   field (`priority`, `min-pass`, or `mode`): preserve complete legacy behavior.
   If `min-pass` is omitted, retain the legacy default of one gate; do not
   silently double spend.
4. Every remaining config has no gate decision and receives the built-in ordered
   default. This includes blank/command-only files and an `## external gate`
   section containing only non-profile keys such as `design-gate` or
   `implementer`; those keys never select PR reviewer count/order.

For this classification, keys are read from the `## external gate` section;
same-named keys such as `mode:` under another heading do not select a gate
profile. Existing generated configs already use that heading. The shared config
library gains section-scoped presence/value readers for this new classification
without changing the legacy whole-file reader used by existing consumers.

`gates` must contain one or more entries. An unknown provider name is an
ineligible preferred provider for that slot, so normal fallback may fill it and
the typo is recorded. If the `gates` key is present but empty or syntactically
malformed, configuration fails closed: record the error and leave the PR plan
unready. It never falls through to legacy one-gate behavior. A duplicate
preference is treated as ineligible for every later duplicate slot; normal
fallback must fill that slot or leave the plan unready. The `gates` vocabulary
is exactly the four families with gate helpers: `codex`, `claude`, `kimi`, and
`glm`. A known implementer-only family such as `gemini` or `copilot` is reported
as "no gate helper", not as an unknown typo. More than four requested roles is
a blocking configuration error; four can be valid for an implementer outside
the gate-family set, while kickoff capacity checks may reject it for a gate-
capable implementer.

When a config contains both `gates` and a legacy `min-pass` whose value is
larger than the ordered list, kickoff labels the change an explicit coverage
downgrade and requires operator confirmation before starting an issue. A legacy
`mode: parallel` paired with ordered gates likewise receives a behavior-change
confirmation because ordered roles are waterfall-only. The file remains
unchanged; confirmation and the effective profile are recorded in the ledger.

### D3 — Assign every role atomically before paid review

The driver performs a cheap provider-presence preflight and complete assignment
calculation during every AFK kickoff, after resolving config and the implementer
but before selecting or starting an issue. Presence uses only the locally
observable, non-metered evidence each shipped helper actually exposes:

- Codex: gate enabled, helper/provider executable resolves, and `codex login
  status` reports logged in;
- Claude: gate enabled, helper/provider executable resolves, and any explicit
  `CLAUDE_REVIEW_MODEL` is a pinned ID rather than a rejected alias; auth,
  credit, network, and returned model identity remain first-call evidence;
- Kimi: gate enabled and helper/provider executable resolves; auth, credit,
  network, and model access remain first-call evidence;
- GLM: gate enabled and a nonempty `ZAI_API_KEY` or `GLM_API_KEY` is found in the
  environment or the helper's existing `.env` search locations (current working
  directory, git top level, or main worktree); key validity remains first-call
  evidence.

Presence does not make a stronger remote-availability claim. Only Codex exposes
a local auth probe; the other providers may fail later on first invocation.
If the presence plan cannot fill every role, kickoff records and surfaces an
anticipated readiness blocker but does not prevent safe issue work; this
preserves the shipped AFK behavior and issue #1's actual bar (never mark one gate
as double-gate ready). On a resumed run, the calculation covers only roles not
already clean at the current HEAD/merge-base stamp. The full eligibility plan is
checked again immediately before external review and after a classified
outcome; if still incomplete there, the PR remains blocked/unready.

For a roleful `gates` profile, the driver:

1. Resolves the implementer family. The always-pass rule applies only to
   AFK-driven PR roles: each invocation passes `--implementer <family>` and the
   ledger stores it. Standalone/manual helper calls keep today's conservative
   omission behavior. Existing helper precedence remains unchanged: an explicit
   live flag is authoritative (including the supported Claude-driver → Codex-
   implementer relay), while config and driver environment are conservative
   fallbacks only when that flag is absent. A flag naming the gate's own family
   still self-skips. This relies on the trusted AFK driver passing the correct
   implementer, exactly as the shipped guard already does; issue #1 adds no
   stronger attestation claim. If AFK cannot resolve its own implementer family,
   kickoff blocks before assignment; a relay must declare it. This does not
   change the permissive no-signal fallback for standalone helper calls.
2. Builds all stable role slots from `gates`.
3. Computes one complete assignment before any paid verdict counts with a
   left-to-right rule a driver can execute reliably. For each stable role in
   order, form `[role preference, ...priority]`, keep the first occurrence of
   each gate family, exclude the implementer/config exclusions and families
   already assigned, then choose the first remaining candidate. A later
   duplicate role preference is already ineligible under D2 and begins directly
   with fallback. Because every role shares the same complete fallback pool and
   a role-specific preference absent from that pool cannot be consumed by an
   earlier different role, backtracking cannot rescue a failed slot; failure
   means the profile is unfillable. For the default profile and Codex
   implementer this yields Claude outer then Kimi final.
4. Classifies the complete helper outcome, not `SKIPPED` alone, and records the
   exact marker/reason/exit status:
   - a review message is the only outcome that counts as a clean or finding-
     bearing verdict;
   - `SKIPPED` for a disabled gate, missing executable, or missing credential is
     stable-unavailable for this run. Claude additionally emits stable skips for
     exhausted quota or unavailable model. Recompute still-unfilled roles
     without reusing a family that already produced a clean verdict;
   - an independence `SKIPPED` makes that provider ineligible for the role and
     recomputes the unfilled plan without recording an outage;
   - a skip/error saying the driver-supplied `--implementer` is missing or
     unrecognized is a driver/configuration error and stops immediately; it is
     never misreported as provider unavailability;
   - Claude's rejected model alias is stable configuration-unavailable and may
     fall back to another provider; returned model-identity mismatch remains an
     unclassified safety error and stops;
   - no-diff `SKIPPED` or target-related `ERROR` stops for target correction and
     never substitutes;
   - timeout/network/non-JSON/empty-response is transient whether represented as
     GLM's current `SKIPPED` or Codex/Claude/Kimi's current nonzero `ERROR`.
     Spend at most one transient retry for that stable role in the current full
     sequence: retry the same sticky provider once, then mark it temporarily
     unavailable and recompute. A substituted provider does not reset that
     sequence's transient-retry allowance;
   - any unclassified `ERROR` stops with its transcript for operator-safe
     diagnosis rather than guessing availability.

   Skip/error attempts create no verdict, consume no finding-bearing budget, and
   do not stale a sequence by themselves; every retry and disposition is still
   included in total paid-call/accounting history.
5. If no complete distinct-family assignment exists, records the missing role
   and reason. The PR is not ready; one clean review is never presented as two.
   After all installed fallbacks are exhausted this is recorded as the true
   external dependency `blocked: missing eligible external reviewer`, not as
   "operator manually runs the review." The run may resume after a provider is
   installed/authenticated or the operator explicitly changes `gates`.

An unclean verdict does not cause provider shopping. It enters that provider's
finding loop; substitution is for independence or
availability, not disagreement.

`priority` is the complete fallback pool, not a prefix before hidden defaults.
Gate families omitted from it remain usable only when explicitly preferred by a
`gates` slot; they are not appended automatically. A deliberately short pool may
therefore choose a less-obvious complete assignment or fail kickoff, and D3's
recorded plan makes that operator decision visible before work begins.

Provider choice is sticky per stable role for the life of the PR. A sequence
restart reuses the assignment while every provider remains eligible. A role may
switch only for unavailability or independence; the ledger archives that role's
open-finding baseline, records the substitution, and starts a new baseline for
the replacement. Other roles keep their provider and finding history. A
classified stable-unavailable outcome before any verdict opens no baseline;
after another role is clean it recomputes only still-unfilled roles without
stealing a sticky provider. Other skip classes follow step 4 and do not trigger
that substitution path.
If the operator edits `gates`, `priority`, or the implementer declaration during
a PR, every existing role stamp becomes stale and kickoff-style assignment is
re-derived; no prior clean verdict is carried into the new plan.

Default consequences:

| Implementer | Outer | Final |
|---|---|---|
| Claude | Codex | Kimi |
| Codex | Claude | Kimi |
| Kimi | Codex | Claude |
| GLM | Codex | Kimi |

The family mapping follows the selected AFK helper (`codex`, `claude`, `kimi`,
or `glm`). This is driver doctrine, not cryptographic attestation. The local
machine, configured binaries, proxies, and endpoints are trusted; the design
does not claim stronger evidence than the repository can enforce.

### D4 — Both gates and final tests cover one stamped revision

This preserves the shipped waterfall's full native local suite after external
review and preserves the existing middle order: TDD/relevant tests →
implementation → adversarial sweep → commit/push → draft PR → deterministic CI
green → internal review → fix every finding → external roles → full native local
suite on the final commit. Internal-review fixes receive relevant tests, a new
commit/push, and exact-revision CI green before outer. The operator may explicitly
name replacement local gates for a run, as in this issue's kickoff. That per-run
exception names every command in the ledger/PR and the final report says
`remote CI not run; operator-authorized local gates used`; it never reports
deterministic remote CI green. Before outer the driver verifies:

```text
git status --porcelain=v1 --untracked-files=all   # empty
git rev-parse HEAD                                # recorded target SHA
git rev-parse <base-ref>                          # recorded base-tip SHA
git merge-base HEAD <base-ref>                    # recorded immutable base SHA
sha256(normalized ## external gate section or
       an absent sentinel)                        # ignored role-profile hash
```

The lib-based Claude/Kimi/GLM helpers receive the recorded merge-base SHA as
`--base`. Codex's external CLI surface is only proven for a base ref, so the
Codex helper receives the resolved base ref; the mandatory before/after merge-
base check invalidates its verdict if that ref movement changed the diff during
the call. No unsupported raw-SHA claim is made for Codex. Before and after each
required PR gate the driver verifies the same clean status, `HEAD`, merge-base,
and normalized external-gate-section hash. The
hash deliberately excludes test/build commands, plugin root, merge policy, and
other ignored state that cannot change reviewer assignment. Routine ignored
test outputs and `.afk/runs/**` also remain outside the revision invariant. The
base-ref tip is informational ledger context only: unrelated base advancement does not
change `<merge-base>...HEAD` and cannot consume a sequence restart. A changed
HEAD, merge-base, or role-profile hash stales the sequence; a persistent
working-tree change pauses for operator-safe recovery, and the driver never auto-reverts
unexpected data. This is a PR-role rule only and does not change helper support
for dirty `--design` or `--uncommitted` targets.

These stamps prove the branch diff reviewed by the gates, not a synthetic post-
merge tree. Before an authorized automatic merge, the merge step compares the
current base tip with the base tip attached to exact-revision CI. If it moved,
AFK waits for platform-required checks on the current merge result/merge queue
or leaves the PR open; it does not claim prior branch-only CI covered that
integration. This issue's `leave-open` policy performs no automatic merge.

Outer closes its existing finding loop inside the current sequence. If an outer
finding changes code, tests, docs, or generated artifacts, the driver:

1. fixes and records the disposition;
2. reruns required relevant tests and the internal adversarial sweep;
3. commits and pushes the new revision;
4. obtains deterministic remote-CI green for that pushed revision unless the
   operator explicitly replaced CI with named local gates for the run;
5. re-invokes the same sticky outer provider until its finding loop closes.

Only after outer is clean do intermediate/final roles run. A content-changing
finding from any later role stales every prior stamp, runs the same fix/test/
commit steps, and starts a new full sequence at outer. The later role's sticky
provider and open-finding identity carry into that new sequence unless D3's
substitution rule resets its baseline.

After final is clean, run the full native local suite once. If it fails or any
fix/content change follows, commit the repair and restart the complete external
sequence; if it passes with the same HEAD, merge-base, role-profile hash, and clean
tracked/untracked status, the stamps remain valid and the PR may become ready.
Base-ref-tip movement with an unchanged merge-base is recorded but does not
stale a verdict. A merge commit created by the authorized merge policy after
ready is terminal and does not trigger post-merge reviews.

Convergence couples two explicit counters:

- each stable role has a hard limit of four finding-bearing verdicts over the
  life of the PR, across sequence restarts and provider substitutions. Clean
  re-verification after a later role changed the diff is metered separately and
  does not starve this finding budget. Outer iterations occur within one
  sequence; a later role's finding rounds may span restarted sequences. Three
  consecutive finding-bearing rounds still trigger the existing whole-diff/
  root-cause review before the fourth and final finding-bearing verdict. If that
  verdict is still unclean, AFK escalates with the open-finding record and stops;
  substitution resets provider-specific baseline identity and the consecutive-
  new-finding trigger for the incoming reviewer, but never the stable role's
  PR-scoped named-finding archive or four-verdict lifetime budget;
- the new full-sequence counter increments for every sequence start regardless
  of cause: initial run, later-role content fix, changed HEAD/merge-base/role
  profile, final-suite repair, rebase, or operator edit. AFK refuses to start a
  fourth sequence and escalates with all histories and dispositions. There is
  no automatic reset; after fixing the underlying cause, an operator may
  explicitly authorize one fresh bounded epoch, which is linked to rather than
  erasing the exhausted counters.

The enforceable cost controls are the counters themselves rather than one
misleading aggregate ceiling: at most three complete sequences, four finding-
bearing verdicts per stable role, and one transient retry per role per sequence.
Preflight skips produce no verdict and do not count, but every attempted paid
call is recorded. Ledger counters expose sequence, finding-bearing, clean re-
verification, transient retry, and total calls rather than merging them. A no-
change `Refuted` or operator `Accepted` disposition does not start a new
sequence. P1 remains blocking; P2 acceptance follows the existing risk rule.
Ping-pong is an explicit escalation risk, not assumed autonomous convergence.

### D5 — Ledger and handoff are role-aware

For every sequence and role, the ledger records:

- stable role instance (`outer`, `intermediate-N`, `final`);
- preferred and actual provider;
- live implementer family;
- substitution, skip, or missing-role reason;
- target `HEAD`, base ref, base-tip SHA, immutable merge-base SHA, and AFK
  normalized external-gate-section hash/absent sentinel;
- verdict and finding dispositions;
- stale/superseding revision relationship;
- per-role finding-bearing, clean re-verification, transient-retry, and total
  paid-call counters, plus the full-sequence counter.

`afk-internal-review` hands off to outer and cannot emit its per-PR final report
until all configured roles are clean on the same `HEAD`, merge-base, and config
stamp and the final full suite is green. The AFK driver likewise cannot emit the
end-of-run success report earlier. Kimi is the default final reviewer, not an
interchangeable second pass.

### D6 — Existing configs get a non-mutating, bounded notice

The ignored notice receipt is the single source of truth across install modes.
`scripts/gate-profile-notice.mjs` is the sole implementation of notice
classification, signature calculation, output, and receipt writing. The
SessionStart hook imports its resolver; `afk-init` and AFK kickoff invoke its CLI
through the resolved plugin root. The first entry point observing no current
receipt emits and writes it, and the others skip. This covers plugin, drop-in,
non-startup, and already-active sessions without systematically duplicating the
notice. The resolver prepares a notice plus a receipt commit; each caller commits
only after its stdout delivery succeeds, so a failed delivery remains retryable.
The operation distinguishes two
bounded, config-aware notices. D2 case 3 (`gates` absent and at least one
external-gate field present) receives the legacy opt-in notice:

```text
This AFK config uses a legacy gate profile (effective min-pass: <N>, mode: <M>).
Ordered roles are opt-in; the new-repository example is `gates: codex > kimi`.
Use at least <N> distinct roles to avoid reducing coverage; a shorter list
requires explicit downgrade confirmation at kickoff.
```

An existing repo with no config, or a config with no PR gate decision (D2 cases
1 and 4), still receives issue #1's new ordered default but gets a one-time cost
notice rather than changing silently:

```text
This config has no external-gate decision. AFK now uses the new default:
`gates: codex > kimi` (two sequential external reviews). Add an explicit
`gates:` profile to override it before starting issue work. If two independent
reviewers are not locally present, kickoff blocks; `gates: codex` is the explicit
single-gate escape hatch if reduced coverage is your deliberate choice.
```

No entry point adds the field automatically because writing config would alter
reviewer count/cost and erase the distinction between explicit and default
choice. The non-secret receipt
under ignored `.afk/` is keyed by plugin version and a hash of the recognized
profile fields in `## external gate`, so unrelated command or policy edits do
not re-fire it. The shared writer uses temp-file-plus-rename and ignores write
failure. Concurrent
windows therefore provide at-least-once rather than exactly-once delivery; the
worst race is one duplicated bounded notice. Editing that section or installing
a later behavior-changing version permits one fresh notice. When `.afk/` is
absent, the first emitter creates it only to store this ignored receipt; failure
to create it leaves at-least-once repetition rather than suppressing the notice.
New bootstraps
already contain `gates` and do not receive either notice. Bootstrap performs
D3's cheap presence checks and warns when fewer than two non-implementer families are
locally plausible; the warning explicitly does not claim auth, credit, network,
or model availability. Bootstrap does not weaken or rewrite the two-role
default. The every-run kickoff preflight is
authoritative for presence, while first invocation may still discover a later
availability failure handled by D3 step 4.

### D7 — Design-stage review remains separate

The design-stage external gate remains default-off and one review per design
version, regardless of PR `gates` length or legacy `min-pass`. It continues
using its existing selection and skip/error rules. PR role count, sequence
counters, and final-role semantics do not apply to design review.

### D8 — Tests pin doctrine without inventing a runtime

`scripts/external-gate-profile.test.mjs` reads active artifacts and the AFK
skill's normative scenario table. It pins:

- new/no config selects ordered Codex then Kimi and the existing no-config case
  receives the bounded cost notice/receipt path;
- existing config with a legacy external-gate field but no `gates`, including
  omitted `min-pass`, remains legacy one-gate behavior;
- any config with neither `gates` nor legacy profile keys receives the new
  default—including `design-gate`/`implementer`-only sections—while a present
  malformed `gates` key blocks and never falls to one gate;
- the legacy notice fires only for D2 case 3 and quotes effective count/mode;
  existing no-config/profileless configs get the separate one-time two-review
  cost notice while still adopting the required new default; hook/init/kickoff
  share one atomic at-least-once receipt;
- `gates` overrides legacy `min-pass`/`mode` without rewriting the file, while a
  lower count or parallel-to-waterfall change requires recorded confirmation;
- grammar normalization, unknown preference fallback, and later-duplicate
  fallback are deterministic; empty-key presence is distinct from absence;
- same-named keys outside `## external gate` do not affect classification;
- gate-only vocabulary, implementer-only-family diagnostics, and the four-role
  syntax ceiling are explicit;
- atomic left-to-right assignment for Claude, Codex, Kimi, and GLM
  implementers, including truncated pools and duplicate preferences;
- a truncated `priority` remains a deliberately closed fallback pool and may
  yield a non-default assignment or a kickoff blocker;
- kickoff uses the exact per-family presence evidence in D3 (including Codex's
  local auth status and GLM's existing `.env` search), blocks an unresolved
  implementer, and on resume covers only unstamped roles;
- review, `SKIPPED(reason)`, and nonzero `ERROR` outcomes are distinct; stable-
  unavailable, independence, no-target, transient, and unknown errors take the
  specified actions, with one transient retry per role per sequence;
- a rejected driver-supplied implementer stops as a driver error rather than
  walking the provider pool; Claude alias rejection is preflight-visible;
- duplicate preferences, unavailable providers, and pool exhaustion;
- provider stickiness and baseline reset on a recorded substitution;
- the existing explicit-flag precedence preserves the Claude-driver/Codex-
  implementer relay and still rejects a gate matching the declared implementer;
- Kimi runs only after outer findings/fixes and their relevant tests; the full
  native suite remains the final check and any ensuing fix restarts the roles;
- draft PR, CI, internal review, external roles, and final suite retain the
  shipped order, with exact-revision CI after internal-review fixes;
- outer loops close within a sequence; a later-role content change invalidates
  every stamp and restarts outer without resetting PR-scoped finding history;
- all clean role stamps name one `HEAD`, merge-base SHA, and normalized external-
  gate-section hash; lib gates receive the SHA while Codex uses the checked base
  ref,
  while base-ref-tip movement is informational and does not stale an unchanged
  diff;
- the four-finding-verdict per-role cap and three-sequence cap are distinct and
  coupled; every sequence-start cause counts, with clean re-verification and
  transient retries metered separately;
- design-stage behavior remains one optional gate;
- every active document names the same defaults and compatibility behavior.

These are executable consistency checks over shipped instructions, not a second
selector implementation. Existing helper unit tests remain unchanged because
this design no longer changes helper mechanisms.

## Alternatives considered

### `outer`, `final`, and `min-pass`

Rejected after adversarial review. Three fields can disagree about count and
order, require four-way legacy precedence, and leave ambiguous behavior when
only one role key or no `min-pass` is present.

### `gates: codex > kimi`

Chosen because position expresses role and list length expresses count. It also
gives existing configurations one unambiguous opt-in switch while leaving their
legacy fields untouched.

### Keep `min-pass`; derive role order from `priority`

Rejected because one list cannot express two different concerns. In the default
profile `priority: codex > claude > kimi > glm` is the fallback order, while the
required final-role preference is Kimi; taking the last required item from
`priority` would select Claude rather than Kimi for common implementers. The new
`gates` field is therefore necessary to express role preference and count while
`priority` remains a fallback pool.

### Add provider-evidence blocks and helper drift mechanisms in this issue

Rejected as scope expansion. Binary/provider attestation and helper-local drift
hardening may be designed independently later, but issue #1 remains correct
under its stated trusted-local-machine model and does not create those tasks.

### Add a helper `TARGET` marker

Rejected for this issue. A helper echoing the target that the same AFK driver
passed to it does not create a control point outside that driver's authority and
does not prove the external model consumed that target. The accepted issue
explicitly says not to describe the workflow as externally non-bypassable.
Passing an immutable merge-base, checking HEAD/merge-base around every helper,
and recording both in the ledger is the honest level-3 guarantee. The existing
marker protocol remains stable.

### Add an unused assignment module

Rejected because this repository has no orchestration runtime that would call
it. A pure selector used only by tests would create the appearance of level-2
enforcement while the actual LLM driver still follows separate prose. D3 keeps
one simple left-to-right rule, worked examples, and active-artifact consistency
tests, and labels the result as driver doctrine. A future runtime may extract
the rule when it has a real consumer.

### Lexicographic backtracking assignment

Rejected in favor of D3's greedy rule. Every role has the same closed fallback
pool; a role-specific preference outside that pool cannot be consumed by an
earlier different role, and duplicate later preferences are ineligible. A
failed greedy slot therefore has no complete backtracking solution. Adding rank
tuples and search would increase driver error surface without changing a valid
assignment.

### One non-finding confirmation pass after a final-role fix

Rejected because a later-role repair can reintroduce the structural defect the
outer role exists to detect. A pass forbidden from opening a genuinely new P1
would provide weaker evidence than a normal review of the final diff. D4 instead
restarts the ordered roles, while the shared sequence/finding budgets bound
ping-pong.

### Provider-aware bootstrap that silently writes one role

Rejected because issue #1 explicitly requires two distinct external roles and
forbids presenting one pass as ready. A single-role generated config would make
security depend on what happened to be installed during bootstrap and could
remain weak after another provider is added. Bootstrap warns about missing
capacity; the safe configured default remains two roles, and a genuine
single-provider installation reaches the explicit external-dependency blocker.

## Files to change

| File | Change |
|---|---|
| `skills/afk/SKILL.md` | Define ordered `gates`, compatibility, honest kickoff presence preflight, classified skips, atomic assignment, internal-review/test placement, same-HEAD/base restart, hard counters, ledger, and normative scenarios; restate design gate as one regardless of `gates` length or legacy `min-pass`. |
| `templates/afk-config.example.md` | Replace the default legacy count/mode fields with `gates: codex > kimi`; retain fallback priority and explain legacy precedence. |
| `skills/afk-codex-review/SKILL.md` | Describe Codex, including frontmatter, as the default outer rather than the last/interchangeable check; document sticky-role reuse and same-HEAD metering. |
| `skills/afk-kimi-review/SKILL.md` | Describe Kimi, including frontmatter, as the default final rather than an interchangeable gate; document sticky-role reuse and same-HEAD metering. |
| `skills/afk-claude-review/SKILL.md` | Describe Claude, including frontmatter, as fallback/default outer when Codex implemented; document sticky-role substitution and same-HEAD metering. |
| `skills/afk-glm-review/SKILL.md` | Describe GLM, including frontmatter, as a fallback rather than an interchangeable gate; document sticky-role substitution and same-HEAD metering. |
| `skills/afk-internal-review/SKILL.md` | Hand off to the complete ordered role sequence and prevent an early final report. |
| `skills/afk-init/SKILL.md` | Participate in the shared receipt-first notice operation for drop-in installs without rewriting config. |
| `scripts/gate-profile-notice.mjs` + test | Own notice classification, signature, CLI output, and atomic receipt writing for all three entry points. |
| `hooks/afk-resume-detect.mjs` + test | Import the shared notice resolver for plugin sessions instead of carrying a private implementation. |
| `lib/config.mjs` + `lib/config.test.mjs` | Add section-scoped presence/value readers so absent, empty, and same-named keys outside `## external gate` have different safe outcomes; leave legacy readers compatible. |
| `README.md`, `AGENTS.md`, `CONTRIBUTING.md` | Update the default pipeline, config, compatibility, local-test ordering, and cost/escalation behavior. |
| `scripts/external-gate-profile.test.mjs` | Pin active doctrine and the scenario table. |
| `scripts/loop-rules.test.mjs` | Pin the coupled limits: outer finding rounds close inside a sequence, later-role content fixes restart it, and finding/sequence/transient-retry counters retain separate caps. |
| `.claude-plugin/marketplace.json` | Bump canonical plugin version from 0.2.11 to 0.2.12. |
| generated manifests and `package.json` | Regenerate using `scripts/sync-marketplace.mjs`. |

No provider-specific gate helper, shared implementer guard, marker protocol,
provider routing, or selector executable is changed. The shared config reader
gains only the section-aware detection required for compatibility notices.

## Test plan

### RED

Add the config-presence and profile/notice assertions first. Confirm failure
against the current single-gate template, one-gate active docs, absent-versus-
empty `gates` semantics, per-family presence evidence, skip/error classification,
late capacity detection, moving-base stamps, early internal-review report, and
missing hard role/sequence/retry limits.

### GREEN

Run the new profile tests plus existing design-gate, loop-rule, gate-finding,
hook, skill-lint, manifest-sync, and version-bump tests. Provider-specific gate
and implementer-guard tests remain unchanged; shared config tests gain the new
presence and section cases.

For this issue's current AFK execution, the operator explicitly replaced remote
CI with the local gates below. That run-specific override is evidence recorded
in the ledger and PR; it does not alter the repository's permanent remote-CI
policy or the shipped AFK doctrine.

### Full local gates

```text
node scripts/sync-marketplace.mjs --check
node scripts/lint-skills.mjs
node scripts/check-links.mjs
node scripts/scan-provenance.mjs
node --test
node scripts/check-version-bump.mjs --base origin/main
```

Manually search active files (excluding historical designs) for the retired
default: one external gate, Codex as last gate, Kimi as interchangeable, or
post-clean edits that do not invalidate role stamps.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Every previously bootstrapped template config stays legacy single-gate until opt-in | Existing installations do not inherit the new default automatically | Preserve cost/behavior intentionally; emit the exact `gates: codex > kimi` opt-in snippet once and never mutate it silently. |
| Existing/no configs with no gate decision adopt two reviews | Cost increases, or the PR cannot become ready when two reviewers are absent | This is issue #1's explicit default rule; emit a one-time notice with the explicit one-item `gates:` escape hatch. |
| Provider pool cannot satisfy independence | Only one role can run | Keep safe issue work possible, record the anticipated blocker at kickoff, and block readiness—not implementation—until capacity or explicit configuration changes. |
| Presence preflight cannot prove remote auth/credit/network | A provider can pass kickoff and skip at first invocation | State the limit explicitly, classify the skip, allow one retry only for transient failure, then recompute or block. |
| Local binary routes to an unexpected family | Independence record may be inaccurate | State the trusted-local-machine boundary honestly; retain existing helper checks and identity evidence where emitted, and require live implementer records. |
| AFK passes an incorrect explicit implementer | The existing authoritative flag can permit the wrong reviewer | Preserve the shipped relay behavior and trusted-driver boundary; require the live value in the ledger and make no new attestation claim. |
| A provider substitution inherits a partly spent role budget | The replacement has fewer than four finding-bearing verdicts available | Reset its consecutive/root-cause trigger but keep the PR lifetime hard cap; expose remaining budget before invocation and escalate rather than silently overspend. |
| Later findings cause reviewer ping-pong | Cost and time increase; AFK may stop autonomously | Close outer findings within their current sequence; restart from sticky outer after later-role edits; cap at three full sequences and escalate with dispositions. |
| Branch HEAD, merge-base, or external-gate profile changes before ready | Verdicts no longer cover the same diff/role plan | Restart the complete role sequence; unrelated config/base-tip changes do not invalidate it. |
| Base tip moves after branch-only CI | The eventual merge result was not covered by that CI run | Before auto-merge require current merge-result/queue checks or leave the PR open; do not rerun branch review for an unchanged merge-base. |
| Finding fixes amplify CI runs | Each pushed review revision may spend CI minutes and wall time | Require exact-revision CI green, report the amplification, and honor only an operator-explicit named local-gate override; correctness outranks CI cost. |
| Prose tests are mistaken for enforcement | Users overestimate guarantees | Label selection as driver doctrine and tests as artifact consistency checks. |

## Acceptance mapping

| Issue criterion | Control |
|---|---|
| Default Codex outer then Kimi final for ≥0.2.12 bootstraps and configs with no PR gate decision | D1–D3 |
| Kimi runs after outer fixes | D3–D4 |
| No self-review and distinct families | D3 |
| Two roles unavailable means not ready | D3 |
| Later fix restarts both on final HEAD | D4 |
| Ledger distinguishes roles/providers/revisions | D5 |
| Explicit and legacy configs remain compatible | D1–D2, D6 |
| Internal review cannot end early | D5 |
| Design-stage gate unchanged | D7 |
| Native checks and version bump | D8, test plan |

## Adversarial review outcome

Revisions 1–6 explored separate `outer`/`final` fields, provider evidence,
helper fingerprints, and content-based stamp carry-forward. Three Claude design
gates returned `RETHINK`; their final P1 set was resolved by reducing the design
to an ordered role list and trusted level-3 driver doctrine.

Revision 7's fourth Claude gate found four remaining P1 ambiguities: finding-
loop versus sequence ownership, single-provider bootstrap behavior, malformed
`gates` fallback, and provider stickiness across roles and revisions. Revision 8
resolved those findings without expanding the runtime:

- removes all helper/provenance/drift changes from scope;
- replaces role/count precedence with one ordered `gates` list;
- makes omitted `min-pass` explicitly legacy-one for existing configs;
- keeps PR clean-state checks in driver doctrine and leaves dirty helper modes
  unchanged;
- restores exact final-HEAD review instead of content carry-forward;
- separates existing per-gate convergence from a bounded sequence counter;
- closes outer findings inside the current sequence while later-role edits
  restart the complete sequence;
- keeps the two-role bootstrap fail-safe, warns about insufficient providers,
  and records missing capacity as a resumable external dependency blocker;
- makes present-but-empty or malformed `gates` a blocking configuration error;
- makes provider selection sticky per stable role, resetting only a substituted
  role's finding baseline and preserving every other role's history;
- defines deterministic grammar, duplicate handling, and atomic assignment;
- names the trusted-local-machine boundary and limited enforcement honestly;
- adds a bounded notice and the previously omitted active documentation.

Revision 8's fifth Claude gate found three further P1 gaps: the existing role
loop was described as bounded when it was not, HEAD-only stamps did not freeze a
moving base/diff, and reviewer capacity was checked only after expensive issue
work. Revision 9:

- introduces a hard role budget, later refined to four finding-bearing verdicts
  plus separately metered clean re-verification, coupled with the three-sequence
  cap and existing third-round root-cause trigger;
- stamps HEAD, base-ref tip, and merge-base, and passes the immutable merge-base
  SHA to every helper;
- performs complete role assignment at every kickoff before an issue starts,
  while retaining mid-run recomputation for later provider failures;
- makes empty-key presence, role vocabulary, rank construction, legacy notice
  coverage, CI restarts, and config-edit invalidation explicit;
- records existing helper identity evidence where available and accurately
  limits config/live implementer union to level-3 AFK doctrine.

Revision 9's sixth Claude gate labeled five concerns P1. Revision 10 accepts the
two correctness regressions, accepts the silent-cost portion of a compatibility
finding, and refutes two scope expansions against issue #1's explicit doctrine
boundary:

- initially proposed reconciling flag/config/environment signals in the shared
  implementer guard;
- only HEAD or merge-base movement stales a diff; base-tip movement is retained
  as informational context and cannot consume sequence budget;
- existing blank/command-only configs still adopt the issue-mandated new default
  but receive a bounded two-review cost notice;
- a helper target echo is rejected because it remains under the same driver's
  authority, does not prove model consumption, and conflicts with the accepted
  non-bypassability non-goal;
- an assignment module with no runtime consumer is rejected as false level-2
  assurance; the fully specified algorithm remains honestly labeled doctrine;
- related P2s now define closed truncated-priority pools, PR-scoped finding
  history, section-scoped config classification, separate clean/finding budgets,
  and CI amplification risk.

Revision 10's seventh Claude gate correctly showed that the proposed symmetric
implementer disagreement rule deadlocked the supported Claude-driver → Codex-
implementer relay, that no uniform non-metered auth probe exists across all
providers, and that raw `SKIPPED` is not synonymous with provider
unavailability. Revision 11 resolved these without adding protocols or
provider-specific modes:

- restores the shipped authoritative explicit-flag guard and documents its
  trusted-driver boundary rather than weakening relay behavior;
- limits kickoff to honest local presence evidence and makes resumed preflight
  consider only unstamped roles; remote auth/credit remains first-call evidence;
- classifies existing skip reasons into stable availability, independence,
  target, and transient outcomes, with one bounded sticky transient retry;
- preserves the existing final full-suite placement, explicitly orders internal
  review, and restarts roles after any post-final-suite repair;
- stamps the ignored AFK external-gate section while excluding unrelated config
  keys and routine ignored outputs;
- scoped notice receipts to the external-gate section, clarified legacy-install
  reach, and pinned design-stage single-gate wording plus the rejected
  `priority`-only alternative.

Revision 11's eighth Claude gate found four remaining P1 precision errors.
Revision 12 fixes them within the existing implementation surface:

- restores the shipped draft-PR → CI → internal-review → external-role → final-
  suite order and reruns exact-revision CI after internal-review fixes;
- classifies complete helper outcomes—review, reasoned `SKIPPED`, and nonzero
  `ERROR`—including the provider-specific forms already emitted today;
- defines non-metered presence separately for Codex, Claude, Kimi, and GLM,
  using Codex's local login status and GLM's existing environment/`.env` search;
- lets hook, init, or kickoff win one shared atomic notice receipt so drop-in and
  already-active sessions are covered with at-least-once semantics;
- removes the misleading aggregate call ceiling, bounds transient retries,
  blocks unresolved implementers, documents merge-result limits, exposes the
  single-gate escape hatch, and replaces ranked backtracking with the simpler
  equivalent left-to-right assignment rule.

Revision 12's ninth Claude gate labeled five items P1. Against the operator's
required baseline—only regressions introduced by issue #1 are blockers—four are
real specification gaps and one is migration transparency rather than a
functional blocker. Revision 13 closes all five without expanding runtime:

- makes configuration selection a total function and names `design-gate` and
  `implementer` as non-profile keys;
- hashes only the normalized external-gate section, not unrelated ignored
  commands or plugin paths;
- counts every sequence-start cause and permits only an operator-recorded fresh
  epoch after exhaustion;
- keeps immutable-SHA bases for lib helpers but uses Codex's supported base ref
  with before/after merge-base validation;
- extends the bounded notice to existing no-config repositories and creates the
  ignored receipt directory when needed;
- restores baseline usability by treating incomplete reviewer capacity as a
  readiness blocker rather than refusing to perform issue work.

The operator explicitly rejected further scope inflation from repeated design
gates. No evidence-backed P1 remains against issue #1 or the shipped working
baseline; TDD is unblocked. Remaining suggestions are documented P2 tradeoffs or
explicitly rejected non-goals, not reasons to add protocols or a runtime.
