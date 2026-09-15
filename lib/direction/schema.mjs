import { canonicalBytes, digestBytes } from '../gate/review-receipt.mjs';
import { isExcluded, redactCredential } from '../secret.mjs';
import { byteLength } from '../text-budget.mjs';

export const LIMITS = Object.freeze({ recordBytes: 100000, evidenceBytes: 100000, auditPacketBytes: 262144, sequenceBytes: 4194304, records: 4096 });
export const DEFAULT_POLICY = Object.freeze({ mode: 'off', maxAuditAttempts: null });
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HEX = /^[a-f0-9]{64}$/;
const MODES = ['off', 'shadow', 'required'];
const CLAUSES = ['outcomes', 'acceptance', 'invariants', 'nonGoals', 'priorities', 'allowedChanges', 'publicationLimits'];
const OPERATIONS = ['initialize', 'baseline', 'policy', 'reserve', 'terminal', 'reconcile'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function requireValue(ok, code) { if (!ok) throw Object.assign(new Error(code), { code }); }
export function shape(value, keys) {
  requireValue(plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'invalid_schema');
}
export function text(value) {
  requireValue(typeof value === 'string' && Boolean(value.trim()) && !value.includes('\0'), 'invalid_text');
  requireValue(!redactCredential(value, '').count, 'sensitive_metadata');
}
export function identifier(value) { text(value); requireValue(ID.test(value), 'invalid_identifier'); }
function digest(value) { requireValue(typeof value === 'string' && HEX.test(value), 'invalid_digest'); }
function integer(value, min = 0) { requireValue(Number.isSafeInteger(value) && value >= min, 'invalid_integer'); }
function oneOf(value, values) { requireValue(values.includes(value), 'invalid_enum'); }
function list(value, min = 0) { requireValue(Array.isArray(value) && value.length >= min, 'invalid_array'); }
export const equal = (a, b) => canonicalBytes(a) === canonicalBytes(b);
export const contentDigest = value => digestBytes(canonicalBytes(value));
export const recordName = sequence => `${String(sequence).padStart(6, '0')}.json`;
export function pathName(value) {
  text(value);
  requireValue(!value.includes('\\') && !value.includes(':') && !value.startsWith('/')
    && value.split('/').every(x => x && x !== '.' && x !== '..') && !isExcluded(value), 'invalid_path');
}
export function evidenceRef(value) { shape(value, ['path', 'digest']); pathName(value.path); digest(value.digest); }
export function source(value, kind = null) {
  shape(value, ['id', 'kind', 'origin', 'evidence']); identifier(value.id);
  oneOf(value.kind, ['operator', 'issue', 'repository', 'config']);
  if (kind) requireValue(value.kind === kind, 'invalid_source_kind');
  text(value.origin); evidenceRef(value.evidence);
}
function evidenceList(value, min = 0) { list(value, min); value.forEach(evidenceRef); }
function revision(value) { requireValue(value.version === 1, 'unsupported_version'); integer(value.revision, 1); if (value.previousDigest !== null) digest(value.previousDigest); }
function anchors(value, sources, min) {
  list(value, min);
  for (const anchor of value) {
    shape(anchor, ['sourceId', 'startLine', 'endLine']); identifier(anchor.sourceId);
    integer(anchor.startLine, 1); integer(anchor.endLine, anchor.startLine);
    requireValue(sources.has(anchor.sourceId), 'unknown_source');
  }
}
export function validateBaseline(value) {
  shape(value, ['version', 'revision', 'previousDigest', 'change', 'sources', ...CLAUSES, 'assumptions', 'facts']); revision(value);
  shape(value.change, ['kind', 'reason', 'evidence', 'authorization']);
  oneOf(value.change.kind, ['extraction', 'clarification', 'intent-change']); text(value.change.reason);
  evidenceList(value.change.evidence, value.change.kind === 'clarification' ? 1 : 0);
  if (value.change.kind === 'intent-change') source(value.change.authorization, 'operator');
  else requireValue(value.change.authorization === null, 'unexpected_authorization');
  list(value.sources, 1); const sources = new Map();
  for (const item of value.sources) { source(item); requireValue(!sources.has(item.id), 'duplicate_source'); sources.set(item.id, item); }
  const ids = new Set();
  const itemId = item => { identifier(item.id); requireValue(!ids.has(item.id), 'duplicate_baseline_id'); ids.add(item.id); text(item.text); };
  for (const field of CLAUSES) {
    list(value[field], ['outcomes', 'acceptance'].includes(field) ? 1 : 0);
    for (const item of value[field]) { shape(item, ['id', 'text', 'sources']); itemId(item); anchors(item.sources, sources, 1); }
  }
  list(value.assumptions); list(value.facts);
  for (const item of value.assumptions) {
    shape(item, ['id', 'text', 'kind', 'status', 'sources']); itemId(item);
    oneOf(item.kind, ['technical', 'product-decision']); oneOf(item.status, ['open', 'resolved']);
    anchors(item.sources, sources, item.status === 'resolved' ? 1 : 0);
  }
  for (const item of value.facts) { shape(item, ['id', 'text', 'sources']); itemId(item); anchors(item.sources, sources, 1); }
  requireValue(byteLength(canonicalBytes(value)) <= LIMITS.recordBytes, 'record_limit');
  return value;
}
export function validatePolicy(value) {
  shape(value, ['version', 'revision', 'previousDigest', 'mode', 'maxAuditAttempts', 'sources', 'amendment']); revision(value);
  oneOf(value.mode, MODES);
  if (value.maxAuditAttempts !== null) integer(value.maxAuditAttempts);
  shape(value.sources, ['mode', 'maxAuditAttempts']);
  for (const field of ['mode', 'maxAuditAttempts']) {
    const item = value.sources[field]; shape(item, ['kind', 'source']); oneOf(item.kind, ['built-in', 'config', 'operator']);
    if (item.kind === 'built-in') {
      // Retained version-1 policies must keep their original finite default.
      const historicalDefault = field === 'maxAuditAttempts' && value[field] === 4;
      requireValue(item.source === null && (value[field] === DEFAULT_POLICY[field] || historicalDefault), 'invalid_builtin_source');
    } else source(item.source, item.kind);
  }
  if (value.amendment !== null) {
    shape(value.amendment, ['reason', 'authorization']); text(value.amendment.reason); source(value.amendment.authorization, 'operator');
  }
  return value;
}
function accounting(value) {
  shape(value, ['knowledge', 'priorAttempts', 'reason', 'evidence']); oneOf(value.knowledge, ['known', 'unknown']);
  text(value.reason); evidenceList(value.evidence, 1); list(value.priorAttempts); const ids = new Set();
  for (const item of value.priorAttempts) {
    shape(item, ['id', 'evidence']); identifier(item.id); evidenceList(item.evidence, 1);
    requireValue(!ids.has(item.id), 'duplicate_attempt'); ids.add(item.id);
  }
}
function binding(value) {
  shape(value, ['phase', 'baselineDigest', 'policyDigest', 'targetDigest', 'packet']);
  oneOf(value.phase, ['initial', 'endpoint', 'signal']);
  for (const key of ['baselineDigest', 'policyDigest', 'targetDigest']) digest(value[key]);
  evidenceRef(value.packet);
}
function terminal(value) {
  shape(value, ['attemptId', 'kind', 'dispatch', 'exitCode', 'reason', 'evidence', 'result']);
  identifier(value.attemptId); oneOf(value.kind, ['result', 'error', 'timeout', 'unavailable', 'malformed', 'interrupted']);
  oneOf(value.dispatch, ['started', 'not-started', 'unknown']);
  requireValue(value.exitCode === null || Number.isSafeInteger(value.exitCode), 'invalid_exit');
  text(value.reason); evidenceList(value.evidence, 1);
  if (value.kind === 'result') {
    evidenceRef(value.result); requireValue(value.dispatch === 'started' && [null, 0].includes(value.exitCode), 'contradictory_terminal');
  } else requireValue(value.result === null, 'unexpected_result');
  if (value.kind === 'interrupted') requireValue(value.exitCode !== 0, 'contradictory_terminal');
}
function payload(operation, value) {
  oneOf(operation, OPERATIONS);
  const fields = { initialize: ['baseline', 'policy', 'authorization', 'accounting'], baseline: ['baseline'], policy: ['policy'],
    reserve: ['attemptId', 'binding'], terminal: ['terminal'], reconcile: ['accounting'] };
  shape(value, fields[operation]);
  if (Object.hasOwn(value, 'baseline')) validateBaseline(value.baseline);
  if (Object.hasOwn(value, 'policy')) validatePolicy(value.policy);
  if (Object.hasOwn(value, 'accounting')) accounting(value.accounting);
  if (operation === 'initialize') source(value.authorization, 'operator');
  if (operation === 'reserve') { identifier(value.attemptId); binding(value.binding); }
  if (operation === 'terminal') terminal(value.terminal);
}
export function validateHead(value) {
  shape(value, ['sequence', 'digest']); integer(value.sequence);
  if (value.sequence === 0) requireValue(value.digest === null, 'invalid_head'); else digest(value.digest);
}
export function validateExpected(value) {
  shape(value, ['head', 'baselineDigest', 'policyDigest']); validateHead(value.head);
  digest(value.baselineDigest); digest(value.policyDigest);
}
export function validateRequest(value) {
  shape(value, ['version', 'runId', 'issueId', 'operationId', 'expectedHead', 'operation', 'payload']);
  requireValue(value.version === 1, 'unsupported_version');
  for (const key of ['runId', 'issueId', 'operationId']) identifier(value[key]);
  validateHead(value.expectedHead); payload(value.operation, value.payload);
  requireValue(byteLength(canonicalBytes(value)) <= LIMITS.recordBytes, 'record_limit');
}
function validateRecord(value) {
  shape(value, ['version', 'runId', 'issueId', 'sequence', 'previousDigest', 'operationId', 'recordedAt', 'operation', 'payload']);
  requireValue(value.version === 1, 'unsupported_version');
  for (const key of ['runId', 'issueId', 'operationId']) identifier(value[key]);
  integer(value.sequence, 1); if (value.previousDigest !== null) digest(value.previousDigest);
  requireValue(typeof value.recordedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.recordedAt)
    && !Number.isNaN(Date.parse(value.recordedAt)) && new Date(value.recordedAt).toISOString() === value.recordedAt, 'invalid_time');
  payload(value.operation, value.payload);
  requireValue(byteLength(canonicalBytes(value)) <= LIMITS.recordBytes, 'record_limit');
}
function successor(next, prior) {
  requireValue(next.revision === prior.revision + 1 && next.previousDigest === contentDigest(prior), 'stale_revision');
}
function baselineTransition(next, prior) {
  successor(next, prior); requireValue(next.change.kind !== 'extraction', 'invalid_successor');
  if (next.change.kind === 'clarification') {
    for (const key of CLAUSES) requireValue(equal(next[key], prior[key]), 'clarification_changes_intent');
    requireValue(equal(next.assumptions.filter(x => x.kind === 'product-decision'), prior.assumptions.filter(x => x.kind === 'product-decision')), 'clarification_changes_intent');
    for (const old of prior.sources) requireValue(next.sources.some(x => equal(x, old)), 'clarification_changes_source');
  }
}
export function foldRecords(records) {
  requireValue(records.length <= LIMITS.records, 'record_count_limit');
  let bytes = 0; let head = { sequence: 0, digest: null }; let baseline = null; let policy = null; let history = null;
  const attempts = new Map(); const operations = new Map();
  for (const record of records) {
    validateRecord(record); bytes += byteLength(canonicalBytes(record)); requireValue(bytes <= LIMITS.sequenceBytes, 'sequence_limit');
    requireValue(record.sequence === head.sequence + 1 && record.previousDigest === head.digest, 'broken_sequence');
    requireValue(!operations.has(record.operationId), 'duplicate_operation');
    requireValue(record.runId === records[0].runId && record.issueId === records[0].issueId, 'wrong_identity');
    const p = record.payload; const recordDigest = contentDigest(record);
    const locator = { sequence: record.sequence, digest: recordDigest, path: `issues/${record.issueId}/direction/${recordName(record.sequence)}` };
    if (record.operation === 'initialize') {
      requireValue(record.sequence === 1, 'already_initialized');
      requireValue(p.baseline.revision === 1 && p.baseline.previousDigest === null && p.baseline.change.kind === 'extraction', 'invalid_initial_baseline');
      requireValue(p.policy.revision === 1 && p.policy.previousDigest === null && p.policy.amendment === null, 'invalid_initial_policy');
      baseline = p.baseline; policy = p.policy; history = p.accounting;
    } else {
      requireValue(baseline !== null, 'initialization_missing');
      if (record.operation === 'baseline') { baselineTransition(p.baseline, baseline); baseline = p.baseline; }
      else if (record.operation === 'policy') {
        successor(p.policy, policy); requireValue(p.policy.amendment !== null, 'amendment_source_required'); policy = p.policy;
      } else if (record.operation === 'reserve') {
        requireValue(history.knowledge === 'known', 'accounting_unknown'); requireValue(policy.mode !== 'off', 'direction_off');
        requireValue(policy.maxAuditAttempts === null || history.priorAttempts.length + attempts.size < policy.maxAuditAttempts, 'attempts_exhausted');
        requireValue(!attempts.has(p.attemptId) && !history.priorAttempts.some(x => x.id === p.attemptId), 'duplicate_attempt');
        requireValue(p.binding.baselineDigest === contentDigest(baseline) && p.binding.policyDigest === contentDigest(policy), 'stale_binding');
        attempts.set(p.attemptId, { id: p.attemptId, origin: 'reservation', reservation: locator, binding: p.binding, terminal: null });
      } else if (record.operation === 'terminal') {
        const attempt = attempts.get(p.terminal.attemptId); requireValue(attempt && attempt.terminal === null, 'terminal_conflict');
        attempt.terminal = { ...locator, value: p.terminal };
      } else if (record.operation === 'reconcile') {
        for (const old of history.priorAttempts) requireValue(p.accounting.priorAttempts.some(x => equal(x, old)), 'accounting_reduction');
        requireValue(p.accounting.priorAttempts.every(x => !attempts.has(x.id)), 'duplicate_attempt'); history = p.accounting;
      }
    }
    operations.set(record.operationId, record); head = { sequence: record.sequence, digest: recordDigest };
  }
  const prior = (history?.priorAttempts || []).map(x => ({ id: x.id, origin: 'prior', reservation: null, binding: null, terminal: null }));
  const charged = prior.length + attempts.size; const reserved = [...attempts.values()].filter(x => x.terminal === null).length;
  const count = history ? { knowledge: history.knowledge, charged, reserved,
    remaining: history.knowledge === 'known' && policy.maxAuditAttempts !== null ? Math.max(0, policy.maxAuditAttempts - charged) : null } : null;
  return { head, baseline, baselineDigest: baseline && contentDigest(baseline), policy, policyDigest: policy && contentDigest(policy),
    accounting: count, attempts: [...prior, ...attempts.values()], operations,
    canReserve: Boolean(policy && policy.mode !== 'off' && count.knowledge === 'known' && (policy.maxAuditAttempts === null || count.remaining > 0)) };
}

export function references(value, out = [], path = []) {
  if (Array.isArray(value)) for (const [index, item] of value.entries()) references(item, out, [...path, index]);
  else if (plain(value)) {
    if (equal(Object.keys(value).sort(), ['digest', 'path'])) { evidenceRef(value); out.push({ reference: value, path }); }
    else for (const [key, item] of Object.entries(value)) references(item, out, [...path, key]);
  }
  return out;
}

export function checkBaselineLines(baseline, load) {
  const sources = new Map(baseline.sources.map(item => [item.id, load(item.evidence).split('\n')]));
  for (const items of [...CLAUSES.map(key => baseline[key]), baseline.assumptions, baseline.facts]) {
    for (const item of items) for (const anchor of item.sources) {
      requireValue(anchor.endLine <= sources.get(anchor.sourceId).length, 'source_line_unavailable');
    }
  }
}
