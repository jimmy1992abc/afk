#!/usr/bin/env node
// Skill docs get moved/renamed across PRs; a stale relative link fails
// silently for a reader (agent or human) instead of erroring at CI time.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
const EXTERNAL_RE = /^(?:https?:|mailto:)/i;

function findMarkdownFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      findMarkdownFiles(join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function isIgnorableTarget(target) {
  return target.startsWith('#') || target.startsWith('//') || EXTERNAL_RE.test(target);
}

export function checkLinks(rootDir) {
  const broken = [];
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) return broken;

  for (const file of findMarkdownFiles(rootDir)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(LINK_RE)) {
      const rawTarget = match[1].trim();
      if (!rawTarget || isIgnorableTarget(rawTarget)) continue;

      const hashIndex = rawTarget.indexOf('#');
      const targetPath = hashIndex === -1 ? rawTarget : rawTarget.slice(0, hashIndex);
      if (!targetPath) continue;

      const resolved = targetPath.startsWith('/')
        ? join(rootDir, targetPath.slice(1))
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
  const broken = checkLinks(repoRoot);
  for (const { file, link } of broken) {
    const rel = relative(repoRoot, file).split('\\').join('/');
    console.log(`${rel} -> ${link}`);
  }
  process.exit(broken.length > 0 ? 1 : 0);
}
