#!/usr/bin/env node
// This repo is published open source; any operator email, private IPv4, or
// local username baked into a skill/doc leaks that operator's identity
// to every downstream installer. Catch it before merge, not after.

import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.woff', '.woff2']);
// Exact paths, not a basename prefix: a prefix rule was a tree-wide filename
// bypass of every rule ("skills/x/scan-provenance-notes.md" merged unscanned).
const SELF_PATHS = new Set(['scripts/scan-provenance.mjs', 'scripts/scan-provenance.test.mjs']);
const GITLINK_MODE = '160000';
const SYMLINK_MODE = '120000';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL_DOMAIN_RE = /(^|\.)example\.(com|org|net)$/i;
const ALLOWED_EMAIL_EXACT = 'noreply@anthropic.com';

const PRIVATE_IP_RE = /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?!\d)/g;

const WIN_PATH_RE = /[A-Za-z]:\\Users\\[^\s"'`<>]*/g;
const POSIX_PATH_RE = /\/(?:home|Users)\/[^\s"'`<>]*/g;

// Tracked files only, enumerated with mode bits so symlinks and gitlinks
// classify exactly. `cwd` is load-bearing: without it, an invoker sitting in
// any other repo would enumerate THAT repo, every join would miss, and the
// scan would silently exit 0 — a scanner that scans nothing.
function trackedEntries(rootDir) {
  let raw;
  try {
    // Enumeration belongs to rootDir, never a caller-selected repository/index.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    raw = execFileSync('git', ['ls-files', '-z', '-s'], { cwd: rootDir, encoding: 'utf8', env });
  } catch (err) {
    throw new Error(`cannot enumerate tracked files in ${rootDir}: ${err.message}`);
  }
  const seen = new Set();
  const entries = [];
  for (const record of raw.split('\0')) {
    if (!record) continue;
    // "<mode> <sha> <stage>\t<path>" — conflicted paths repeat per stage.
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const mode = record.slice(0, record.indexOf(' '));
    const path = record.slice(tab + 1);
    if (seen.has(path)) continue;
    seen.add(path);
    if (mode === GITLINK_MODE) continue;
    if (SELF_PATHS.has(path)) continue;
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    if (BINARY_EXT.has(ext)) continue;
    entries.push({ path, symlink: mode === SYMLINK_MODE });
  }
  return entries;
}

function isAllowedEmail(match) {
  const lower = match.toLowerCase();
  if (lower === ALLOWED_EMAIL_EXACT) return true;
  const domain = lower.slice(lower.indexOf('@') + 1);
  return ALLOWED_EMAIL_DOMAIN_RE.test(domain);
}

function findMatches(line, re) {
  return [...line.matchAll(re)].map((m) => m[0]);
}

function scanLine(line, extraTerms) {
  const findings = [];

  for (const match of findMatches(line, EMAIL_RE)) {
    if (!isAllowedEmail(match)) findings.push({ rule: 'email', match });
  }
  for (const match of findMatches(line, PRIVATE_IP_RE)) {
    findings.push({ rule: 'private-ip', match });
  }
  for (const match of findMatches(line, WIN_PATH_RE)) {
    findings.push({ rule: 'local-path', match });
  }
  for (const match of findMatches(line, POSIX_PATH_RE)) {
    findings.push({ rule: 'local-path', match });
  }

  const lower = line.toLowerCase();
  for (const term of extraTerms) {
    const termLower = term.toLowerCase();
    if (!termLower) continue;
    const idx = lower.indexOf(termLower);
    if (idx !== -1) {
      findings.push({ rule: 'denylist', match: line.slice(idx, idx + term.length) });
    }
  }

  return findings;
}

export function scanProvenance(rootDir, extraTerms = [], { warn = (m) => process.stderr.write(m) } = {}) {
  const results = [];
  for (const entry of trackedEntries(rootDir)) {
    const file = join(rootDir, entry.path);
    let text;
    if (entry.symlink) {
      // The shipped bytes of a tracked symlink ARE the link text; following
      // it would scan the wrong content (or nothing, on CI where the target
      // does not exist).
      try {
        text = readlinkSync(file);
      } catch {
        // core.symlinks=false checkouts materialize the link text as a plain
        // file; fall through to the regular read.
        text = null;
      }
    }
    if (text == null) {
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        // A tracked file that cannot be read still ships in the archive; a
        // silent skip here would be a scanner hole, not a convenience.
        warn(`[scan-provenance] warning: cannot read tracked file ${entry.path}; not scanned\n`);
        continue;
      }
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const finding of scanLine(line, extraTerms)) {
        results.push({ file, line: i + 1, match: finding.match, rule: finding.rule });
      }
    });
  }

  return results;
}

// Env-only denylist: a committed term list would publish the very strings it
// exists to hide. No comment filter — in an env var a #-prefixed term is a
// term, not a comment.
export function parseDenylistEnv(value) {
  return String(value ?? '')
    .split(/[\n,]/)
    .map((term) => term.trim())
    .filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const extraTerms = parseDenylistEnv(process.env.AFK_PROVENANCE_DENYLIST);
  let findings;
  try {
    findings = scanProvenance(repoRoot, extraTerms);
  } catch (err) {
    console.error(`scan-provenance failed: ${err.message}`);
    process.exit(2);
  }
  for (const { file, line, rule, match } of findings) {
    const rel = relative(repoRoot, file).split('\\').join('/');
    console.log(`${rel}:${line} [${rule}] ${match}`);
  }
  process.exit(findings.length > 0 ? 1 : 0);
}
