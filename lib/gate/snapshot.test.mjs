import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildSnapshot } from './snapshot.mjs';
import { parseTarget } from './target.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'afk-snapshot-'));
  try {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    writeFileSync(join(dir, 'base.txt'), 'base\n');
    git(dir, ['add', 'base.txt']);
    git(dir, ['commit', '-qm', 'base']);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('uncommitted snapshot excludes .env and redacts a bare MiMo token', () => {
  withRepo((dir) => {
    const token = `tp-${'Ab3'.repeat(12)}`;
    writeFileSync(join(dir, '.env'), 'UNLABELLED_VALUE=must-not-leave\n');
    writeFileSync(join(dir, 'review.txt'), `safe line\n${token}\n`);
    const target = parseTarget(['--uncommitted'], { cwd: dir });
    const snapshot = buildSnapshot({ target, cwd: dir, maxBytes: 20000 });
    assert.equal(snapshot.error, null);
    assert.deepEqual(snapshot.changedFiles, ['review.txt']);
    assert.match(snapshot.payload, /safe line/);
    assert.doesNotMatch(snapshot.payload, /must-not-leave|tp-/);
  });
});

test('uncommitted snapshot never follows an out-of-repository symlink', () => {
  withRepo((dir) => {
    const outside = mkdtempSync(join(tmpdir(), 'afk-snapshot-outside-'));
    try {
      writeFileSync(join(outside, 'credential.txt'), 'outside-secret-value\n');
      symlinkSync(join(outside, 'credential.txt'), join(dir, 'review.txt'));
      const target = parseTarget(['--uncommitted'], { cwd: dir });
      const snapshot = buildSnapshot({ target, cwd: dir, maxBytes: 20000 });
      assert.equal(snapshot.error, null);
      assert.doesNotMatch(snapshot.payload, /outside-secret-value/);
      assert.ok(snapshot.notes.some((note) => /symlink/.test(note)));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('Git-quoted secret paths are excluded through NUL metadata', () => {
  withRepo((dir) => {
    const name = '.env.\tprod';
    writeFileSync(join(dir, name), 'first-secret\n');
    git(dir, ['add', '--', name]);
    git(dir, ['commit', '-qm', 'secret fixture']);
    writeFileSync(join(dir, name), 'second-secret\n');
    const target = parseTarget(['--uncommitted'], { cwd: dir });
    const snapshot = buildSnapshot({ target, cwd: dir, maxBytes: 20000 });
    assert.equal(snapshot.error, null);
    assert.doesNotMatch(snapshot.payload, /first-secret|second-secret|\.env/);
    assert.equal(snapshot.changedFiles.length, 0);
  });
});

test('a staged copy from a secret path is excluded through both NUL metadata sides', () => {
  withRepo((dir) => {
    const value = 'unlabelled-sensitive-source-value';
    writeFileSync(join(dir, '.env'), `${value}\n`);
    git(dir, ['add', '-f', '.env']);
    git(dir, ['commit', '-qm', 'secret fixture']);
    writeFileSync(join(dir, 'public.txt'), `${value}\n`);
    git(dir, ['add', 'public.txt']);
    const target = parseTarget(['--uncommitted'], { cwd: dir });
    const snapshot = buildSnapshot({ target, cwd: dir, maxBytes: 20000 });
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.hasChanges, false);
    assert.doesNotMatch(snapshot.payload, new RegExp(value));
    assert.doesNotMatch(snapshot.payload, /public\.txt|\.env/);
  });
});

test('commit snapshot reads selected commit blobs, not dirty worktree bytes', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'app.txt'), 'selected-commit-value\n');
    git(dir, ['add', 'app.txt']);
    git(dir, ['commit', '-qm', 'selected']);
    const selected = git(dir, ['rev-parse', 'HEAD']);
    writeFileSync(join(dir, 'app.txt'), 'dirty-worktree-value\n');
    const target = parseTarget(['--commit', selected], { cwd: dir });
    const snapshot = buildSnapshot({ target, cwd: dir, maxBytes: 20000 });
    assert.equal(snapshot.error, null);
    assert.match(snapshot.payload, /selected-commit-value/);
    assert.doesNotMatch(snapshot.payload, /dirty-worktree-value/);
  });
});

