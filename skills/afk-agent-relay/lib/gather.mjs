// gather.mjs — collect raw context OUT OF PROCESS so it never enters Claude's
// window. Reads git diff / gh issue / files / ripgrep hits / log tails, applies
// excludes + redaction, and enforces a loud byte cap (no silent truncation).
//
// All side-effecting deps (process spawn, file read) are injectable for test
// mocking.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { isExcluded, redactSecrets } from './redact.mjs';

function defaultRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error,
  };
}

function defaultReadFile(p) {
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}

function detectBase(run) {
  const r = run('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, '');
  return 'main';
}

// Drop per-file sections of a `git diff` whose path is on the exclude list, so a
// secret file caught in the diff (e.g. an accidental .env change) is NOT sent to
// the provider. The exclude check is the same one used for --files/--logs.
export function filterDiffByExcludes(diff, excludeGlobs = []) {
  const sections = [];
  let cur = null;
  for (const line of diff.split('\n')) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      if (cur) sections.push(cur);
      // Capture BOTH sides — a rename/copy of a secret to a non-secret name
      // (`diff --git a/.env b/config.txt`) must still be dropped.
      cur = { aPath: m[1], bPath: m[2], lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      cur = { aPath: null, bPath: null, lines: [line] }; // preamble before first file
    }
  }
  if (cur) sections.push(cur);

  const kept = [];
  const dropped = [];
  for (const s of sections) {
    const excluded =
      (s.aPath && isExcluded(s.aPath, excludeGlobs)) ||
      (s.bPath && isExcluded(s.bPath, excludeGlobs));
    if (excluded) dropped.push(s.bPath || s.aPath);
    else kept.push(s.lines.join('\n'));
  }
  return { text: kept.join('\n'), dropped };
}

// Same idea for ripgrep output (`path:line:content`) — drop hits from excluded
// files so a `--grep` over the tree can't surface a secret file's contents.
export function filterGrepByExcludes(out, excludeGlobs = []) {
  const kept = [];
  const dropped = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/^([^:]+):\d+:/);
    if (m && isExcluded(m[1], excludeGlobs)) {
      dropped.add(m[1]);
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join('\n'), dropped: [...dropped] };
}

export function gatherContext(sources = {}, opts = {}) {
  const {
    maxBytes = 400000,
    excludeGlobs = [],
    redact = true,
    run = defaultRun,
    readFile = defaultReadFile,
    logTailLines = 200,
  } = opts;

  const notes = [];
  const chunks = [];

  // git diff (only when --diff was passed; '' means "default base")
  if (sources.diff !== undefined) {
    const base = sources.diff || detectBase(run);
    const r = run('git', ['diff', base]);
    if (r.error || r.status !== 0) {
      notes.push(`[skip: git diff ${base} unavailable]`);
    } else if (r.stdout.trim()) {
      const { text: filtered, dropped } = filterDiffByExcludes(r.stdout, excludeGlobs);
      for (const p of dropped) notes.push(`[excluded from diff: ${p} (secret/binary exclude)]`);
      if (filtered.trim()) chunks.push({ title: `git diff ${base}`, body: filtered });
    }
  }

  // gh issues
  for (const n of sources.issue || []) {
    const r = run('gh', ['issue', 'view', String(n)]);
    if (r.error || r.status !== 0) notes.push(`[skip: gh issue view ${n} unavailable]`);
    else if (r.stdout.trim()) chunks.push({ title: `issue #${n}`, body: r.stdout });
  }

  // files
  for (const f of sources.files || []) {
    if (isExcluded(f, excludeGlobs)) {
      notes.push(`[excluded: ${f} (secret/binary exclude)]`);
      continue;
    }
    const body = readFile(f);
    if (body == null) {
      notes.push(`[skip: cannot read ${f}]`);
      continue;
    }
    chunks.push({ title: `file ${f}`, body });
  }

  // ripgrep hits
  for (const g of sources.grep || []) {
    const r = run('rg', ['-n', '--no-heading', g]);
    if (r.error) {
      notes.push(`[skip: rg unavailable for '${g}']`);
      continue;
    }
    if ((r.stdout || '').trim()) {
      const { text: filtered, dropped } = filterGrepByExcludes(r.stdout, excludeGlobs);
      for (const p of dropped) notes.push(`[excluded from grep: ${p}]`);
      if (filtered.trim()) chunks.push({ title: `grep '${g}'`, body: filtered });
    }
  }

  // log tails
  for (const lg of sources.logs || []) {
    if (isExcluded(lg, excludeGlobs)) {
      notes.push(`[excluded: ${lg}]`);
      continue;
    }
    const body = readFile(lg);
    if (body == null) {
      notes.push(`[skip: cannot read ${lg}]`);
      continue;
    }
    const lines = body.split(/\r?\n/);
    if (lines.length > logTailLines) {
      notes.push(`[note: ${lg} tailed to last ${logTailLines} lines]`);
    }
    chunks.push({ title: `log ${lg} (tail)`, body: lines.slice(-logTailLines).join('\n') });
  }

  // redact every chunk before anything is assembled for sending
  if (redact) {
    let total = 0;
    for (const c of chunks) {
      const { text, count } = redactSecrets(c.body);
      c.body = text;
      total += count;
    }
    if (total > 0) notes.push(`[redacted ${total} secret-like token(s)]`);
  } else {
    notes.push('[warning: secret redaction DISABLED (AGENT_RELAY_REDACT=off)]');
  }

  // assemble under the byte cap — truncation is loud
  let budget = maxBytes;
  let capped = false;
  const parts = [];
  for (const c of chunks) {
    const header = `\n===== ${c.title} =====\n`;
    if (capped || budget - header.length <= 0) {
      capped = true;
      notes.push(`[dropped: ${c.title} — AGENT_RELAY_MAX_INPUT_BYTES reached]`);
      continue;
    }
    let body = c.body;
    const avail = budget - header.length;
    if (body.length > avail) {
      const cut = body.length - avail;
      body = body.slice(0, avail) + `\n…[truncated ${cut} bytes of ${c.title}]`;
      notes.push(`[truncated: ${c.title} (${cut} bytes) to fit cap]`);
      capped = true;
    }
    parts.push(header + body);
    budget -= header.length + body.length;
  }

  const text = parts.join('\n');
  return { text, notes, bytes: text.length };
}
