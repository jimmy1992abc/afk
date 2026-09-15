import { lstatSync, mkdirSync, opendirSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { canonicalBytes, digestBytes, publishImmutable } from '../gate/review-receipt.mjs';
import { readConfinedUtf8File } from '../gate/file-boundary.mjs';
import { gitTry, mainWorktree } from '../gate/git.mjs';
import { isExcluded, redactCredential } from '../secret.mjs';
import { byteLength } from '../text-budget.mjs';
import { parseLedger, LEDGER_READ_BYTES } from '../resume/detect.mjs';
import { readConfigSectionStrict } from '../config.mjs';
import { LIMITS, DEFAULT_POLICY, requireValue, shape, identifier, pathName, source, validatePolicy,
  validateRequest, validateExpected, equal, recordName, foldRecords, references, checkBaselineLines } from './schema.mjs';

export function directories(path, create = false) {
  const absolute = resolve(path); const parent = dirname(absolute);
  if (parent !== absolute) directories(parent, false);
  let stat;
  try { stat = lstatSync(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT' || !create) throw Object.assign(new Error('directory_unavailable'), { code: 'directory_unavailable' });
    try { mkdirSync(absolute, { mode: 0o700 }); } catch (race) { if (race.code !== 'EEXIST') throw race; }
    stat = lstatSync(absolute);
  }
  requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe_directory');
}
function roots(cwd) {
  const main = mainWorktree({ cwd }); requireValue(Boolean(main), 'main_worktree_unavailable');
  directories(main);
  requireValue(gitTry(['check-ignore', '--quiet', '--no-index', '.afk/'], { cwd: main }).ok, 'afk_not_ignored');
  return { main, runs: join(main, '.afk', 'runs') };
}
function locate({ cwd, runId, issueId }) {
  identifier(runId); if (issueId !== undefined) identifier(issueId);
  const { main, runs } = roots(cwd); const run = join(runs, runId); directories(run);
  return { main, run, directory: issueId === undefined ? null : join(run, 'issues', issueId, 'direction') };
}
function load(root, name, maxBytes, { prefix = false, sensitive = true } = {}) {
  pathName(name); directories(root); directories(dirname(resolve(root, name)));
  const found = readConfinedUtf8File(name, { root,
    approve: ({ relativePath, stat }) => ({ ok: !isExcluded(relativePath) && (prefix || stat.size <= BigInt(maxBytes)), code: 'file_limit' }),
    readImpl: fd => {
      const bytes = Buffer.alloc(maxBytes + (prefix ? 0 : 1)); let total = 0;
      while (total < bytes.length) {
        const count = readSync(fd, bytes, total, bytes.length - total, null); if (count === 0) break; total += count;
      }
      requireValue(total <= maxBytes, 'file_limit');
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, total));
    } });
  requireValue(found.ok, found.code || 'file_unavailable');
  requireValue(!found.content.includes('\0'), 'binary_source');
  if (sensitive) requireValue(!redactCredential(found.content, '').count, 'sensitive_source');
  return found.content;
}
function json(bytes) {
  let value; try { value = JSON.parse(bytes); } catch { requireValue(false, 'invalid_json'); }
  requireValue(bytes === canonicalBytes(value), 'noncanonical_json'); return value;
}
function lifecycle(run, runId, writing = false) {
  const prefix = load(run, 'ledger.md', LEDGER_READ_BYTES, { prefix: true, sensitive: false });
  const header = prefix.split(/^##\s/m, 1)[0];
  for (const field of ['run-id', 'state']) {
    requireValue([...header.matchAll(new RegExp(`^${field}:[ \\t]*([^\\r\\n]*)`, 'gim'))].length === 1, 'invalid_lifecycle_header');
  }
  const value = parseLedger(header);
  requireValue(value.runId === runId && ['active', 'complete'].includes(value.state), 'invalid_lifecycle_header');
  if (writing) requireValue(value.state === 'active', 'run_complete');
  return value.state;
}
function listDirectory(path) {
  try { directories(path); }
  catch (error) {
    try { lstatSync(path); } catch (missing) { if (missing.code === 'ENOENT') return null; }
    throw error;
  }
  const names = []; const directory = opendirSync(path);
  try {
    for (let item = directory.readSync(); item !== null; item = directory.readSync()) {
      requireValue(names.length < LIMITS.records, 'directory_entry_limit');
      requireValue(item.isFile() && !item.isSymbolicLink(), 'invalid_sequence_entry'); names.push(item.name);
    }
  } finally { directory.closeSync(); }
  return names.sort();
}
function verifyReferences(operation, payload, proof) {
  for (const { reference, path } of references(payload)) {
    const packet = operation === 'reserve' && equal(path, ['binding', 'packet']);
    const result = operation === 'terminal' && equal(path, ['terminal', 'result']);
    proof(reference, packet ? 'audit-packet' : result ? 'opaque' : 'source');
  }
}
function inspect({ cwd, runId, issueId }) {
  const location = locate({ cwd, runId, issueId }); const runState = lifecycle(location.run, runId);
  const names = listDirectory(location.directory);
  const notices = []; const records = []; const evidenceCache = new Map(); let total = 0;
  const proof = (ref, validation = 'source') => {
    const key = canonicalBytes({ ref, validation });
    if (!evidenceCache.has(key)) {
      const bytes = load(location.run, ref.path, validation === 'audit-packet' ? LIMITS.auditPacketBytes : LIMITS.evidenceBytes,
        { sensitive: validation === 'source' });
      requireValue(digestBytes(bytes) === ref.digest, 'evidence_digest_mismatch'); evidenceCache.set(key, bytes);
    }
    return evidenceCache.get(key);
  };
  const sequenceNames = [];
  for (const name of names || []) {
    if (name.startsWith('.stage-')) { notices.push(`orphan_stage:${name}`); continue; }
    requireValue(/^\d{6}\.json$/.test(name), 'invalid_sequence_filename'); sequenceNames.push(name);
  }
  for (const name of sequenceNames) {
    requireValue(name === recordName(records.length + 1), 'sequence_gap');
    const bytes = load(location.directory, name, LIMITS.recordBytes, { sensitive: false });
    total += byteLength(bytes); requireValue(total <= LIMITS.sequenceBytes, 'sequence_limit');
    const record = json(bytes); records.push(record);
  }
  const folded = foldRecords(records);
  for (const record of records) {
    requireValue(record.runId === runId && record.issueId === issueId, 'wrong_identity');
    verifyReferences(record.operation, record.payload, proof);
    if (record.payload.baseline) checkBaselineLines(record.payload.baseline, proof);
  }
  requireValue(equal(names, listDirectory(location.directory)), 'state_changed');
  return { ...location, runState, names, records, folded, notices, proof };
}
function view(inspected) {
  const { folded, notices, runState, names } = inspected;
  const reasons = [...notices]; let status = 'valid';
  if (!folded.baseline) { status = names === null ? 'off' : 'unavailable'; reasons.push(names === null ? 'direction_off_legacy' : 'initialization_incomplete'); }
  else if (folded.policy.mode === 'off') { status = 'off'; reasons.push('direction_off'); }
  if (folded.accounting?.knowledge === 'unknown') reasons.push('accounting_unknown');
  else if (folded.accounting?.remaining === 0) reasons.push('attempts_exhausted');
  if (runState === 'complete') reasons.push('run_complete');
  const { head, baseline, baselineDigest, policy, policyDigest, accounting, attempts } = folded;
  return { version: 1, status, reasons, head: baseline ? head : null, baseline, baselineDigest, policy, policyDigest,
    accounting, attempts, canReserve: status === 'valid' && runState === 'active' && folded.canReserve };
}
function reason(error) { return error.code || 'state_unavailable'; }
function failedRead(code) {
  const invalid = /invalid|malformed|noncanonical|broken|duplicate|sequence_gap|wrong_identity|contradictory|reduction/.test(code);
  return { version: 1, status: code === 'state_changed' ? 'stale' : invalid ? 'invalid' : 'unavailable', reasons: [code],
    head: null, baseline: null, baselineDigest: null, policy: null, policyDigest: null, accounting: null, attempts: [], canReserve: false };
}
export function readDirectionState({ cwd = process.cwd(), runId, issueId, expected } = {}) {
  try {
    if (expected !== undefined) validateExpected(expected);
    const state = view(inspect({ cwd, runId, issueId }));
    if (expected && (!equal(state.head, expected.head) || state.baselineDigest !== expected.baselineDigest || state.policyDigest !== expected.policyDigest)) {
      return { ...state, status: 'stale', reasons: [...state.reasons, 'stale_expected'], canReserve: false };
    }
    return state;
  } catch (error) { return failedRead(reason(error)); }
}
function createIssueDirectories(location, issueId) {
  const issues = join(location.run, 'issues'); directories(issues, true);
  const issue = join(issues, issueId); directories(issue, true); directories(location.directory, true);
}
export function appendDirectionRecord({ cwd = process.cwd(), request, publish = publishImmutable, beforePublish = () => {} } = {}) {
  let destination = null; let bytes = null; let locator = null; let attempted = false;
  try {
    validateRequest(request);
    const args = { cwd, runId: request.runId, issueId: request.issueId }; const first = inspect(args);
    lifecycle(first.run, request.runId, true);
    const old = first.folded.operations.get(request.operationId);
    if (old) {
      requireValue(old.operation === request.operation && equal(old.payload, request.payload), 'operation_conflict');
      return { version: 1, status: 'already_recorded', reasons: ['already_recorded_not_dispatchable'],
        record: { sequence: old.sequence, digest: digestBytes(canonicalBytes(old)), path: `issues/${request.issueId}/direction/${recordName(old.sequence)}` },
        state: { ...view(first), canReserve: false } };
    }
    requireValue(equal(first.folded.head, request.expectedHead), 'stale_head');
    const record = { version: 1, runId: request.runId, issueId: request.issueId, sequence: request.expectedHead.sequence + 1,
      previousDigest: request.expectedHead.digest, operationId: request.operationId, recordedAt: new Date().toISOString(),
      operation: request.operation, payload: request.payload };
    foldRecords([...first.records, record]);
    verifyReferences(request.operation, request.payload, first.proof);
    if (request.payload.baseline) checkBaselineLines(request.payload.baseline, first.proof);
    if (request.operation === 'initialize') createIssueDirectories(first, request.issueId);
    bytes = canonicalBytes(record); destination = join(first.directory, recordName(record.sequence));
    locator = { sequence: record.sequence, digest: digestBytes(bytes), path: `issues/${request.issueId}/direction/${recordName(record.sequence)}` };
    beforePublish();
    const last = inspect(args); lifecycle(last.run, request.runId, true);
    requireValue(equal(last.folded.head, request.expectedHead), 'stale_head');
    verifyReferences(request.operation, request.payload, last.proof);
    directories(last.directory);
    attempted = true; publish(destination, bytes);
    const after = inspect(args);
    requireValue(equal(after.records[record.sequence - 1], record), 'publication_not_verified');
    requireValue(after.runState === 'active', 'run_changed_after_publish');
    return { version: 1, status: 'published', reasons: [...after.notices], record: locator, state: view(after) };
  } catch (error) {
    if (attempted && destination) {
      try {
        const retained = load(dirname(destination), recordName(locator.sequence), LIMITS.recordBytes, { sensitive: false });
        if (retained === bytes) return { version: 1, status: 'publication_unknown', reasons: [reason(error)], record: locator, state: null };
        return { version: 1, status: 'refused', reasons: ['stale_head'], record: null, state: null };
      } catch {
        if (error.code === 'EEXIST') return { version: 1, status: 'publication_unknown', reasons: ['collision_unreadable'], record: null, state: null };
      }
    }
    return { version: 1, status: 'refused', reasons: [reason(error)], record: null, state: null };
  }
}

export function resolveDirectionPolicy({ cwd = process.cwd(), runId, overrides = {}, configSource = null } = {}) {
  requireValue(overrides && typeof overrides === 'object' && !Array.isArray(overrides)
    && Object.keys(overrides).every(key => ['mode', 'maxAuditAttempts'].includes(key)), 'invalid_overrides');
  const location = locate({ cwd, runId }); const configPath = join(location.main, '.afk', 'config.md');
  let bytes = null;
  try { lstatSync(configPath); bytes = load(join(location.main, '.afk'), 'config.md', LIMITS.evidenceBytes); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const parsed = readConfigSectionStrict(configPath, 'direction');
  requireValue(parsed.text.length === 0, 'invalid_policy');
  const rawMode = parsed.fields.mode || ''; const rawLimit = parsed.fields['max-audit-attempts'] || '';
  requireValue(!rawMode || ['off', 'shadow', 'required'].includes(rawMode), 'invalid_policy');
  requireValue(!rawLimit || /^\d+$/.test(rawLimit) && Number.isSafeInteger(Number(rawLimit)), 'invalid_policy');
  const values = { mode: rawMode || DEFAULT_POLICY.mode, maxAuditAttempts: rawLimit ? Number(rawLimit) : DEFAULT_POLICY.maxAuditAttempts };
  const configured = { mode: Boolean(rawMode), maxAuditAttempts: Boolean(rawLimit) }; const sources = {};
  for (const key of ['mode', 'maxAuditAttempts']) {
    if (Object.hasOwn(overrides, key)) {
      shape(overrides[key], ['value', 'source']); source(overrides[key].source, 'operator'); values[key] = overrides[key].value;
      const ref = overrides[key].source.evidence; requireValue(digestBytes(load(location.run, ref.path, LIMITS.evidenceBytes)) === ref.digest, 'evidence_digest_mismatch');
      sources[key] = { kind: 'operator', source: overrides[key].source };
    } else if (configured[key]) {
      source(configSource, 'config'); const ref = configSource.evidence;
      const retained = load(location.run, ref.path, LIMITS.evidenceBytes);
      requireValue(retained === bytes && digestBytes(retained) === ref.digest, 'config_source_mismatch');
      sources[key] = { kind: 'config', source: configSource };
    } else sources[key] = { kind: 'built-in', source: null };
  }
  if (bytes !== null) requireValue(load(join(location.main, '.afk'), 'config.md', LIMITS.evidenceBytes) === bytes, 'config_changed');
  else {
    try { lstatSync(configPath); requireValue(false, 'config_changed'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return validatePolicy({ version: 1, revision: 1, previousDigest: null, ...values, sources, amendment: null });
}

export function loadDirectionInput({ cwd = process.cwd(), path, runId } = {}) {
  requireValue(typeof path === 'string' && Boolean(path), 'input_path_required');
  const found = roots(cwd); const root = runId ? locate({ cwd, runId }).run : found.runs;
  const absolute = resolve(cwd, path); const name = relative(root, absolute).split(sep).join('/');
  requireValue(!isAbsolute(name) && name !== '..' && !name.startsWith('../'), 'input_outside_run');
  const value = json(load(root, name, LIMITS.recordBytes, { sensitive: false }));
  if (!runId) {
    validateRequest(value);
    requireValue(name.startsWith(`${value.runId}/`), 'input_wrong_run');
  }
  return value;
}
