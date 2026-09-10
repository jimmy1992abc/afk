import { createHash } from 'node:crypto';
import { readSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import { isExcluded, redactCredential } from '../secret.mjs';
import { byteLength } from '../text-budget.mjs';
import { readConfinedUtf8File } from './file-boundary.mjs';
import { collectDiff, parseTarget, readOption, validateTarget } from './target.mjs';
import { gitTry, mainWorktree, RAW_DIFF_FLAGS } from './git.mjs';
import { REVIEW_CONTEXT_POSTURE } from './prompt.mjs';

export const MAX_REVIEW_CONTEXT_BYTES = 100000;
const DISPOSITIONS = new Set(['open', 'fixed', 'refuted', 'deferred', 'suppressed', 'contested']);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const nonempty = (value) => typeof value === 'string' && Boolean(value.trim());
const commitId = (value) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function shape(value, fields) {
  return object(value) && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}
function requireGit(args, cwd, reason) {
  const result = gitTry(args, { cwd });
  if (!result.ok) throw new Error(reason);
  return result.out.trim();
}
function rootAt(cwd) {
  return requireGit(['rev-parse', '--show-toplevel'], cwd, 'review-context worktree root unavailable');
}
function readAllowed(path, { cwd, base = cwd, maxBytes, digestOnly = false, extraExcludeGlobs = [] }) {
  const current = rootAt(cwd);
  const main = mainWorktree({ cwd });
  const roots = [{ root: current, afkOnly: false }];
  if (main && resolve(main) !== resolve(current)) roots.push({ root: main, afkOnly: true });
  let failure = 'outside_path';
  for (const { root, afkOnly } of roots) {
    const result = readConfinedUtf8File(path, {
      root, base,
      approve: ({ relativePath, stat }) => {
        const normalized = relativePath.split('\\').join('/');
        if (afkOnly && !normalized.startsWith('.afk/')) return { ok: false, code: 'outside_path' };
        if (!digestOnly && isExcluded(normalized, extraExcludeGlobs)) return { ok: false, code: 'excluded_path' };
        if (maxBytes != null && stat.size > BigInt(maxBytes)) return { ok: false, code: 'too_large' };
        return { ok: true };
      },
      readImpl: digestOnly ? (fd) => {
        const digest = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let size;
        while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, size));
        return digest.digest('hex');
      } : (fd) => {
        const buffer = Buffer.alloc(maxBytes + 1);
        let total = 0;
        while (total < buffer.length) {
          const size = readSync(fd, buffer, total, buffer.length - total, null);
          if (!size) break;
          total += size;
        }
        return buffer.subarray(0, total);
      },
    });
    if (!result.ok) {
      if (failure === 'outside_path' || !['outside_path', 'root_unresolved'].includes(result.code)) failure = result.code;
      continue;
    }
    const absolutePath = resolve(root, result.relativePath);
    if (digestOnly) return { text: result.content, absolutePath };
    if (result.content.length > maxBytes) throw new Error('file too_large');
    if (result.content.includes(0)) throw new Error('binary context or evidence is unsupported');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.content); }
    catch { throw new Error('context or evidence is not valid UTF-8'); }
    if (byteLength(text) > maxBytes) throw new Error('file too_large');
    return { text, absolutePath };
  }
  throw new Error(`file unavailable (${failure})`);
}

export function describeReviewTarget(target, { cwd = process.cwd() } = {}) {
  const valid = validateTarget(target, { cwd });
  if (!valid.ok) throw new Error('review-context target is invalid');
  const revision = requireGit(['rev-parse', '--verify', `${target.kind === 'commit' ? target.commit : 'HEAD'}^{commit}`], cwd, 'review-context current revision unavailable');
  const descriptor = { kind: target.kind, revision };
  if (target.kind === 'branch') {
    descriptor.baseRevision = requireGit(['merge-base', target.base, revision], cwd, 'review-context merge base unavailable');
  } else if (target.kind === 'design') {
    const artifact = readAllowed(target.path, { cwd, digestOnly: true });
    descriptor.path = relative(rootAt(cwd), artifact.absolutePath).split('\\').join('/');
    descriptor.artifactDigest = artifact.text;
  } else if (target.kind === 'uncommitted') {
    const collected = collectDiff(target, { cwd });
    if (collected.error) throw new Error('review-context uncommitted target unavailable');
    // Binary patches distinguish working bytes that ordinary Git diff elides.
    const diff = gitTry(['diff', ...RAW_DIFF_FLAGS, '--binary', '--full-index', '--no-relative', 'HEAD'], { cwd });
    if (!diff.ok) throw new Error('review-context uncommitted patch unavailable');
    const root = rootAt(cwd);
    const untracked = collected.untracked.slice().sort().map((path) => [
      path, readAllowed(path, { cwd, base: root, digestOnly: true }).text,
    ]);
    descriptor.artifactDigest = hash(JSON.stringify({ diff: diff.out, untracked }));
  }
  return descriptor;
}

