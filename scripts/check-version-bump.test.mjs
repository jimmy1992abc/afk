import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { evaluate, requiresBump, semverGt } from './check-version-bump.mjs';

describe('semverGt', () => {
  test('true when major is greater', () => {
    assert.equal(semverGt('2.0.0', '1.9.9'), true);
  });

  test('true when minor is greater', () => {
    assert.equal(semverGt('1.2.0', '1.1.9'), true);
  });

  test('true when patch is greater', () => {
    assert.equal(semverGt('1.1.2', '1.1.1'), true);
  });

  test('false when equal', () => {
    assert.equal(semverGt('1.2.3', '1.2.3'), false);
  });

  test('false when lower', () => {
    assert.equal(semverGt('1.0.0', '1.2.0'), false);
  });
});

describe('requiresBump', () => {
  test('true for a skills/ path', () => {
    assert.equal(requiresBump(['skills/afk-demo/SKILL.md']), true);
  });

  test('true for a scripts/ path', () => {
    assert.equal(requiresBump(['scripts/lint-skills.mjs']), true);
  });

  test('true for a lib/ path', () => {
    // lib/gate/ is shared runtime imported by every gate helper: a change there
    // alters installed behaviour, and the version is the install cache key, so
    // shipping it unbumped leaves every install running the stale lib.
    assert.equal(requiresBump(['lib/gate/protocol.mjs']), true);
  });

  test('true for a manifest file', () => {
    assert.equal(requiresBump(['.claude-plugin/marketplace.json']), true);
  });

  test('false for unrelated paths', () => {
    assert.equal(requiresBump(['docs/designs/specs/notes.md', 'README.md']), false);
  });

  test('false for an empty change set', () => {
    assert.equal(requiresBump([]), false);
  });
});

describe('evaluate', () => {
  test('ok when base version is null (first PR)', () => {
    const result = evaluate(null, '0.1.0', ['skills/afk-demo/SKILL.md']);
    assert.equal(result.ok, true);
  });

  test('ok when no version-relevant paths changed', () => {
    const result = evaluate('0.1.0', '0.1.0', ['README.md']);
    assert.equal(result.ok, true);
  });

  test('ok when version was bumped', () => {
    const result = evaluate('0.1.0', '0.2.0', ['skills/afk-demo/SKILL.md']);
    assert.equal(result.ok, true);
  });

  test('not ok when version-relevant paths changed but version was not bumped', () => {
    const result = evaluate('0.1.0', '0.1.0', ['skills/afk-demo/SKILL.md']);
    assert.equal(result.ok, false);
  });
});
