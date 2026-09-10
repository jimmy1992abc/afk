// gather.mjs — collect raw context OUT OF PROCESS so it never enters Claude's
// window. Reads git diff / tracked issues / files / ripgrep hits / log tails, applies
// excludes + redaction, and enforces a loud byte cap (no silent truncation).
//
// All side-effecting deps (process spawn, file read) are injectable for test
// mocking.

import { spawnSync } from 'node:child_process';
import { readConfigSectionValue } from '../../../lib/config.mjs';
import { issueCommand, resolveForge } from '../../../lib/forge.mjs';
import { RAW_DIFF_FLAGS, runGit } from '../../../lib/gate/git.mjs';
import { readConfinedUtf8File } from '../../../lib/gate/file-boundary.mjs';
import { literalPath, parseNameStatusZ } from '../../../lib/gate/target.mjs';
import { byteLength, truncateWithMarker } from '../../../lib/text-budget.mjs';
import {
  filterGrepByExcludes,
  isExcluded,
  redactSecrets,
} from '../../../lib/secret.mjs';
import { relayError } from './relay.mjs';

export { filterGrepByExcludes };

function defaultRun(cmd, args) {
  const r = cmd === 'git'
    ? runGit(args, { maxBuffer: 64 * 1024 * 1024 })
    : spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error,
  };
}

// A lenient inventory parser must not turn malformed input into a partial
// allowlist whose omitted source endpoint bypasses exclusion.
function completeInventory(raw) {
  const text = String(raw ?? '');
  const entries = parseNameStatusZ(text);
  if (entries.some((entry) => !/^(?:[ADMT]|[RC](?:100|0\d{2}))$/.test(entry.status))) return null;
  const rebuilt = entries.map(({ status, oldPath, path }) =>
    [status, ...(oldPath ? [oldPath] : []), path].join('\0') + '\0').join('');
  return rebuilt === text ? entries : null;
}

function detectBase(run) {
  const r = run('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, '');
  return 'main';
}

// A read whose payload states a comment count but carries no comment bodies has
// lost the discussion, and the count is what makes that knowable. Derived from
// the response, never from the forge: a read that renders its comments inline
// carries no count and must not acquire a note for having none.
function uncollectedComments(stdout) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return 0;
  }
  const count = payload?.fields?.['System.CommentCount'];
  // Integer, not merely a number: the note stands in for the payload a reader
  // cannot see, and half a comment reads as a defect in the note itself.
  return Number.isInteger(count) && count > 0 ? count : 0;
}

export function boundNotes(notes, maxInputBytes) {
  const noteBudget = Math.min(8192, Math.floor(maxInputBytes / 4));
  const unique = [];
  const seen = new Set();
  let oversized = 0;
  for (const raw of notes) {
    const note = redactSecrets(String(raw)).text;
    if (seen.has(note)) continue;
    seen.add(note);
    if (byteLength(note) > 512) oversized++;
    else unique.push(note);
  }

  for (let keep = Math.min(50, unique.length); keep >= 0; keep--) {
    const omitted = oversized + unique.length - keep;
    const candidate = unique.slice(0, keep);
    if (omitted) candidate.push(`[${omitted} additional gather note(s) omitted]`);
    if (byteLength(candidate.join(' ')) <= noteBudget) return candidate;
  }
  throw relayError('notes_unreportable', 'gather notes cannot fit the input budget');
}