test('branch snapshot reads HEAD blobs, not unrelated dirty worktree bytes', () => {
  withRepo((dir) => {
    const base = git(dir, ['rev-parse', 'HEAD']);
    writeFileSync(join(dir, 'app.txt'), 'branch-head-value\n');
    git(dir, ['add', 'app.txt']);
    git(dir, ['commit', '-qm', 'feature']);
    writeFileSync(join(dir, 'app.txt'), 'unrelated-dirty-value\n');
    const target = parseTarget([], { cwd: dir, base });
    const snapshot = buildSnapshot({ target, cwd: dir, maxBytes: 20000 });
    assert.equal(snapshot.error, null);
    assert.match(snapshot.payload, /branch-head-value/);
    assert.doesNotMatch(snapshot.payload, /unrelated-dirty-value/);
  });
});

test('tracked paths remain repository-relative when invoked below the root', () => {
  withRepo((dir) => {
    const base = git(dir, ['rev-parse', 'HEAD']);
    mkdirSync(join(dir, 'sub'));
    git(dir, ['config', 'diff.relative', 'true']);
    writeFileSync(join(dir, 'base.txt'), 'changed-from-root\n');
    git(dir, ['add', 'base.txt']);
    git(dir, ['commit', '-qm', 'change root file']);
    const cwd = join(dir, 'sub');
    const snapshot = buildSnapshot({
      target: parseTarget([], { cwd, base }),
      cwd,
      maxBytes: 20000,
    });
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.hasChanges, true);
    assert.match(snapshot.payload, /changed-from-root/);
    assert.match(snapshot.payload, /## Full diff\n[\s\S]*diff --git a\/base\.txt b\/base\.txt/);
    assert.deepEqual(snapshot.changedFiles, ['base.txt']);
  });
});

test('untracked paths below the root retain their repository prefix', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'same.txt'), 'wrong-root-content\n');
    git(dir, ['add', 'same.txt']);
    git(dir, ['commit', '-qm', 'root fixture']);
    mkdirSync(join(dir, 'sub'));
    mkdirSync(join(dir, 'other'));
    writeFileSync(join(dir, 'sub', 'same.txt'), 'correct-sub-content\n');
    writeFileSync(join(dir, 'other', 'new.txt'), 'other-untracked-content\n');
    const cwd = join(dir, 'sub');
    const snapshot = buildSnapshot({
      target: parseTarget(['--uncommitted'], { cwd }),
      cwd,
      maxBytes: 20000,
    });
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.hasChanges, true);
    assert.match(snapshot.payload, /correct-sub-content/);
    assert.match(snapshot.payload, /other-untracked-content/);
    assert.doesNotMatch(snapshot.payload, /wrong-root-content/);
    assert.deepEqual(snapshot.changedFiles.sort(), ['other/new.txt', 'sub/same.txt']);
  });
});

test('a merge commit target errors instead of becoming a no-change skip', () => {
  withRepo((dir) => {
    const main = git(dir, ['branch', '--show-current']);
    git(dir, ['checkout', '-qb', 'side']);
    writeFileSync(join(dir, 'side.txt'), 'side\n');
    git(dir, ['add', 'side.txt']);
    git(dir, ['commit', '-qm', 'side']);
    git(dir, ['checkout', '-q', main]);
    writeFileSync(join(dir, 'main.txt'), 'main\n');
    git(dir, ['add', 'main.txt']);
    git(dir, ['commit', '-qm', 'main']);
    git(dir, ['merge', '--no-ff', '-qm', 'merge side', 'side']);
    const snapshot = buildSnapshot({
      target: parseTarget(['--commit', 'HEAD'], { cwd: dir }),
      cwd: dir,
      maxBytes: 20000,
    });
    assert.match(snapshot.error, /merge commit/i);
    assert.equal(snapshot.hasChanges, false);
  });
});

test('deletion-only snapshots include the deletion patch and remain reviewable', () => {
  withRepo((dir) => {
    const base = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['rm', 'base.txt']);
    git(dir, ['commit', '-qm', 'delete base']);
    const snapshot = buildSnapshot({
      target: parseTarget([], { cwd: dir, base }),
      cwd: dir,
      maxBytes: 20000,
    });
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.hasChanges, true);
    assert.deepEqual(snapshot.changedFiles, ['base.txt']);
    assert.match(snapshot.payload, /deleted file mode/);
    assert.match(snapshot.payload, /-base/);
  });
});

