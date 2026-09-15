import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalBytes, digestBytes } from '../../../lib/gate/review-receipt.mjs';
import { appendDirectionRecord } from '../../../lib/direction/state.mjs';
import { contentDigest, requireValue } from '../../../lib/direction/schema.mjs';
import { observeTarget } from '../../../lib/direction/audit.mjs';

export const FIXTURE_ROOT = dirname(fileURLToPath(import.meta.url));
export function initializeFixture({ cwd, runId = 'qualification', issueId = 'synthetic', auditId = 'final-protocol', sourceRoot = FIXTURE_ROOT }) {
  const run = join(cwd, '.afk', 'runs', runId); mkdirSync(run, { recursive: true });
  writeFileSync(join(cwd, '.git', 'info', 'exclude'), '.afk/\n');
  writeFileSync(join(run, 'ledger.md'), `run-id: ${runId}\nstate: active\nscope: synthetic qualification\n\n## Qualification\nNo previous synthetic direction calls.\n`);
  const content = readFileSync(join(sourceRoot, 'requirements.md'), 'utf8'); writeFileSync(join(run, 'source.md'), content);
  const reference = { path: 'source.md', digest: digestBytes(content) };
  const source = { id: 'request', kind: 'operator', origin: 'Synthetic qualification authorization', evidence: reference };
  const clause = id => ({ id, text: 'Combine returns the numeric sum.', sources: [{ sourceId: 'request', startLine: 3, endLine: 3 }] });
  const baseline = { version: 1, revision: 1, previousDigest: null,
    change: { kind: 'extraction', reason: 'Faithful synthetic extraction.', evidence: [], authorization: null }, sources: [source],
    outcomes: [clause('O1')], acceptance: [clause('A1')], invariants: [], nonGoals: [], priorities: [],
    allowedChanges: [], publicationLimits: [], assumptions: [], facts: [] };
  const policy = { version: 1, revision: 1, previousDigest: null, mode: 'required', maxAuditAttempts: 1,
    sources: { mode: { kind: 'operator', source }, maxAuditAttempts: { kind: 'operator', source } }, amendment: null };
  const initialized = appendDirectionRecord({ cwd, request: { version: 1, runId, issueId, operationId: 'initialize',
    expectedHead: { sequence: 0, digest: null }, operation: 'initialize', payload: { baseline, policy, authorization: source,
      accounting: { knowledge: 'known', priorAttempts: [], reason: 'No previous synthetic calls.', evidence: [reference] } } } });
  requireValue(initialized.status === 'published', initialized.reasons[0]);
  const target = { kind: 'commit', commit: observeTarget({ kind: 'uncommitted' }, cwd).currentHead };
  const targetDigest = contentDigest(observeTarget(target, cwd));
  const log = readFileSync(join(sourceRoot, 'check.txt'), 'utf8'); writeFileSync(join(run, 'check.txt'), log);
  const input = { version: 1, auditId, phase: 'endpoint', endpoint: { id: 'local-completion', source }, target,
    evidence: [{ id: 'request', kind: 'source', reference }, { id: 'implementation', kind: 'artifact', path: 'artifact.mjs' },
      { id: 'check', kind: 'check', reference: { path: 'check.txt', digest: digestBytes(log) }, targetDigest,
        command: 'node --input-type=module arithmetic assertions', exitCode: 0 }],
    coverage: ['O1', 'A1'].map(requirementId => ({ requirementId, evidenceIds: ['request', 'implementation', 'check'], note: 'Inspect the full sources.' })),
    history: { audits: [], findings: [], dispositions: [] }, authors: [{ family: 'openai', model: 'codex-astra', source }],
    nextAction: 'Finish the authorized local endpoint if source-grounded coverage is complete.' };
  writeFileSync(join(run, 'input.json'), canonicalBytes(input)); return { cwd, run, runId, issueId, input };
}
export function completeResult(packet) {
  const source = packet.evidence.find(x => x.kind === 'source'); const artifact = packet.evidence.find(x => x.kind === 'artifact');
  const check = packet.evidence.find(x => x.kind === 'check');
  const anchor = (e, line) => ({ evidenceId: e.id, startLine: line, endLine: line, quote: e.content.split('\n')[line - 1].trim() });
  return { version: 1, packetDigest: contentDigest(packet), phase: packet.phase, endpointId: packet.endpoint.id, targetDigest: packet.targetDigest,
    outcome: 'COMPLETE', coverage: packet.coverage.map(row => ({ requirementId: row.requirementId, status: 'supported',
      source: anchor(source, 3), artifacts: [anchor(artifact, 1), anchor(check, 1)], explanation: 'The implementation and retained check support the requirement.' })),
    findings: [], nextAction: 'Finish the authorized endpoint after the ordinary checks and review.' };
}
