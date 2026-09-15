import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonicalBytes, digestBytes } from '../lib/gate/review-receipt.mjs';
import { appendDirectionRecord } from '../lib/direction/state.mjs';
import { requireValue, shape, text, identifier, evidenceRef, equal, contentDigest } from '../lib/direction/schema.mjs';
import { LIMITS, CANDIDATE, prepareAudit, loadPrepared, readJson, readArtifact, directories, publish,
  terminalRequest, qualificationEvidence, profileFingerprint, readResult, exists } from '../lib/direction/audit.mjs';
import { recordExchange } from '../lib/direction/transport.mjs';
import { initializeFixture, FIXTURE_ROOT } from './fixtures/direction-transport/setup.mjs';

export { LIMITS, CANDIDATE };
const SELF = fileURLToPath(import.meta.url);
const HARNESS = [SELF, join(FIXTURE_ROOT, 'setup.mjs')];
const FIXTURE_FILES = ['requirements.md', 'artifact.mjs', 'check.txt', 'expected.json'];
const PRIOR_ELAPSED_MS = 1900;
const AMENDMENT_DIRECTORY = 'budget-amendment';
const AMENDMENT_FILE = 'amendment.json';
const AMENDMENT_PATH = `${AMENDMENT_DIRECTORY}/${AMENDMENT_FILE}`;
function effectiveBudget(amendment = null) {
  if (amendment === null) return { priorCalls: 1, priorElapsedMs: PRIOR_ELAPSED_MS,
    remainingCalls: 1, remainingMs: LIMITS.totalMs - PRIOR_ELAPSED_MS };
  shape(amendment, ['version', 'physicalCallId', 'authorization', 'history', 'priorAttempts', 'priorRequests', 'priorElapsedMs', 'additionalAttempts']);
  requireValue(amendment.version === 1 && amendment.additionalAttempts === 1, 'qualification_budget');
  identifier(amendment.physicalCallId); evidenceRef(amendment.authorization); evidenceRef(amendment.history);
  for (const value of [amendment.priorAttempts, amendment.priorRequests, amendment.priorElapsedMs]) {
    requireValue(Number.isSafeInteger(value) && value >= 0, 'qualification_budget');
  }
  requireValue(Number.isSafeInteger(amendment.priorAttempts + 1) && amendment.priorRequests <= amendment.priorAttempts, 'qualification_budget');
  const remainingMs = LIMITS.totalMs - amendment.priorElapsedMs;
  requireValue(remainingMs >= LIMITS.processMs, 'qualification_budget');
  return { priorCalls: amendment.priorAttempts, priorRequests: amendment.priorRequests, priorElapsedMs: amendment.priorElapsedMs,
    remainingCalls: 1, remainingMs, physicalCallId: amendment.physicalCallId, amendmentDigest: contentDigest(amendment) };
}
function readAmendment(root, path) {
  const amendment = readJson(root, path, { maxBytes: LIMITS.requestBytes }); const budget = effectiveBudget(amendment);
  const sources = new Map();
  for (const ref of [amendment.authorization, amendment.history]) {
    requireValue(ref.path !== AMENDMENT_FILE, 'output_exists');
    const bytes = readArtifact(root, ref.path, { sensitive: true, maxBytes: LIMITS.requestBytes }); text(bytes);
    requireValue(digestBytes(bytes) === ref.digest, 'qualification_source_digest'); sources.set(ref.path, bytes);
  }
  return { amendment, budget, sources };
}
function harnessDigest() { return contentDigest(HARNESS.map(path => ({ path: path === SELF ? 'qualifier' : 'fixture-setup', digest: digestBytes(readFileSync(path)) }))); }
function command(binary, args, cwd) {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: LIMITS.responseBytes,
    env: { PATH: process.env.PATH || '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  requireValue(result.status === 0 && !result.error && !result.signal, 'fixture_command_failed'); return result.stdout;
}
export function prepare({ fixtureRoot = FIXTURE_ROOT, out, budgetAmendmentPath }) {
  const amendmentPath = budgetAmendmentPath === undefined ? null : resolve(budgetAmendmentPath);
  const amendment = amendmentPath === null ? null : readAmendment(dirname(amendmentPath), basename(amendmentPath));
  const absolute = resolve(out); directories(dirname(absolute));
  const files = Object.fromEntries(FIXTURE_FILES.map(path => [path, readArtifact(fixtureRoot, path, { sensitive: true, maxBytes: LIMITS.requestBytes })]));
  const expected = JSON.parse(files['expected.json']); validateOracle(expected);
  mkdirSync(absolute, { mode: 0o700 }); const cwd = join(absolute, 'subject'); mkdirSync(cwd, { mode: 0o700 });
  writeFileSync(join(cwd, 'artifact.mjs'), files['artifact.mjs']);
  command('git', ['init', '-q', '-b', 'main'], cwd);
  command('git', ['add', 'artifact.mjs'], cwd);
  command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic candidate'], cwd);
  const checked = command(process.execPath, ['--input-type=module', '-e',
    "import assert from 'node:assert/strict'; const { combine } = await import('./artifact.mjs'); assert.equal(combine(2,3),5); assert.equal(combine(-2,3),1); assert.equal(combine(0,0),0); process.stdout.write('PASS combine(2, 3) = 5; combine(-2, 3) = 1; combine(0, 0) = 0.\\n');"], cwd);
  requireValue(checked === files['check.txt'], 'fixture_check_mismatch');
  const fixture = initializeFixture({ cwd, sourceRoot: fixtureRoot });
  const prepared = prepareAudit({ ...fixture, input: fixture.input });
  requireValue(prepared.status === 'prepared', 'fixture_prepare_failed');
  publish(absolute, 'expected.json', expected);
  directories(join(absolute, 'fixture'), true);
  for (const path of FIXTURE_FILES) publish(join(absolute, 'fixture'), path, files[path], true);
  const metadata = { version: 1, cwd, runId: fixture.runId, issueId: fixture.issueId, auditId: fixture.input.auditId,
    profileDigest: profileFingerprint().digest, harnessDigest: harnessDigest(), fixtureDigests: FIXTURE_FILES.map(path => ({ path, digest: digestBytes(files[path]) })),
    expectedDigest: contentDigest(expected), packetDigest: prepared.packet.digest, requestDigest: prepared.request.digest,
    qualification: 'NOT_RUN', budget: amendment?.budget ?? effectiveBudget() };
  if (amendment) {
    const root = join(absolute, AMENDMENT_DIRECTORY); directories(root, true);
    for (const [path, bytes] of amendment.sources) { directories(dirname(join(root, path)), true); publish(root, path, bytes, true); }
    metadata.budgetAmendment = publish(absolute, AMENDMENT_PATH, amendment.amendment);
  }
  publish(absolute, 'prepared.json', metadata); return metadata;
}
function validateOracle(expected) {
  shape(expected, ['version', 'phase', 'outcome', 'sourceId', 'sourceLine', 'sourceMarker', 'artifactId', 'checkId']);
  requireValue(expected.version === 1 && expected.phase === 'endpoint' && expected.outcome === 'COMPLETE'
    && Number.isSafeInteger(expected.sourceLine) && expected.sourceLine > 0, 'oracle_schema');
  for (const key of ['sourceId', 'artifactId', 'checkId']) identifier(expected[key]); text(expected.sourceMarker);
}
export function inspectPrepared(prepared) {
  const metadata = readJson(prepared, 'prepared.json');
  shape(metadata, ['version', 'cwd', 'runId', 'issueId', 'auditId', 'profileDigest', 'harnessDigest', 'fixtureDigests',
    'expectedDigest', 'packetDigest', 'requestDigest', 'qualification', 'budget',
    ...(Object.hasOwn(metadata, 'budgetAmendment') ? ['budgetAmendment'] : [])]);
  requireValue(metadata.version === 1 && metadata.qualification === 'NOT_RUN' && metadata.harnessDigest === harnessDigest()
    && metadata.profileDigest === profileFingerprint().digest, 'qualification_preparation_stale');
  let budget = effectiveBudget();
  if (Object.hasOwn(metadata, 'budgetAmendment')) {
    evidenceRef(metadata.budgetAmendment); requireValue(metadata.budgetAmendment.path === AMENDMENT_PATH, 'qualification_budget');
    const retained = readAmendment(join(resolve(prepared), AMENDMENT_DIRECTORY), AMENDMENT_FILE);
    requireValue(contentDigest(retained.amendment) === metadata.budgetAmendment.digest, 'qualification_amendment_digest'); budget = retained.budget;
  }
  requireValue(metadata.cwd === join(resolve(prepared), 'subject') && equal(metadata.budget, budget), 'qualification_budget');
  const input = loadPrepared(metadata);
  requireValue(contentDigest(input.packet) === metadata.packetDigest && input.preparation.requestDigest === metadata.requestDigest, 'qualification_binding');
  const expected = readJson(prepared, 'expected.json'); validateOracle(expected);
  requireValue(contentDigest(expected) === metadata.expectedDigest, 'oracle_digest');
  requireValue(Array.isArray(metadata.fixtureDigests) && equal(metadata.fixtureDigests.map(x => x.path), FIXTURE_FILES), 'fixture_inventory');
  const retained = Object.fromEntries(metadata.fixtureDigests.map(row => {
    shape(row, ['path', 'digest']); const bytes = readArtifact(join(prepared, 'fixture'), row.path, { sensitive: true, maxBytes: LIMITS.requestBytes });
    requireValue(digestBytes(bytes) === row.digest, 'fixture_digest'); return [row.path, bytes];
  }));
  requireValue(equal(JSON.parse(retained['expected.json']), expected)
    && input.packet.evidence.find(x => x.kind === 'source')?.content === retained['requirements.md']
    && input.packet.evidence.find(x => x.kind === 'artifact')?.content === retained['artifact.mjs']
    && input.packet.evidence.find(x => x.kind === 'check')?.content === retained['check.txt'], 'fixture_source_binding');
  return { metadata, input, expected };
}
export function inspectQualification(prepared) {
  const { metadata, input, expected } = inspectPrepared(prepared);
  const proof = qualificationEvidence(metadata); const result = readResult(input).result.payload;
  requireValue(result.phase === expected.phase && result.outcome === expected.outcome, 'fixture_judgment');
  requireValue(result.coverage.every(row => row.status === 'supported' && row.source.evidenceId === expected.sourceId
    && row.source.startLine <= expected.sourceLine && row.source.endLine >= expected.sourceLine && row.source.quote.includes(expected.sourceMarker)
    && row.artifacts.some(a => a.evidenceId === expected.artifactId) && row.artifacts.some(a => a.evidenceId === expected.checkId)), 'source_delivery_challenge');
  return { version: 1, status: 'ARTIFACT_CANDIDATE_PASS', proof, actualInvocation: 'DRIVER_JUDGMENT_REQUIRED',
    harnessDigest: metadata.harnessDigest, preparedDigest: contentDigest(metadata) };
}
export function budgetRequest(prepared, physicalCallId) {
  identifier(physicalCallId); const { metadata } = inspectPrepared(prepared);
  const prior = metadata.budget; const amended = Object.hasOwn(metadata, 'budgetAmendment');
  if (amended) requireValue(physicalCallId === prior.physicalCallId, 'qualification_budget');
  return { version: 1, physicalCallId, attemptOrdinal: prior.priorCalls + 1, priorCalls: prior.priorCalls, priorElapsedMs: prior.priorElapsedMs,
    remainingMs: prior.remainingMs, processMs: LIMITS.processMs, preparedDigest: contentDigest(metadata),
    profileDigest: metadata.profileDigest, ...(amended ? { priorRequests: prior.priorRequests, amendmentDigest: prior.amendmentDigest } : {}) };
}
export async function probe({ prepared, budget, env = {}, fetchImpl = globalThis.fetch, httpTimeoutMs = LIMITS.httpTimeoutMs }) {
  const { metadata, input } = inspectPrepared(prepared);
  requireValue(equal(budget, budgetRequest(prepared, budget?.physicalCallId)), 'qualification_budget');
  for (const name of ['budget.json', 'terminal.json']) requireValue(!exists(join(prepared, name)), 'output_exists');
  for (const name of ['dispatch.json', 'response.json', 'result.json', 'terminal-witness.txt']) requireValue(!exists(join(input.directory, name)), 'output_exists');
  publish(prepared, 'budget.json', budget);
  const request = readJson(input.directory, 'reserve-request.json');
  const reservation = appendDirectionRecord({ cwd: metadata.cwd, request });
  requireValue(reservation.status === 'published', 'reservation_not_fresh');
  const started = Date.now();
  const result = await recordExchange({ ...metadata, env, fetchImpl, httpTimeoutMs });
  const terminal = terminalRequest({ ...metadata, operationId: `${metadata.auditId}-terminal` });
  const recorded = appendDirectionRecord({ cwd: metadata.cwd, request: terminal });
  requireValue(recorded.status === 'published', 'terminal_not_published');
  let evidence = null; let reason = result.reason;
  try { evidence = inspectQualification(prepared); } catch (error) { reason = error.code || 'qualification_invalid'; }
  const elapsedMs = Date.now() - started;
  const passed = evidence !== null && elapsedMs <= LIMITS.processMs && elapsedMs <= budget.remainingMs;
  const output = { version: 1, classification: passed ? 'CANDIDATE-PASS' : 'INVALID', exitCode: passed ? 0 : 1,
    reason: passed ? 'final_protocol_artifacts_passed' : elapsedMs > LIMITS.processMs ? 'qualification_time_limit' : reason,
    elapsedMs, physicalCallId: budget.physicalCallId, experimentAttempt: budget.attemptOrdinal, directionAttempt: metadata.auditId,
    requests: result.requests, evidence, qualification: 'NOT_QUALIFIED_BY_HELPER',
    actualInvocation: 'DRIVER_JUDGMENT_REQUIRED', runtimeCarryforward: 'EXACT_PROFILE_REQUIRED' };
  publish(prepared, 'terminal.json', output); return output;
}
function argumentsFor(argv) {
  const [operation, ...args] = argv;
  const required = operation === 'prepare' ? ['--fixture-root', '--out'] : operation === 'probe' ? ['--prepared', '--budget'] : [];
  const expected = operation === 'prepare' ? [...required, '--budget-amendment'] : required;
  requireValue(required.length && args.length % 2 === 0, 'invalid_arguments'); const options = {};
  for (let i = 0; i < args.length; i += 2) {
    requireValue(expected.includes(args[i]) && !Object.hasOwn(options, args[i]) && args[i + 1] && !args[i + 1].startsWith('--'), 'invalid_arguments'); options[args[i]] = args[i + 1];
  }
  requireValue(required.every(key => Object.hasOwn(options, key)), 'invalid_arguments');
  return { operation, options };
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  try {
    const { operation, options } = argumentsFor(process.argv.slice(2));
    const result = operation === 'prepare' ? prepare({ fixtureRoot: options['--fixture-root'], out: options['--out'], budgetAmendmentPath: options['--budget-amendment'] })
      : await probe({ prepared: options['--prepared'], budget: readJson(dirname(resolve(options['--budget'])), options['--budget'].split('/').at(-1)), env: process.env });
    process.stdout.write(canonicalBytes(result)); process.exitCode = result.exitCode || 0;
  } catch (error) {
    process.stdout.write(canonicalBytes({ version: 1, classification: 'INVALID', reason: error.code || 'qualification_unavailable' })); process.exitCode = 1;
  }
}
