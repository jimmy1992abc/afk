# Agent Relay must bound both trust and bytes

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#68.

## Frozen issue contract

Acceptance criteria:

1. `--files` and `--logs` read only regular files whose canonical path is
   inside the current Git worktree.
2. Missing files, leaf symlinks, ancestor-symlink escapes, irregular files,
   unresolved roots, and outside paths fail closed with distinct reasons that
   do not echo an unsafe absolute path.
3. `AGENT_RELAY_MAX_INPUT_BYTES` strictly bounds the combined UTF-8 bytes of
   the system and user message content sent to a paid provider, including task,
   notes, context, separators, and truncation markers.
4. If the fixed system prompt, the role's minimum task request, and the
   truncation marker cannot fit, the relay returns an error before a provider
   call rather than sending a partial task.
5. Gather notes are redacted, deduplicated, individually bounded, globally
   bounded, and carry an omission summary whenever entries are dropped.
6. Truncation preserves UTF-8 and never exceeds either the gather-context cap
   or the final request cap.
7. Existing safe in-worktree collection, exclusion, redaction, log-tail, diff,
   issue, and grep behavior remains compatible.

Engineering invariants: no outside-worktree reads; no silent omission; one
definition of UTF-8 prefix truncation; no new runtime dependency.

Non-goals: changing source extensions, log formats, provider selection,
authentication, response budgets, or the semantics of diff/issue/grep sources.

## Design

### File boundary

Move the existing uncommitted-snapshot regular-file boundary into one shared
descriptor-owning reader under `lib/gate/`. It accepts an explicit root and
resolution base. It records lexical containment, rejects a leaf symlink,
requires a regular file, resolves file and root canonically, and applies the
cross-platform `relative` containment check. Canonical containment is the
authority: a lexically outside path reached through a worktree alias is allowed
when its canonical target is inside. A lexically in-root path whose canonical
target escapes returns `ancestor_symlink_escape`; a path outside both
lexically and canonically returns `outside_path`.

The helper opens the canonical target itself with no-follow protection where
the platform exposes it, verifies the opened descriptor is regular, and compares
bigint device/inode identity with the bigint identity observed during
inspection. Missing, zero, or otherwise unusable identity returns
`identity_unavailable`; a mismatch returns `changed_during_read`. A test-only
pre-open hook deterministically replaces the file during that window. Mutation
of the same already-open inode is outside the path-substitution guarantee: it
cannot redirect the descriptor outside the approved worktree inode.

Before reading, while the descriptor remains open, the helper synchronously
invokes a caller approval callback with the canonical repository-relative path
and opened-file metadata. Agent Relay applies secret/custom exclusions there;
Snapshot applies its existing 200 KiB size policy there. Rejection closes the
descriptor without invoking the injectable descriptor-read primitive. Approval
then reads from the same descriptor and closes it. Consumers never receive a
pathname to reopen. The helper returns content plus safe relative metadata only
on success. Snapshot maps stable codes to its existing notes; Agent Relay maps
boundary codes to path-free notes and may name only an approved canonical
relative path for an exclusion.

Agent Relay resolves the current worktree with `git rev-parse --show-toplevel`
once whenever a file or log source exists. Failure to resolve it disables those
reads and emits a distinct note for each source type. Relative requests resolve
from the invocation directory, while containment is tested against the
worktree root; absolute paths are permitted only when their canonical target is
inside that root. Exclusion checks and display titles use the canonical
repository-relative path before any file content is read. A test-only inspector
injection keeps unit tests hermetic without weakening the production default.

### One paid-input budget

Add one shared byte-budget utility for UTF-8 measurement, safe prefix slicing,
and marker-reserving truncation. Gather uses it to ensure each assembled context
chunk, including its header and truncation marker, fits `maxBytes`; if even the
marker cannot fit, the chunk is dropped with a note. Every serialized segment
owns its leading separator: the first begins with one newline and later segments
with two, preserving the existing rendering without an uncharged `join`
separator. Assembly uses `join('')`, and tests assert the exact final byte count
with multiple boundary-sized chunks.

