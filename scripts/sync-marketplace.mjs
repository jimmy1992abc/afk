#!/usr/bin/env node
// Regenerate every agent manifest from skills/ and the Claude marketplace, so
// plugin identity and version live in exactly one place. Default rewrites
// drifted files; `--check` fails on drift without writing (CI gate).

import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = join(repoRoot, 'skills');
const PLUGIN_NAME = 'afk-skills';
const checkOnly = process.argv.includes('--check');

// A skill is any skills/<name>/ that contains a SKILL.md.
const skills = existsSync(skillsDir)
  ? readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort()
  : [];
const skillPaths = skills.map((n) => `./skills/${n}`);

// Identity + version come from the Claude marketplace (the one authoritative file).
const claudePath = join(repoRoot, '.claude-plugin', 'marketplace.json');
const claude = JSON.parse(readFileSync(claudePath, 'utf8'));
const claudePlugin = claude.plugins.find((p) => p.name === PLUGIN_NAME) ?? claude.plugins[0];
const version = claudePlugin.version; // = install cache key
const id = {
  name: claude.name,
  owner: claude.owner,
  description: claude.metadata?.description ?? claudePlugin.description,
  pluginDescription: claudePlugin.description,
};

const serialize = (o) => `${JSON.stringify(o, null, 2)}\n`;
const readMaybe = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const parseMaybe = (p) => { const r = readMaybe(p); return r ? JSON.parse(r) : null; };

const drift = [];
function emit(absPath, obj) {
  const next = serialize(obj);
  if (next === readMaybe(absPath)) return;
  drift.push(relative(repoRoot, absPath).split('\\').join('/'));
  if (!checkOnly) {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, next);
  }
}

// Claude marketplace: enumerate skills (add + prune), mirror version into metadata.
claudePlugin.skills = skillPaths;
claude.metadata = { ...(claude.metadata ?? {}), description: id.description, version };
emit(claudePath, claude);

// Copilot marketplace: one bundled plugin.
emit(join(repoRoot, '.github', 'plugin', 'marketplace.json'), {
  name: id.name,
  owner: id.owner,
  metadata: { description: id.description, version },
  plugins: [{ name: PLUGIN_NAME, description: id.pluginDescription, version, source: './' }],
});

// Codex marketplace: one bundled plugin; preserve any hand-set policy/category.
const codexMktPath = join(repoRoot, '.agents', 'plugins', 'marketplace.json');
const codexMktPrev = parseMaybe(codexMktPath);
const codexPluginPrev = codexMktPrev?.plugins?.find((p) => p.name === PLUGIN_NAME);
emit(codexMktPath, {
  name: id.name,
  interface: { displayName: codexMktPrev?.interface?.displayName ?? 'AFK Skills' },
  plugins: [{
    name: PLUGIN_NAME,
    source: { source: 'local', path: './' },
    policy: codexPluginPrev?.policy ?? { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: codexPluginPrev?.category ?? 'Productivity',
  }],
});

// Bundled-plugin manifests: identity only. No "skills" field — Claude enumerates
// in the marketplace, Codex/Copilot auto-scan skills/.
emit(join(repoRoot, 'plugin.json'), {
  name: PLUGIN_NAME, description: id.pluginDescription, version,
});
emit(join(repoRoot, '.codex-plugin', 'plugin.json'), {
  name: PLUGIN_NAME, version, description: id.pluginDescription,
});

// package.json version mirrors the plugin version (one source of truth).
const pkgPath = join(repoRoot, 'package.json');
const pkg = parseMaybe(pkgPath);
if (pkg && pkg.version !== version) { pkg.version = version; emit(pkgPath, pkg); }

console.log(`skills (${skills.length}): ${skills.join(', ') || '(none)'}`);
if (drift.length === 0) {
  console.log('✓ manifests in sync');
} else if (checkOnly) {
  console.error(`✗ manifest drift:\n${drift.map((f) => `  ${f}`).join('\n')}`);
  console.error('run: node scripts/sync-marketplace.mjs');
  process.exit(1);
} else {
  console.log(`updated:\n${drift.map((f) => `  ${f}`).join('\n')}`);
}
