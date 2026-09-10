import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const skills = readdirSync(new URL('../skills/', import.meta.url))
  .map((name) => [`skills/${name}/SKILL.md`, read(`skills/${name}/SKILL.md`)]);

test('release identity remains canonical across managed manifests and governance', () => {
  for (const path of ['.claude-plugin/marketplace.json', '.github/plugin/marketplace.json']) {
    const manifest = JSON.parse(read(path));
    assert.equal(manifest.owner.name, 'jimmy1992abc');
    assert.equal(manifest.plugins[0].version, JSON.parse(read('package.json')).version);
  }
  assert.match(read('.github/CODEOWNERS'), /\* @jimmy1992abc/);
  assert.doesNotMatch(read('.github/workflows/require-owner-approval.yml'), /AlvinShenSSW/);
});

test('active skills retain structural P2 repairs without an implicit numeric cap', () => {
  for (const [path, text] of skills) {
    assert.doesNotMatch(text, /P2\/minor observations without implementation|only inseparable|Default to \*\*two review-driven|Do not start a third automatic cycle/i, path);
  }
  const driver = read('skills/afk/SKILL.md').replace(/\s+/g, ' ');
  assert.match(driver, /no numeric repair cap by default/i);
  assert.match(driver, /including P2/i);
  assert.match(driver, /two consecutive unfinished rounds without material progress/i);
  assert.match(driver, /Initial review covers the full acceptance criteria/i);
  assert.match(driver, /Re-review checks accepted finding closure/i);
});

test('an absent CI policy requires a resolved remote reading', () => {
  const driver = read('skills/afk/SKILL.md').replace(/\s+/g, ' ');
  assert.match(driver, /blank or absent is `expected`/);
  assert.match(read('templates/afk-config.example.md'), /expected \(default\)/);
});
