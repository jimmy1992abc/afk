// Which flags a CLI actually accepts, read from the CLI's own `--help`.
//
// Two different products install a binary named `kimi` — `@moonshot-ai/kimi-code`
// (npm, commander) and MoonshotAI's frozen Python `kimi-cli` — and their
// headless surfaces disagree: one takes `-p <prompt> --output-format text`, the
// other rejects `--output-format` unless `--print` accompanies it. A gate that
// pins either table is broken on the other install, and a version string does
// not separate them. So the flag list is DERIVED from `--help` rather than
// transcribed, which is also the literal form of the rule the last flag-drift
// fix could only state in prose: send nothing the installed CLI does not
// document.
//
// Every rule below exists because a reading of a real help text broke it; the
// ones that cost a full design round are named at their line.

/** Option spellings whose value is the prompt. */
const PROMPT_FLAGS = ['-p', '--prompt'];
/** Option spellings that mean "non-interactive, print the answer". */
const PRINT_FLAGS = ['-p', '--print'];

/** A positional named one of these carries the prompt. */
const PROMPT_WORDS = ['prompt', 'query', 'message', 'text', 'input'];

const BOX_RUNES = /^[\s│┃|*]+/;
const OPTION_TOKEN = /^(-{1,2}[A-Za-z0-9][A-Za-z0-9-]*)/;
/** `<value>`, `[value]`, or an argparse-style UPPERCASE metavar. */
const VALUE_PLACEHOLDER = /^ *(<[^>]+>|\[[^\]]+\]|[A-Z][A-Z0-9_]+)(\s|$)/;

/**
 * Every option `helpText` documents, mapped to `'value'` or `'boolean'`.
 *
 * Arity is the point, not presence: `-p` is `-p, --prompt <prompt>` on one CLI
 * and `-p, --print` on another, and attaching a prompt to the boolean one makes
 * the CLI read the prompt's second word as a subcommand.
 */
export function documentedFlags(helpText) {
  const passed = [];

  for (const line of String(helpText ?? '').split(/\r?\n/)) {
    const stripped = line.replace(BOX_RUNES, '');
    if (!stripped.startsWith('-')) continue;
    // The column of the first `-`, counting stripped whitespace AND box runes
    // alike. Leading whitespace alone is 0 for every line inside a box, which
    // flattens the anchor below and lets a wrapped description back in.
    const column = line.length - stripped.length;

    let rest = stripped;
    const names = [];
    let prose = false;
    for (;;) {
      const token = OPTION_TOKEN.exec(rest);
      if (!token) break;
      names.push(token[1]);
      rest = rest.slice(token[1].length);
      // The separator in `-p, --prompt` belongs to the run. Tested as prose
      // punctuation first, it ends the candidate and every short spelling on
      // every real help text disappears.
      if (/^,\s+-/.test(rest)) { rest = rest.replace(/^,\s+/, ''); continue; }
      if (/^ (?=-)/.test(rest)) { rest = rest.slice(1); continue; }
      break;
    }
    // Punctuation glued to the run's end is a sentence, not an option:
    // `--output-format=stream-json)` inside a wrapped description.
    if (/^[).:=,]/.test(rest)) prose = true;
    if (prose || !names.length) continue;

    const placeholder = VALUE_PLACEHOLDER.exec(rest);
    // An option line ends its flag run at a value, two spaces, or the line end.
    if (!placeholder && !/^(\s{2,}|\s*$)/.test(rest)) continue;
    passed.push({ column, names, arity: placeholder ? 'value' : 'boolean' });
  }

  const flags = new Map();
  if (!passed.length) return flags;
  // The option column, computed over lines that already look like options: a
  // stray `- bullet` or `-----` above the block would otherwise redefine the
  // minimum and drop every real option.
  const column = Math.min(...passed.map((entry) => entry.column));
  for (const entry of passed) {
    if (entry.column !== column) continue;
    for (const name of entry.names) flags.set(name, entry.arity);
  }
  return flags;
}

/** The `Usage:` synopsis: its line plus indented continuations. */
function usageBlock(helpText) {
  const lines = String(helpText ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*usage:/i.test(line));
  if (start === -1) return '';
  const block = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || !/^\s/.test(line)) break;
    block.push(line);
  }
  return block.join(' ');
}

/**
 * Whether the usage synopsis documents a positional that carries the prompt.
 *
 * Consulted only for a CLI whose prompt flag is boolean; without it the gate
 * would have to guess whether the positional slot takes a prompt or a
 * subcommand, and guessing wrong sends a multi-line prompt to a subcommand
 * parser.
 */