test('a change with no patch or readable file content is not reviewable', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
    const snapshot = buildSnapshot({
      target: parseTarget(['--uncommitted'], { cwd: dir }),
      cwd: dir,
      maxBytes: 20000,
    });
    assert.match(snapshot.error, /incomplete.*render/i);
    assert.deepEqual(snapshot.omittedChangedPaths, ['binary.dat']);
    assert.equal(snapshot.hasChanges, false);
    assert.deepEqual(snapshot.changedFiles, []);
  });
});

test('the payload summary includes content-stage exclusions', () => {
  withRepo((dir) => {
    symlinkSync('base.txt', join(dir, 'linked.txt'));
    git(dir, ['add', 'linked.txt']);
    git(dir, ['commit', '-qm', 'add link']);
    const snapshot = buildSnapshot({
      target: parseTarget(['--commit', 'HEAD'], { cwd: dir }),
      cwd: dir,
      maxBytes: 20000,
    });
    assert.equal(snapshot.error, null);
    assert.match(snapshot.payload, /Excluded entries: 1/);
    assert.doesNotMatch(snapshot.payload, /linked\.txt|\+base\.txt/);
  });
});

test('a gitlink is omitted as an uninspectable tracked entry', () => {
  withRepo((dir) => {
    const missingCommit = '1'.repeat(40);
    git(dir, ['update-index', '--add', '--info-only', '--cacheinfo', `160000,${missingCommit},vendor`]);
    git(dir, ['commit', '-qm', 'add gitlink']);
    const snapshot = buildSnapshot({
      target: parseTarget(['--commit', 'HEAD'], { cwd: dir }),
      cwd: dir,
      maxBytes: 20000,
    });
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.hasChanges, false);
    assert.ok(snapshot.notes.some((note) => /gitlink|submodule/i.test(note)));
  });
});

test('operator exclusion globs omit matching paths and report them safely', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'review.fixture'), 'fixture-content-must-not-leave\n');
    writeFileSync(join(dir, 'safe.txt'), 'safe changed content\n');
    const snapshot = buildSnapshot({
      target: parseTarget(['--uncommitted'], { cwd: dir }),
      cwd: dir,
      maxBytes: 20000,
      extraExcludeGlobs: ['*.fixture'],
    });
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.excludedCount, 1);
    assert.doesNotMatch(snapshot.payload, /review\.fixture|fixture-content-must-not-leave/);
    assert.match(snapshot.payload, /safe changed content/);
    assert.deepEqual(snapshot.excludedPaths, ['review.fixture']);
  });
});

