#!/usr/bin/env node
// Whether the `pluginRoot` recorded in .afk/config.md still describes the
// install that is actually running.
//
// The cache path is version-keyed, so a value written before an update points
// at a directory that no longer holds the current skills — and a skill added
// after that version does not exist under it at all. afk-init's idempotence
// must preserve a developer's own root without also preserving that.

import { pathToFileURL } from 'node:url';

const asPath = (value) => (typeof value === 'string' ? value.trim() : '');
const segmentsOf = (path) => asPath(path).replace(/\\/g, '/').replace(/\/+$/, '').split('/');

// A host install lives at <…>/plugins/cache/<marketplace>/<plugin>/<version>.
// Return its base (everything above the version) and version, or null when the
// path is anything else — a checkout, a symlink farm, a hand-written root.
export function parseVersionedCacheRoot(path) {
  const parts = segmentsOf(path);
  if (parts.length < 3) return null;

  const version = parts[parts.length - 1];
  if (!/^\d+\.\d+\.\d+/.test(version)) return null;

  // The `plugins/cache` pair is what makes this the host's directory rather
  // than a coincidentally version-named folder in someone's source tree.
  const hasCacheSegment = parts.some((part, i) => part === 'plugins' && parts[i + 1] === 'cache');
  if (!hasCacheSegment) return null;

  return { base: parts.slice(0, -1).join('/'), version };
}

// action: 'record' (nothing configured) · 'refresh' (configured value expired)
// · 'keep' (configured value stands). `root` is the value to write or retain.
export function resolvePluginRootUpdate(configured, resolved) {
  const current = asPath(configured);
  const target = asPath(resolved);

  if (!current) {
    return target
      ? { action: 'record', root: target, reason: 'no pluginRoot recorded yet' }
      : { action: 'keep', root: '', reason: 'nothing configured and nothing resolved' };
  }
  // Overwriting with an unresolved value would strip a working config.
  if (!target || current === target) {
    return { action: 'keep', root: current, reason: 'the recorded root is the resolved one' };
  }

  const currentCache = parseVersionedCacheRoot(current);
  const targetCache = parseVersionedCacheRoot(target);

  // Same install, different version key: an expired fact, not a choice.
  if (currentCache && targetCache && currentCache.base === targetCache.base) {
    return {
      action: 'refresh',
      root: target,
      reason: `the recorded root is v${currentCache.version} of this install, which is now v${targetCache.version}`,
    };
  }

  // A different plugin, a different marketplace, or a path the host did not
  // create: a deliberate choice, and idempotence means it survives.
  return { action: 'keep', root: current, reason: 'the recorded root is not a superseded install of this plugin' };
}

function optVal(argv, flag) {
  const i = argv.indexOf(flag);
  const next = i >= 0 ? argv[i + 1] : undefined;
  return next && !next.startsWith('--') ? next : '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const resolved = optVal(argv, '--resolved');
  if (!resolved) {
    // Guessing the install location is what the caller asked this helper to
    // avoid; without it there is no decision to make.
    process.stderr.write('plugin-root: --resolved <path> is required\n');
    process.exit(2);
  }
  const decision = resolvePluginRootUpdate(optVal(argv, '--configured'), resolved);
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
}
