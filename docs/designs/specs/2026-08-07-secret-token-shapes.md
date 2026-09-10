# Secret redaction: cover today's common provider token shapes

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#23 (from the #19 audit — the one finding with a real
data-exposure surface; pass-throughs verified by execution). Mechanical scope;
brief design per the scaling rule.

## Frozen issue contract

Acceptance criteria:

1. A prefix rule redacts `ghp_|gho_|ghu_|ghs_|ghr_` (GitHub tokens),
   `github_pat_` (fine-grained), `glpat-` (GitLab), and `xox[abprs]-` (Slack)
   tokens wherever they appear — including inside URLs
   (`https://ghp_…@github.com`, the git-remote leak shape) and after
   `Authorization: token …`.
2. A JWT rule redacts `eyJ…`.`…`.`…` regardless of segment length (the
   current 40-char base64 rule misses short or `-`/`_`-bearing segments),
   including the unsigned trailing-dot form.
3. `token <value>` after a label (space-separated, as in
   `Authorization: token ghs_…`) is covered — the existing `Bearer` rule
   generalises to a label-preserving `Bearer|token` rule whose `token` branch
   requires a digit in the value (R1-F1: without it, ordinary prose — "token
   authentication", "Token verification" — is redacted; digitless GitHub
   tokens after the `token` label are still caught by the prefix rule). The existing
   `key[:=]value` rule covers separator forms and is unchanged.
4. Existing behavior is unchanged and still tested: git SHAs (40-hex) kept,
   64+-hex redacted, pure-alpha long runs kept, sk-/tp-/AKIA/PEM/key=value
   rules untouched.
5. `redact.test.mjs` gains a case per shape, plus the URL-embedded and
   `Authorization: token` forms, a Bearer label-preservation regression (none
   exists today), the prose negative cases ("token authentication" stays,
   `xoxb-compatible` stays, `_ghp_…_` redacts under the lookbehind), and a `sha512-` label
   survival pin. Exact-count assertions avoid inputs containing a kept 40-hex
   SHA (the pre-existing count-before-keep miscount would make them lie).
6. Version bumped 0.4.6 → 0.4.7 (`lib/` ships) with manifests synced.

Engineering invariants: dependency-free; fail toward less exposure (a
placeholder that looks like a token is redacted — over-redaction of
token-shaped text is the accepted cost, stated here); rules count matches the
same way existing rules do (this issue does not fix the pre-existing
count-before-keep miscount — #19 minor, out of scope).

Non-goals: gather/relay flow, payload budgeting, `filterDiffByExcludes`,
exclude globs, the `redactSecrets` count semantics.

## Design

Two new rules in `RULES` (`lib/secret.mjs`), placed **immediately after the
AKIA rule** (before Bearer/key=value/64-hex — R1-F3: a later slot lets the
64-hex rule pre-mangle a JWT with a hex signature):

- Prefix tokens:
  `/(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{20,})/g`
  → `[REDACTED]`. The lookbehind (not `\b`) also catches `_ghp_…`-style
  concatenations (R1-F4); the boundary holds after `//` and `:`/space, so the
  git-remote URL and header forms match; length floors keep short prose
  mentions (`ghp_` alone, `xoxb-compatible`, `glpat-compatible-token` —
  R1-F6/R2, floors 20) unredacted
  while real tokens always exceed them.
- JWT: `/(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g`
  → `[REDACTED]` — two mandatory base64url segments, optional signature
  (unsigned `alg:none` form ends in a dot). The lookbehind matches the prefix
  rule's (R2-N1: `\b` missed `_eyJ…` the same way it missed `_ghp_…`); `eyJ`
  mid-base64-run still cannot match (preceding alnum blocks it), verified in
  debate.

One generalisation: the `Bearer` rule becomes
`/\b(?:([Bb]earer)\s+[A-Za-z0-9._-]{12,}|([Tt]oken)\s+(?=[A-Za-z0-9._-]*[0-9])[A-Za-z0-9._-]{12,})/g`
with a label-preserving replacement — Bearer semantics unchanged, `token`
branch digit-gated (R1-F1).

## Test plan

New cases: each GitHub prefix (`ghp_`, `ghs_` at minimum) at realistic length;
`github_pat_`; `glpat-`; `xoxb-`; the git-remote URL form; `Authorization:
token ghs_…` (label kept, value gone); signed and unsigned JWTs with short
segments; underscore-adjacent `_ghp_…_` and `_eyJ…` redact (lookbehind
positives); a short prose `ghp_abc` mention stays (floor works). Plus the AC 5
amendments: Bearer label regression, prose negatives ("token authentication",
`xoxb-compatible`, `glpat-compatible-token` stay), `sha512-` label survival
pin, and no exact-count assertions near a kept 40-hex SHA. Regression cases
stay green (SHA kept, base64 rule, sk-/tp-).

## Debate record

- R1: F1 (P1, supported by execution): the naive `Bearer|token` generalisation
  redacts ordinary prose → digit-gated token branch. F2 (P2): version-bump AC
  missing → AC 6. F3 (minor): rule placement ambiguous across three
  intervening rules → "immediately after AKIA". F4 (minor): `\b` misses
  `_ghp_…` → lookbehind. F5: lockfile `sha512-` FP claim refuted (pre-existing
  behavior, new rules add nothing). F6 (minor): Slack floor 10 caught
  `xoxb-compatible` → floor 20. F7 (minor): test-plan gaps (Bearer
  regression, prose negatives, count-assertion hazard) → AC 5 amended. All
  positive shapes verified by execution in debate.
- R2: F1/F2/F3/F4 resolved; F6 resolved for Slack with a residual glpat
  floor-16 FP (`glpat-compatible-token`) → floor 20; F7 partially — Test plan
  lagged AC 5 → mirrored; new N1 (minor, leak-direction): JWT rule kept `\b`
  while prefixes moved to lookbehind → JWT lookbehind too (no FP risk,
  verified). Hyphenated-compound prose (`xoxb-style-integration-tests`) is
  the accepted irreducible over-redaction residue, stated per the invariant.
- R3: glpat floor / Test plan mirror / JWT lookbehind resolved by name, no
  new findings — clean round. Implementation starts here.