test('a secret or symlink design path fails before payload assembly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afk-design-secret-'));
  try {
    const secret = join(dir, '.env');
    const link = join(dir, 'design.md');
    writeFileSync(secret, 'SECRET=value\n');
    symlinkSync(secret, link);
    const secretResult = buildSnapshot({
      target: { kind: 'design', path: secret, label: 'secret design' },
      cwd: dir,
      maxBytes: 20000,
    });
    assert.match(secretResult.error, /secret-bearing path/);
    const linkResult = buildSnapshot({
      target: { kind: 'design', path: link, label: 'linked design' },
      cwd: dir,
      maxBytes: 20000,
    });
    assert.match(linkResult.error, /symlink/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an outside design path ignores secret-like ancestor directory names', () => {
  withRepo((dir) => {
    const outside = mkdtempSync(join(tmpdir(), 'credentials-work-'));
    try {
      const design = join(outside, 'design.md');
      writeFileSync(design, '# Safe design\n');
      const snapshot = buildSnapshot({
        target: { kind: 'design', path: design, label: 'safe design' },
        cwd: dir,
        maxBytes: 20000,
      });
      assert.equal(snapshot.error, null);
      assert.match(snapshot.payload, /Safe design/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('an in-repository design path still checks every repository-relative segment', () => {
  withRepo((dir) => {
    mkdirSync(join(dir, 'secrets'));
    mkdirSync(join(dir, 'sub'));
    const design = join(dir, 'secrets', 'design.md');
    writeFileSync(design, '# Must stay local\n');
    const snapshot = buildSnapshot({
      target: { kind: 'design', path: design, label: 'secret-path design' },
      cwd: join(dir, 'sub'),
      maxBytes: 20000,
    });
    assert.match(snapshot.error, /secret-bearing path/);
  });
});

test('a diff that cannot fit any bytes errors instead of becoming no changes', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'base.txt'), 'changed content\n');
    const target = parseTarget(['--uncommitted'], { cwd: dir });
    const metadata = '## Diff summary\nIncluded files: 1\nExcluded entries: 0\n\n## Full diff\n';
    const contents = '\n## Full selected contents\n';
    const marker = '\n[diff truncated at the snapshot budget]\n';
    const snapshot = buildSnapshot({
      target,
      cwd: dir,
      maxBytes: Buffer.byteLength(metadata + contents + marker, 'utf8'),
    });
    assert.match(snapshot.error, /budget/i);
    assert.equal(snapshot.hasChanges, false);
  });
});

test('design snapshots state that the complete document is present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afk-design-complete-'));
  try {
    const design = join(dir, 'design.md');
    writeFileSync(design, '# Complete design\n');
    const snapshot = buildSnapshot({
      target: { kind: 'design', path: design, label: 'complete design' },
      cwd: dir,
      maxBytes: 20000,
    });
    assert.equal(snapshot.error, null);
    assert.match(snapshot.systemPrompt, /full text of the design document/i);
    assert.doesNotMatch(snapshot.systemPrompt, /bounded snapshot/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret-shaped values in file and design names are redacted from review text', () => {
  withRepo((dir) => {
    const token = `tp-${'N4q'.repeat(12)}`;
    const file = `review-${token}.txt`;
    writeFileSync(join(dir, file), 'safe content\n');
    const diffSnapshot = buildSnapshot({
      target: parseTarget(['--uncommitted'], { cwd: dir }),
      cwd: dir,
      maxBytes: 20000,
    });
    assert.equal(diffSnapshot.error, null);
    assert.doesNotMatch(`${diffSnapshot.systemPrompt}\n${diffSnapshot.reviewLabel}\n${diffSnapshot.payload}`, /tp-/);

    const design = join(dir, `design-${token}.md`);
    writeFileSync(design, '# Safe design\n');
    const designSnapshot = buildSnapshot({
      target: parseTarget(['--design', design], { cwd: dir }),
      cwd: dir,
      maxBytes: 20000,
    });
    assert.equal(designSnapshot.error, null);
    assert.doesNotMatch(`${designSnapshot.systemPrompt}\n${designSnapshot.reviewLabel}\n${designSnapshot.payload}`, /tp-/);
  });
});

test('a code snapshot never exceeds its configured byte budget', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'base.txt'), `${'€'.repeat(200)}\n`);
    const target = parseTarget(['--uncommitted'], { cwd: dir });
    const tooSmall = buildSnapshot({ target, cwd: dir, maxBytes: 64 });
    assert.match(tooSmall.error, /budget/i);

    const incomplete = buildSnapshot({ target, cwd: dir, maxBytes: 256 });
    assert.match(incomplete.error, /incomplete.*budget/i);
    assert.deepEqual(incomplete.changedFiles, []);
    assert.deepEqual(incomplete.omittedChangedPaths, ['base.txt']);
    const bounded = buildSnapshot({ target, cwd: dir, maxBytes: 2000 });
    assert.equal(bounded.error, null);
    assert.ok(Buffer.byteLength(bounded.payload, 'utf8') <= 2000);
    const included = Number.parseInt(bounded.payload.match(/Included files: (\d+)/)?.[1] || '-1', 10);
    assert.equal(included, bounded.changedFiles.length);
    assert.deepEqual(bounded.changedFiles, ['base.txt']);
  });
});