export function documentedPositional(helpText) {
  const synopsis = usageBlock(helpText)
    // argparse renders options inline WITH their metavars, and `MESSAGE`,
    // `TEXT` and `INPUT` are ordinary metavars: `[--message MESSAGE]` would
    // otherwise read as a prompt positional. Dropped by the group's own first
    // character, so a real positional beside an option group survives.
    .replace(/\[\s*-[^\]]*\]/g, ' ')
    .replace(/\{[^}]*\}/g, ' ');

  const words = PROMPT_WORDS.join('|');
  return new RegExp(`\\[(${words})\\]|<(${words})>|\\b(${words})\\b`, 'i').test(synopsis);
}

/**
 * The flag groups `KIMI_GATE_DIALECT` can force, for an install whose help
 * layout defeats the parser. `print-positional` is not optional: the machine
 * whose help cannot be parsed is the machine whose `-p` arity is unreadable.
 */
export const DIALECT_OVERRIDES = Object.freeze({
  prompt: { transport: 'flag', promptFlag: '-p', mode: ['--output-format', 'text'] },
  print: { transport: 'flag', promptFlag: '-p', mode: ['--print', '--output-format', 'text', '--final-message-only'] },
  'print-positional': { transport: 'positional', mode: ['--print', '--output-format', 'text', '--final-message-only'] },
});

const OUTPUT_FORMAT_FLAGS = ['--output-format', 'text'];

function buildArgsFor({ transport, promptFlag, mode }) {
  return (payload) => {
    const args = [];
    if (transport === 'flag') args.push(promptFlag, payload);
    args.push(...mode);
    if (transport === 'positional') args.push(payload);
    return args;
  };
}

const decline = (reason) => ({
  ok: false,
  reason: `${reason} Set KIMI_GATE_DIALECT to ${Object.keys(DIALECT_OVERRIDES).join(', ')} to state it explicitly.`,
});

/**
 * Resolve the headless invocation for one installed CLI.
 *
 * `override` (from `KIMI_GATE_DIALECT`) replaces the probe outright — it is the
 * escape hatch for a CLI whose help cannot be read at all, so it must not
 * depend on having read it.
 */
export function resolveDialect({ helpText = '', override = '' } = {}) {
  const forced = String(override ?? '').trim().toLowerCase();
  if (forced) {
    const set = DIALECT_OVERRIDES[forced];
    if (!set) {
      return {
        ok: false,
        reason: `KIMI_GATE_DIALECT=${JSON.stringify(override)} is not a dialect this gate knows; accepted values are ${Object.keys(DIALECT_OVERRIDES).join(', ')}.`,
      };
    }
    // Every override set carries `--final-message-only` where it carries
    // `--print`, so a forced dialect cannot reach the transcript hazard below.
    return {
      ok: true,
      dialect: forced,
      source: 'override',
      buildArgs: buildArgsFor(set),
    };
  }

  const flags = documentedFlags(helpText);
  if (!flags.size) {
    return decline('this CLI\'s `--help` documents no options at all, so the gate cannot tell which flags it accepts.');
  }

  const promptFlag = PROMPT_FLAGS.find((flag) => flags.get(flag) === 'value');
  const printFlag = PRINT_FLAGS.find((flag) => flags.get(flag) === 'boolean');
  const mode = [];
  if (flags.has('--print')) mode.push('--print');
  if (flags.has('--output-format')) mode.push(...OUTPUT_FORMAT_FLAGS);
  const finalMessageOnly = flags.has('--final-message-only');
  if (finalMessageOnly) mode.push('--final-message-only');

  let transport;
  if (promptFlag) {
    transport = 'flag';
  } else if (printFlag && documentedPositional(helpText)) {
    transport = 'positional';
  } else {
    return decline(printFlag
      ? 'this CLI documents a boolean print flag but no prompt option and no prompt positional in its usage line, so there is no way to hand it a review brief.'
      : 'this CLI\'s `--help` documents no prompt option, so there is no way to hand it a review brief.');
  }

  const printing = mode.includes('--print');
  // Without `--final-message-only` a print-mode CLI answers with its whole
  // transcript — and `emitVerifiedReview` accepts any answer containing a
  // verdict word, which a transcript does, so the marker block would carry a
  // transcript as a verdict and the round would read clean. Nothing downstream
  // can tell the two apart, and a warning is not a control: the caller is told
  // to keep stdout and read the block. So this resolves to nothing, BEFORE the
  // paid call, rather than after it.
  if (printing && !finalMessageOnly) {
    return decline('this CLI documents --print but no --final-message-only, so its answer would be a whole '
      + 'transcript, and a transcript containing a verdict word cannot be told apart from a verdict.');
  }

  return {
    ok: true,
    dialect: printing ? (transport === 'positional' ? 'print-positional' : 'print') : 'prompt',
    source: 'probe',
    buildArgs: buildArgsFor({ transport, promptFlag, mode }),
  };
}
