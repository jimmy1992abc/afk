import assert from 'node:assert/strict';
import test from 'node:test';

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSupervisorLedger, readLedgerHeartbeatFile, renderSupervisorLedgerBlock } from '../../scripts/supervisor/ledger.mjs';

const metadata = {
  schemaVersion: 1,
  runId: 'run-20260712-001',
  sessionId: '00000000-0000-4000-8000-000000000001',
  state: 'RUNNING',
  heartbeatAt: 1_000,
  nextExpectedTickAt: 1_900,
  unfinished: true,
};

test('round trips an explicit supervisor metadata block', () => {
  const text = `# AFK ledger\n\n${renderSupervisorLedgerBlock(metadata)}\n\n- [ ] work`;
  assert.deepEqual(parseSupervisorLedger(text), metadata);
});

test('rejects terminal, finished, malformed, and duplicate blocks', () => {
  assert.equal(parseSupervisorLedger(renderSupervisorLedgerBlock({ ...metadata, state: 'COMPLETED' })), null);
  assert.equal(parseSupervisorLedger(renderSupervisorLedgerBlock({ ...metadata, unfinished: false })), null);
  assert.equal(parseSupervisorLedger('<!-- afk-supervisor\n{bad}\n-->'), null);
  const block = renderSupervisorLedgerBlock(metadata);
  assert.equal(parseSupervisorLedger(`${block}\n${block}`), null);
});

test('rejects invalid session and run identifiers', () => {
  assert.equal(parseSupervisorLedger(renderSupervisorLedgerBlock({ ...metadata, sessionId: 'bad' })), null);
  assert.equal(parseSupervisorLedger(renderSupervisorLedgerBlock({ ...metadata, runId: '../bad' })), null);
});

test('reads heartbeat only when file metadata matches the registered run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'afk-ledger-heartbeat-'));
  const path = join(root, 'ledger.md');
  await writeFile(path, renderSupervisorLedgerBlock(metadata), 'utf8');
  assert.equal(await readLedgerHeartbeatFile(path, metadata.runId, metadata.sessionId), metadata.heartbeatAt);
  assert.equal(await readLedgerHeartbeatFile(path, 'other', metadata.sessionId), null);
});