test('snapshot includes exact tracked references from changed material', () => {
  withRepo((dir) => {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'context.md'), 'verified unchanged context\n');
    git(dir, ['add', 'docs/context.md']);
    git(dir, ['commit', '-qm', 'add context']);
    writeFileSync(join(dir, 'base.txt'), 'review docs/context.md before deciding\n');

    const snapshot = buildSnapshot({
      target: parseTarget(['--uncommitted'], { cwd: dir }),
      cwd: dir,
      maxBytes: 20000,
    });

    assert.equal(snapshot.error, null);
    assert.deepEqual(snapshot.referencedFiles, ['docs/context.md']);
    assert.match(snapshot.payload, /## Referenced unchanged contents/);
    assert.match(snapshot.payload, /verified unchanged context/);
  });
});

test('snapshot includes an exact tracked root-file reference', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'README.md'), 'root-level reference\n');
    git(dir, ['add', 'README.md']);
    git(dir, ['commit', '-qm', 'add root reference']);
    writeFileSync(join(dir, 'base.txt'), 'review README.md before deciding\n');

    const snapshot = buildSnapshot({
      target: parseTarget(['--uncommitted'], { cwd: dir }), cwd: dir, maxBytes: 20000,
    });

    assert.deepEqual(snapshot.referencedFiles, ['README.md']);
    assert.match(snapshot.payload, /root-level reference/);
  });
});

test('changed-file references preserve real repository directories named a or b', () => {
  withRepo((dir) => {
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a', 'context.md'), 'directory-a reference\n');
    git(dir, ['add', 'a/context.md']);
    git(dir, ['commit', '-qm', 'add directory reference']);
    writeFileSync(join(dir, 'base.txt'), 'review a/context.md before deciding\n');

    const snapshot = buildSnapshot({
      target: parseTarget(['--uncommitted'], { cwd: dir }), cwd: dir, maxBytes: 20000,
    });

    assert.deepEqual(snapshot.referencedFiles, ['a/context.md']);
    assert.match(snapshot.payload, /directory-a reference/);
  });
});

test('relative references resolve from the changed file without extension guessing', () => {
  withRepo((dir) => {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'src', 'main.js'), 'export const main = true;\n');
    writeFileSync(join(dir, 'lib', 'context.js'), 'exact-relative-context\n');
    git(dir, ['add', 'src/main.js', 'lib/context.js']);
    git(dir, ['commit', '-qm', 'add source']);

    writeFileSync(join(dir, 'src', 'main.js'), "import '../lib/context.js';\n");
    let snapshot = buildSnapshot({
      target: parseTarget(['--uncommitted'], { cwd: dir }), cwd: dir, maxBytes: 20000,
    });
    assert.deepEqual(snapshot.referencedFiles, ['lib/context.js']);
    assert.match(snapshot.payload, /exact-relative-context/);

    writeFileSync(join(dir, 'src', 'main.js'), "import '../lib/context';\n");
    snapshot = buildSnapshot({
      target: parseTarget(['--uncommitted'], { cwd: dir }), cwd: dir, maxBytes: 20000,
    });
    assert.deepEqual(snapshot.referencedFiles, []);
    assert.doesNotMatch(snapshot.payload, /exact-relative-context/);
  });
});

test('referenced files come from the selected revision, not dirty worktree bytes', () => {
  withRepo((dir) => {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'context.md'), 'selected-reference-value\n');
    git(dir, ['add', 'docs/context.md']);
    git(dir, ['commit', '-qm', 'add context']);
    writeFileSync(join(dir, 'base.txt'), 'use docs/context.md\n');
    git(dir, ['add', 'base.txt']);
    git(dir, ['commit', '-qm', 'reference context']);
    writeFileSync(join(dir, 'docs', 'context.md'), 'dirty-reference-value\n');

    const snapshot = buildSnapshot({
      target: parseTarget(['--commit', 'HEAD'], { cwd: dir }), cwd: dir, maxBytes: 20000,
    });
    assert.match(snapshot.payload, /selected-reference-value/);
    assert.doesNotMatch(snapshot.payload, /dirty-reference-value/);
  });
});

