// The marker-block contract every external gate prints on stdout. The gate
// skills tell the reader to parse these exact strings, so the label is the only
// thing that varies between gates.
//
// A gate always emits a block — a skip, an error, and a review are all
// parseable outcomes. Exiting without one hands the caller silence to interpret.

import { writeSync } from 'node:fs';
import { DESIGN_VERDICTS, DIFF_VERDICTS } from './prompt.mjs';

// Review text is model output over attacker-influenced input (the diff under
// review). A body line that looks like a marker would terminate the block
// early for a strict parser and let a forged SKIPPED/verdict ride outside it.
// [A-Z]+ assumes single-word labels — true of all six gates; a multi-word
// label would need the class widened here.
const MARKER_LOOKALIKE = /^\s*===== (?:END )?[A-Z]+ REVIEW/;

// A decision must be explicit; examples and incidental words are not verdicts.
export function validateTerminalVerdict(review, mode) {
  if (!['diff', 'design'].includes(mode)) throw new Error(`unknown review mode: ${mode}`);
  if (![DIFF_VERDICTS, DESIGN_VERDICTS].every((words) => Array.isArray(words)
    && words.length && words.every((word) => typeof word === 'string' && word))) {
    throw new Error('unusable verdict vocabulary');
  }
  const allowed = mode === 'design' ? DESIGN_VERDICTS : DIFF_VERDICTS;
  const recognized = new Set([...DIFF_VERDICTS, ...DESIGN_VERDICTS]);
  const decisions = new Set();
  let fence = null;
  let terminal = null;
  for (const raw of review.split(/\r?\n/)) {
    let line = raw.trim().replace(/^•\s+/, '');
    if (!line) continue;
    terminal = null;
    if (/^(?: {4}| {0,3}\t)/.test(raw)) continue;
    const marker = /^(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length
        && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    if (line.startsWith('>')) continue;
    const outerBold = line.startsWith('**') && line.endsWith('**');
    if (outerBold) line = line.slice(2, -2);
    if (line.startsWith('Verdict: ')) {
      line = line.slice('Verdict: '.length);
      if (!outerBold && line.startsWith('**') && line.endsWith('**')) line = line.slice(2, -2);
    }
    if (recognized.has(line)) {
      decisions.add(line);
      terminal = line;
    }
  }
  return {
    ok: !fence && allowed.includes(terminal) && decisions.size === 1,
    label: allowed.join(' / '),
    verdict: terminal,
  };
}

export function createProtocol({ label, slug, out = process.stdout, err = process.stderr, observer = null }) {
  const start = `===== ${label} REVIEW (final message) =====`;
  const end = `===== END ${label} REVIEW =====`;

  // Trim FIRST, then sanitize: mapping before a trim would hand the trim the
  // sanitizer's own leading space on a first-line forgery and restore the
  // marker to column 0.
  function block(body) {
    const sanitized = String(body)
      .trim()
      .split('\n')
      .map((line) => (MARKER_LOOKALIKE.test(line) ? ` ${line}` : line))
      .join('\n');
    // Written synchronously to the descriptor. A piped stdout is written
    // asynchronously, so the process.exit() that follows a skip or an error
    // would discard whatever had not drained — losing the END marker of any
    // review past the pipe buffer and leaving it unparseable. `out` is the
    // injected stream in tests, which has no descriptor.
    write(`${start}\n${sanitized}\n${end}\n`);
  }

  function write(text) {
    const fd = out === process.stdout ? 1 : null;
    if (fd === null) {
      out.write(text);
      return;
    }
    let written = 0;
    const buffer = Buffer.from(text, 'utf8');
    while (written < buffer.length) {
      try {
        written += writeSync(fd, buffer, written);
      } catch (error) {
        // A non-blocking descriptor can refuse a full buffer; retry the rest.
        if (error.code !== 'EAGAIN') throw error;
      }
    }
  }

  function publish(body, event, { preview = false } = {}) {
    try {
      observer?.prepare(event);
      if (preview) {
        if (observer) write(body); else out.write(body);
      } else block(body);
      observer?.commit();
    } catch (error) {
      const message = `review receipt publication failed: ${error.message}`;
      err.write(`[${slug}] ${message}\n`);
      block(`ERROR: ${message}`);
      process.exit(1);
    }
  }

  const protocol = {
    start,
    end,

    // A skip is not a failure: the gate is optional, so the caller continues.
    emitSkip(reason) {
      err.write(`[${slug}] skipped: ${reason}\n`);
      publish(`SKIPPED: ${reason}`, { kind: 'skipped', reason, verdict: null, text: null });
      process.exit(0);
    },

    emitReview(text, verdict = null) {
      publish(text, { kind: 'review', text, verdict, reason: null });
    },

    emitPreview(text) {
      publish(text, { kind: 'preview', reason: 'preview only; no review requested', verdict: null, text: null }, { preview: true });
    },

    // The gate ran and could not produce a verdict. Never exits 0 — a caller
    // that only checks the exit code must not read this as a clean review.
    emitError(message, exitCode = 1) {
      err.write(`[${slug}] ${message}\n`);
      publish(`ERROR: ${message}`, { kind: 'error', reason: message, verdict: null, text: null });
      process.exit(exitCode || 1);
    },

    // Returns on success; only its error paths exit (via emitError) — the
    // per-gate exit tails after it stay live code.
    emitVerifiedReview(text, {
      requireVerdict = false,
      mode = 'diff',
      emptyMessage,
      missingVerdictMessage,
      exitCode = 1,
    } = {}) {
      const review = String(text ?? '').trim();
      if (!review) {
        protocol.emitError(
          emptyMessage || `${label} returned an empty review — an empty result is an error, not an empty approval.`,
          exitCode,
        );
      }
      let decision = null;
      if (requireVerdict) {
        let verdict;
        try {
          verdict = validateTerminalVerdict(review, mode);
        } catch (validationError) {
          protocol.emitError(`cannot review — invalid verdict configuration: ${validationError.message}`, 1);
        }
        if (!verdict.ok) {
          protocol.emitError(
            missingVerdictMessage
              || `${label} answered without an unambiguous terminal verdict line (${verdict.label}); the review is discarded rather than presented as a verdict.`,
            exitCode,
          );
        }
        decision = verdict.verdict;
      }
      protocol.emitReview(review, decision);
    },
  };
  return protocol;
}
