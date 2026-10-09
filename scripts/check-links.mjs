#!/usr/bin/env node
// Skill docs get moved/renamed across PRs; a stale relative link fails
// silently for a reader (agent or human) instead of erroring at CI time.

import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { readConfinedUtf8File } from '../lib/gate/file-boundary.mjs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
const EXTERNAL_RE = /^(?:https?:|mailto:)/i;
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

function inventory(rootDir) {
  try {
    const root = resolve(utf8(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] })).replace(/\r?\n$/, ''));
    const names = utf8(execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }));
    if (names && !names.endsWith('\0')) throw new Error('incomplete inventory');
    return { root, files: [...new Set(names.split('\0').filter(path => /\.md$/i.test(path)))] };
  } catch { throw new Error('inventory unavailable: cannot enumerate tracked Markdown'); }
}
function source(root, path) {
  try {
    // Git can retain a path while its worktree ancestor is replaced by a symlink.
    for (let dir = dirname(join(root, path)); dir !== root; dir = dirname(dir)) {
      if (lstatSync(dir).isSymbolicLink()) throw new Error('symlink');
    }
    const found = readConfinedUtf8File(path, { root, readImpl: fd => utf8(readFileSync(fd)) });
    if (!found.ok) throw new Error(found.code);
    return found.content;
  } catch (error) { throw new Error(`source unreadable (${path}): ${error.code || error.message}`); }
}

function isIgnorableTarget(target) {
  return target.startsWith('#') || target.startsWith('//') || EXTERNAL_RE.test(target);
}

export function checkLinks(rootDir) {
  const broken = [];
  const { root, files } = inventory(rootDir);
  if (!files.length) console.log('check-links: no tracked Markdown files');

  for (const path of files) {
    const file = join(root, path);
    const text = source(root, path);
    for (const match of text.matchAll(LINK_RE)) {
      const rawTarget = match[1].trim();
      if (!rawTarget || isIgnorableTarget(rawTarget)) continue;

      const hashIndex = rawTarget.indexOf('#');
      const targetPath = hashIndex === -1 ? rawTarget : rawTarget.slice(0, hashIndex);
      if (!targetPath) continue;

      const resolved = targetPath.startsWith('/')
        ? join(root, targetPath.slice(1))
        : resolve(dirname(file), targetPath);

      if (!existsSync(resolved)) {
        broken.push({ file, link: rawTarget });
      }
    }
  }

  return broken;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const broken = checkLinks(repoRoot);
    for (const { file, link } of broken) {
      const rel = relative(repoRoot, file).split('\\').join('/');
      console.log(`${rel} -> ${link}`);
    }
    process.exitCode = broken.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(`check-links: ${error.message}`);
    process.exitCode = 1;
  }
}
