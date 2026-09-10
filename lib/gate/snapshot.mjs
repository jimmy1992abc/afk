// A single boundary keeps every tool-less gate on the same exposure policy.

import {
  lstatSync, readFileSync, realpathSync,
} from 'node:fs';
import {
  basename, isAbsolute, join, posix, relative, resolve,
} from 'node:path';

import { isExcluded, redactCredential, redactSecrets } from '../secret.mjs';
import { utf8Prefix } from '../text-budget.mjs';
import { readConfinedUtf8File } from './file-boundary.mjs';
import { git, gitTry, RAW_DIFF_FLAGS } from './git.mjs';
import { buildDesignReviewPrompt, buildReviewPrompt } from './prompt.mjs';
import { collectDiff, literalPath } from './target.mjs';

const MAX_FILE_BYTES = 200000;
const MAX_REFERENCE_SCAN_BYTES = 200000;
const MAX_REFERENCED_FILES = 40;
const SNAPSHOT_CONTEXT = 'You are given a bounded snapshot of the selected artifact. That snapshot is everything you have: you cannot run commands or open other files, so never claim to have done either. Verify that a path is present before relying on its contents. If a trigger or consequence depends only on an absent file or its name, report the missing evidence for driver verification rather than assert a defect or structural severity.';
const DESIGN_CONTEXT = 'You are given the full text of the design document. That document is everything you have: you cannot run commands or open other files, so never claim to have done either.';
const PATH_TOKEN = /(?:^|["'`(\s])((?:\.{1,2}\/)?[A-Za-z0-9_@.+-]+(?:\/[A-Za-z0-9_@.+-]+)*)(?=$|["'`),:;\s])/g;

function entryPaths(entry) {
  return [entry.oldPath, entry.path].filter(Boolean);
}

export function formatExcludedPathsNote(paths, credential) {
  const unique = [...new Set(paths)];
  if (!unique.length) return '';
  const shown = unique.slice(0, 20).map((path) => {
    const safe = utf8Prefix(redactCredential(path, credential).text, 200);
    return JSON.stringify(safe);
  });
  const remainder = unique.length - shown.length;
  return `excluded paths: ${shown.join(', ')}${remainder ? `, and ${remainder} more` : ''}`;
}

export function formatReferencedCoverageNote(snapshot, credential) {
  const included = snapshot.referencedFiles?.length || 0;
  const omitted = [...new Set(snapshot.budgetOmittedReferencedPaths || [])];
  if (!included && !omitted.length) return '';
  const shown = omitted.slice(0, 20).map((path) => (
    utf8Prefix(redactCredential(path, credential).text, 200)
  ));
  const suffix = omitted.length
    ? ` budget_omitted_paths=${JSON.stringify(shown)}${omitted.length > shown.length ? ` omitted_path_remainder=${omitted.length - shown.length}` : ''}`
    : '';
  return `SNAPSHOT_NOTE referenced_files=${included} budget_omitted_references=${omitted.length}${suffix}`;
}

function normalizedReference(token, sourcePath = '') {
  let candidate = token;
  if (candidate.startsWith('./') || candidate.startsWith('../')) {
    if (!sourcePath) return '';
    candidate = posix.join(posix.dirname(sourcePath), candidate);
  } else if (!sourcePath && (candidate.startsWith('a/') || candidate.startsWith('b/'))) {
    candidate = candidate.slice(2);
  }
  candidate = posix.normalize(candidate);
  if (!candidate || candidate === '.' || candidate === '..'
    || candidate.startsWith('../') || posix.isAbsolute(candidate)) return '';
  return candidate;
}

function referenceTokens(text, sourcePath) {
  const bounded = utf8Prefix(text, MAX_REFERENCE_SCAN_BYTES);
  const found = [];
  for (const match of bounded.matchAll(PATH_TOKEN)) {
    const normalized = normalizedReference(match[1], sourcePath);
    if (normalized) found.push(normalized);
  }
  return found;
}

function discoverReferencedPaths({ patchText, fileBlocks, revision, changedPaths, cwd }) {
  const listed = gitTry(['ls-tree', '--full-tree', '-r', '-z', '--name-only', revision], { cwd });
  if (!listed.ok) return { paths: [], omittedCount: 0, unavailable: true };
  const tracked = new Set(listed.out.split('\0').filter(Boolean));
  const candidates = [];
  const seen = new Set();
  const accept = (path) => {
    if (!tracked.has(path) || changedPaths.has(path) || seen.has(path)) return;
    seen.add(path);
    candidates.push(path);
  };
  for (const path of referenceTokens(patchText, '')) accept(path);
  for (const block of fileBlocks) {
    for (const path of referenceTokens(block.scanText, block.path)) accept(path);
  }
  return {
    paths: candidates.slice(0, MAX_REFERENCED_FILES),
    omittedCount: Math.max(0, candidates.length - MAX_REFERENCED_FILES),
    unavailable: false,
  };
}

function approvedPatch(target, paths, cwd) {
  if (!paths.length || target.kind === 'design') return { text: '', error: null };
  const pathspecs = [...new Set(paths)].map(literalPath);
  let args;
  if (target.kind === 'commit') {
    args = [
      'show', ...RAW_DIFF_FLAGS, '--no-relative', '--format=', '-M', '-C', '--find-copies-harder',
      target.commit, '--', ...pathspecs,
    ];
  } else if (target.kind === 'uncommitted') {
    args = ['diff', ...RAW_DIFF_FLAGS, '--no-relative', '-M', '-C', '--find-copies-harder', 'HEAD', '--', ...pathspecs];
  } else {
    args = [
      'diff', ...RAW_DIFF_FLAGS, '--no-relative', '-M', '-C', '--find-copies-harder', `${target.base}...HEAD`,
      '--', ...pathspecs,
    ];
  }
  const result = gitTry(args, { cwd });
  if (!result.ok) return { text: '', error: `git could not build the approved patch: ${result.err}` };
  if (!result.out.trim()) {
    return { text: '', error: 'git returned an empty approved patch for tracked changes.' };
  }
  return { text: result.out, error: null };
}

function worktreeFile(path, cwd, top) {
  const rootPath = top || git(['rev-parse', '--show-toplevel'], { cwd }).trim() || cwd;
  const loaded = readConfinedUtf8File(path, {
    root: rootPath,
    base: rootPath,
    approve: ({ stat }) => stat.size > BigInt(MAX_FILE_BYTES)
      ? { ok: false, code: 'too_large' }
      : { ok: true },
  });
  if (loaded.ok) {
    if (loaded.content.includes('\0')) {
      return { content: null, note: 'binary file omitted', excluded: false };
    }
    return { content: loaded.content, note: '', excluded: false };
  }
  const outcomes = {
    missing_file: ['missing file omitted', false],
    symlink: ['symlink omitted', true],
    non_regular: ['non-regular file omitted', true],
    too_large: ['large file omitted', false],
    outside_path: ['out-of-worktree file omitted', true],
    ancestor_symlink_escape: ['out-of-worktree file omitted', true],
    unresolvable_file: ['unresolvable file omitted', true],
    root_unresolved: ['unresolvable file omitted', true],
  };
  const [note, excluded] = outcomes[loaded.code] || ['unreadable file omitted', true];
  return { content: null, note, excluded };
}

function trackedFile(revision, path, cwd) {
  const spec = `${revision}:${path}`;
  const tree = gitTry(['ls-tree', '-z', revision, '--', literalPath(path)], { cwd });
  if (!tree.ok) return { error: `git could not inspect tracked path: ${tree.err}` };
  if (!tree.out) return { error: 'git could not locate the tracked blob.' };
  const [mode, type] = tree.out.split(/\s+/, 2);
  if (mode === '120000') return { content: null, note: 'symlink blob omitted', excluded: true };
  if (type !== 'blob') return { content: null, note: 'gitlink or non-blob entry omitted', excluded: true };
  const sizeResult = gitTry(['cat-file', '-s', spec], { cwd });
  if (!sizeResult.ok) return { error: `git could not inspect the tracked blob: ${sizeResult.err}` };
  const size = Number.parseInt(sizeResult.out.trim(), 10);
  if (!Number.isFinite(size) || size > MAX_FILE_BYTES) {
    return { content: null, note: 'large or unreadable blob omitted', excluded: false };
  }
  const blob = gitTry(['show', spec], { cwd });
  if (!blob.ok) return { error: `git could not read the tracked blob: ${blob.err}` };
  if (blob.out.includes('\0')) return { content: null, note: 'binary blob omitted', excluded: false };
  return { content: blob.out, note: '', excluded: false };
}

function designSnapshot({ target, cwd, maxBytes, budgetName, extraExcludeGlobs }) {
  const path = cwd ? resolve(cwd, target.path) : resolve(target.path);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { error: `--design "${target.path}" could not be read.`, payload: '', changedFiles: [], notes: [] };
  }
  if (stat.isSymbolicLink()) {
    return { error: '--design must not be a symlink.', payload: '', changedFiles: [], notes: [] };
  }
  if (!stat.isFile()) {
    return { error: '--design must name a regular file.', payload: '', changedFiles: [], notes: [] };
  }
  const repo = gitTry(['rev-parse', '--show-toplevel'], { cwd });
  const root = resolve(repo.ok && repo.out.trim() ? repo.out.trim() : cwd || process.cwd());
  let actualPath;
  let actualRoot;
  try {
    actualPath = realpathSync(path);
    actualRoot = realpathSync(root);
  } catch {
    return { error: `--design "${target.path}" could not be resolved.`, payload: '', changedFiles: [], notes: [] };
  }
  const rel = relative(actualRoot, actualPath);
  const exclusionPath = rel && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
    ? rel
    : basename(actualPath);
  if (isExcluded(exclusionPath, extraExcludeGlobs)) {
    return { error: '--design names a secret-bearing path.', payload: '', changedFiles: [], notes: [] };
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { error: `--design "${target.path}" could not be read.`, payload: '', changedFiles: [], notes: [] };
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return {
      error: `--design doc is over the ${maxBytes}-byte budget; scope it or raise ${budgetName}.`,
      payload: '', changedFiles: [], notes: [],
    };
  }
  const redacted = redactSecrets(text);
  const safePath = redactSecrets(target.path).text;
  const reviewLabel = redactSecrets(target.label).text;
  return {
    error: null,
    payload: `## Design document (${safePath})\n${redacted.text}\n`,
    changedFiles: [target.path],
    notes: redacted.count ? [`redacted ${redacted.count} secret-like value(s)`] : [],
    excludedCount: 0,
    excludedPaths: [],
    referencedFiles: [],
    budgetOmittedReferencedPaths: [],
    hasChanges: true,
    reviewLabel,
    systemPrompt: buildDesignReviewPrompt({ scope: reviewLabel, context: DESIGN_CONTEXT }),
  };
}

export function buildSnapshot({
  target,
  cwd = process.cwd(),
  maxBytes = 400000,
  budgetName = 'REVIEW_MAX_CTX_BYTES',
  extraExcludeGlobs = [],
} = {}) {
  if (target.kind === 'design') {
    return designSnapshot({ target, cwd, maxBytes, budgetName, extraExcludeGlobs });
  }

  const collected = collectDiff(target, { cwd, detectCopiesHarder: true });
  if (collected.error) {
    return { error: collected.error, payload: '', changedFiles: [], notes: [], hasChanges: false };
  }

  const notes = [];
  const approved = [];
  const excludedPaths = [];
  let excludedCount = 0;
  let worktreeTop = '';
  let entries = collected.entries;
  if (target.kind === 'uncommitted') {
    const top = gitTry(['rev-parse', '--show-toplevel'], { cwd });
    if (!top.ok || !top.out.trim()) {
      return {
        error: `git could not resolve the worktree root${top.err ? `: ${top.err}` : ''}`,
        payload: '', changedFiles: [], notes: [], hasChanges: false,
      };
    }
    worktreeTop = top.out.trim();
    const untracked = gitTry(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: worktreeTop });
    if (!untracked.ok) {
      return {
        error: `git could not list repository-wide untracked files: ${untracked.err}`,
        payload: '', changedFiles: [], notes: [], hasChanges: false,
      };
    }
    entries = [
      ...collected.entries.filter((entry) => entry.status !== '?'),
      ...untracked.out.split('\0').filter(Boolean).map((path) => ({ status: '?', oldPath: null, path })),
    ];
  }
  for (const entry of entries) {
    if (entryPaths(entry).some((path) => isExcluded(path, extraExcludeGlobs))) {
      excludedCount++;
      excludedPaths.push(...entryPaths(entry));
      continue;
    }
    approved.push(entry);
  }

  const revision = target.kind === 'commit' ? target.commit : 'HEAD';
  // An approved entry the snapshot could not render — too large, or binary.
  // It is neither a change the reviewer sees nor an absence of change, and
  // conflating it with the second is what made a lone large asset skip clean.
  const unrenderableChangedPaths = [];
  const reviewable = [];
  const fileBlocks = [];
  for (const entry of approved) {
    if (entry.status === 'D') {
      reviewable.push(entry);
      continue;
    }
    const loaded = target.kind === 'uncommitted'
      ? worktreeFile(entry.path, cwd, worktreeTop)
      : trackedFile(revision, entry.path, cwd);
    if (loaded.error) {
      return { error: loaded.error, payload: '', changedFiles: [], notes, hasChanges: false };
    }
    if (loaded.excluded) {
      excludedCount++;
      excludedPaths.push(entry.path);
      notes.push(loaded.note);
      continue;
    }
    reviewable.push(entry);
    if (loaded.note) notes.push(loaded.note);
    if (loaded.content == null) {
      unrenderableChangedPaths.push(entry.path);
      continue;
    }
    const redacted = redactSecrets(loaded.content);
    if (redacted.count) notes.push(`redacted ${redacted.count} secret-like file value(s)`);
    const safePath = redactSecrets(entry.path).text;
    fileBlocks.push({
      path: entry.path,
      scanText: redacted.text,
      text: `\n### ${safePath}\n\`\`\`\n${redacted.text}\n\`\`\`\n`,
    });
  }

  const trackedPaths = reviewable
    .filter((entry) => entry.status !== '?')
    .flatMap(entryPaths);
  const patch = approvedPatch(target, trackedPaths, cwd);
  if (patch.error) {
    return { error: patch.error, payload: '', changedFiles: [], notes, hasChanges: false };
  }
  const redactedPatch = redactSecrets(patch.text);
  if (redactedPatch.count) notes.push(`redacted ${redactedPatch.count} secret-like diff value(s)`);

  const requiredPaths = [...new Set(reviewable.flatMap(entryPaths))];
  const incomplete = (reason) => ({
    error: `snapshot required coverage is incomplete: ${reason}`,
    payload: '', changedFiles: [], notes, hasChanges: false,
    unreviewable: requiredPaths.length > 0,
    omittedChangedPaths: requiredPaths,
    unrenderableChangedPaths,
    excludedCount, excludedPaths,
    referencedFiles: [], budgetOmittedReferencedPaths: [],
  });
  if (excludedCount) {
    notes.push(`${excludedCount} secret-bearing or unsafe entr${excludedCount === 1 ? 'y was' : 'ies were'} omitted`);
  }
  if (unrenderableChangedPaths.length) {
    return incomplete('required changed content cannot be rendered; select a renderable target or a tool-capable reviewer.');
  }
  if (/^(?:Binary files .* differ|GIT binary patch)\r?$/m.test(patch.text)) {
    return incomplete('the approved patch contains an unrendered binary change; select a renderable target or a tool-capable reviewer.');
  }

  const patchPaths = redactedPatch.text.trim()
    ? reviewable.filter((entry) => entry.status !== '?').map((entry) => entry.path)
    : [];
  const visibleFiles = [...new Set([...patchPaths, ...fileBlocks.map((block) => block.path)])];
  const prefix = `## Diff summary\nIncluded files: ${visibleFiles.length}\nExcluded entries: ${excludedCount}\n\n## Full diff\n`;
  let payload = prefix + redactedPatch.text + '\n## Full selected contents\n'
    + fileBlocks.map((block) => block.text).join('');
  if (Buffer.byteLength(payload, 'utf8') > maxBytes) {
    return incomplete(`required content exceeds the ${maxBytes}-byte budget; narrow the target or raise ${budgetName}.`);
  }

  const changedPaths = new Set(approved.flatMap(entryPaths));
  const discovered = discoverReferencedPaths({
    patchText: redactedPatch.text,
    fileBlocks,
    revision,
    changedPaths,
    cwd,
  });
  if (discovered.unavailable) notes.push('referenced-file discovery unavailable');
  if (discovered.omittedCount) {
    notes.push(`${discovered.omittedCount} referenced file candidate(s) omitted at the discovery limit`);
  }
  const referenceBlocks = [];
  let unavailableReferenceCount = 0;
  let excludedReferenceCount = 0;
  for (const path of discovered.paths) {
    if (isExcluded(path, extraExcludeGlobs)) {
      excludedReferenceCount++;
      continue;
    }
    const loaded = trackedFile(revision, path, cwd);
    if (loaded.error || loaded.excluded || loaded.content == null) {
      unavailableReferenceCount++;
      continue;
    }
    const redacted = redactSecrets(loaded.content);
    if (redacted.count) notes.push(`redacted ${redacted.count} secret-like referenced value(s)`);
    const safePath = redactSecrets(path).text;
    referenceBlocks.push({
      path,
      text: `\n### ${safePath} (unchanged reference)\n\`\`\`\n${redacted.text}\n\`\`\`\n`,
    });
  }
  if (excludedReferenceCount) {
    notes.push(`${excludedReferenceCount} referenced path(s) excluded by snapshot policy`);
  }
  if (unavailableReferenceCount) {
    notes.push(`${unavailableReferenceCount} referenced file(s) unreadable or unsuitable for the snapshot`);
  }

  const referencedFiles = [];
  const budgetOmittedReferencedPaths = [];
  for (const block of referenceBlocks) {
    const heading = referencedFiles.length ? '' : '\n## Referenced unchanged contents\n';
    if (Buffer.byteLength(payload + heading + block.text, 'utf8') > maxBytes) {
      budgetOmittedReferencedPaths.push(block.path);
      continue;
    }
    payload += heading + block.text;
    referencedFiles.push(block.path);
  }
  if (budgetOmittedReferencedPaths.length) {
    notes.push(`${budgetOmittedReferencedPaths.length} referenced file(s) omitted at snapshot budget`);
  }
  const reviewLabel = redactSecrets(target.label).text;

  return {
    error: null,
    payload,
    changedFiles: visibleFiles,
    notes,
    excludedCount,
    excludedPaths,
    referencedFiles,
    budgetOmittedReferencedPaths,
    hasChanges: Boolean(redactedPatch.text.trim() || fileBlocks.length),
    unreviewable: false,
    omittedChangedPaths: [],
    unrenderableChangedPaths: [],
    reviewLabel,
    systemPrompt: buildReviewPrompt({ scope: reviewLabel, context: SNAPSHOT_CONTEXT }),
  };
}
