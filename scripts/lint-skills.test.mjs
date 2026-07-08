import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { lintSkills } from './lint-skills.mjs';

let root;
let skillsDir;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'lint-skills-'));
  skillsDir = join(root, 'skills');
  mkdirSync(skillsDir);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSkill(dirName, body) {
  const dir = join(skillsDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8');
}

const VALID_DESCRIPTION = 'Does one well-scoped thing across several agent surfaces reliably.';

describe('lintSkills', () => {
  test('valid skill produces no errors', () => {
    writeSkill('afk-demo', `---\nname: afk-demo\ndescription: ${VALID_DESCRIPTION}\n---\nBody.\n`);
    const errors = lintSkills(skillsDir).filter((e) => e.startsWith('afk-demo:'));
    assert.deepEqual(errors, []);
  });

  test('missing frontmatter is flagged', () => {
    writeSkill('afk-no-front', 'Just a body, no frontmatter at all.\n');
    const errors = lintSkills(skillsDir);
    assert.ok(errors.includes('afk-no-front: SKILL.md missing frontmatter'));
  });

  test('missing name is flagged', () => {
    writeSkill('afk-no-name', `---\ndescription: ${VALID_DESCRIPTION}\n---\nBody.\n`);
    const errors = lintSkills(skillsDir);
    assert.ok(errors.includes('afk-no-name: missing name'));
  });

  test('name mismatched with directory is flagged', () => {
    writeSkill('afk-mismatch', `---\nname: afk-other\ndescription: ${VALID_DESCRIPTION}\n---\n`);
    const errors = lintSkills(skillsDir);
    assert.ok(errors.some((e) => e.startsWith('afk-mismatch: name "afk-other" does not match directory')));
  });

  test('name not matching the afk-* pattern is flagged', () => {
    writeSkill('notprefixed', `---\nname: notprefixed\ndescription: ${VALID_DESCRIPTION}\n---\n`);
    const errors = lintSkills(skillsDir);
    assert.ok(errors.some((e) => e.includes('does not match pattern')));
  });

  test('missing description is flagged', () => {
    writeSkill('afk-no-desc', '---\nname: afk-no-desc\n---\n');
    const errors = lintSkills(skillsDir);
    assert.ok(errors.includes('afk-no-desc: missing description'));
  });

  test('description too short is flagged', () => {
    writeSkill('afk-short-desc', '---\nname: afk-short-desc\ndescription: too short\n---\n');
    const errors = lintSkills(skillsDir);
    assert.ok(errors.some((e) => e.startsWith('afk-short-desc: description length')));
  });

  test('description too long is flagged', () => {
    const longDescription = 'x'.repeat(1025);
    writeSkill('afk-long-desc', `---\nname: afk-long-desc\ndescription: ${longDescription}\n---\n`);
    const errors = lintSkills(skillsDir);
    assert.ok(errors.some((e) => e.startsWith('afk-long-desc: description length')));
  });

  test('directory without SKILL.md is flagged', () => {
    mkdirSync(join(skillsDir, 'afk-empty'), { recursive: true });
    const errors = lintSkills(skillsDir);
    assert.ok(errors.includes('afk-empty: missing SKILL.md'));
  });

  test('missing skills directory returns no errors', () => {
    const errors = lintSkills(join(root, 'does-not-exist'));
    assert.deepEqual(errors, []);
  });

  test('empty skills directory returns no errors', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'lint-skills-empty-'));
    const emptySkillsDir = join(emptyRoot, 'skills');
    mkdirSync(emptySkillsDir);
    try {
      assert.deepEqual(lintSkills(emptySkillsDir), []);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});
