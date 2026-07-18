import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'node:test';

const repoRoot = new URL('..', import.meta.url);
const GATE = 'skills/afk-glm-review/glm-gate.mjs';

function runGate({ args = [], env = {} } = {}) {
  return spawnSync(process.execPath, [GATE, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function withDesignDoc(text, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'glm-gate-design-'));
  try {
    const path = join(dir, 'spec.md');
    writeFileSync(path, text);
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('glm gate disabled flag emits a clean skipped review', () => {
  const result = runGate({ args: ['--base', 'main'], env: { GLM_REVIEW_GATE: 'off' } });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /===== GLM REVIEW \(final message\) =====/);
  assert.match(result.stdout, /SKIPPED: GLM gate disabled via GLM_REVIEW_GATE\./);
  assert.match(result.stdout, /===== END GLM REVIEW =====/);
});

// ── design mode ─────────────────────────────────────────────────────────────

test('glm design mode resolves the design kind, not a diff selector', () => {
  withDesignDoc('# Spec\n', (path) => {
    const result = runGate({ args: ['--design', path, '--print-args'] });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.kind, 'design');
    assert.equal(parsed.base, null);
    assert.equal(parsed.commit, null);
  });
});

test('glm design mode sends the doc text as the payload, not a diff+files snapshot', () => {
  const body = '# Title\n\nA DESIGN-ONLY claim GLM must review.\n';
  withDesignDoc(body, (path) => {
    const result = runGate({ args: ['--design', path, '--print-prompt'] });
    assert.equal(result.status, 0, result.stderr);
    const out = result.stdout;
    // The document text is the payload GLM receives...
    assert.match(out, /A DESIGN-ONLY claim GLM must review\./);
    // ...under a design system prompt, not a code-diff one.
    assert.match(out, /SOUND WITH CONCERNS/);
    assert.doesNotMatch(out, /file:line/);
    // The diff-mode payload sections must be absent.
    assert.doesNotMatch(out, /## Full diff/);
    assert.doesNotMatch(out, /## Full current contents of changed files/);
  });
});

test('glm design mode fails loudly on a missing doc, never a skip', () => {
  const missing = join(tmpdir(), 'glm-gate-no-such-design-xyz.md');
  const result = runGate({ args: ['--design', missing] });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /ERROR: cannot review/);
  assert.match(result.stdout, /--design/);
  assert.doesNotMatch(result.stdout, /SKIPPED/);
});

test('every external gate is listed on every plugin surface', () => {
  // A gate nobody can discover is a gate that never runs, so each surface that
  // advertises the set must advertise all of it.
  const afkSkill = readFileSync(new URL('../skills/afk/SKILL.md', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../templates/afk-config.example.md', import.meta.url), 'utf8');

  for (const gate of ['afk-codex-review', 'afk-claude-review', 'afk-kimi-review', 'afk-glm-review']) {
    assert.match(afkSkill, new RegExp(gate), `afk/SKILL.md must list ${gate}`);
    assert.match(readme, new RegExp(gate), `README must list ${gate}`);
  }
  assert.match(config, /priority: codex > claude > kimi > glm/);
});
