// The parser that decides which flags this gate may send. Every fixture whose
// name says "captured" is real output from an installed CLI, trimmed but with
// its columns intact — the layouts are the whole subject, so a fixture written
// to suit the parser would test nothing.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DIALECT_OVERRIDES, documentedFlags, documentedPositional, resolveDialect,
} from './cli-dialect.mjs';

// Captured: @moonshot-ai/kimi-code 0.38.0 (npm, commander).
const KIMI_CODE_HELP = `Usage: kimi [options] [command]

The Starting Point for Next-Gen Agents

Options:
  -V, --version                 output the version number
  -y, --yolo                    Auto-approve regular tool calls; the agent may still ask questions.
                                (default: false)
  -m, --model <model>           LLM model alias to use for this invocation. Defaults to
                                default_model in config.toml.
  -p, --prompt <prompt>         Run one prompt non-interactively and print the response.
  --output-format <format>      Output format for prompt mode. Defaults to text. (choices: "text",
                                "stream-json")
  --plan                        Start in plan mode. (default: false)
  -h, --help                    Show help.

Commands:
  login [options]               Authenticate with Kimi Code CLI via the device-code flow.
  doctor                        Validate Kimi Code configuration files.
`;

// Captured: claude. The hostile one — a BOOLEAN `-p`, a prompt positional in
// the usage line, and three wrapped description lines that begin with a flag.
const CLAUDE_HELP = `Usage: claude [options] [command] [prompt]

Claude Code - starts an interactive session by default, use -p/--print for
non-interactive output

Options:
  --include-partial-messages            Include partial message chunks as they
                                        arrive (only works with --print and
                                        --output-format=stream-json)
  --input-format <format>               Input format (only works with --print):
  --output-format <format>              Output format (only works with --print):
                                        "text" (default), "json" (single
  -p, --print                           Print response and exit (useful for
                                        pipes). Note: The workspace trust dialog
  -h, --help                            Display help for command
`;

// Hypothetical: kimi-cli 1.43.0's help is not capturable here (the product is
// not installed). Shaped from its one reported behaviour — `--output-format`
// valid only alongside `--print` — NOT from a captured layout.
const KIMI_CLI_HELP = `Usage: kimi [OPTIONS] [PROMPT]...

Options:
  -p, --prompt TEXT           Run one prompt non-interactively.
  --print                     Print the response and exit.
  --output-format TEXT        Output format for print mode.  [text|stream-json]
  --final-message-only        Print only the final message.
  --help                      Show this message and exit.
`;

test('a captured commander help yields its options with their arity', () => {
  const flags = documentedFlags(KIMI_CODE_HELP);

  assert.equal(flags.get('-p'), 'value');
  assert.equal(flags.get('--prompt'), 'value', 'both spellings of one option carry its arity');
  assert.equal(flags.get('--output-format'), 'value');
  assert.equal(flags.get('--plan'), 'boolean');
  assert.equal(flags.has('--print'), false);
  assert.equal(flags.has('--final-message-only'), false);
});

test('the separator comma is part of the run, not prose punctuation', () => {
  // Read as prose first, `-p,` ends its candidate and EVERY short spelling
  // disappears — on both real fixtures — which would report "no prompt
  // transport" and error 100% of installs, including the one that works today.
  for (const help of [KIMI_CODE_HELP, CLAUDE_HELP]) {
    const flags = documentedFlags(help);
    assert.ok(flags.has('-p'), 'the short spelling survives the comma');
    assert.ok(flags.has('-h'));
  }
});

test('a boolean flag is not read as value-taking', () => {
  const flags = documentedFlags(CLAUDE_HELP);

  // The claim Revision 1 of the design got wrong: a `-p` token says nothing
  // about arity. Here it is `-p, --print`, and a prompt attached to it would
  // be parsed by the CLI as a subcommand.
  assert.equal(flags.get('-p'), 'boolean');
  assert.equal(flags.get('--print'), 'boolean');
  assert.equal(flags.get('--output-format'), 'value');
  assert.equal(flags.has('--prompt'), false);
});

