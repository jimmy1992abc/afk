import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { defaultConfig } from '../../scripts/supervisor/config.mjs';
import { handleHook } from '../../scripts/supervisor/hook-handler.mjs';
import { renderSupervisorLedgerBlock } from '../../scripts/supervisor/ledger.mjs';
import { StateStore } from '../../scripts/supervisor/state-store.mjs';

const now = 10_000;
const sessionId = '00000000-0000-4000-8000-000000000001';

async function harness(metadata = {}) {
  const root = await mkdtemp(join(tmpdir(), 'afk-supervisor-hooks-'));
  const cwd = join(root, 'repo');
  await mkdir(join(cwd, '.afk'), { recursive: true });
  const base = {
    schemaVersion: 1, runId: 'run-1', sessionId, state: 'RUNNING',
    heartbeatAt: now - 10, nextExpectedTickAt: now + 890, unfinished: true,
    ...metadata,
  };
  await writeFile(join(cwd, '.afk', 'afk-ledger.md'), renderSupervisorLedgerBlock(base), 'utf8');
  const store = new StateStore(join(root, 'global'));
  const spawnCalls = [];
  return {
    root, cwd, store, spawnCalls,
    deps: {
      store,
      config: defaultConfig(),
      now: () => now,
      spawn: (...args) => spawnCalls.push(args),
      readFile: async (path) => (await import('node:fs/promises')).readFile(path, 'utf8'),
    },
  };
}

function sessionStart(cwd) {
  return { hook_event_name: 'SessionStart', session_id: sessionId, cwd, transcript_path: 'ignored' };
}

test('SessionStart reconstructs only recent explicit unfinished runs', async () => {
  const active = await harness();
  assert.equal((await handleHook(sessionStart(active.cwd), active.deps)).code, 'action:run-reconstructed');
  assert.equal((await active.store.read()).runs['run-1'].state, 'RUNNING');
  assert.equal(active.spawnCalls.length, 0);

  const completed = await harness({ state: 'COMPLETED' });
  assert.equal((await handleHook(sessionStart(completed.cwd), completed.deps)).code, 'skip:ledger-not-recoverable');
  const old = await harness({ heartbeatAt: now - defaultConfig().registrationRecoveryMaxAgeSeconds - 1 });
  assert.equal((await handleHook(sessionStart(old.cwd), old.deps)).code, 'skip:ledger-stale');
});

test('SessionStart from supervisor resume updates metadata but never spawns', async () => {
  const active = await harness();
  await active.store.update((state) => ({
    ...state,
    runs: { 'run-1': { runId: 'run-1', sessionId, state: 'RUNNING', cwd: active.cwd } },
  }));
  const result = await handleHook({ ...sessionStart(active.cwd), source: 'resume' }, active.deps);
  assert.equal(result.code, 'action:run-reconciled');
  assert.equal(active.spawnCalls.length, 0);
});

test('a second session in the same repository marks the observation ambiguous', async () => {
  // The observation is keyed by cwd alone, so the second session simply overwrote the
  // first. Registration then resolved the run to whichever session started last. Two
  // Claudes in one repository is an ordinary thing to do, and it silently bound the
  // run to the wrong conversation.
  const active = await harness();
  await handleHook(sessionStart(active.cwd), active.deps);
  assert.equal((await active.store.read()).sessions[active.cwd].ambiguous, false);

  const other = { ...sessionStart(active.cwd), session_id: '00000000-0000-4000-8000-0000000000ff' };
  await handleHook(other, active.deps);
  const observed = (await active.store.read()).sessions[active.cwd];
  assert.equal(observed.ambiguous, true, 'two sessions in one repository cannot be told apart by cwd');

  // ...and it stays ambiguous while the first session may still be there. Comparing
  // only against the PREVIOUS observation forgets it the moment the same session
  // ticks twice in a row — and the run is then quietly bound to it, with the other
  // session still open in the same repository.
  await handleHook(other, active.deps);
  assert.equal((await active.store.read()).sessions[active.cwd].ambiguous, true,
    'a repeated observation is not evidence that the other session went away');

  await handleHook(sessionStart(active.cwd), active.deps);
  assert.equal((await active.store.read()).sessions[active.cwd].ambiguous, true);
});

test('rate-limit StopFailure records upper bound without spawning', async () => {
  const active = await harness();
  await handleHook(sessionStart(active.cwd), active.deps);
  const result = await handleHook({
    hook_event_name: 'StopFailure', session_id: sessionId, cwd: active.cwd,
    transcript_path: 'ignored', error: 'rate_limit', error_details: '429',
  }, active.deps);
  const run = (await active.store.read()).runs['run-1'];
  assert.equal(result.code, 'result:quota-rescheduled');
  assert.equal(run.state, 'RATE_LIMITED');
  assert.equal(run.firstRateLimitedAt, now);
  assert.equal(run.rateLimitedUntil, now + 18_000);
  assert.equal(active.spawnCalls.length, 0);
});