test('referenced paths honor exclusions and report byte-budget omissions', () => {
  withRepo((dir) => {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'context.md'), `reference-${'x'.repeat(4000)}\n`);
    git(dir, ['add', 'docs/context.md']);
    git(dir, ['commit', '-qm', 'add context']);
    writeFileSync(join(dir, 'base.txt'), 'use docs/context.md\n');

    const excluded = buildSnapshot({
      target: parseTarget(['--uncommitted'], { cwd: dir }), cwd: dir,
      maxBytes: 20000, extraExcludeGlobs: ['docs/*'],
    });
    assert.deepEqual(excluded.referencedFiles, []);
    assert.ok(excluded.notes.some((note) => /referenced.*excluded/i.test(note)));

    const bounded = buildSnapshot({
      target: parseTarget(['--uncommitted'], { cwd: dir }), cwd: dir, maxBytes: 800,
    });
    assert.equal(bounded.error, null);
    assert.ok(Buffer.byteLength(bounded.payload, 'utf8') <= 800);
    assert.deepEqual(bounded.referencedFiles, []);
    assert.deepEqual(bounded.budgetOmittedReferencedPaths, ['docs/context.md']);
  });
});

test('referenced-file discovery is bounded', () => {
  withRepo((dir) => {
    mkdirSync(join(dir, 'docs'));
    const references = [];
    for (let index = 0; index < 41; index++) {
      const path = `docs/context-${index}.md`;
      references.push(path);
      writeFileSync(join(dir, path), `context ${index}\n`);
    }
    git(dir, ['add', 'docs']);
    git(dir, ['commit', '-qm', 'add bounded references']);
    writeFileSync(join(dir, 'base.txt'), `${references.join('\n')}\n`);

    const snapshot = buildSnapshot({
      target: parseTarget(['--uncommitted'], { cwd: dir }), cwd: dir, maxBytes: 50000,
    });

    assert.equal(snapshot.referencedFiles.length, 40);
    assert.ok(snapshot.notes.some((note) => /1 referenced file candidate.*discovery limit/i.test(note)));
    assert.doesNotMatch(snapshot.payload, /context 40/);
  });
});

// A target whose changes exist but render nothing is not an unchanged target.
// Counting it as unchanged made the snapshot gates skip clean over a change
// nobody read — the unreviewable-target-as-benign-skip AGENTS.md forbids.

test('a lone oversized untracked file leaves the target unreviewable, not unchanged', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'asset.bin'), 'x'.repeat(300 * 1024));
    const snapshot = buildSnapshot({
      target: parseTarget(['--uncommitted']),
      cwd: dir,
      systemPrompt: 's',
      reviewLabel: 'uncommitted changes',
    });
    assert.equal(snapshot.hasChanges, false);
    assert.equal(snapshot.unreviewable, true);
    assert.match(snapshot.notes.join(' '), /large file omitted/);
  });
});

test('a lone binary untracked file leaves the target unreviewable', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'blob.dat'), Buffer.from([0x41, 0x00, 0x42]));
    const snapshot = buildSnapshot({
      target: parseTarget(['--uncommitted']),
      cwd: dir,
      systemPrompt: 's',
      reviewLabel: 'uncommitted changes',
    });
    assert.equal(snapshot.hasChanges, false);
    assert.equal(snapshot.unreviewable, true);
  });
});

test('a target with no changes at all stays a plain unchanged target', () => {
  // The benign skip must survive: only an entry that could not be rendered
  // turns "nothing to review" into "nothing was reviewed".
  withRepo((dir) => {
    const snapshot = buildSnapshot({
      target: parseTarget(['--uncommitted']),
      cwd: dir,
      systemPrompt: 's',
      reviewLabel: 'uncommitted changes',
    });
    assert.equal(snapshot.hasChanges, false);
    assert.equal(snapshot.unreviewable, false);
  });
});

test('a renderable change alongside an unrenderable one refuses complete review', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'asset.bin'), 'x'.repeat(300 * 1024));
    writeFileSync(join(dir, 'src.js'), 'export const a = 1;\n');
    const snapshot = buildSnapshot({
      target: parseTarget(['--uncommitted']),
      cwd: dir,
      systemPrompt: 's',
      reviewLabel: 'uncommitted changes',
    });
    assert.equal(snapshot.hasChanges, false);
    assert.equal(snapshot.unreviewable, true);
    assert.match(snapshot.error, /incomplete.*render/i);
    assert.deepEqual(snapshot.changedFiles, []);
    assert.deepEqual(snapshot.omittedChangedPaths.sort(), ['asset.bin', 'src.js']);
    assert.deepEqual(snapshot.unrenderableChangedPaths, ['asset.bin']);
  });
});

