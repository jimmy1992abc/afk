# Config readers: CRLF tolerance

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#21 (from the #19 audit, item 3). Mechanical scope;
brief design per the scaling rule.

## Frozen issue contract

Acceptance criteria:

1. All three exported readers (`readConfigValue`, `hasConfigKeyInSection`,
   `readConfigSectionValue`) plus the shared section walk agree on CRLF and LF
   files with the same logical content. Today `sectionLines` splits on `'\n'`
   and `keyMatch` anchors `(.*)$` without `/m`, so a `\r` remnant defeats the
   match (`.` excludes `\r`, `$` matches only end-of-string) while
   `readConfigValue`'s `[^#]+` tolerates it — two readers disagreeing about
   one file, and `gate-profile-notice` emitting wrong migration advice on a
   Windows-saved config.
2. Duplicate-key first-occurrence semantics are identical under LF and CRLF —
   the empty-first-value case (`key:` then `key: value`) resolves the same way
   on both (today the bare `\r` satisfies `[^#]+`, flipping which line wins).
3. No grammar change; every existing test stays green unchanged.

Engineering invariants: dependency-free Node ESM; readers stay tolerant (an
unreadable/absent file still contributes nothing — the fail direction of this
module is unchanged and documented).

Non-goals: lone-`\r` (classic-Mac) endings; any new config key; template
changes; the heading/comment grammar.

## Design

Minimal causal fix — strip `\r` at line assembly, so no regex downstream ever
sees it: one shared helper splits on `'\n'` and removes every trailing `\r`
(`/\r+$/`) per line; `sectionLines` and `readConfigValue` both use it.
Splitting on `/\r?\n/` alone was rejected in debate (R1-C4): a final line
terminated by a bare `\r` with no `\n` keeps its `\r` through that split and
recreates the reader disagreement. A single-`\r` strip was likewise rejected
(R2-N1): `\r\r\n` endings — the classic double-conversion artifact — leave one
`\r` behind; `/\r+$/` closes the class. After assembly
no line carries `\r`, so `keyMatch`'s anchors and `[^#]+` behave identically
for both endings, which also settles the duplicate-key asymmetry (an empty
CRLF value becomes a genuinely empty match target, skipped by `[^#]+` exactly
as under LF). A UTF-8 BOM needs no handling: ECMAScript `\s` includes U+FEFF,
so `^\s*` already absorbs it (verified in debate) — noted so it is not
reopened later.

## Test plan

CRLF variants in `lib/config.test.mjs`: `hasConfigKeyInSection` +
`readConfigSectionValue` on a CRLF `## external gate` block (with inline
comment) — the discriminating section cases; the duplicate-key
empty-first-value case asserted through `readConfigValue` (the one reader
where it discriminates, per R1-C7) with the same winner under LF and CRLF; a
CRLF flat key (pins today's accidental tolerance as contract); an EOF bare-`\r`
final line (the R1-C4 corner); a `\r\r\n` file (the R2-N1 corner); and a
mixed-endings file. Existing LF cases untouched.

## Debate record

- R1: C1/C2/C5/C6 supported-verifying (regex claims and consumer inventory
  verified by execution; no dependence on the divergent behavior; lone-`\r`
  direction unchanged and declared). C4 (P2, supported): `/\r?\n/` split
  leaves an EOF bare-`\r` — resolved by per-line stripping. C8 (minor):
  "four exported readers" miscount — corrected to three plus the walk.
  C7 (minor): dup-key test must target `readConfigValue` to discriminate —
  test plan reworded. C3 (minor): BOM premise refuted in the good direction —
  one design note added.
- R2: C4/C7/C8/C3 resolved by name. New N1 (minor, supported by execution):
  `\r\r\n` double-conversion endings survive a single-`\r` strip → resolved by
  `/\r+$/` per line + a test-plan case.
- R3: N1 resolved by name, no new findings — clean round. Implementation
  starts here.
