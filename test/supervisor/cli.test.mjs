import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from '../../scripts/supervisor/config.mjs';
import { runCli } from '../../scripts/supervisor/cli.mjs';
import { defaultState } from '../../scripts/supervisor/state-store.mjs';

// Registration now refuses a path recovery could never use, and "absolute" is a
// question only the host can answer: C:\repo is not an absolute path on Linux.
const WIN = process.platform === 'win32';
const CWD = WIN ? String.raw`C:\repo` : '/repo';
const LEDGER = WIN ? String.raw`C:\repo\.afk\afk-ledger.md` : '/repo/.afk/afk-ledger.md';
const OUTSIDE = WIN ? String.raw`C:\other\afk-ledger.md` : '/other/afk-ledger.md';
const SESSION = '00000000-0000-4000-8000-000000000001';

function harness() {
  let config = defaultConfig();
  let state = defaultState();
  const calls = [];
  const deps = {
    configStore: { read: async () => config, write: async (next) => { config = next; return next; } },
    stateStore: { read: async () => structuredClone(state), update: async (fn) => { state = await fn(structuredClone(state)); state.revision += 1; return state; } },
    install: async () => { calls.push('install'); return { code: 'action:supervisor-installed' }; },
    preflight: async () => ({ claudePath: 'C:\\Tools\\claude.exe', authenticated: true }),
    uninstall: async () => { calls.push('uninstall'); return { code: 'action:supervisor-uninstalled' }; },
    repair: async () => { calls.push('repair'); return { code: 'action:supervisor-repaired' }; },
    installStatus: async () => ({ installed: true, scheduler: { intervalSeconds: 60 } }),
    reconcile: async () => { calls.push('reconcile'); return { code: 'skip:no-active-run' }; },
    runnerLiveness: async () => 'dead',
    now: () => 20_000,
    output: [],
    writeOutput(text) { this.output.push(text); },
  };
  return { deps, calls, get config() { return config; }, get state() { return state; }, set state(next) { state = next; } };
}

test('configure validates values and status reports effective interval', async () => {
  const h = harness();
  assert.equal((await runCli(['configure', '--window-mode', 'auto'], h.deps)).code, 0);
  assert.equal(h.config.windowMode, 'auto');
  const status = await runCli(['status', '--json'], h.deps);
  assert.equal(status.code, 0);
  const value = JSON.parse(h.deps.output.at(-1));
  assert.equal(value.scheduler.intervalSeconds, 60);
  assert.equal(value.config.windowMode, 'auto');
});

test('setup persists the verified standalone Claude path', async () => {
  const h = harness();
  await runCli(['setup'], h.deps);
  assert.equal(h.config.claudePath, 'C:\\Tools\\claude.exe');
  assert.ok(h.calls.includes('install'));
});

test('enable and disable persist config and trigger-now clears quota backoff', async () => {
  const h = harness();
  await runCli(['disable'], h.deps);
  assert.equal(h.config.enabled, false);
  await runCli(['enable'], h.deps);
  assert.equal(h.config.enabled, true);
  const state = defaultState();
  state.runs.one = {
    runId: 'one', state: 'RATE_LIMITED', quotaRejections: { consecutive: 3, backoffLevel: 1, nextProbeAt: 99_000, lastNotifiedAt: 1 },
    scheduledResumeAt: 99_000, scheduleState: 'pending',
  };
  h.state = state;
  await runCli(['trigger-now', '--run-id', 'one'], h.deps);
  assert.equal(h.state.runs.one.quotaRejections.consecutive, 0);
  assert.equal(h.state.runs.one.scheduledResumeAt, 20_000);
  assert.ok(h.calls.includes('reconcile'));
});

test('internal register transition and lease commands update one run', async () => {
  const h = harness();
  const args = ['register', '--run-id', 'one', '--session-id', '00000000-0000-4000-8000-000000000001', '--cwd', 'C:\\repo', '--ledger', 'C:\\repo\\.afk\\afk-ledger.md'];
  assert.equal((await runCli(args, h.deps)).code, 0);
  assert.equal(h.state.runs.one.state, 'RUNNING');
  assert.equal((await runCli(['lease', '--run-id', 'one'], h.deps)).code, 0);
  assert.ok(h.state.runs.one.tickGuard.expiresAt > 20_000);
  assert.equal((await runCli(['lease', '--run-id', 'one'], h.deps)).code, 0);
  assert.equal((await runCli(['transition', '--run-id', 'one', '--state', 'COMPLETED'], h.deps)).code, 0);
  assert.equal(h.state.runs.one.state, 'COMPLETED');
});

