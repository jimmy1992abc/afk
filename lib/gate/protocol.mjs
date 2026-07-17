// The marker-block contract every external gate prints on stdout. The gate
// skills tell the reader to parse these exact strings, so the label is the only
// thing that varies between gates.
//
// A gate always emits a block — a skip, an error, and a review are all
// parseable outcomes. Exiting without one hands the caller silence to interpret.

export function createProtocol({ label, slug, out = process.stdout, err = process.stderr }) {
  const start = `===== ${label} REVIEW (final message) =====`;
  const end = `===== END ${label} REVIEW =====`;

  function block(body) {
    out.write(`${start}\n`);
    out.write(`${body.trim()}\n`);
    out.write(`${end}\n`);
  }

  return {
    start,
    end,

    // A skip is not a failure: the gate is optional, so the caller continues.
    emitSkip(reason) {
      err.write(`[${slug}] skipped: ${reason}\n`);
      block(`SKIPPED: ${reason}`);
      process.exit(0);
    },

    emitReview(text) {
      block(text);
    },

    // The gate ran and could not produce a verdict. Never exits 0 — a caller
    // that only checks the exit code must not read this as a clean review.
    emitError(message, exitCode = 1) {
      err.write(`[${slug}] ${message}\n`);
      block(`ERROR: ${message}`);
      process.exit(exitCode || 1);
    },
  };
}
