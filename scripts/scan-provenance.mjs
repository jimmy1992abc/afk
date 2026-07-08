#!/usr/bin/env node
// This repo is published open source; any operator email, home IP, or
// local username baked into a skill/doc leaks that operator's identity
// to every downstream installer. Catch it before merge, not after.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.woff', '.woff2']);
const DENYLIST_FILE = '.afk-provenance-denylist.txt';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL_DOMAIN_RE = /(^|\.)example\.(com|org|net)$/i;
const ALLOWED_EMAIL_EXACT = 'noreply@anthropic.com';

const PRIVATE_IP_RE = /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?!\d)/g;

const WIN_PATH_RE = /[A-Za-z]:\\Users\\[^\s"'`<>]*/g;
const POSIX_PATH_RE = /\/(?:home|Users)\/[^\s"'`<>]*/g;

function findTextFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      findTextFiles(full, out);
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
      if (BINARY_EXT.has(ext)) continue;
      if (basename(entry.name).startsWith('scan-provenance')) continue;
      out.push(full);
    }
  }
  return out;
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

export function scanProvenance(rootDir, extraTerms = []) {
  const results = [];
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) return results;

  for (const file of findTextFiles(rootDir)) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
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

function loadDenylist(rootDir) {
  const path = join(rootDir, DENYLIST_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const extraTerms = loadDenylist(repoRoot);
  const findings = scanProvenance(repoRoot, extraTerms);
  for (const { file, line, rule, match } of findings) {
    const rel = relative(repoRoot, file).split('\\').join('/');
    console.log(`${rel}:${line} [${rule}] ${match}`);
  }
  process.exit(findings.length > 0 ? 1 : 0);
}
