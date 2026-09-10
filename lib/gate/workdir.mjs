// A gate's temp directory is an OUTCOME, not an assumption.
//
// `mkdtempSync` throws when the resolved temp root does not exist — a stale
// TMPDIR export, a cleaned-up per-session directory, a locked-down image — and
// every gate called it at module top level, so the exception escaped and the
// process exited with a raw stack and NO marker block. A driver parsing stdout
// then has silence to classify: not a verdict, not a skip, not an error.
//
// Returns `{ path, error }` rather than taking a reporter that exits, matching
// every other helper here (`validateTarget`, `readDesign`, `spawnViaShell`):
// the exit belongs to the gate's own protocol object, and a returned error is
// assertable in-process instead of only through a spawned binary.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function gateWorkDir(prefix, { tmp = tmpdir() } = {}) {
  try {
    return { path: mkdtempSync(join(tmp, prefix)), error: null };
  } catch (err) {
    return {
      path: null,
      // Both spellings deliberately: `os.tmpdir()` reads TMPDIR then TMP then
      // TEMP on POSIX, and TEMP then TMP on Windows, so naming only TMPDIR
      // tells a Windows operator to change a variable that is never read.
      error: `cannot create this gate's working directory under ${tmp}: ${err.message}. `
        + 'Point TMPDIR (POSIX) or TEMP/TMP (Windows) at a directory that exists and is writable.',
    };
  }
}