test('register resolves a recent SessionStart observation for the cwd', async () => {
  const h = harness();
  h.state.sessions['C:\\repo'] = { sessionId: '00000000-0000-4000-8000-000000000001', observedAt: 19_999 };
  const result = await runCli(['register', '--run-id', 'one', '--cwd', 'C:\\repo', '--ledger', 'C:\\repo\\.afk\\afk-ledger.md'], h.deps);
  assert.equal(result.code, 0);
  assert.equal(h.state.runs.one.sessionId, '00000000-0000-4000-8000-000000000001');
});

const REGISTER = ['register', '--run-id', 'one', '--session-id', SESSION, '--cwd', CWD, '--ledger', LEDGER];

test('registration refuses the paths recovery would later refuse', async () => {
  // register accepted any truthy cwd and ledger. validateRecoveryRun rejects a
  // relative cwd, a relative ledger, and a ledger outside the run — but only at
  // recovery time, where the throw burns one of the run's finite recovery attempts
  // on every invocation until they are exhausted. The run could never be resumed,
  // and nothing said so while there was still an operator there to see it.
  for (const paths of [
    ['--cwd', 'repo', '--ledger', LEDGER],
    ['--cwd', CWD, '--ledger', 'afk-ledger.md'],
    ['--cwd', CWD, '--ledger', OUTSIDE],
  ]) {
    const h = harness();
    const result = await runCli(['register', '--run-id', 'one', '--session-id', SESSION, ...paths], h.deps);
    assert.equal(result.code, 2, paths.join(' '));
    assert.match(h.deps.output.at(-1), /error:registration-invalid/);
    assert.deepEqual(h.state.runs, {}, 'a run recovery can never use must not be stored');
  }
});

test('re-registering a run preserves its recovery state', async () => {
  const h = harness();
  await runCli(REGISTER, h.deps);
  const state = h.state;
  state.runs.one = {
    ...state.runs.one, state: 'RATE_LIMITED',
    firstRateLimitedAt: 15_000, rateLimitedUntil: 33_000, resetConfidence: 'estimated',
    scheduledResumeAt: 33_100, scheduledResetAt: 33_000, scheduleState: 'pending', scheduleConfidence: 'estimated',
    quotaRejections: { consecutive: 2, backoffLevel: 0, nextProbeAt: null, lastNotifiedAt: null },
    retry: { attempts: 1, nextAttemptAt: 21_000 },
  };
  h.state = state;
  await runCli(REGISTER, h.deps);
  const item = h.state.runs.one;
  assert.equal(item.firstRateLimitedAt, 15_000);
  assert.equal(item.rateLimitedUntil, 33_000);
  assert.equal(item.scheduledResumeAt, 33_100);
  assert.equal(item.scheduleState, 'pending');
  assert.equal(item.quotaRejections.consecutive, 2);
  assert.equal(item.retry.attempts, 1);
});

test('a run registered after the threshold crossing inherits the current schedule', async () => {
  const h = harness();
  const state = defaultState();
  state.usage = { ...state.usage, confidence: 'exact', fiveHourResetAt: 40_000, thresholdResetAt: 40_000 };
  h.state = state;
  await runCli(REGISTER, h.deps);
  const item = h.state.runs.one;
  assert.equal(item.scheduledResetAt, 40_000);
  assert.ok(item.scheduledResumeAt >= 40_060 && item.scheduledResumeAt <= 40_180);
  assert.equal(item.scheduleState, 'pending');
});

test('trigger-now revives exactly the runs the selector refuses', async () => {
  // The operator reaches for trigger-now for a run in retry backoff, a run that
  // exhausted its attempts, or a run wedged behind a lease whose runner is gone.
  // The selector short-circuits on all three long before it looks at a schedule,
  // so arming a schedule alone made the only manual escape hatch a no-op that
  // still printed a success code.
  const h = harness();
  const state = defaultState();
  state.runs.stuck = {
    runId: 'stuck', state: 'FAILED',
    retry: { attempts: 4, nextAttemptAt: null },
    quotaRejections: { consecutive: 3, backoffLevel: 2, nextProbeAt: 999_999, lastNotifiedAt: 1 },
    recoveryLease: { attemptId: 'dead-runner', token: 'x', expiresAt: 999_999, pid: 4242, startedAt: 1 },
    scheduledResumeAt: 999_999, scheduleState: 'pending',
  };
  h.state = state;

  await runCli(['trigger-now', '--run-id', 'stuck'], h.deps);

  const run = h.state.runs.stuck;
  assert.deepEqual(run.retry, { attempts: 0, nextAttemptAt: null });
  assert.equal(run.quotaRejections.consecutive, 0);
  assert.equal(run.quotaRejections.nextProbeAt, null);
  assert.equal(run.recoveryLease.attemptId, null, 'a lease whose runner is gone must be cleared');
  assert.equal(run.recoveryLease.pid, null);
  assert.equal(run.scheduledResumeAt, 20_000);
  assert.ok(h.calls.includes('reconcile'));
});

