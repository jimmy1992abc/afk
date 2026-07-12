const START = '<!-- afk-supervisor';
const END = '-->';
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOVERABLE = new Set(['RUNNING', 'RATE_LIMITED', 'RECOVERY_DUE', 'RECOVERING', 'FAILED']);

function validMetadata(value) {
  return value?.schemaVersion === 1
    && RUN_ID.test(value.runId ?? '')
    && SESSION_ID.test(value.sessionId ?? '')
    && RECOVERABLE.has(value.state)
    && Number.isFinite(value.heartbeatAt)
    && (value.nextExpectedTickAt === null || Number.isFinite(value.nextExpectedTickAt))
    && value.unfinished === true;
}

export function renderSupervisorLedgerBlock(metadata) {
  return `${START}\n${JSON.stringify(metadata)}\n${END}`;
}

export function parseSupervisorLedger(text) {
  if (typeof text !== 'string') return null;
  const starts = [...text.matchAll(/<!-- afk-supervisor/g)];
  if (starts.length !== 1) return null;
  const start = starts[0].index + START.length;
  const end = text.indexOf(END, start);
  if (end < 0) return null;
  let metadata;
  try { metadata = JSON.parse(text.slice(start, end).trim()); } catch { return null; }
  return validMetadata(metadata) ? metadata : null;
}

export async function readLedgerHeartbeatFile(path, runId, sessionId) {
  let metadata;
  try { metadata = parseSupervisorLedger(await readFile(path, 'utf8')); } catch { return null; }
  return metadata?.runId === runId && metadata?.sessionId === sessionId ? metadata.heartbeatAt : null;
}
import { readFile } from 'node:fs/promises';