export function gatherContext(sources = {}, opts = {}) {
  const hasRepoRoot = Object.hasOwn(opts, 'repoRoot');
  const {
    maxBytes = 400000,
    excludeGlobs = [],
    redact = true,
    run = defaultRun,
    readFile,
    logTailLines = 200,
    configPath = null,
    cwd = process.cwd(),
    repoRoot = null,
  } = opts;

  const notes = [];
  const chunks = [];
  let root = repoRoot;
  if (!hasRepoRoot && ((sources.files || []).length || (sources.logs || []).length)) {
    const resolved = run('git', ['rev-parse', '--show-toplevel']);
    root = resolved.status === 0 && resolved.stdout.trim() ? resolved.stdout.trim() : '';
  }

  function load(kind, requested) {
    if (readFile) {
      if (isExcluded(requested, excludeGlobs)) return { excluded: true, label: requested };
      try {
        const body = readFile(requested);
        return body == null ? { code: 'missing_file' } : { body, label: requested };
      } catch {
        return { code: 'unreadable_file' };
      }
    }
    const loaded = readConfinedUtf8File(requested, {
      root,
      base: cwd,
      approve: ({ relativePath }) => isExcluded(relativePath, excludeGlobs)
        ? { ok: false, code: 'excluded' }
        : { ok: true },
    });
    if (loaded.ok) return { body: loaded.content, label: loaded.relativePath };
    if (loaded.code === 'excluded') return { excluded: true, label: loaded.relativePath };
    return { code: loaded.code, kind };
  }

  // git diff (only when --diff was passed; '' means "default base")
  if (sources.diff !== undefined) {
    const base = sources.diff || detectBase(run);
    const inventory = run('git', ['diff', ...RAW_DIFF_FLAGS, '--no-relative', '--name-status', '-z', '-M', '-C', '--find-copies-harder', base, '--']);
    if (inventory.error || inventory.status !== 0) {
      notes.push('[skip: git diff inventory unavailable]');
    } else {
      const entries = completeInventory(inventory.stdout);
      if (entries === null) {
        notes.push('[skip: git diff inventory ambiguous]');
      } else {
        const paths = new Set();
        for (const entry of entries) {
          const endpoints = [entry.oldPath, entry.path].filter(Boolean);
          if (endpoints.some((path) => isExcluded(path, excludeGlobs))) {
            for (const path of endpoints) notes.push(`[excluded from diff: ${JSON.stringify(path)} (secret/binary exclude)]`);
          } else {
            for (const path of endpoints) paths.add(path);
          }
        }
        if (paths.size) {
          // Detection belongs to the full inventory; narrowed collection must
          // not discover a new copy source outside the approved path set.
          const patch = run('git', ['diff', ...RAW_DIFF_FLAGS, '--no-relative', '--no-renames', base, '--', ...[...paths].map(literalPath)]);
          if (patch.error || patch.status !== 0 || !patch.stdout?.trim()) {
            notes.push('[skip: git diff approved patch unavailable]');
          } else {
            chunks.push({ title: `git diff ${base}`, body: patch.stdout });
          }
        } else {
          notes.push(entries.length ? '[skip: git diff has no approved paths]' : '[skip: git diff has no tracked changes]');
        }
      }
    }
  }

  // tracked issues — dispatched on the resolved forge, never on which CLI runs.
  // A forge without an adapter is named here rather than attempted: the CLI of
  // a different forge can answer for an id it recognises and exit 0, which
  // would put another tracker's issue into the brief under this id.
  if ((sources.issue || []).length) {
    const remote = run('git', ['remote', 'get-url', 'origin']);
    const remoteUrl = remote.status === 0 ? remote.stdout.trim() : '';
    const { forge } = resolveForge({ configPath, remoteUrl });
    // Both name the tracker for a checkout whose remote cannot; without them the
    // forge's CLI picks one from the working directory or its own environment.
    const organization = configPath
      ? readConfigSectionValue(configPath, 'forge', 'azure-organization')
      : null;
    const repository = configPath
      ? readConfigSectionValue(configPath, 'forge', 'github-repository')
      : null;
    for (const n of sources.issue) {
      const cmd = issueCommand(forge, n, { remoteUrl, organization, repository });
      if (cmd.unsupported) {
        notes.push(`[skip: issue ${n} not read — ${cmd.unsupported}]`);
        continue;
      }
      const r = run(cmd.bin, cmd.args);
      if (r.error || r.status !== 0) {
        notes.push(`[skip: ${cmd.bin} could not read issue ${n} on ${forge}]`);
      } else if (r.stdout.trim()) {
        chunks.push({ title: `issue #${n}`, body: r.stdout });
        const dropped = uncollectedComments(r.stdout);
        if (dropped) notes.push(`[issue ${n}: ${dropped} comment(s) not in the read]`);
      }
    }
  }

  // files
  for (const f of sources.files || []) {
    const loaded = load('file', f);
    if (loaded.excluded) {
      notes.push(`[excluded: ${loaded.label} (secret/binary exclude)]`);
      continue;
    }
    if (loaded.code) {
      notes.push(`[skip: file ${loaded.code}]`);
      continue;
    }
    chunks.push({ title: `file ${loaded.label}`, body: loaded.body });
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
    const loaded = load('log', lg);
    if (loaded.excluded) {
      notes.push(`[excluded: ${loaded.label}]`);
      continue;
    }
    if (loaded.code) {
      notes.push(`[skip: log ${loaded.code}]`);
      continue;
    }
    const lines = loaded.body.split(/\r?\n/);
    if (lines.length > logTailLines) {
      notes.push(`[note: ${loaded.label} tailed to last ${logTailLines} lines]`);
    }
    chunks.push({ title: `log ${loaded.label} (tail)`, body: lines.slice(-logTailLines).join('\n') });
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

  // Each segment owns its separator so every byte in the aggregate is charged.
  let used = 0;
  let capped = false;
  const parts = [];
  for (const c of chunks) {
    const header = `${parts.length ? '\n\n' : '\n'}===== ${c.title} =====\n`;
    const headerBytes = byteLength(header);
    const available = maxBytes - used - headerBytes;
    if (capped || available <= 0) {
      capped = true;
      notes.push(`[dropped: ${c.title} — AGENT_RELAY_MAX_INPUT_BYTES reached]`);
      continue;
    }
    const fitted = truncateWithMarker(
      c.body,
      available,
      (omitted) => `\n…[truncated ${omitted} bytes of ${c.title}]`,
    );
    if (fitted.truncated && !fitted.markerFits) {
      notes.push(`[dropped: ${c.title} — AGENT_RELAY_MAX_INPUT_BYTES reached]`);
      capped = true;
      continue;
    }
    if (fitted.truncated) {
      notes.push(`[truncated: ${c.title} (${fitted.omittedBytes} bytes) to fit cap]`);
      capped = true;
    }
    const part = header + fitted.text;
    parts.push(part);
    used += byteLength(part);
  }

  const text = parts.join('');
  const noteBudget = Math.min(8192, Math.floor(maxBytes / 4));
  const omissionMarkerBytes = byteLength('[1 additional gather note(s) omitted]');
  const reportableNotes = noteBudget < omissionMarkerBytes && notes.length
    ? [...new Set(notes.map((note) => /dropped|truncated/.test(note) ? 'cap drop' : note))]
    : notes;
  return { text, notes: boundNotes(reportableNotes, maxBytes), bytes: byteLength(text) };
}