test('a wrapped description line that begins with a flag is not an option', () => {
  const flags = documentedFlags(CLAUDE_HELP);

  // `--output-format=stream-json)` and `--print and` sit at the description
  // indent. Harvesting `--print` here sends it to a CLI that rejects it.
  assert.equal(flags.get('--print'), 'boolean', 'the real entry is still found');
  assert.equal(flags.has('--output-format=stream-json'), false);
});

test('the option column is the first-dash column, so a box cannot flatten it', () => {
  // Inside a box every line's LEADING WHITESPACE is 0, so an indent measured
  // that way makes the anchor a no-op and the prose flag returns.
  const boxed = [
    '┌─ Options ─┐',
    '│ -p, --prompt <p>     send a prompt',
    '│ --output-format <f>  format',
    '│                --print   (see the print UI)',
    '└───────────┘',
  ].join('\n');

  const flags = documentedFlags(boxed);

  assert.equal(flags.get('--prompt'), 'value');
  assert.equal(flags.get('--output-format'), 'value');
  assert.equal(flags.has('--print'), false, 'a wrapped line inside a box is still prose');
});

test('a dash-leading noise line above the options block cannot drop the block', () => {
  const noisy = ['Usage: x [options]', '', '- a bullet', '-----', '', 'Options:', '  -p, --prompt <p>  send'].join('\n');

  assert.equal(documentedFlags(noisy).get('--prompt'), 'value');
});

test('help text with no options at all yields nothing, and says nothing', () => {
  assert.equal(documentedFlags('').size, 0);
  assert.equal(documentedFlags('Usage: kimi\n\nNo options.\n').size, 0);
});

// ── the usage line's positional ─────────────────────────────────────────────

test('a prompt positional is read from the usage line, in either vocabulary', () => {
  assert.equal(documentedPositional(CLAUDE_HELP), true, '[prompt]');
  assert.equal(documentedPositional(KIMI_CLI_HELP), true, '[PROMPT]... — the Python rendering');
  assert.equal(documentedPositional(KIMI_CODE_HELP), false, '[command] is a subcommand slot');
  assert.equal(documentedPositional('Usage: kimi [OPTIONS] COMMAND [ARGS]...'), false);
});

test("an option's inline metavar is not a positional", () => {
  // argparse renders every option inline with its metavar, and three of the
  // words this vocabulary accepts are ordinary metavars. Reading them as a
  // positional makes the gate GUESS a transport and append the review prompt
  // to a subcommand slot.
  for (const usage of [
    'usage: kimi [-h] [-p] [--message MESSAGE] {doctor,login}',
    'usage: kimi [-h] [-p] [--input INPUT] {doctor,login}',
    'usage: kimi [-h] [-p] [--text TEXT]',
  ]) {
    assert.equal(documentedPositional(usage), false, usage);
  }

  // …and the guard is not a blanket refusal: a real positional beside an
  // option metavar, or after a nested option group, still counts.
  assert.equal(documentedPositional('usage: kimi [-h] [--text TEXT] PROMPT'), true);
  assert.equal(documentedPositional('usage: kimi [-h] [--file [FILE ...]] PROMPT'), true);
  assert.equal(documentedPositional('usage: kimi [-h] [-p | --print] [PROMPT]'), true);
});

test('the usage block is read past its first line', () => {
  assert.equal(documentedPositional('usage: kimi [-h] [-p]\n            [PROMPT]\n'), true);
  // A following section is not part of the block.
  assert.equal(
    documentedPositional('usage: kimi [-h]\n\npositional arguments:\n  PROMPT   the prompt\n'),
    false,
    'only the synopsis decides',
  );
});

// ── composition ─────────────────────────────────────────────────────────────

const argsFor = (help) => {
  const resolved = resolveDialect({ helpText: help });
  assert.equal(resolved.ok, true, resolved.reason);
  return { resolved, args: resolved.buildArgs('PAYLOAD') };
};

test('a commander CLI gets exactly the argv this gate sends today', () => {
  const { resolved, args } = argsFor(KIMI_CODE_HELP);

  assert.equal(resolved.dialect, 'prompt');
  assert.deepEqual(args, ['-p', 'PAYLOAD', '--output-format', 'text']);
});

test('a print-mode CLI gets its own group, and no flag leaks either way', () => {
  const { resolved, args } = argsFor(KIMI_CLI_HELP);

  assert.equal(resolved.dialect, 'print');
  assert.deepEqual(args, ['-p', 'PAYLOAD', '--print', '--output-format', 'text', '--final-message-only']);
});