test('a rescheduled run stops calling itself a quota backoff', async () => {
  // The hook rebuilt the schedule inline instead of asking the one scheduler for
  // it, and forgot `scheduleSource`. A run that had escalated to a 24-hour quota
  // backoff kept that source while carrying an ordinary reset schedule — so the
  // next new window, whose headroom un-parks quota-backoff runs, un-parked a run
  // that was merely waiting for its reset.
  const active = await harness();
  await handleHook(sessionStart(active.cwd), active.deps);
  await active.store.update((state) => {
    state.runs['run-1'].scheduleSource = 'quota-backoff';
    return state;
  });
  await handleHook({
    hook_event_name: 'StopFailure', session_id: sessionId, cwd: active.cwd,
    transcript_path: 'ignored', error: 'rate_limit', error_details: '429',
  }, active.deps);
  assert.equal((await active.store.read()).runs['run-1'].scheduleSource, 'reset');
});

test('a StopFailure never schedules a resume in the past', async () => {
  // The run carries a firstRateLimitedAt from an earlier limit episode that the
  // supervisor never finalized — the in-session tick recovered it instead. The
  // hook must not derive this window's reset from that stale timestamp.
  const active = await harness();
  await handleHook(sessionStart(active.cwd), active.deps);
  await active.store.update((state) => {
    state.runs['run-1'].firstRateLimitedAt = now - 6 * 3_600;
    return state;
  });
  await handleHook({
    hook_event_name: 'StopFailure', session_id: sessionId, cwd: active.cwd, error: 'rate_limit',
  }, active.deps);
  const run = (await active.store.read()).runs['run-1'];
  assert.ok(run.rateLimitedUntil > now, `rateLimitedUntil ${run.rateLimitedUntil} must not be in the past`);
  assert.ok(run.scheduledResumeAt > now, `scheduledResumeAt ${run.scheduledResumeAt} must not be in the past`);
});

test('one quota event is not counted twice toward escalation', async () => {
  // The supervisor's own --resume runs with hooks enabled, so a single quota
  // rejection reaches both the StopFailure hook and the runner's stream
  // classifier. Counting it in both places escalates to a 24-hour backoff after
  // two real rejections instead of three.
  const active = await harness();
  await handleHook(sessionStart(active.cwd), active.deps);
  await handleHook({
    hook_event_name: 'StopFailure', session_id: sessionId, cwd: active.cwd, error: 'rate_limit',
  }, active.deps);
  const run = (await active.store.read()).runs['run-1'];
  assert.equal(run.quotaRejections.consecutive, 0,
    'the runner owns the probe-rejection counter; the hook must not also increment it');
});

test('a stop failure that is not a rate limit never parks the run', async () => {
  const active = await harness();
  await handleHook(sessionStart(active.cwd), active.deps);
  const result = await handleHook({
    hook_event_name: 'StopFailure', session_id: sessionId, cwd: active.cwd, error: 'server_error',
  }, active.deps);
  assert.equal(result.code, 'skip:hook-event-ignored');
  assert.equal((await active.store.read()).runs['run-1'].state, 'RUNNING',
    'a crash or an overload must not park the run rate-limited for five hours');
});

test('a rate limit never resurrects a finished run', async () => {
  // The operator keeps using the session interactively after the run completes.
  // A rate limit there would otherwise park the finished run RATE_LIMITED and
  // have the supervisor fire `claude --resume` at a session a human is using.
  const active = await harness();
  await handleHook(sessionStart(active.cwd), active.deps);
  await active.store.update((state) => {
    state.runs['run-1'].state = 'COMPLETED';
    return state;
  });
  const result = await handleHook({
    hook_event_name: 'StopFailure', session_id: sessionId, cwd: active.cwd, error: 'rate_limit',
  }, active.deps);
  assert.equal(result.code, 'skip:run-not-registered');
  assert.equal((await active.store.read()).runs['run-1'].state, 'COMPLETED');
});

test('SessionStart refuses a working directory that is not absolute', async () => {
  const active = await harness();
  const result = await handleHook({ hook_event_name: 'SessionStart', session_id: sessionId, cwd: 'relative/path' }, active.deps);
  assert.equal(result.code, 'skip:cwd-invalid');
});

test('a session never adopts another session ledger', async () => {
  const other = await harness({ sessionId: '00000000-0000-4000-8000-00000000000f' });
  assert.equal((await handleHook(sessionStart(other.cwd), other.deps)).code, 'skip:ledger-not-recoverable');
  assert.equal((await other.store.read()).runs['run-1'], undefined);
});

test('unrelated hook event and unregistered failure have distinct skips', async () => {
  const active = await harness();
  assert.equal((await handleHook({ hook_event_name: 'Stop' }, active.deps)).code, 'skip:hook-event-ignored');
  assert.equal((await handleHook({ hook_event_name: 'StopFailure', error: 'rate_limit', session_id: sessionId }, active.deps)).code, 'skip:run-not-registered');
});
