#!/usr/bin/env node
// The plugin's install cache is keyed by version; a stale install silently
// keeps old skills with no signal to the operator. This check compares the
// installed version against the canonical repo's latest and warns only —
// it must never block a run or exit nonzero.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MANIFEST_RELPATH = ['.claude-plugin', 'marketplace.json'];

export function isBehind(local, latest) {
  const partsOf = (v) => String(v).split('.').slice(0, 3)
    .map((p) => Number.parseInt(p, 10) || 0);
  const [lMajor, lMinor, lPatch] = partsOf(local);
  const [gMajor, gMinor, gPatch] = partsOf(latest);
  if (lMajor !== gMajor) return lMajor < gMajor;
  if (lMinor !== gMinor) return lMinor < gMinor;
  return lPatch < gPatch;
}

export function updateNotice(local, latest) {
  if (!isBehind(local, latest)) return null;
  return `afk: installed v${local}, latest v${latest} — update to get the newer skills.`;
}

export function localVersion(repoRoot) {
  const manifestPath = join(repoRoot, ...MANIFEST_RELPATH);
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return manifest.plugins?.[0]?.version ?? null;
  } catch {
    return null;
  }
}

export function repoFromHomepage(homepage) {
  if (typeof homepage !== 'string') return null;
  const match = homepage.trim().match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function resolveRepo(repoRoot, env = {}) {
  const fromEnv = typeof env.AFK_UPDATE_REPO === 'string' ? env.AFK_UPDATE_REPO.trim() : '';
  if (fromEnv) return fromEnv;

  const manifestPath = join(repoRoot, ...MANIFEST_RELPATH);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  return repoFromHomepage(manifest.homepage ?? manifest.metadata?.homepage);
}

export async function latestVersion(repo, fetchImpl = fetch, timeoutMs = 4000) {
  const url = `https://raw.githubusercontent.com/${repo}/main/.claude-plugin/marketplace.json`;
  // Bound the fetch: a stalled (not failed) network must never block kickoff;
  // an abort surfaces as a rejection that the caller treats as a silent skip.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`update-check: fetch failed with status ${res.status}`);
    const manifest = JSON.parse(await res.text());
    return manifest.plugins?.[0]?.version ?? null;
  } finally {
    clearTimeout(timer);
  }
}

// Runs the checks and prints a notice if warranted; never throws.
async function runCli(repoRoot, env) {
  const local = localVersion(repoRoot);
  if (local === null) return; // can't tell — stay silent

  const repo = resolveRepo(repoRoot, env);
  if (repo === null) return; // can't tell — stay silent

  try {
    const latest = await latestVersion(repo);
    const notice = updateNotice(local, latest);
    if (notice) console.log(notice);
  } catch {
    // network/parse failure: never block, stay silent
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  await runCli(repoRoot, process.env);
  // exitCode (not process.exit()) — forcing exit right after fetch crashes
  // node on Windows (libuv UV_HANDLE_CLOSING assertion on the undici socket).
  process.exitCode = 0;
}