test('a boolean prompt flag puts the payload in the documented positional', () => {
  const help = KIMI_CLI_HELP.replace('-p, --prompt TEXT           Run one prompt non-interactively.',
    '-p, --print                 Print the response and exit.');
  const { resolved, args } = argsFor(help);

  assert.equal(resolved.dialect, 'print-positional');
  assert.deepEqual(args, ['--print', '--output-format', 'text', '--final-message-only', 'PAYLOAD']);
  assert.equal(args.indexOf('PAYLOAD'), args.length - 1, 'the payload is never a flag value here');
});

test('a boolean prompt flag with no documented positional resolves to nothing', () => {
  // The death this row exists to prevent: appending a multi-line prompt to a
  // slot the CLI documents as a subcommand.
  const help = KIMI_CODE_HELP
    .replace('-p, --prompt <prompt>         Run one prompt non-interactively and print the response.',
      '-p, --print                   Print the response and exit.');

  const resolved = resolveDialect({ helpText: help });

  assert.equal(resolved.ok, false);
  assert.match(resolved.reason, /prompt/i);
  assert.match(resolved.reason, /KIMI_GATE_DIALECT/, 'the message carries its own remedy');
});

test('a print CLI that would answer with a transcript resolves to nothing', () => {
  // `emitVerifiedReview` accepts any answer carrying a verdict word, and a
  // transcript carries one — so a transcript would be emitted between the
  // markers and read as a verdict. Nothing downstream can tell them apart, so
  // this fails closed BEFORE the paid call rather than warning after it.
  const help = KIMI_CLI_HELP.replace('  --final-message-only        Print only the final message.\n', '');

  const resolved = resolveDialect({ helpText: help });

  assert.equal(resolved.ok, false);
  assert.match(resolved.reason, /transcript/i);
  assert.match(resolved.reason, /KIMI_GATE_DIALECT/);
});

test('a forced print dialect always carries --final-message-only', () => {
  // The override is the remedy the refusal above points at, so it must not
  // land the operator in the same hazard.
  for (const name of ['print', 'print-positional']) {
    const args = resolveDialect({ override: name }).buildArgs('PAYLOAD');
    assert.ok(args.includes('--final-message-only'), name);
  }
});

test('an unreadable help text resolves to nothing rather than a guess', () => {
  for (const helpText of ['', '   ', 'kimi: command is deprecated']) {
    const resolved = resolveDialect({ helpText });
    assert.equal(resolved.ok, false, JSON.stringify(helpText));
    assert.match(resolved.reason, /KIMI_GATE_DIALECT/);
  }
});

// ── the override ────────────────────────────────────────────────────────────

test('the override outranks the probe and needs no help text', () => {
  for (const [name, expected] of Object.entries({
    prompt: ['-p', 'PAYLOAD', '--output-format', 'text'],
    print: ['-p', 'PAYLOAD', '--print', '--output-format', 'text', '--final-message-only'],
    'print-positional': ['--print', '--output-format', 'text', '--final-message-only', 'PAYLOAD'],
  })) {
    const resolved = resolveDialect({ override: name });
    assert.equal(resolved.ok, true, name);
    assert.equal(resolved.source, 'override');
    assert.deepEqual(resolved.buildArgs('PAYLOAD'), expected, name);
  }

  // Every shape the probe can compose is expressible: the machine whose help
  // defeats the parser is the machine whose arity is unreadable too.
  assert.deepEqual(Object.keys(DIALECT_OVERRIDES).sort(), ['print', 'print-positional', 'prompt']);
});

test('an unrecognised override is a stop, never a fall back to probing', () => {
  const resolved = resolveDialect({ override: 'prnt', helpText: KIMI_CODE_HELP });

  assert.equal(resolved.ok, false);
  assert.match(resolved.reason, /prnt/);
  assert.match(resolved.reason, /prompt/, 'the accepted values are named');
  assert.equal(resolved.dialect, undefined, 'a typo must not silently probe');
});

test('the override is read case- and whitespace-insensitively', () => {
  assert.equal(resolveDialect({ override: ' Print ' }).dialect, 'print');
});
