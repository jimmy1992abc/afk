# A truncated stream and a cap counting the wrong unit

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#55. Two output-layer defects; brief design per the
scaling rule.

## Frozen issue contract

Acceptance criteria:

1. No exit path discards a pending write; a marker block past the pipe buffer
   arrives whole, END marker included.
2. A test demonstrates it through an actual pipe, not a file.
3. The relay's cap and its reported total are measured in the unit they are
   named for, and truncation never splits a character.
4. A test covers multi-byte and astral-plane content against the cap.

Engineering invariants: no silent truncation; one definition of the unit.

Non-goals: no change to the cap's default; no change to which chunks are
gathered or their order; no change to the redaction rules.

## Design

**The stream.** A piped stdout is written asynchronously, so `process.exit()`
discards what has not drained — measured at exactly 65536 bytes. `emitSkip` and
`emitError` must both write and stop execution, so deferring the exit is not
available without changing their contract at every call site. Writing the block
synchronously to the descriptor keeps that contract and removes the hazard;
measured, the same 200KB arrives whole. A non-blocking descriptor may accept a
partial write, so the loop retries the remainder rather than assuming one call
suffices. An injected stream in tests has no descriptor and takes the ordinary
path.

The repository had already fixed this once, in `hooks/afk-resume-detect.mjs`,
by awaiting the write; that path is async and could afford to.

**The cap.** `AGENT_RELAY_MAX_INPUT_BYTES` is named in bytes and bounds what a
paid model receives, and every measurement was `String.length` — UTF-16 code
units. Chinese content ran about three times the cap. Truncation now cuts on a
character boundary by stepping back off a UTF-8 continuation byte, which also
removes the lone-surrogate hazard the old code-unit slice carried.

## Test plan

`lib/gate/protocol.test.mjs`: a child process emitting a 200KB error block
through a pipe, asserting both the byte count and the END marker survive, and
that the exit code is preserved.

`skills/afk-agent-relay/tests/gather.test.mjs`: CJK content against a byte cap,
asserting the payload and the reported total are both in bytes; astral-plane
content asserting no lone surrogate survives truncation; an ASCII payload under
the cap asserting the cap adds no note.
