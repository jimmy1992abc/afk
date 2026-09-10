// Unit tests for the shared single-line `.afk/config.md` reader.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { test } from 'node:test';

import {
  hasConfigKeyInSection,
  readConfigSectionValue,
  readConfigSectionStrict,
  readConfigValue,
} from './config.mjs';

test('strict section observation distinguishes absent, empty, unreadable and invalid UTF-8', () => {
  withConfig('##   EXTERNAL GATE\n', (path) => {
    assert.equal(readConfigSectionStrict(path, 'external gate').present, true);
    assert.equal(readConfigSectionStrict(`${path}.missing`, 'external gate').present, false);
    assert.throws(() => readConfigSectionStrict(dirname(path), 'external gate'), /unreadable/);
    writeFileSync(path, Buffer.from([0xc0, 0xaf]));
    assert.throws(() => readConfigSectionStrict(path, 'external gate'), /UTF-8|unreadable/);
  });
});

function withConfig(text, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'afk-config-'));
  const path = join(dir, 'config.md');
  try {
    writeFileSync(path, text, 'utf8');
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('readConfigValue reads a key and trims the value', () => {
  withConfig('auto-resume:   notify  \n', (p) => {
    assert.equal(readConfigValue(p, 'auto-resume'), 'notify');
  });
});

test('readConfigValue strips a trailing inline comment', () => {
  withConfig('auto-resume: auto   # opt in to auto-drive\n', (p) => {
    assert.equal(readConfigValue(p, 'auto-resume'), 'auto');
  });
});

test('readConfigValue is case-insensitive on the key and ignores leading space', () => {
  withConfig('   Auto-Resume: off\n', (p) => {
    assert.equal(readConfigValue(p, 'auto-resume'), 'off');
  });
});

test('readConfigValue returns empty for an absent key', () => {
  withConfig('policy: leave-open\n', (p) => {
    assert.equal(readConfigValue(p, 'auto-resume'), '');
  });
});

test('readConfigValue returns empty for a missing or empty path', () => {
  assert.equal(readConfigValue('', 'auto-resume'), '');
  assert.equal(readConfigValue(join(tmpdir(), 'does-not-exist-xyz', 'config.md'), 'auto-resume'), '');
});

test('readConfigValue matches the first occurrence only', () => {
  withConfig('auto-resume: notify\nauto-resume: auto\n', (p) => {
    assert.equal(readConfigValue(p, 'auto-resume'), 'notify');
  });
});

// CRLF tolerance: a Windows-saved config must parse exactly like its LF twin.

test('section readers agree on a CRLF external-gate block', () => {
  const text = '## external gate\r\ngates: codex > kimi   # ordered\r\npriority: codex > claude\r\n';
  withConfig(text, (p) => {
    assert.equal(hasConfigKeyInSection(p, 'external gate', 'gates'), true);
    assert.equal(readConfigSectionValue(p, 'external gate', 'gates'), 'codex > kimi');
  });
});

test('readConfigValue reads a CRLF flat key (pins the existing tolerance)', () => {
  withConfig('auto-resume: notify\r\n', (p) => {
    assert.equal(readConfigValue(p, 'auto-resume'), 'notify');
  });
});

test('duplicate key with an empty first value resolves the same under LF and CRLF', () => {
  withConfig('gates:\ngates: codex\n', (lf) => {
    withConfig('gates:\r\ngates: codex\r\n', (crlf) => {
      assert.equal(readConfigValue(lf, 'gates'), readConfigValue(crlf, 'gates'));
      assert.equal(readConfigValue(crlf, 'gates'), 'codex');
    });
  });
});

test('a final line ending in a bare \\r with no \\n still parses', () => {
  withConfig('## external gate\r\ngates: codex\r', (p) => {
    assert.equal(hasConfigKeyInSection(p, 'external gate', 'gates'), true);
    assert.equal(readConfigSectionValue(p, 'external gate', 'gates'), 'codex');
    assert.equal(readConfigValue(p, 'gates'), 'codex');
  });
});

test('double-converted \\r\\r\\n endings still parse', () => {
  withConfig('## external gate\r\r\ngates: codex\r\r\n', (p) => {
    assert.equal(hasConfigKeyInSection(p, 'external gate', 'gates'), true);
    assert.equal(readConfigSectionValue(p, 'external gate', 'gates'), 'codex');
  });
});

test('mixed line endings parse consistently', () => {
  const text = '## merge\npolicy: leave-open\r\n\n## resume\r\nauto-resume: auto\n';
  withConfig(text, (p) => {
    assert.equal(readConfigSectionValue(p, 'merge', 'policy'), 'leave-open');
    assert.equal(readConfigSectionValue(p, 'resume', 'auto-resume'), 'auto');
  });
});

test('readConfigValue reproduces the implementer parse it replaces', () => {
  // Parity with the pattern lib/gate/implementer.mjs used before this reader
  // was shared: `^\s*<key>\s*:\s*([^#]+)` trimmed.
  withConfig('# comment\nimplementer:  codex  # who wrote it\n', (p) => {
    assert.equal(readConfigValue(p, 'implementer'), 'codex');
  });
});

test('section readers distinguish absent, empty, and nonempty keys', () => {
  withConfig([
    '## external gate',
    'gates:',
    'priority: codex > kimi',
    '',
    '## commands',
    'mode: unrelated',
    '',
  ].join('\n'), (p) => {
    assert.equal(hasConfigKeyInSection(p, 'external gate', 'gates'), true);
    assert.equal(readConfigSectionValue(p, 'external gate', 'gates'), '');
    assert.equal(readConfigSectionValue(p, 'external gate', 'priority'), 'codex > kimi');
    assert.equal(hasConfigKeyInSection(p, 'external gate', 'mode'), false);
    assert.equal(readConfigSectionValue(p, 'commands', 'mode'), 'unrelated');
  });
});

test('section readers are heading/key case-insensitive and stop at the next heading', () => {
  withConfig('## External Gate\n  Gates: CODEx > KIMI # note\n## Merge\ngates: wrong\n', (p) => {
    assert.equal(hasConfigKeyInSection(p, 'external gate', 'gates'), true);
    assert.equal(readConfigSectionValue(p, 'EXTERNAL GATE', 'GATES'), 'CODEx > KIMI');
  });
});

test('section readers return safe defaults for missing files and sections', () => {
  const missing = join(tmpdir(), 'afk-config-missing', 'config.md');
  assert.equal(hasConfigKeyInSection(missing, 'external gate', 'gates'), false);
  assert.equal(readConfigSectionValue(missing, 'external gate', 'gates'), '');
  withConfig('## commands\ntest: node --test\n', (p) => {
    assert.equal(hasConfigKeyInSection(p, 'external gate', 'gates'), false);
  });
});