// The acceptance test for the whole restructuring. Before the lease was split,
// this failed: the supervisor resumed a run, and the session it started asked for
// the lease, found the supervisor's own claim, was told another layer owned
// recovery, and exited having done nothing — for ever, while every log line said
// result:success.
//
//   1. reconciler leases run.lease with a supervisor attemptId and the runner
//      renews it for the whole life of the child.
//   2. the runner spawns `claude --resume` with RESUME_PROMPT: "Resume the active
//      AFK run ... continue from the first unfinished step".
//   3. that session enters the AFK skill, which says (SKILL.md:117) "Before each
//      resumable step and every tick ... use `afk-supervisor lease`".
//   4. `lease` sees a live lease owned by someone else — the supervisor itself —
//      and returns skip:recovery-lease-held.
//   5. the skill says (SKILL.md:124) skip:recovery-lease-held "means another
//      lifecycle layer owns recovery; exit the tick".
//
// The resumed session exits immediately having done nothing. Claude exits 0, the
// runner records result:success, and 25 minutes later the stale heartbeat makes
// the supervisor resume it again. For ever.
//
// The two claims are separate fields now, so a resumed session takes its own
// guard and gets on with the work.
test('a session the supervisor resumed can acquire its own tick guard', async () => {
  const h = harness();
  const state = defaultState();
  state.runs.one = {
    runId: 'one', sessionId: '00000000-0000-4000-8000-000000000001', state: 'RECOVERING',
    // exactly what reconciler.mjs writes before it spawns the runner
    recoveryLease: { attemptId: 'supervisor-attempt', token: 'tok', expiresAt: 20_180, pid: 4242, startedAt: 1 },
  };
  h.state = state;

  const result = await runCli(['lease', '--run-id', 'one'], h.deps);

  assert.equal(result.code, 0, 'the session the supervisor just resumed must be able to work');
  assert.equal(h.deps.output.at(-1).trim(), 'action:tick-guard-acquired');
  // ...and the supervisor's own claim on the run is untouched by it.
  assert.equal(h.state.runs.one.recoveryLease.attemptId, 'supervisor-attempt');
  assert.equal(h.state.runs.one.tickGuard.sessionId, '00000000-0000-4000-8000-000000000001');
});

test('a different session cannot steal a live tick guard', async () => {
  const h = harness();
  const state = defaultState();
  state.runs.one = {
    runId: 'one', sessionId: '00000000-0000-4000-8000-000000000001', state: 'RUNNING',
    tickGuard: { sessionId: '00000000-0000-4000-8000-0000000000ff', expiresAt: 21_000 },
  };
  h.state = state;
  const result = await runCli(['lease', '--run-id', 'one'], h.deps);
  assert.equal(result.code, 1);
  assert.equal(h.deps.output.at(-1).trim(), 'skip:tick-guard-held');
});

test('trigger-now refuses to release a runner that is still working', async () => {
  // Clearing that lease would start a second `claude --resume` on the same
  // session, concurrently with the first — the exact corruption the whole
  // liveness check exists to prevent. The operator can still force it.
  const h = harness();
  const state = defaultState();
  state.runs.busy = {
    runId: 'busy', sessionId: '00000000-0000-4000-8000-000000000001', state: 'RECOVERING',
    recoveryLease: { attemptId: 'live-runner', token: 'tok', expiresAt: 20_180, pid: 4242, startedAt: 1 },
  };
  h.state = state;
  h.deps.runnerLiveness = async () => 'alive';

  const refused = await runCli(['trigger-now', '--run-id', 'busy'], h.deps);
  assert.equal(refused.code, 1);
  assert.equal(h.deps.output.at(-1).trim(), 'skip:runner-alive');
  assert.equal(h.state.runs.busy.recoveryLease.attemptId, 'live-runner', 'the lease must be untouched');
  assert.ok(!h.calls.includes('reconcile'));

  const forced = await runCli(['trigger-now', '--run-id', 'busy', '--force'], h.deps);
  assert.equal(forced.code, 0);
  assert.equal(h.state.runs.busy.recoveryLease.attemptId, null);
});

test('unknown commands and missing runs emit distinct errors', async () => {
  const h = harness();
  assert.equal((await runCli(['unknown'], h.deps)).code, 2);
  assert.match(h.deps.output.at(-1), /error:unknown-command/);
  assert.equal((await runCli(['trigger-now', '--run-id', 'missing'], h.deps)).code, 1);
  assert.match(h.deps.output.at(-1), /skip:run-not-registered/);
});
