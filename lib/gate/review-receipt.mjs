import { createHash, randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { readConfigSectionStrict } from '../config.mjs';
import { redactCredential } from '../secret.mjs';
import { byteLength } from '../text-budget.mjs';
import { readConfinedUtf8File } from './file-boundary.mjs';
import { gitTry, mainWorktree } from './git.mjs';
import { sameModelLineage, sameVersionedModelLineage } from './model-identity.mjs';
import { DESIGN_VERDICTS, DIFF_VERDICTS } from './prompt.mjs';
import { createProtocol, validateTerminalVerdict } from './protocol.mjs';
import { describeReviewTarget, loadReviewContext } from './review-context.mjs';
import { parseTarget, readOption } from './target.mjs';

export const MAX_RECEIPT_BYTES = 100000;
const FAMILIES = new Set(['claude', 'codex', 'kimi', 'glm', 'deepseek', 'mimo']);
const HEX = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const prefixPaths = (prefix, entries) => entries.map(([path, pattern]) => [[...prefix, ...path], pattern]);
const TARGET_HASH_PATHS = [[['revision'], COMMIT], [['baseRevision'], COMMIT], [['artifactDigest'], HEX]];
const STATE_HASH_PATHS = [[['head'], COMMIT], [['baseTip'], COMMIT], ...prefixPaths(['target'], TARGET_HASH_PATHS)];
const INPUT_HASH_PATHS = [...prefixPaths(['target'], TARGET_HASH_PATHS), [['context', 'digest'], HEX]];
const TERMINAL_HASH_PATHS = [[['startedDigest'], HEX], [['input', 'digest'], HEX], [['review', 'digest'], HEX],
  ...prefixPaths(['observations', 'before'], STATE_HASH_PATHS), ...prefixPaths(['observations', 'after'], STATE_HASH_PATHS)];
const plain = (value) => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function requireCondition(condition, reason) { if (!condition) throw new Error(reason); }
function shape(value, keys) {
  requireCondition(plain(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key)), 'invalid receipt schema');
}
function string(value, reason = 'invalid string') {
  requireCondition(typeof value === 'string' && value.trim() && !value.includes('\0'), reason);
}
export function canonicalBytes(value) {
  function sorted(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isSafeInteger(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${Array.from(item, sorted).join(',')}]`;
    requireCondition(plain(item), 'unsupported canonical value');
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${sorted(item[key])}`).join(',')}}`;
  }
  return `${sorted(value)}\n`;
}
export const digestBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => canonicalBytes(a) === canonicalBytes(b);

function metadata(value, credential = '', hashPaths = []) {
  const hashes = new Map(hashPaths.map(([path, pattern]) => [JSON.stringify(path), pattern]));
  function visit(item, path) {
    if (typeof item === 'string') {
      requireCondition(!item.includes('\0'), 'binary receipt metadata');
      requireCondition(!credential || !item.includes(credential), 'receipt contains configured credential');
      const hash = hashes.get(JSON.stringify(path));
      if (hash) requireCondition(hash.test(item), 'invalid receipt hash metadata');
      else requireCondition(!redactCredential(item, credential).count, 'receipt contains sensitive metadata');
    } else if (Array.isArray(item)) item.forEach((entry, index) => visit(entry, [...path, index]));
    else if (plain(item)) for (const [name, entry] of Object.entries(item)) {
      visit(name, []); visit(entry, [...path, name]);
    }
  }
  visit(value, []);
  requireCondition(byteLength(canonicalBytes(value)) <= MAX_RECEIPT_BYTES, 'receipt metadata exceeds size bound');
}
function normalizeProfile(value) {
  shape(value, ['source', 'roles']);
  requireCondition(['flags', 'config', 'legacy', 'built-in'].includes(value.source), 'invalid profile source');
  requireCondition(Array.isArray(value.roles) && value.roles.length > 0, 'profile roles are required');
  return { source: value.source, roles: value.roles.map((role) => {
    shape(role, ['preferred', 'reviewer', 'model', 'effort']);
    string(role.preferred, 'invalid preferred role');
    const preferred = role.preferred.trim().toLowerCase();
    requireCondition(preferred.length <= 100, 'preferred role exceeds size bound');
    requireCondition(FAMILIES.has(role.reviewer), 'unsupported actual reviewer');
    for (const key of ['model', 'effort']) if (role[key] !== null) string(role[key], `invalid ${key}`);
    return { preferred, reviewer: role.reviewer, model: role.model, effort: role.effort };
  }) };
}
export function profileParts(value, roleIndex) {
  const profile = normalizeProfile(value);
  requireCondition(Number.isSafeInteger(roleIndex) && roleIndex >= 0 && roleIndex < profile.roles.length, 'invalid role index');
  return { profile: { source: profile.source, preferences: profile.roles.map((role) => role.preferred) },
    selections: profile.roles.slice(0, roleIndex + 1).map(({ reviewer, model, effort }) => ({ reviewer, model, effort })) };
}
function roots(cwd) {
  const current = gitTry(['rev-parse', '--show-toplevel'], { cwd });
  const main = mainWorktree({ cwd });
  requireCondition(current.ok && main, 'receipt worktree unavailable');
  return { current: current.out.trim(), main };
}
function readAllowed(path, { cwd, root = null, bounded = true } = {}) {
  const locations = root ? [{ root, afkOnly: false }] : (() => {
    const found = roots(cwd);
    return [{ root: found.current, afkOnly: false }, { root: found.main, afkOnly: true }];
  })();
  let code = 'outside_path';
  for (const location of locations) {
    const loaded = readConfinedUtf8File(path, { root: location.root, base: cwd,
      approve: ({ relativePath, stat }) => {
        if (location.afkOnly && !relativePath.split('\\').join('/').startsWith('.afk/')) return { ok: false, code: 'outside_path' };
        if (bounded && stat.size > BigInt(MAX_RECEIPT_BYTES)) return { ok: false, code: 'too_large' };
        return { ok: true };
      }, readImpl: (fd) => readFileSync(fd),
    });
    if (!loaded.ok) { if (code === 'outside_path') code = loaded.code; continue; }
    if (bounded) requireCondition(loaded.content.length <= MAX_RECEIPT_BYTES, 'receipt file exceeds size bound');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(loaded.content);
  }
  throw new Error(`receipt file unavailable (${code})`);
}
function parseReceiptJson(bytes) {
  try { return JSON.parse(bytes); }
  catch { throw new Error('receipt JSON is malformed'); }
}
export function readReceiptJson(path, { cwd = process.cwd(), root, canonical = false } = {}) {
  const bytes = readAllowed(path, { cwd, root });
  const value = parseReceiptJson(bytes);
  if (canonical) requireCondition(bytes === canonicalBytes(value), 'noncanonical receipt bytes');
  return { value, bytes };
}
function safeDirectories(path, { create = false } = {}) {
  const parent = dirname(path);
  if (parent !== path) safeDirectories(parent);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    mkdirSync(path, { mode: 0o700 }); stat = lstatSync(path);
  }
  requireCondition(stat.isDirectory() && !stat.isSymbolicLink(), 'receipt directory is not a regular directory');
}
function runDirectory(runId, cwd) {
  requireCondition(typeof runId === 'string' && ID.test(runId), 'invalid run identifier');
  const { main } = roots(cwd);
  requireCondition(gitTry(['check-ignore', '--quiet', '--no-index', '.afk/'], { cwd: main }).ok, 'receipt .afk directory must be ignored');
  const path = join(main, '.afk', 'runs', runId);
  safeDirectories(path);
  return path;
}
function stage(path, bytes, { linkImpl = linkSync } = {}) {
  const temporary = join(dirname(path), `.stage-${randomUUID()}`);
  writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  requireCondition(readFileSync(temporary).equals(Buffer.from(bytes)), 'receipt staging verification failed');
  let published = false;
  return () => {
    requireCondition(!published, 'terminal already published');
    try { linkImpl(temporary, path); published = true; }
    finally {
      try { unlinkSync(temporary); }
      catch { process.stderr.write('[review-receipt] staged-file cleanup unavailable\n'); }
    }
  };
}
export function publishImmutable(path, bytes, options = {}) { stage(path, bytes, options)(); }

export function observeConfiguration({ cwd = process.cwd(), source } = {}) {
  const { main } = roots(cwd);
  const result = readConfigSectionStrict(join(main, '.afk', 'config.md'), 'external gate');
  if (Object.hasOwn(result.fields, 'gates')) {
    requireCondition(result.fields.gates.split('>').every((part) => part.trim()), 'invalid present gates configuration');
  }
  for (const key of ['gates', 'priority']) if (Object.hasOwn(result.fields, key)) {
    result.fields[key] = result.fields[key].split('>').map((part) => part.trim().toLowerCase()).join(' > ');
  }
  if (source === 'flags') delete result.fields.gates;
  metadata(result);
  return result;
}
function gitValue(args, cwd, reason) {
  const result = gitTry(args, { cwd }); requireCondition(result.ok, reason); return result.out.trim();
}
function observe({ cwd, source, target = null }) {
  return { head: gitValue(['rev-parse', 'HEAD'], cwd, 'receipt HEAD unavailable'),
    dirty: Boolean(gitValue(['status', '--porcelain'], cwd, 'receipt dirty state unavailable')),
    configuration: observeConfiguration({ cwd, source }),
    target: target ? describeReviewTarget(target, { cwd }) : null,
    baseTip: target?.kind === 'branch' ? gitValue(['rev-parse', `${target.base}^{commit}`], cwd, 'receipt base tip unavailable') : null };
}
function requestShape(value) {
  shape(value, ['version', 'runId', 'issue', 'attemptId', 'roleIndex', 'profile']);
  requireCondition(value.version === 1 && ID.test(value.runId) && ID.test(value.attemptId), 'invalid receipt request identity');
  if (value.issue !== null) string(value.issue, 'invalid issue identifier');
  const profile = normalizeProfile(value.profile); profileParts(profile, value.roleIndex);
  return { ...value, profile };
}
const nullModel = () => ({ observed: null, verification: 'unavailable', reason: 'response identity unavailable' });
const nullExecution = () => ({ exitCode: null, signal: null, completion: null });

export function beginReviewReceipt({ family, argv = [], cwd = process.cwd(), credential = '' } = {}) {
  const option = readOption(argv, '--review-receipt');
  if (!option.supplied) return { argv, enabled: false, capture() {}, prepare() {}, commit() {} };
  requireCondition(!option.duplicate && option.value, '--review-receipt requires exactly one file');
  const cleanArgs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--review-receipt') { i++; continue; }
    if (argv[i].startsWith('--review-receipt=')) continue;
    cleanArgs.push(argv[i]);
  }
  const request = requestShape(readReceiptJson(option.value, { cwd }).value);
  metadata(request, credential);
  requireCondition(request.profile.roles[request.roleIndex].reviewer === family, 'receipt role does not match helper family');
  const run = runDirectory(request.runId, cwd);
  const parent = join(run, 'receipts'); safeDirectories(parent, { create: true });
  const path = join(parent, request.attemptId);
  mkdirSync(path, { mode: 0o700 });
  const startedAt = new Date().toISOString();
  const startClock = performance.now();
  const started = { version: 1, attemptId: request.attemptId, family, startedAt,
    claims: { runId: request.runId, issue: request.issue, roleIndex: request.roleIndex, profile: request.profile } };
  const startBytes = canonicalBytes(started);
  publishImmutable(join(path, 'started.json'), startBytes);
  let before = null, target = null, context = null, requested = { model: null, effort: null };
  let model = nullModel(), execution = nullExecution(), sources = null, publishTerminal = null;
  const receipt = { enabled: true, argv: cleanArgs, request, family, path, error: null,
    capture(values) {
      if (values.selection) {
        const nextRequested = { model: values.selection.model ?? null, effort: values.selection.effort ?? null };
        const expected = request.profile.roles[request.roleIndex];
        for (const key of ['model', 'effort']) {
          requireCondition(expected[key] === null || nextRequested[key] === null || expected[key] === nextRequested[key], `receipt requested ${key} conflicts with profile`);
        }
        const nextSources = values.selection.sources ?? null;
        metadata({ requested: nextRequested, sources: nextSources }, credential);
        requested = nextRequested; sources = nextSources;
      }
      if (values.target) {
        const current = observe({ cwd, source: request.profile.source, target: values.target });
        requireCondition(before && before.head === current.head && equal(before.configuration, current.configuration), 'receipt target/configuration changed before capture');
        metadata(current, credential, STATE_HASH_PATHS);
        target = values.target;
        before = current;
      }
      if (values.context) {
        requireCondition(!values.context.error, 'invalid delivered receipt context');
        context = { phase: values.context.phase, digest: values.context.digest };
      }
      if (before) metadata(before, credential, STATE_HASH_PATHS);
      if (values.model) { metadata(values.model, credential); model = values.model; }
      if (values.execution) { metadata(values.execution, credential); execution = values.execution; }
    },
    prepare(event) {
      requireCondition(!publishTerminal, 'terminal already prepared');
      let after = null, input = null;
      if (before) after = observe({ cwd, source: request.profile.source, target });
      if (['review', 'preview'].includes(event.kind)) {
        requireCondition(target && context && before && after, 'receipt review inputs are incomplete');
        requireCondition(before.head === after.head && equal(before.configuration, after.configuration)
          && equal(before.target, after.target), 'receipt target/configuration changed during review');
      }
      if (target && context && before) {
        input = { version: 1, scope: { runId: request.runId, issue: request.issue }, roleIndex: request.roleIndex,
          ...profileParts(request.profile, request.roleIndex), configuration: before.configuration,
          target: before.target, context, requested };
        metadata(input, credential, INPUT_HASH_PATHS);
      }
      let inputRef = null, reviewRef = null;
      if (input) {
        const bytes = canonicalBytes(input); publishImmutable(join(path, 'input.json'), bytes);
        inputRef = { path: 'input.json', digest: digestBytes(bytes) };
      }
      if (event.kind === 'review') {
        const text = redactCredential(String(event.text), credential).text;
        publishImmutable(join(path, 'review.txt'), text);
        reviewRef = { kind: 'final-review', path: 'review.txt', digest: digestBytes(text) };
      }
      const terminal = { version: 1, attemptId: request.attemptId, startedDigest: digestBytes(startBytes),
        finishedAt: new Date().toISOString(), durationMs: Math.max(0, Math.round(performance.now() - startClock)),
        input: inputRef, outcome: { kind: event.kind, verdict: event.kind === 'review' ? event.verdict ?? null : null,
          reason: event.kind === 'review' ? null : redactCredential(String(event.reason), credential).text },
        model: { requested, ...model }, observations: { before, after, selectionSources: sources }, execution,
        review: reviewRef, transcript: { available: false, reason: 'raw transcript not captured in receipt' } };
      metadata(terminal, credential, TERMINAL_HASH_PATHS);
      publishTerminal = stage(join(path, 'terminal.json'), canonicalBytes(terminal));
    },
    commit() { requireCondition(publishTerminal, 'terminal is not prepared'); publishTerminal(); },
  };
  try {
    const observed = observe({ cwd, source: request.profile.source });
    metadata(observed, credential, STATE_HASH_PATHS); before = observed;
  }
  catch (error) { receipt.error = error.message; }
  return receipt;
}

export function createReceiptProtocol(options) {
  let receipt;
  try { receipt = beginReviewReceipt(options); }
  catch (error) {
    createProtocol(options).emitError(`cannot record review receipt: ${error.message}`);
  }
  const protocol = createProtocol({ ...options, observer: receipt.enabled ? receipt : null });
  const capture = receipt.capture.bind(receipt);
  receipt.capture = (values) => {
    try { capture(values); }
    catch (error) { protocol.emitError(`cannot record review receipt: ${error.message}`); }
  };
  if (receipt.error) protocol.emitError(`cannot record review receipt: ${receipt.error}`);
  return { receipt, protocol, argv: receipt.argv };
}

function candidateArguments(value) {
  requireCondition(plain(value), 'invalid candidate target');
  if (value.kind === 'branch') { shape(value, ['kind', 'base']); string(value.base); return ['--base', value.base]; }
  if (value.kind === 'commit') { shape(value, ['kind', 'commit']); string(value.commit); return ['--commit', value.commit]; }
  if (value.kind === 'design') { shape(value, ['kind', 'path']); string(value.path); return ['--design', value.path]; }
  shape(value, ['kind']); requireCondition(value.kind === 'uncommitted', 'invalid candidate target kind');
  return ['--uncommitted'];
}
function validateTargetDescriptor(target) {
  const keys = ['kind', 'revision'];
  if (target?.kind === 'branch') keys.push('baseRevision');
  else if (target?.kind === 'design') keys.push('path', 'artifactDigest');
  else if (target?.kind === 'uncommitted') keys.push('artifactDigest');
  else requireCondition(target?.kind === 'commit', 'invalid receipt target');
  shape(target, keys);
  requireCondition(COMMIT.test(target.revision), 'invalid receipt revision');
  if (target.baseRevision) requireCondition(COMMIT.test(target.baseRevision), 'invalid receipt base');
  if (target.artifactDigest) requireCondition(HEX.test(target.artifactDigest), 'invalid artifact digest');
}
function validateState(state) {
  if (state === null) return;
  shape(state, ['head', 'dirty', 'configuration', 'target', 'baseTip']);
  requireCondition(COMMIT.test(state.head) && typeof state.dirty === 'boolean', 'invalid receipt state');
  if (state.target !== null) validateTargetDescriptor(state.target);
  if (state.baseTip !== null) requireCondition(COMMIT.test(state.baseTip), 'invalid base tip');
}
function validateModel(value, family) {
  shape(value, ['requested', 'observed', 'verification', 'reason']);
  shape(value.requested, ['model', 'effort']);
  for (const item of Object.values(value.requested)) if (item !== null) string(item);
  requireCondition(['verified', 'mismatch', 'unavailable'].includes(value.verification), 'invalid identity verification');
  if (value.reason !== null) string(value.reason, 'invalid identity reason');
  requireCondition(value.observed === null || (Array.isArray(value.observed) && value.observed.every((id) => typeof id === 'string' && id)), 'invalid observed identity');
  if (value.verification === 'verified') {
    requireCondition(!['kimi', 'codex'].includes(family) && value.requested.model && value.observed?.length, 'unsupported verified identity');
    const match = family === 'claude' ? sameModelLineage : sameVersionedModelLineage;
    requireCondition(value.observed.some((id) => match(id, value.requested.model)), 'conflicting verified identity');
  }
}
function readBoundArtifact(path, reference, expected, cwd, { review = false } = {}) {
  shape(reference, review ? ['kind', 'path', 'digest'] : ['path', 'digest']);
  requireCondition(reference.path === expected && HEX.test(reference.digest)
    && (!review || reference.kind === 'final-review'), 'invalid receipt artifact reference');
  const bytes = readAllowed(join(path, expected), { cwd, root: path, bounded: !review });
  requireCondition(digestBytes(bytes) === reference.digest, 'receipt artifact digest mismatch');
  return bytes;
}

export function checkReviewReceipts({ candidate, receiptPaths = [], cwd = process.cwd() } = {}) {
  const result = { version: 1, consistent: false, reviewsComplete: false, allRequiredApproved: false,
    candidate: null, profileDigest: null, roles: [], issues: [] };
  try {
    shape(candidate, ['version', 'runId', 'issue', 'profile', 'target', 'contexts']);
    requireCondition(candidate.version === 1, 'unsupported candidate version');
    if (candidate.issue !== null) string(candidate.issue, 'invalid candidate issue');
    requireCondition(byteLength(canonicalBytes(candidate)) <= MAX_RECEIPT_BYTES, 'candidate exceeds size bound');
    metadata({ version: candidate.version, runId: candidate.runId, issue: candidate.issue, profile: candidate.profile });
    const profile = normalizeProfile(candidate.profile);
    const run = runDirectory(candidate.runId, cwd);
    const args = candidateArguments(candidate.target);
    const target = parseTarget(args, { cwd });
    const descriptor = describeReviewTarget(target, { cwd });
    metadata(descriptor, '', TARGET_HASH_PATHS);
    const configuration = observeConfiguration({ cwd, source: profile.source });
    requireCondition(Array.isArray(candidate.contexts) && candidate.contexts.length === profile.roles.length, 'one candidate context is required per role');
    const contexts = candidate.contexts.map((item, index) => {
      shape(item, ['phase', 'path']);
      requireCondition(item.path === null || typeof item.path === 'string', 'invalid candidate context path');
      const context = loadReviewContext({ argv: [...args, '--review-phase', item.phase,
        ...(item.path === null ? [] : ['--review-context', item.path])], cwd, target,
        supported: profile.roles[index].reviewer !== 'codex' || target.kind === 'design' });
      requireCondition(!context.error, context.error || 'invalid candidate context');
      return { phase: context.phase, digest: context.digest };
    });
    result.candidate = descriptor;
    result.profileDigest = digestBytes(canonicalBytes({ profile: profileParts(profile, 0).profile, configuration }));
    const attempts = new Map();
    for (const supplied of receiptPaths) {
      try {
        const path = resolve(cwd, supplied);
        requireCondition(dirname(path) === join(run, 'receipts'), 'receipt attempt is outside selected run');
        safeDirectories(path);
        const start = readReceiptJson(join(path, 'started.json'), { cwd, root: path, canonical: true });
        shape(start.value, ['version', 'attemptId', 'family', 'startedAt', 'claims']);
        shape(start.value.claims, ['runId', 'issue', 'roleIndex', 'profile']);
        const normalized = requestShape({ version: start.value.version, attemptId: start.value.attemptId, ...start.value.claims });
        requireCondition(equal(normalized.profile, start.value.claims.profile), 'noncanonical started profile');
        const index = start.value.claims.roleIndex;
        requireCondition(Number.isSafeInteger(index) && index >= 0 && index < profile.roles.length, 'invalid receipt role');
        requireCondition(!attempts.has(index), 'duplicate receipt role');
        attempts.set(index, { path, start });
      } catch (error) { result.issues.push(error.message); }
    }
    for (let index = 0; index < profile.roles.length; index++) {
      const role = { roleIndex: index, path: null, consistent: false, outcome: null, approved: false,
        modelVerification: 'unavailable', inputDigest: null, issues: [] };
      result.roles.push(role);
      try {
        const attempt = attempts.get(index);
        requireCondition(attempt, 'unknown-legacy-or-missing receipt');
        const { path, start } = attempt;
        role.path = relative(run, path).split('\\').join('/');
        const claims = start.value.claims;
        requireCondition(start.value.version === 1 && ID.test(start.value.attemptId)
          && path === join(run, 'receipts', start.value.attemptId), 'invalid started identity');
        requireCondition(claims.runId === candidate.runId && claims.issue === candidate.issue, 'receipt scope mismatch');
        requireCondition(start.value.family === profile.roles[index].reviewer, 'receipt reviewer mismatch');
        const expectedParts = profileParts(profile, index);
        requireCondition(equal(profileParts(claims.profile, index), expectedParts), 'receipt profile or selection prefix mismatch');
        const terminal = readReceiptJson(join(path, 'terminal.json'), { cwd, root: path, canonical: true }).value;
        shape(terminal, ['version', 'attemptId', 'startedDigest', 'finishedAt', 'durationMs', 'input', 'outcome', 'model', 'observations', 'execution', 'review', 'transcript']);
        metadata(terminal, '', TERMINAL_HASH_PATHS);
        requireCondition(terminal.version === 1 && terminal.attemptId === start.value.attemptId
          && terminal.startedDigest === digestBytes(start.bytes), 'terminal start binding mismatch');
        requireCondition(typeof start.value.startedAt === 'string' && !Number.isNaN(Date.parse(start.value.startedAt))
          && typeof terminal.finishedAt === 'string' && !Number.isNaN(Date.parse(terminal.finishedAt))
          && Number.isSafeInteger(terminal.durationMs) && terminal.durationMs >= 0, 'invalid receipt timing');
        shape(terminal.outcome, ['kind', 'verdict', 'reason']);
        requireCondition(['review', 'error', 'skipped', 'preview'].includes(terminal.outcome.kind), 'invalid outcome kind');
        role.outcome = terminal.outcome.kind;
        validateModel(terminal.model, start.value.family);
        role.modelVerification = terminal.model.verification;
        shape(terminal.observations, ['before', 'after', 'selectionSources']);
        if (terminal.observations.selectionSources !== null) {
          shape(terminal.observations.selectionSources, ['model', 'effort']);
          for (const value of Object.values(terminal.observations.selectionSources)) string(value, 'invalid selection source');
        }
        validateState(terminal.observations.before); validateState(terminal.observations.after);
        shape(terminal.execution, ['exitCode', 'signal', 'completion']);
        requireCondition(terminal.execution.exitCode === null || (Number.isSafeInteger(terminal.execution.exitCode)
          && terminal.execution.exitCode >= 0), 'invalid execution exit code');
        for (const key of ['signal', 'completion']) if (terminal.execution[key] !== null) string(terminal.execution[key], 'invalid execution state');
        shape(terminal.transcript, ['available', 'reason']);
        string(terminal.transcript.reason, 'invalid transcript availability reason');
        requireCondition(terminal.transcript.available === false, 'unsupported transcript claim');
        requireCondition(terminal.outcome.kind === 'review', `required role outcome is ${terminal.outcome.kind}`);
        requireCondition(terminal.execution.signal === null
          && (['claude', 'codex', 'kimi'].includes(start.value.family)
            ? terminal.execution.exitCode === 0 : terminal.execution.completion === 'stop'), 'execution does not establish a completed review');
        requireCondition(['codex', 'kimi'].includes(start.value.family)
          || terminal.model.verification === 'verified', 'helper identity requirement is not satisfied');
        requireCondition(terminal.input && terminal.review, 'required review artifacts are missing');
        const inputBytes = readBoundArtifact(path, terminal.input, 'input.json', cwd);
        const input = parseReceiptJson(inputBytes);
        requireCondition(inputBytes === canonicalBytes(input), 'noncanonical input bytes');
        shape(input, ['version', 'scope', 'roleIndex', 'profile', 'selections', 'configuration', 'target', 'context', 'requested']);
        shape(input.scope, ['runId', 'issue']); shape(input.context, ['phase', 'digest']);
        shape(input.requested, ['model', 'effort']);
        requireCondition(input.version === 1 && input.roleIndex === index
          && equal(input.scope, { runId: candidate.runId, issue: candidate.issue }), 'input scope mismatch');
        requireCondition(equal({ profile: input.profile, selections: input.selections }, expectedParts), 'input profile mismatch');
        validateTargetDescriptor(input.target);
        requireCondition(equal(input.target, descriptor) && equal(input.configuration, configuration), 'candidate target/configuration mismatch');
        requireCondition(equal(input.context, contexts[index]), 'candidate context mismatch');
        requireCondition(equal(input.requested, terminal.model.requested), 'requested identity conflict');
        for (const key of ['model', 'effort']) requireCondition(profile.roles[index][key] === null
          || input.requested[key] === null || profile.roles[index][key] === input.requested[key], 'requested selection mismatch');
        const { before, after } = terminal.observations;
        requireCondition(before && after && before.head === after.head && equal(before.target, input.target)
          && equal(after.target, input.target) && equal(before.configuration, configuration)
          && equal(after.configuration, configuration), 'receipt observations drifted');
        const review = readBoundArtifact(path, terminal.review, 'review.txt', cwd, { review: true });
        const verdict = terminal.outcome.verdict;
        const vocabulary = descriptor.kind === 'design' ? DESIGN_VERDICTS : DIFF_VERDICTS;
        requireCondition(verdict === null || vocabulary.includes(verdict), 'invalid receipt verdict');
        if (verdict !== null) {
          const parsed = validateTerminalVerdict(review, descriptor.kind === 'design' ? 'design' : 'diff');
          requireCondition(parsed.ok && parsed.verdict === verdict, 'review text contradicts receipt verdict');
        }
        requireCondition(terminal.outcome.reason === null && terminal.model.verification !== 'mismatch', 'conflicting review outcome');
        role.inputDigest = terminal.input.digest;
        role.approved = verdict === null ? null : vocabulary.slice(0, 2).includes(verdict);
        role.consistent = true;
      } catch (error) { role.issues.push(error.message); }
    }
    result.consistent = !result.issues.length && result.roles.every((role) => role.consistent);
    result.reviewsComplete = result.consistent && result.roles.every((role) => role.outcome === 'review');
    result.allRequiredApproved = !result.reviewsComplete || result.roles.some((role) => role.approved === false)
      ? false : result.roles.some((role) => role.approved === null) ? null : true;
  } catch (error) { result.issues.push(error.message); }
  return result;
}