Before provider invocation, each role formatter returns two segments: a fixed
prefix containing the complete task framing and complete bounded notes, and an
optional context tail. `runRole` never truncates the prefix. The final budget
counts `system + provider framing + prefix + context` message content. HTTP
providers have zero content framing; the Codex adapter declares its two-byte
`system + "\n\n" + user` separator. If all content fits, it is unchanged.
Otherwise the utility reserves the final truncation marker and truncates only
the context segment on a UTF-8 boundary. If
`system + provider-framing + prefix + marker` cannot fit, the relay returns a
classified error and makes no provider call.

This definition intentionally excludes JSON transport syntax and provider-side
tokenization. It includes every content separator added by a provider adapter;
tests capture the actual Codex stdin as well as HTTP message bodies.

### Notes

Normalize notes after redaction and exact deduplication. A note over 512 UTF-8
bytes is dropped, never silently shortened, and contributes to the omission
count. The list is limited to 50 entries and the combined notes to the smaller
of 8 KiB or one quarter of the configured input budget. The formatter reserves
space for a fixed `[N additional gather note(s) omitted]` summary before
accepting another note. If the note sub-budget cannot carry that summary,
`gatherContext` throws `relayError('notes_unreportable', ...)`. `runRole` wraps
gathering, note formatting, and final budgeting in one catch that converts every
relay-domain failure into a nonzero role `ERROR` block before provider
invocation. The fixed prefix and captured-provider tests prove that retained
notes and this summary survive final context truncation.

When the context budget itself is smaller than the omission marker, an
internally generated cap notice uses the complete `cap drop` code. This keeps
truncation visible without creating another omission that cannot be reported.
Other unreportable omissions still fail with `notes_unreportable`.

`gatherContext` returns the bounded notes and a strict `bytes` value for context
only. `runRole` owns the authoritative final paid-input check, so no caller can
append task text or notes outside the configured cap.

## Consumer impact

- `lib/gate/snapshot.mjs`: imports the shared descriptor reader for uncommitted
  files and supplies its size approval callback; existing note strings and
  snapshot behavior stay unchanged.
- `skills/afk-agent-relay/lib/gather.mjs`: validates file/log paths before
  exclusions and reads; uses the shared byte utilities and bounded notes.
- `skills/afk-agent-relay/lib/role.mjs`: performs the authoritative final
  system-plus-user budget check before `provider.complete`.
- `brief.mjs` and `scope.mjs`: return a fixed task-plus-notes prefix and a
  separate optional context tail; notes precede optional context.
- Tests that inject file reads also inject an approved reader explicitly;
  production entry points never do.

## Test plan

`skills/afk-agent-relay/tests/gather.test.mjs` covers a safe relative path, a
safe absolute in-root path, a lexically outside worktree alias whose canonical
target is inside, an outside path (`outside_path`), a leaf symlink, an
ancestor-symlink escape (`ancestor_symlink_escape`), a deterministic
inspection/open replacement (`changed_during_read`), a directory, an unresolved
worktree, unusable/mismatched bigint identities, file and log parity, a 32-byte
context cap, a cap smaller than the chunk marker, multiple chunks whose charged
separators land exactly at the cap, multi-byte truncation, 10,000
duplicate/unique notes, an oversized multibyte note, redaction, deduplication,
and omission summaries. Path rejection assertions require distinct stable codes
and path-free Relay notes.

`skills/afk-agent-relay/tests/entry.test.mjs` captures actual HTTP messages and
Codex stdin. It asserts provider framing plus all message content stays within
the configured cap with oversized notes and context, and that complete notes
and their omission summary remain ahead of the truncated context. A too-small
cap and `notes_unreportable` must return an error without calling the provider.
Brief and scope both exercise the same shared `runRole` boundary.

Existing snapshot tests pin that extracting the file reader does not weaken
symlink, irregular-file, outside-worktree, or pre-read large-file handling. An
injected descriptor-read spy proves a file over the existing size limit is
closed without being read. The full repository suite and manifest/version
checks run after implementation.
