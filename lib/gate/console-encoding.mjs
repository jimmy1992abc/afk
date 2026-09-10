// A non-UTF-8 Windows code page destroys a review, and the failure wears the
// wrong face twice over.
//
// The reported crash: one character outside the ANSI code page in the model's
// answer kills the CLI as it writes stdout, and the gate reports a reviewer
// that gave no verdict. Forty minutes of paid review, discarded, blamed on the
// reviewer.
//
// Two independent halves live here, on purpose. The prompt constraint is
// LEVEL 1 — a model choosing to comply, the same standing this repo gives its
// read-only clause. `encodingCrash` is what holds when it does not.
//
// Measured with the codecs themselves, because the intuitive answer is wrong:
//
//   gbk / cp936   cannot encode  U+2212 minus, U+00A0 nbsp
//   cp932         cannot encode  U+2013, U+2014, U+00A0
//   cp949         cannot encode  U+2010, U+2013, U+2014, U+2212, U+00A0
//   cp950         cannot encode  U+2010, U+2015, U+2212, U+00A0
//
// On the reporter's cp936 the em dash, en dash, curly quotes and ellipsis all
// encode FINE. The only two that kill it are the typographic minus — the exact
// character in the bug report — and the no-break space. A mitigation described
// as "dashes and quotes" would have missed both.

/**
 * The output constraint, VERBATIM from the operator report: this exact text ran
 * through several consecutive real reviews without a crash, and a re-invented
 * level-1 control carries none of that evidence. It names its own reason
 * because a model told to restrict its punctuation for no reason drifts back.
 *
 * The last sentence is an ADDITION, not part of the verified text: NBSP encodes
 * on none of the four code pages above and the report does not mention it. It
 * is also weaker cover than the rest — an NBSP is invisible in the model's own
 * output in a way an em dash is not — so `encodingCrash` remains the net.
 */
export const ASCII_PUNCTUATION_CONSTRAINT = [
  'Output constraint (a tooling limit on this machine, not a style preference):',
  'write the review using ASCII punctuation only - a plain hyphen rather than a',
  'minus sign, en dash or em dash, and straight quotes rather than curly ones.',
  'CJK text is fine. A single character outside this set aborts the run and the',
  'entire review is lost. Use ordinary spaces, never a no-break space.',
].join('\n');

/** Every character the four code pages reject, plus the quotes the constraint asks for. */
const PUNCTUATION = new Map([
  ['‐', '-'], ['‑', '-'], ['‒', '-'], ['–', '-'],
  ['—', '-'], ['―', '-'], ['−', '-'],
  ['‘', "'"], ['’', "'"], ['“', '"'], ['”', '"'],
  [' ', ' '], ['…', '...'],
]);
const MAPPED = new RegExp(`[${[...PUNCTUATION.keys()].join('')}]`, 'g');

/**
 * Punctuation only — never a transliterator. CJK, ASCII and everything else
 * pass through untouched: a review is not worth mangling to save it, and on
 * cp932/949/950 a Chinese character is unencodable too, which this deliberately
 * does not try to "fix".
 *
 * The curly quotes and the ellipsis are mapped although all four pages encode
 * them: the constraint asks the model for straight quotes, so a brief carrying
 * curly ones contradicts its own instruction.
 */
export function toAsciiPunctuation(text) {
  return String(text ?? '').replace(MAPPED, (char) => PUNCTUATION.get(char));
}

const UTF8_CODE_PAGE = 65001;

/**
 * The ANSI code page, or null when it cannot be read.
 *
 * The ANSI page, NOT the console's: the review crosses a PIPE (the gate sets no
 * `stdio`), so the console page never governs it — which is why the operator
 * report lists `chcp 65001` among the workarounds that did nothing. Probing
 * `chcp` would read 65001 on a machine that had tried exactly that, withhold
 * the constraint, and lose the review while claiming the gate had checked.
 *
 * `probe` is injected so this is testable without a Windows box.
 */
export function ansiCodePage({ platform = process.platform, probe } = {}) {
  if (platform !== 'win32') return null;
  let answer;
  try {
    answer = probe();
  } catch {
    return null;
  }
  if (!answer || answer.error || answer.status !== 0) return null;
  const line = String(answer.stdout || '').split(/\r?\n/).find((l) => /\bACP\b/.test(l));
  if (!line) return null;
  const token = line.trim().split(/\s+/).pop();
  // Decimal only: a REG_DWORD presentation prints `0x3a8`, which a base-10
  // parse would silently read as code page 0 — fail-closed, but the diagnosis
  // would name a page that does not exist.
  return /^\d+$/.test(token || '') ? Number(token) : null;
}

/**
 * Fail-closed: on win32 an undetermined page constrains the prompt anyway. An
 * undetected page costs punctuation; an undetected GBK costs the whole round.
 */
export function needsAsciiPunctuation({ platform = process.platform, codePage } = {}) {
  if (platform !== 'win32') return false;
  return codePage !== UTF8_CODE_PAGE;
}

/** `utf8` / `legacy` — forced, they REPLACE the probe rather than seed it. */
const CONSOLE_OVERRIDES = Object.freeze({ utf8: false, legacy: true });

/**
 * Whether this run constrains the prompt, and on what evidence.
 *
 * The override exists so the Windows-only branch can execute off Windows — two
 * Windows-only paths in this gate shipped having never run anywhere — and so an
 * operator whose machine defeats the probe has a remedy that needs no code
 * change.
 */
export function resolveConsole({ platform = process.platform, override = '', probe } = {}) {
  const forced = String(override ?? '').trim().toLowerCase();
  if (forced) {
    if (!Object.hasOwn(CONSOLE_OVERRIDES, forced)) {
      return {
        ok: false,
        reason: `KIMI_GATE_CONSOLE=${JSON.stringify(override)} is not a value this gate knows; accepted values are ${Object.keys(CONSOLE_OVERRIDES).join(', ')}.`,
      };
    }
    return {
      ok: true, constrain: CONSOLE_OVERRIDES[forced], codePage: null, source: 'override',
    };
  }
  const codePage = ansiCodePage({ platform, probe });
  return {
    ok: true, constrain: needsAsciiPunctuation({ platform, codePage }), codePage, source: 'probe',
  };
}

// An ENCODE failure is the output-side crash this module exists for. A DECODE
// failure is a different event with a different remedy: on the Windows shim
// path the gate writes the brief as UTF-8 and the CLI reads it under the locale
// encoding, so a decode error IS a brief that was never read, and an
// output-punctuation constraint does nothing for it.
const ENCODE = /UnicodeEncodeError|codec can't encode character|charmap' codec can't encode/i;
const DECODE = /UnicodeDecodeError|codec can't decode/i;
const ILLEGAL = /illegal multibyte sequence/i;

/**
 * The encoding fault in a CLI's output, or null. Matched against stderr AND
 * stdout — a CLI that folds its traceback into its transcript stream must not
 * escape the diagnosis — at the cost that a review *about* encodings could
 * match its own text, on a path that is an error either way.
 */
export function encodingCrash(text) {
  const haystack = String(text ?? '');
  const kind = (DECODE.test(haystack) && 'decode')
    || ((ENCODE.test(haystack) || ILLEGAL.test(haystack)) && 'encode')
    || null;
  if (!kind) return null;
  const detail = haystack.split(/\r?\n/).find(
    (line) => ENCODE.test(line) || DECODE.test(line) || ILLEGAL.test(line),
  );
  return { kind, detail: (detail || '').trim().slice(0, 300) };
}
