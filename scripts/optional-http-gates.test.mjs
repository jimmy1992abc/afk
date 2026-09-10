import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('..', import.meta.url);

test('optional DeepSeek and MiMo gate entry points and skills are bundled', () => {
  for (const family of ['deepseek', 'mimo']) {
    const dir = new URL(`skills/afk-${family}-review/`, root);
    assert.equal(existsSync(new URL('SKILL.md', dir)), true, `${family} skill missing`);
    assert.equal(existsSync(new URL(`${family}-gate.mjs`, dir)), true, `${family} helper missing`);
    const skill = readFileSync(new URL('SKILL.md', dir), 'utf8');
    const prefix = family.toUpperCase();
    assert.match(skill, new RegExp(`${prefix}_REVIEW_MAX_OUTPUT_TOKENS`));
    assert.match(skill, new RegExp(`${prefix}_REVIEW_EXCLUDE_GLOBS`));
    assert.match(skill, /--print-args/);
    assert.match(skill, /--print-prompt/);
  }
});

test('optional families are documented without changing built-in defaults', () => {
  const afk = readFileSync(new URL('skills/afk/SKILL.md', root), 'utf8');
  const claude = readFileSync(new URL('skills/afk-claude-review/SKILL.md', root), 'utf8');
  const readme = readFileSync(new URL('README.md', root), 'utf8');
  const template = readFileSync(new URL('templates/afk-config.example.md', root), 'utf8');
  assert.match(afk, /valid role families[^\n]*deepseek[^\n]*mimo/i);
  assert.match(template, /^gates:\s+codex\s*$/m);
  assert.match(template, /^priority:\s+codex > claude > kimi > glm\b/m);
  assert.doesNotMatch(template, /^priority:.*(?:deepseek|mimo)/m);
  for (const name of ['ZAI_API_KEY', 'DEEPSEEK_REVIEW_API_KEY', 'MIMO_REVIEW_API_KEY']) {
    assert.match(readme, new RegExp(`export ${name}=`), `${name} needs copyable setup guidance`);
  }
  assert.match(readme, /git check-ignore -v \.env/);
  assert.match(claude, /Known families:[^\n]*deepseek[^\n]*mimo/i);
});
