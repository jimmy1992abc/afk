#!/usr/bin/env node
// The plugin's install cache is keyed by version; a stale install silently
// keeps old skills with no signal to the operator. This check compares the
// installed version against the canonical repo's latest and warns only —
// it must never block a run or exit nonzero.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isGateDisabled } from '../lib/gate/env.mjs';
import { mainWorktree } from '../lib/gate/git.mjs';
import { isReleaseVersion } from '../lib/version.mjs';

const MANIFEST_RELPATH = ['.claude-plugin', 'marketplace.json'];

export function isBehind(local, latest) {
  if (!isReleaseVersion(local) || !isReleaseVersion(latest)) return false;
  const partsOf = (v) => String(v).split('.').slice(0, 3)
    .map((p) => Number.parseInt(p, 10) || 0);
  const [lMajor, lMinor, lPatch] = partsOf(local);
  const [gMajor, gMinor, gPatch] = partsOf(latest);
  if (lMajor !== gMajor) return lMajor < gMajor;
  if (lMinor !== gMinor) return lMinor < gMinor;
  return lPatch < gPatch;
}

// The action is named because a notice an operator cannot act on is noise, and
// host-agnostic because this plugin ships manifests for four hosts — a command
// that is right for one of them is wrong advice for the others. Installing is
// the host's job: a skill that rewrote its own running code would change the
// run underneath the reviewer that approved it.
export function updateNotice(local, latest) {
  if (!isBehind(local, latest)) return null;
  return `afk: installed v${local}, latest v${latest} — update the afk-skills plugin from your agent host (Claude Code: /plugin) to pick up the newer skills.`;
}

export function localVersion(repoRoot) {
  const manifestPath = join(repoRoot, ...MANIFEST_RELPATH);
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const version = manifest.plugins?.[0]?.version;
    return isReleaseVersion(version) ? version : null;
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
    const version = manifest.plugins?.[0]?.version;
    return isReleaseVersion(version) ? version : null;
  } finally {
    clearTimeout(timer);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// The cache exists so a session start is not a network round-trip.
//
// It records that a check HAPPENED, not only that one succeeded: a machine
// that cannot reach GitHub would otherwise re-attempt on every window it opens
// and pay the fetch timeout each time, which is the cost the cache exists to
// avoid — and the population most likely to pay it is the one that gains
// nothing from the retry. Returns null when there is no usable entry,
// otherwise `{ latest }` with `latest` null for a recorded failure.
function readCache(cachePath, now, ttlMs) {
  try {
    const { checkedAt, latest } = JSON.parse(readFileSync(cachePath, 'utf8'));
    const age = now.getTime() - new Date(checkedAt).getTime();
    if (!Number.isFinite(age) || age < 0 || age >= ttlMs) return null;
    return { latest: isReleaseVersion(latest) ? latest : null };
  } catch {
    return null;
  }
}

function writeCache(cachePath, latest, now) {
  // Written through a temp file: concurrent windows start at once, and a reader
  // must never see half an object. A lost write costs one extra fetch.
  const tmp = `${cachePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ checkedAt: now.toISOString(), latest }), 'utf8');
    renameSync(tmp, cachePath);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* nothing left to clean up */ }
  }
}

// Resolve the one-line notice for an installed plugin, or null. Never throws:
// every caller is a place where a version check must not be able to fail a run.
export async function resolveUpdateNotice({
  pluginRoot,
  cachePath,
  env = process.env,
  now = new Date(),
  fetchImpl = fetch,
  ttlMs = DAY_MS,
} = {}) {
  try {
    if (isGateDisabled('AFK_UPDATE_CHECK', env)) return null;

    const local = localVersion(pluginRoot);
    if (local === null) return null; // can't tell — stay silent

    const cached = cachePath ? readCache(cachePath, now, ttlMs) : null;
    if (cached) return cached.latest ? updateNotice(local, cached.latest) : null;

    const repo = resolveRepo(pluginRoot, env);
    if (repo === null) return null;

    let latest = null;
    try {
      latest = await latestVersion(repo, fetchImpl);
    } catch {
      // An unreachable canonical repo is a fact about this attempt; record it
      // so the next window is silent and fast rather than paying the timeout
      // again. The notice is advisory, so deferring it a day costs nothing.
      latest = null;
    }
    if (!isReleaseVersion(latest)) latest = null;

    if (cachePath) writeCache(cachePath, latest, now);
    return latest ? updateNotice(local, latest) : null;
  } catch {
    // network/parse/filesystem failure: never block, stay silent
    return null;
  }
}

// Runs the checks and prints a notice if warranted; never throws.
async function runCli(repoRoot, env) {
  const root = mainWorktree() || process.cwd();
  const afk = join(root, '.afk');
  const cachePath = existsSync(afk) ? join(afk, 'update-check.json') : null;
  const notice = await resolveUpdateNotice({ pluginRoot: repoRoot, env, cachePath });
  if (notice) console.log(notice);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  await runCli(repoRoot, process.env);
  // exitCode (not process.exit()) — forcing exit right after fetch crashes
  // node on Windows (libuv UV_HANDLE_CLOSING assertion on the undici socket).
  process.exitCode = 0;
}
