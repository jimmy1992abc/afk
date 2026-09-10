import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import {
  evaluate,
  getChangedPaths,
  readBaseVersion,
  readWorkingVersion,
  requiresBump,
  semverGt,
} from './check-version-bump.mjs';

const MANIFEST_REL = '.claude-plugin/marketplace.json';

function git(root, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8' },
  );
}

function writeManifest(root, version) {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(root, MANIFEST_REL),
    JSON.stringify({ plugins: [{ name: 'afk-skills', version }] }),
  );
}

const fixtures = [];
after(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

// A fixture repo whose `main` holds the given manifest content (or none).
function makeRepo({ manifest } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'version-bump-'));
  fixtures.push(root);
  git(root, 'init', '-q', '-b', 'main');
  if (manifest === undefined) {
    writeFileSync(join(root, 'README.md'), 'x\n');
  } else {
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, MANIFEST_REL), manifest);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

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

  test('true for a hooks/ path', () => {
    // hooks/ ships to every install as a plugin component (hooks/hooks.json and
    // its bundled scripts), so a change there alters installed behaviour and
    // must bump the version like skills/, scripts/, and lib/.
    assert.equal(requiresBump(['hooks/afk-resume-detect.mjs']), true);
    assert.equal(requiresBump(['hooks/hooks.json']), true);
  });

  test('true for a manifest file', () => {
    assert.equal(requiresBump(['.claude-plugin/marketplace.json']), true);
  });

  test('true for a templates/ path', () => {
    // templates/ ships with the plugin and afk-init consumes it at runtime, so
    // an unbumped template change is invisible to installed hosts.
    assert.equal(requiresBump(['templates/afk-config.example.md']), true);
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

  test('not ok when a bump is required but the head version is unusable', () => {
    // semverGt(head, x) coerces garbage to 0.0.0; an unusable head version must
    // be a distinct failure, never an operand.
    for (const head of [null, undefined, 'one.two', '']) {
      const result = evaluate('0.1.0', head, ['skills/afk-demo/SKILL.md']);
      assert.equal(result.ok, false);
      assert.match(result.reason, /head version/);
    }
  });

  test('ok (skip) with an unusable head version when no shipped path changed', () => {
    // The shape rule sits after the requiresBump early-return.
    const result = evaluate('0.1.0', null, ['README.md']);
    assert.equal(result.ok, true);
  });
});

describe('readBaseVersion', () => {
  test('classifies a readable manifest as { kind: version }', () => {
    const root = makeRepo({ manifest: JSON.stringify({ plugins: [{ version: '0.1.0' }] }) });
    assert.deepEqual(readBaseVersion(root, 'main'), { kind: 'version', version: '0.1.0' });
  });

  test('classifies a manifest absent at the ref as { kind: absent }', () => {
    const root = makeRepo();
    assert.deepEqual(readBaseVersion(root, 'main'), { kind: 'absent' });
  });

  test('classifies an empty-tree base commit as { kind: absent }', () => {
    const root = mkdtempSync(join(tmpdir(), 'version-bump-empty-'));
    fixtures.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'commit', '-q', '--allow-empty', '-m', 'empty');
    assert.deepEqual(readBaseVersion(root, 'main'), { kind: 'absent' });
  });

  test('throws on an unresolvable ref — never a skip', () => {
    const root = makeRepo();
    assert.throws(() => readBaseVersion(root, 'no-such-ref'), /cannot resolve base ref/);
  });

  test('throws on a non-JSON manifest at the ref', () => {
    const root = makeRepo({ manifest: 'not json{' });
    assert.throws(() => readBaseVersion(root, 'main'), /not valid JSON/);
  });

  test('throws on a manifest without plugins[0].version', () => {
    const root = makeRepo({ manifest: JSON.stringify({ plugins: [] }) });
    assert.throws(() => readBaseVersion(root, 'main'), /plugins\[0\]\.version/);
  });

  test('throws on a non-semver version string — no coercion to 0.0.0', () => {
    const root = makeRepo({ manifest: JSON.stringify({ plugins: [{ version: 'one.two' }] }) });
    assert.throws(() => readBaseVersion(root, 'main'), /plugins\[0\]\.version/);
  });
});

describe('readWorkingVersion', () => {
  test('reads a valid working-tree manifest', () => {
    const root = makeRepo({ manifest: JSON.stringify({ plugins: [{ version: '0.2.0' }] }) });
    assert.equal(readWorkingVersion(root), '0.2.0');
  });

  test('throws a classified reason on an unparseable working-tree manifest', () => {
    const root = makeRepo({ manifest: JSON.stringify({ plugins: [{ version: '0.2.0' }] }) });
    writeFileSync(join(root, MANIFEST_REL), 'not json{');
    assert.throws(() => readWorkingVersion(root), /working manifest/);
  });
});

describe('getChangedPaths', () => {
  test('a rename out of a shipped directory surfaces the shipped-side path', () => {
    const root = makeRepo({ manifest: JSON.stringify({ plugins: [{ version: '0.1.0' }] }) });
    mkdirSync(join(root, 'templates'), { recursive: true });
    writeFileSync(join(root, 'templates/example.md'), 'shipped template content\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'add template');
    git(root, 'checkout', '-q', '-b', 'topic');
    mkdirSync(join(root, 'docs'), { recursive: true });
    git(root, 'mv', 'templates/example.md', 'docs/example.md');
    git(root, 'commit', '-q', '-m', 'move template out of shipping');
    const changed = getChangedPaths(root, 'main');
    assert.ok(changed.includes('templates/example.md'), `expected templates/example.md in ${changed}`);
  });
});
