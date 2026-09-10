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

function assertFrontmatterError(dirName, category) {
  const errors = lintSkills(skillsDir).filter((e) => e.startsWith(`${dirName}:`));
  assert.ok(
    errors.some((e) => e.includes(category)),
    `expected ${dirName} to report ${category}; got ${JSON.stringify(errors)}`,
  );
}

const VALID_DESCRIPTION = 'afk-demo — Part of the afk pipeline. Does one well-scoped thing reliably.';

describe('lintSkills', () => {
  test('valid skill produces no errors', () => {
    writeSkill('afk-demo', `---\nname: afk-demo\ndescription: "afk-demo: Part of the afk pipeline. Does one well-scoped thing reliably."\n---\nBody.\n`);
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

  test('rejects an unquoted mapping delimiter inside a scalar', () => {
    writeSkill(
      'afk-colon-space',
      '---\nname: afk-colon-space\ndescription: afk-colon-space: Part of the pipeline.\n---\n',
    );
    assertFrontmatterError('afk-colon-space', 'invalid plain scalar');
  });

  test('accepts the same mapping delimiter inside a quoted scalar', () => {
    writeSkill(
      'afk-quoted-colon',
      "---\nname: afk-quoted-colon\ndescription: 'afk-quoted-colon: Part of the afk pipeline.'\n---\n",
    );
    const errors = lintSkills(skillsDir).filter((e) => e.startsWith('afk-quoted-colon:'));
    assert.deepEqual(errors, []);
  });

  test('rejects tab and end-of-value mapping delimiters in plain scalars', () => {
    writeSkill(
      'afk-colon-tab',
      '---\nname: afk-colon-tab\ndescription: A sufficiently long value:\tchild\n---\n',
    );
    writeSkill(
      'afk-colon-end',
      '---\nname: afk-colon-end\ndescription: A sufficiently long value ending here:\n---\n',
    );
    assertFrontmatterError('afk-colon-tab', 'invalid plain scalar');
    assertFrontmatterError('afk-colon-end', 'invalid plain scalar');
  });

  test('rejects a mapping without separation and a malformed line', () => {
    writeSkill(
      'afk-no-separation',
      `---\nname:afk-no-separation\ndescription: ${VALID_DESCRIPTION}\n---\n`,
    );
    writeSkill(
      'afk-malformed-line',
      `---\nname: afk-malformed-line\nnot metadata\ndescription: ${VALID_DESCRIPTION}\n---\n`,
    );
    assertFrontmatterError('afk-no-separation', 'missing mapping separation');
    assertFrontmatterError('afk-malformed-line', 'malformed frontmatter line');
  });

  test('rejects duplicate keys', () => {
    writeSkill(
      'afk-duplicate-key',
      `---\nname: afk-duplicate-key\nname: afk-duplicate-key\ndescription: ${VALID_DESCRIPTION}\n---\n`,
    );
    assertFrontmatterError('afk-duplicate-key', 'duplicate key');
  });

  test('rejects malformed or trailing-content quoted scalars', () => {
    writeSkill(
      'afk-open-quote',
      "---\nname: afk-open-quote\ndescription: 'A sufficiently long open quoted value.\n---\n",
    );
    writeSkill(
      'afk-quote-trailing',
      '---\nname: afk-quote-trailing\ndescription: "A sufficiently long quoted value." trailing\n---\n',
    );
    assertFrontmatterError('afk-open-quote', 'malformed quoted scalar');
    assertFrontmatterError('afk-quote-trailing', 'malformed quoted scalar');
  });

  test('accepts YAML single-quote escaping', () => {
    writeSkill(
      'afk-single-quote',
      "---\nname: afk-single-quote\ndescription: 'afk-single-quote: Part of the afk pipeline with YAML''s escaping.'\n---\n",
    );
    const errors = lintSkills(skillsDir).filter((e) => e.startsWith('afk-single-quote:'));
    assert.deepEqual(errors, []);
  });

  test('rejects YAML implicit non-string plain scalars', () => {
    const cases = [
      ['afk-number-value', '1234567890123456789012345'],
      ['afk-boolean-value', 'true'],
      ['afk-null-value', 'null'],
      ['afk-timestamp-value', '2001-12-15 2:59:43.10'],
    ];
    for (const [dirName, description] of cases) {
      writeSkill(dirName, `---\nname: ${dirName}\ndescription: ${description}\n---\n`);
      assertFrontmatterError(dirName, 'invalid plain scalar');
    }
  });

  test('rejects inline comments that alter a plain scalar', () => {
    writeSkill(
      'afk-inline-comment',
      '---\nname: afk-inline-comment\ndescription: A sufficiently long description # hidden suffix\n---\n',
    );
    assertFrontmatterError('afk-inline-comment', 'invalid plain scalar');
  });

  test('validates Unicode scalar values and raw YAML characters', () => {
    writeSkill(
      'afk-paired-surrogate',
      '---\nname: afk-paired-surrogate\ndescription: "afk-paired-surrogate: Part of the afk pipeline \\uD83D\\uDE00."\n---\n',
    );
    writeSkill(
      'afk-lone-surrogate',
      '---\nname: afk-lone-surrogate\ndescription: "A sufficiently long escaped value \\uD800."\n---\n',
    );
    writeSkill(
      'afk-raw-control',
      "---\nname: afk-raw-control\ndescription: 'A sufficiently long value with \u0001 raw.'\n---\n",
    );
    const validErrors = lintSkills(skillsDir)
      .filter((e) => e.startsWith('afk-paired-surrogate:'));
    assert.deepEqual(validErrors, []);
    assertFrontmatterError('afk-lone-surrogate', 'invalid Unicode character');
    assertFrontmatterError('afk-raw-control', 'invalid Unicode character');
  });

  test('requires exact frontmatter delimiters at column zero', () => {
    const cases = [
      ['afk-space-delimiter', `  ---\nname: afk-space-delimiter\ndescription: ${VALID_DESCRIPTION}\n---\n`],
      ['afk-tab-delimiter', `\t---\nname: afk-tab-delimiter\ndescription: ${VALID_DESCRIPTION}\n---\n`],
      ['afk-bom-delimiter', `\uFEFF---\nname: afk-bom-delimiter\ndescription: ${VALID_DESCRIPTION}\n---\n`],
      ['afk-decorated-close', `---\nname: afk-decorated-close\ndescription: ${VALID_DESCRIPTION}\n--- # close\n`],
    ];
    for (const [dirName, body] of cases) {
      writeSkill(dirName, body);
      assertFrontmatterError(dirName, 'invalid frontmatter delimiter');
    }
  });
});
