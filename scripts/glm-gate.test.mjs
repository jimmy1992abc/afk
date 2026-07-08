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

test('plugin surfaces list glm as a supported external gate', () => {
  const afkSkill = readFileSync(new URL('../skills/afk/SKILL.md', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../templates/afk-config.example.md', import.meta.url), 'utf8');

  assert.match(afkSkill, /afk-glm-review/);
  assert.match(readme, /afk-glm-review/);
  assert.match(config, /codex > kimi > glm/);
});