export function reviewContextOptions(argv, { supported = true } = {}) {
  const context = readOption(argv, '--review-context');
  const phase = readOption(argv, '--review-phase');
  for (const [flag, option] of [['--review-context', context], ['--review-phase', phase]]) {
    if (option.duplicate || (option.supplied && !option.value)) {
      return { error: `${flag} requires exactly one nonempty value` };
    }
  }
  const value = phase.supplied ? phase.value : 'initial';
  if (!['initial', 're-review'].includes(value)) return { error: '--review-phase must be initial or re-review' };
  if (!supported && (context.supplied || value === 're-review')) {
    return { error: 'native Codex diff review cannot deliver --review-context or re-review focus; keep the selected target/mode and apply driver-side history triage; no context was delivered' };
  }
  if (value === 're-review' && !context.supplied) return { error: '--review-context is required for --review-phase re-review' };
  const remaining = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (['--review-context', '--review-phase'].includes(arg)) { index++; continue; }
    if (['--review-context=', '--review-phase='].some((flag) => arg.startsWith(flag))) continue;
    remaining.push(arg);
  }
  return { error: null, phase: value, path: context.supplied ? context.value : null, argv: remaining };
}

export function loadReviewContext({
  argv = [], cwd = process.cwd(), target = parseTarget(argv, { cwd }), credential = '',
  supported = true, extraExcludeGlobs = [],
} = {}) {
  const options = reviewContextOptions(argv, { supported });
  const fail = (error) => ({ error, section: '', digest: null, context: null, phase: options.phase || null });
  if (options.error) return fail(options.error);
  if (!options.path) return {
    error: null, phase: options.phase, digest: null, context: null,
    section: 'Review phase: initial. No prior history was supplied; perform the complete initial review, not finding closure.',
  };
  try {
    const sensitive = (value, structured = false) => {
      if (typeof value !== 'string') return;
      if (credential && value.includes(credential)) throw new Error('review-context contains the configured credential');
      if (!structured && redactCredential(value, credential).count) throw new Error('review-context contains sensitive content; supply sanitized evidence');
      if (value.includes('\0')) throw new Error('binary context or evidence is unsupported');
    };
    const sensitivePath = (value, { delivered = true } = {}) => {
      if (value.includes('://')) throw new Error('URL context/evidence paths are unsupported');
      if (delivered) {
        // Whole delivered fields retain cross-component credential patterns.
        sensitive(value);
      } else {
        // The source locator is never delivered; full temporary prefixes resemble entropy.
        sensitive(value, true);
        for (const component of value.split(/[\\/]/)) sensitive(component);
      }
    };
    sensitivePath(options.path, { delivered: false });
    const loaded = readAllowed(options.path, { cwd, maxBytes: MAX_REVIEW_CONTEXT_BYTES, extraExcludeGlobs });
    let source;
    try { source = JSON.parse(loaded.text); }
    catch { throw new Error('review-context JSON is malformed'); }
    if (!shape(source, ['version', 'target', 'acceptance', 'priorRevision', 'findings']) || source.version !== 1) {
      throw new Error('review-context schema must be version 1 with the documented fields');
    }
    const actual = describeReviewTarget(target, { cwd });
    if (!shape(source.target, Object.keys(actual)) || Object.entries(actual).some(([key, value]) => source.target[key] !== value)) {
      throw new Error('review-context target mismatch: current revision, base, kind, path or artifact digest is stale');
    }
    for (const [key, value] of Object.entries(source.target)) {
      if (key === 'path') sensitivePath(value);
      else sensitive(value, ['revision', 'baseRevision', 'artifactDigest'].includes(key));
    }
    if (!nonempty(source.acceptance)) throw new Error('review-context acceptance is required');
    sensitive(source.acceptance);
    if (!Array.isArray(source.findings)) throw new Error('review-context findings must be an array');
    if (options.phase === 'initial') {
      if (source.priorRevision !== null || source.findings.length) throw new Error('initial review-context requires null prior revision and empty findings');
    } else {
      sensitive(source.priorRevision, true);
      if (!commitId(source.priorRevision)) throw new Error('review-context prior revision must be a full commit ID');
      const resolved = gitTry(['rev-parse', '--verify', `${source.priorRevision}^{commit}`], { cwd });
      if (!resolved.ok || resolved.out.trim() !== source.priorRevision
        || !gitTry(['merge-base', '--is-ancestor', source.priorRevision, actual.revision], { cwd }).ok
        || (actual.baseRevision && !gitTry(['merge-base', '--is-ancestor', actual.baseRevision, source.priorRevision], { cwd }).ok)) {
        throw new Error('review-context prior revision is missing or outside the selected revision history');
      }
      if (!source.findings.length) throw new Error('re-review-context requires prior findings');
    }
    const ids = new Set();
    let expandedBytes = byteLength(loaded.text);
    const findings = source.findings.map((finding) => {
      if (!shape(finding, ['id', 'disposition', 'claim', 'evidence']) || !nonempty(finding.id)
        || !DISPOSITIONS.has(finding.disposition) || !nonempty(finding.claim)) throw new Error('review-context finding schema is invalid');
      if (ids.has(finding.id)) throw new Error('review-context duplicate finding ID');
      ids.add(finding.id);
      for (const value of [finding.id, finding.disposition, finding.claim]) sensitive(value);
      if (!Array.isArray(finding.evidence) || !finding.evidence.length) throw new Error('review-context finding evidence is required');
      const evidence = finding.evidence.map((entry) => {
        if (!shape(entry, ['revision', Object.hasOwn(entry || {}, 'path') ? 'path' : 'text'])) throw new Error('review-context evidence requires exactly revision and text or path');
        sensitive(entry.revision, true);
        if (entry.revision !== actual.revision) throw new Error('review-context evidence revision mismatch');
        if (Object.hasOwn(entry, 'text')) {
          if (!nonempty(entry.text)) throw new Error('review-context evidence text is required');
          sensitive(entry.text);
          return { revision: entry.revision, text: entry.text };
        }
        if (!nonempty(entry.path)) throw new Error('review-context evidence path is required');
        sensitivePath(entry.path);
        let proof;
        try { proof = readAllowed(entry.path, { cwd, base: dirname(loaded.absolutePath), maxBytes: MAX_REVIEW_CONTEXT_BYTES, extraExcludeGlobs }); }
        catch (error) { throw new Error(`review-context evidence ${error.message}`); }
        if (!nonempty(proof.text)) throw new Error('review-context evidence file is empty');
        sensitive(proof.text);
        expandedBytes += byteLength(proof.text);
        if (expandedBytes > MAX_REVIEW_CONTEXT_BYTES) throw new Error('review-context expanded evidence exceeds the byte budget');
        return { revision: entry.revision, path: entry.path, text: proof.text };
      });
      return { id: finding.id, disposition: finding.disposition, claim: finding.claim, evidence };
    });
    const context = { version: 1, target: actual, acceptance: source.acceptance, priorRevision: source.priorRevision, findings };
    const json = JSON.stringify(context);
    const digest = hash(json);
    const section = [
      `Review phase: ${options.phase}.`, REVIEW_CONTEXT_POSTURE,
      `Review context SHA-256: ${digest}`,
      source.priorRevision ? `Repair delta: ${source.priorRevision}..${actual.revision}${actual.artifactDigest ? ' plus the bound working artifact' : ''}. The complete initial target remains unchanged.` : 'Perform the complete initial review.',
      '## Supplied review context (JSON claims)', json,
      'Verify each named disposition against the supplied proof and target. Report missing, stale or inaccessible evidence before claiming closure.',
    ].join('\n');
    if (byteLength(section) > MAX_REVIEW_CONTEXT_BYTES) throw new Error('review-context expanded section exceeds the byte budget');
    return { error: null, phase: options.phase, digest, context, section };
  } catch (error) {
    return fail(error.message);
  }
}
