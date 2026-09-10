// What a non-UTF-8 Windows code page does to a review, and the two independent
// halves of the answer: a prompt the model is asked to comply with (level 1),
// and a diagnosis that names the fault when it does not (level 2).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ASCII_PUNCTUATION_CONSTRAINT, ansiCodePage, encodingCrash,
  needsAsciiPunctuation, resolveConsole, toAsciiPunctuation,
} from './console-encoding.mjs';

// ── the probe ───────────────────────────────────────────────────────────────

const regOutput = (body) => ({ status: 0, stdout: body, stderr: '' });

test('the ANSI code page is read from the registry value', () => {
  const probe = () => regOutput(
    '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage\r\n'
    + '    ACP    REG_SZ    936\r\n\r\n',
  );

  assert.equal(ansiCodePage({ platform: 'win32', probe }), 936);
});

test('a UTF-8 ACP reads as 65001, so the constraint is not applied', () => {
  const probe = () => regOutput('    ACP    REG_SZ    65001\r\n');

  assert.equal(ansiCodePage({ platform: 'win32', probe }), 65001);
  assert.equal(needsAsciiPunctuation({ platform: 'win32', codePage: 65001 }), false);
});

test('a hex value is not read as a decimal code page', () => {
  // `0x3a8` under a base-10 parse is 0 — still fail-closed, but the ERROR would
  // name a code page that does not exist.
  const probe = () => regOutput('    ACP    REG_DWORD    0x3a8\r\n');

  assert.equal(ansiCodePage({ platform: 'win32', probe }), null);
});

test('an unusable probe answer is null, never a guess', () => {
  for (const answer of [
    { status: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key' },
    regOutput('nothing useful here'),
    regOutput(''),
    { error: { code: 'ENOENT' } },
  ]) {
    assert.equal(ansiCodePage({ platform: 'win32', probe: () => answer }), null, JSON.stringify(answer));
  }
});

test('off win32 nothing is probed at all', () => {
  let called = false;
  const probe = () => { called = true; return regOutput('    ACP    REG_SZ    936\r\n'); };

  assert.equal(ansiCodePage({ platform: 'darwin', probe }), null);
  assert.equal(called, false, 'a POSIX box has no ANSI code page to read');
});

test('an undetermined code page fails CLOSED, on win32 only', () => {
  // An undetected page costs punctuation; an undetected GBK costs the round.
  assert.equal(needsAsciiPunctuation({ platform: 'win32', codePage: null }), true);
  assert.equal(needsAsciiPunctuation({ platform: 'win32', codePage: 936 }), true);
  assert.equal(needsAsciiPunctuation({ platform: 'darwin', codePage: null }), false);
  assert.equal(needsAsciiPunctuation({ platform: 'linux', codePage: 936 }), false);
});

// ── the normaliser ──────────────────────────────────────────────────────────

test('every character the four code pages reject is mapped', () => {
  // Measured with the codecs themselves: cp936 cannot encode U+2212 or U+00A0
  // — and CAN encode the em dash, which is why "dashes and quotes" is the
  // wrong description of this set. cp932/949/950 reject different members.
  const mapped = {
    '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-',
    '―': '-', '−': '-', '‘': "'", '’': "'", '“': '"',
    '”': '"', ' ': ' ', '…': '...',
  };
  for (const [from, to] of Object.entries(mapped)) {
    assert.equal(toAsciiPunctuation(`a${from}b`), `a${to}b`, JSON.stringify(from));
  }
  // The two that actually crash the reporter's page.
  assert.equal(toAsciiPunctuation('12−3'), '12-3');
  assert.equal(toAsciiPunctuation('a b'), 'a b');
});

test('the normaliser is not a transliterator', () => {
  // Transliterating CJK would destroy the review — and on cp932/949/950 a
  // Chinese character is unencodable too, which this deliberately does NOT
  // try to fix.
  const text = '设计规格 review: 100% ok, path/to/file.mjs, "quoted", 3-4';
  assert.equal(toAsciiPunctuation(text), text);
  assert.equal(toAsciiPunctuation('日本語'), '日本語');
});

test('normalising is a no-op on text that has nothing to map', () => {
  assert.equal(toAsciiPunctuation(''), '');
  assert.equal(toAsciiPunctuation('plain ascii'), 'plain ascii');
});

// ── the constraint ──────────────────────────────────────────────────────────

test('the constraint states its reason, spares CJK, and covers the two crashers', () => {
  const c = ASCII_PUNCTUATION_CONSTRAINT;

  assert.match(c, /tooling limit/i, 'a model told to restrict punctuation for no reason drifts back');
  assert.match(c, /minus sign/i, 'U+2212 is the character in the bug report');
  assert.match(c, /CJK text is fine/);
  assert.match(c, /no-break space/i, 'the marked addition — NBSP encodes on none of the four pages');
  // It must not itself contain what it forbids.
  assert.equal(toAsciiPunctuation(c), c, 'the constraint models its own instruction');
});

// ── the diagnosis ───────────────────────────────────────────────────────────

test('an output-side crash is recognised as an encode failure', () => {
  const stderr = "UnicodeEncodeError: 'gbk' codec can't encode character '−' in position 41: illegal multibyte sequence";

  const crash = encodingCrash(stderr);

  assert.equal(crash.kind, 'encode');
  assert.match(crash.detail, /gbk/);
});

test('an input-side crash is recognised as a decode failure, which means something else', () => {
  // On the shim path this IS a brief that was never read: the gate wrote that
  // file as UTF-8 and the CLI could not decode it. The remedy differs, so the
  // classification has to.
  const crash = encodingCrash("UnicodeDecodeError: 'gbk' codec can't decode byte 0xe2 in position 12");

  assert.equal(crash.kind, 'decode');
});

test('ordinary reviewer output is not an encoding crash', () => {
  assert.equal(encodingCrash(''), null);
  assert.equal(encodingCrash('P1 candidate: the encoding of this file is wrong'), null);
  assert.equal(encodingCrash('error: unknown option --print'), null);
});

// ── the seam ────────────────────────────────────────────────────────────────

test('KIMI_GATE_CONSOLE replaces the probe in both directions', () => {
  let probed = false;
  const probe = () => { probed = true; return regOutput('    ACP    REG_SZ    936\r\n'); };

  const legacy = resolveConsole({ platform: 'darwin', override: 'legacy', probe });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.constrain, true, 'forced on, off Windows — the branch must be testable');
  assert.equal(legacy.source, 'override');

  const utf8 = resolveConsole({ platform: 'win32', override: 'utf8', probe });
  assert.equal(utf8.constrain, false, 'forced off, on Windows');
  assert.equal(probed, false, 'a forced console must not spend a probe');
});

test('an unrecognised KIMI_GATE_CONSOLE stops the round', () => {
  const resolved = resolveConsole({ platform: 'win32', override: 'legasy', probe: () => regOutput('') });

  assert.equal(resolved.ok, false);
  assert.match(resolved.reason, /legasy/);
  assert.match(resolved.reason, /utf8/);
  assert.equal(resolved.constrain, undefined, 'never a silent fall back to probing');
});

test('unset, the console is resolved by probing', () => {
  const resolved = resolveConsole({
    platform: 'win32', override: '', probe: () => regOutput('    ACP    REG_SZ    936\r\n'),
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.constrain, true);
  assert.equal(resolved.codePage, 936);
  assert.equal(resolved.source, 'probe');
});