test('content dropped at the snapshot budget leaves the target unreviewable', () => {
  // A file that loads fine but never fits is unread content: counting only
  // load failures let it read as no change and skip clean.
  withRepo((dir) => {
    // Ordinary prose: a long run of one character trips the base64 catch-all
    // and would be redacted to something small enough to fit.
    writeFileSync(join(dir, 'big.txt'), 'the quick brown fox jumps\n'.repeat(3000));
    const snapshot = buildSnapshot({
      target: parseTarget(['--uncommitted']),
      cwd: dir,
      systemPrompt: 's',
      reviewLabel: 'uncommitted changes',
      maxBytes: 2000,
    });
    assert.equal(snapshot.hasChanges, false);
    assert.equal(snapshot.unreviewable, true);
  });
});


for (const later of ['deleted', 'modified']) {
  test(`whole required coverage refuses an omitted later ${later} file`, () => {
    withRepo((dir) => {
      writeFileSync(join(dir, 'a.txt'), 'before\n'.repeat(15000));
      writeFileSync(join(dir, 'z-access.txt'), 'REMOVED_ACCESS_FIXTURE\n');
      git(dir, ['add', '.']); git(dir, ['commit', '-qm', 'coverage fixture']);
      writeFileSync(join(dir, 'a.txt'), 'after\n'.repeat(15000));
      if (later === 'deleted') rmSync(join(dir, 'z-access.txt'));
      else writeFileSync(join(dir, 'z-access.txt'), 'UPDATED_ACCESS_FIXTURE\n');
      const target = parseTarget(['--uncommitted'], { cwd: dir });
      const refused = buildSnapshot({ target, cwd: dir, maxBytes: 160000, budgetName: 'TEST_BUDGET' });
      assert.match(refused.error, /incomplete.*budget.*TEST_BUDGET/i);
      assert.equal(refused.payload, '');
      assert.equal(refused.unreviewable, true);
      assert.deepEqual(refused.changedFiles, []);
      assert.deepEqual(refused.omittedChangedPaths, ['a.txt', 'z-access.txt']);
      const complete = buildSnapshot({ target, cwd: dir, maxBytes: 400000 });
      assert.equal(complete.error, null);
      assert.deepEqual(complete.changedFiles, ['a.txt', 'z-access.txt']);
      assert.deepEqual(complete.omittedChangedPaths, []);
      assert.match(complete.payload, /-REMOVED_ACCESS_FIXTURE/);
      if (later === 'modified') assert.match(complete.payload, /\+UPDATED_ACCESS_FIXTURE/);
    });
  });
}

test('a visible file header cannot make a partial hunk complete', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'base.txt'), 'ordinary changed prose\n'.repeat(500));
    const result = buildSnapshot({ target: parseTarget(['--uncommitted'], { cwd: dir }), cwd: dir, maxBytes: 1000 });
    assert.match(result.error, /incomplete.*budget/i);
    assert.equal(result.payload, '');
    assert.deepEqual(result.changedFiles, []);
    assert.deepEqual(result.omittedChangedPaths, ['base.txt']);
  });
});

for (const transition of ['deleted', 'text']) {
  test(`a binary old side ${transition} beside a safe edit is incomplete`, () => {
    withRepo((dir) => {
      writeFileSync(join(dir, 'removed.dat'), Buffer.from('old\0required content'));
      git(dir, ['add', 'removed.dat']); git(dir, ['commit', '-qm', 'binary fixture']);
      if (transition === 'deleted') rmSync(join(dir, 'removed.dat'));
      else writeFileSync(join(dir, 'removed.dat'), 'current ordinary text\n');
      writeFileSync(join(dir, 'base.txt'), 'safe change\n');
      const result = buildSnapshot({ target: parseTarget(['--uncommitted'], { cwd: dir }), cwd: dir, maxBytes: 160000 });
      assert.match(result.error, /incomplete.*binary/i);
      assert.equal(result.payload, '');
      assert.deepEqual(result.changedFiles, []);
      assert.deepEqual(result.omittedChangedPaths, ['base.txt', 'removed.dat']);
    });
  });
}
