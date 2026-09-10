import assert from 'node:assert/strict';
import {
  lstatSync, mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readConfinedUtf8File } from './file-boundary.mjs';

function withTree(fn) {
  const root = mkdtempSync(join(tmpdir(), 'afk-file-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'afk-file-outside-'));
  try {
    writeFileSync(join(root, 'safe.txt'), 'safe content');
    writeFileSync(join(outside, 'secret.txt'), 'outside secret');
    return fn({ root, outside });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

test('reads relative and absolute regular files inside the canonical root', () => {
  withTree(({ root }) => {
    const relative = readConfinedUtf8File('safe.txt', { root, base: root });
    const absolute = readConfinedUtf8File(join(root, 'safe.txt'), { root, base: root });
    assert.equal(relative.ok, true);
    assert.equal(relative.content, 'safe content');
    assert.equal(relative.relativePath, 'safe.txt');
    assert.equal(absolute.ok, true);
    assert.equal(absolute.content, 'safe content');
  });
});

test('allows a lexical outside alias whose canonical target is inside', () => {
  withTree(({ root }) => {
    const aliasParent = mkdtempSync(join(tmpdir(), 'afk-file-alias-'));
    const alias = join(aliasParent, 'repo-alias');
    try {
      symlinkSync(root, alias, 'dir');
      const result = readConfinedUtf8File(join(alias, 'safe.txt'), { root, base: root });
      assert.equal(result.ok, true);
      assert.equal(result.relativePath, 'safe.txt');
    } finally {
      rmSync(aliasParent, { recursive: true, force: true });
    }
  });
});

test('distinguishes direct outside paths from ancestor symlink escapes', () => {
  withTree(({ root, outside }) => {
    const direct = readConfinedUtf8File(join(outside, 'secret.txt'), { root, base: root });
    symlinkSync(outside, join(root, 'linked-dir'), 'dir');
    const escaped = readConfinedUtf8File('linked-dir/secret.txt', { root, base: root });
    assert.deepEqual(direct, { ok: false, code: 'outside_path' });
    assert.deepEqual(escaped, { ok: false, code: 'ancestor_symlink_escape' });
  });
});

test('rejects leaf symlinks and non-regular files', () => {
  withTree(({ root }) => {
    symlinkSync('safe.txt', join(root, 'leaf-link'));
    mkdirSync(join(root, 'directory'));
    assert.deepEqual(
      readConfinedUtf8File('leaf-link', { root, base: root }),
      { ok: false, code: 'symlink' },
    );
    assert.deepEqual(
      readConfinedUtf8File('directory', { root, base: root }),
      { ok: false, code: 'non_regular' },
    );
  });
});

test('detects replacement between inspection and descriptor open', () => {
  withTree(({ root }) => {
    writeFileSync(join(root, 'replacement.txt'), 'replacement');
    const result = readConfinedUtf8File('safe.txt', {
      root,
      base: root,
      beforeOpen: ({ absolutePath }) => {
        renameSync(join(root, 'replacement.txt'), absolutePath);
      },
    });
    assert.deepEqual(result, { ok: false, code: 'changed_during_read' });
  });
});

test('fails closed when bigint file identity is unusable', () => {
  withTree(({ root }) => {
    const result = readConfinedUtf8File('safe.txt', {
      root,
      base: root,
      identityOf: () => null,
    });
    assert.deepEqual(result, { ok: false, code: 'identity_unavailable' });
  });
});

test('approval runs before the descriptor read', () => {
  withTree(({ root }) => {
    let readCalled = false;
    const result = readConfinedUtf8File('safe.txt', {
      root,
      base: root,
      approve: ({ relativePath, stat }) => {
        assert.equal(relativePath, 'safe.txt');
        assert.equal(typeof stat.size, 'bigint');
        return { ok: false, code: 'excluded' };
      },
      readImpl: () => {
        readCalled = true;
        return 'must not be read';
      },
    });
    assert.equal(readCalled, false);
    assert.deepEqual(result, { ok: false, code: 'excluded', relativePath: 'safe.txt' });
  });
});

test('missing files and roots fail with distinct codes', () => {
  withTree(({ root }) => {
    assert.deepEqual(
      readConfinedUtf8File('missing.txt', { root, base: root }),
      { ok: false, code: 'missing_file' },
    );
    assert.deepEqual(
      readConfinedUtf8File('safe.txt', { root: '', base: root }),
      { ok: false, code: 'root_unresolved' },
    );
  });
});

test('unreadable metadata and descriptors are not reported as missing', () => {
  withTree(({ root }) => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    assert.deepEqual(
      readConfinedUtf8File('safe.txt', {
        root,
        base: root,
        lstatImpl: () => { throw denied; },
      }),
      { ok: false, code: 'unresolvable_file' },
    );
    assert.deepEqual(
      readConfinedUtf8File('safe.txt', {
        root,
        base: root,
        openImpl: () => { throw denied; },
      }),
      { ok: false, code: 'unreadable_file' },
    );
  });
});

test('the default identity reader requests bigint stats', () => {
  withTree(({ root }) => {
    const stat = lstatSync(join(root, 'safe.txt'), { bigint: true });
    assert.equal(typeof stat.dev, 'bigint');
    assert.equal(typeof stat.ino, 'bigint');
  });
});
