import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { test } from 'node:test';

test('glm gate disabled flag emits a clean skipped review', () => {
  const result = spawnSync(
    process.execPath,
    ['skills/afk-glm-review/glm-gate.mjs', '--base', 'main'],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: { ...process.env, GLM_REVIEW_GATE: 'off' },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /===== GLM REVIEW \(final message\) =====/);
  assert.match(result.stdout, /SKIPPED: GLM gate disabled via GLM_REVIEW_GATE\./);
  assert.match(result.stdout, /===== END GLM REVIEW =====/);
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
