# Skill frontmatter must fail before a host does

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#67.

## Frozen issue contract

Acceptance criteria:

1. Every shipped `SKILL.md` frontmatter document is valid within the flat YAML
   subset this repository authors.
2. The linter rejects malformed frontmatter rather than silently ignoring a
   line or assigning a value that a YAML parser would interpret differently.
3. Diagnostics identify the skill and the frontmatter defect.
4. Tests pin the unquoted `colon + whitespace` false-pass and the successful
   quoted equivalent.
5. Existing name, directory, and description constraints remain unchanged.

Engineering invariants: the repository remains dependency-free; accepted
frontmatter is valid YAML; malformed metadata fails closed before installation.

Non-goals: supporting nested YAML, block scalars, anchors, aliases, tags, or
multi-line values; changing trigger wording beyond quoting the two invalid
descriptions.

## Design

The current parser is permissive in two unsafe directions: it skips any line
outside its regular expression, and it treats every captured suffix as a string
even when YAML assigns structure or comment semantics to it. Pulling in a full
YAML package would add an install-time dependency for a format whose authored
shape is intentionally flat.

Replace the permissive reader with a validator for the repository's documented
flat scalar subset. The opening and closing `---` delimiters must be exact,
unindented lines; the opener must be the first bytes in the file. A UTF-8 BOM is
not part of the authored subset and is rejected with the same delimiter
diagnostic. Each non-empty frontmatter line must be one unique
`key: value` pair with whitespace after the mapping colon. A line that resembles
a mapping but omits that separation is invalid rather than ignored.

Values may be conservative plain strings or complete single/double quoted
strings. A plain value must start with an ASCII letter, must not equal a YAML
1.1 boolean or null keyword case-insensitively, and must contain no control
character, tab, mapping delimiter (`:` followed by whitespace or the end), or
comment delimiter (whitespace followed by `#`). The ASCII-letter rule excludes
numeric, timestamp, directive, tag, anchor, alias, collection, and block-scalar
forms without reproducing every host's implicit schema.

Double-quoted strings use the JSON escape subset shared by YAML, followed by an
explicit Unicode-scalar check that rejects unpaired UTF-16 surrogates.
Single-quoted strings accept only YAML's doubled-quote escape and receive the
same Unicode-scalar check. Raw scalar source in either form must contain only
YAML-printable characters; JSON decoding already rejects raw controls in double
quotes, and the validator applies the equivalent check directly to the
single-quoted source. Escaped double-quoted controls remain valid YAML. A quote
with trailing content, or an unmatched interior single quote, is invalid. The
parser returns one classified error instead of partial data, so field validation
never runs on an ambiguous document.

The two affected descriptions become single-quoted scalars so their existing
double-quoted trigger phrases need no migration and their text remains
unchanged. The accepted data passed to the existing name and description checks
remains ordinary strings, so there is no behavior change for valid skills.

## Test plan

`scripts/lint-skills.test.mjs` adds fixtures for unquoted descriptions containing
colon followed by space, tab, and end-of-line; quoted equivalents; omitted
mapping separation; a previously ignored malformed line; duplicate keys;
unterminated and trailing-content quotes; valid doubled single quotes; inline
comments that would change the parsed value; numeric/boolean/null/timestamp
implicit types; paired/unpaired Unicode escapes; and raw control characters in
single-quoted input; and space-indented, tab-indented, BOM-prefixed, missing, or
decorated frontmatter delimiters. The shipped descriptions also exercise
embedded double quotes. Each invalid fixture must assert both the skill
identifier and a stable diagnostic category covering delimiters, missing
separation, malformed lines, duplicate keys, invalid plain scalars, malformed
quotes, or invalid Unicode characters. The existing suite proves that valid
plain scalars and field constraints still behave as before.

The repository checks then run in full, including manifest synchronization and
the version-bump guard.
