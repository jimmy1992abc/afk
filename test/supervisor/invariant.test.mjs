// THE invariant: at most one thing drives a session at a time.
//
// Twelve review rounds produced a suite that was green while two `claude --resume`
// sat on one session. Every round wrote example tests that pinned the bug they were
// born from, and every round the bug moved somewhere the examples did not look. So
// this file does not test an example. It enumerates the state space — clock steps
// forwards and backwards, suspends, every liveness answer, every claim shape, every
// command — and asserts the one thing that must never happen.
//
// If a future change makes it possible to start a second driver on a run something
// is already driving, this fails, and it fails without anyone having to have thought
// of that particular way of doing it.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { defaultConfig } from '../../scripts/supervisor/config.mjs';
import { runCli } from '../../scripts/supervisor/cli.mjs';
import { reconcileOnce } from '../../scripts/supervisor/reconciler.mjs';
import { claimOccupied } from '../../scripts/supervisor/state-machine.mjs';
import { StateStore, defaultState } from '../../scripts/supervisor/state-store.mjs';

const NOW = 1_800_000_000;
const SESSION = '00000000-0000-4000-8000-000000000001';
const CWD = process.platform === 'win32' ? String.raw`C:\repo` : '/repo';
const LEDGER = process.platform === 'win32' ? String.raw`C:\repo\.afk\afk-ledger.md` : '/repo/.afk/afk-ledger.md';
const config = defaultConfig();
const TTL = config.leaseRenewalSeconds * config.leaseMissedRenewals;

// Every claim shape the system can actually be in, including the ones that only a
// broken clock or a half-finished upgrade produce.
const CLAIMS = {
  'no claim': null,
  'fresh': { lastRenewedAt: NOW - 5, expiresAt: NOW + TTL, pid: 4242, startedAt: 1_700_000_000_000 },
  'just expired': { lastRenewedAt: NOW - TTL, expiresAt: NOW - 1, pid: 4242, startedAt: 1_700_000_000_000 },
  'long expired': { lastRenewedAt: NOW - 99_999, expiresAt: NOW - 99_000, pid: 4242, startedAt: 1_700_000_000_000 },
  'no pid (upgraded mid-recovery)': { lastRenewedAt: NOW - 5, expiresAt: NOW - 1, pid: null, startedAt: null },
  'clock stepped forward': { lastRenewedAt: NOW + 86_400, expiresAt: NOW + 400 * 86_400, pid: 4242, startedAt: 1 },
  'clock stepped back': { lastRenewedAt: NOW + 300, expiresAt: NOW + 300, pid: 4242, startedAt: 1 },
  'undatable': { lastRenewedAt: null, expiresAt: null, pid: 4242, startedAt: 1 },
  'orphaned child': { lastRenewedAt: NOW - 99_999, expiresAt: NOW - 99_000, pid: 4242, startedAt: 1, childPid: 6666, childStartedAt: 2 },
};

const GUARDS = {
  'no guard': null,
  'held by a live session': { sessionId: SESSION, expiresAt: NOW + 600 },
  'guard from a stepped clock': { sessionId: SESSION, expiresAt: NOW + 400 * 86_400 },
  'stale guard': { sessionId: SESSION, expiresAt: NOW - 1 },
};

const LIVENESS = ['alive', 'dead', 'unknown'];

function claimOf(shape) {
  if (!shape) return { attemptId: null, token: null, lastRenewedAt: null, expiresAt: null, pid: null, startedAt: null, childPid: null, childStartedAt: null, stuckNotifiedAt: null };
  return { attemptId: 'incumbent', token: 'incumbent-token', childPid: null, childStartedAt: null, stuckNotifiedAt: null, ...shape };
}

function runWith(claim, guard) {
  return {
    runId: 'run-1', sessionId: SESSION, state: 'RECOVERING', cwd: CWD, ledgerPath: LEDGER,
    lastHeartbeatAt: NOW - 99_999, nextExpectedTickAt: null, updatedAt: NOW - 99_999,
    scheduledResetAt: null, scheduledResumeAt: null, scheduleState: null,
    recoveryLease: claimOf(claim), tickGuard: guard ? { ...guard } : null,
    retry: { attempts: 0, nextAttemptAt: null },
    quotaRejections: { consecutive: 0, backoffLevel: 0, nextProbeAt: null, lastNotifiedAt: null },
    forcedUntil: null,
  };
}

async function store(claim, guard) {
  const root = await mkdtemp(join(tmpdir(), 'afk-invariant-'));
  const value = new StateStore(root);
  await value.update(() => ({ ...defaultState(), runs: { 'run-1': runWith(claim, guard) } }));
  return value;
}

// Something is already driving this run if a supervisor claim is occupied, or if an
// interactive session holds the tick guard. A guard we cannot believe (a stepped
// clock) still HOLDS: an unbelievable claim on a live session must fail closed, or
// the supervisor resumes a session a human is sitting in front of.
function alreadyDriven(run, liveness) {
  // A claim with no pid cannot be probed at all, so `unknown` is the only answer the
  // system can honestly give about it — the same short-circuit `claimLiveness` makes.
  const effective = Number.isInteger(run.recoveryLease?.pid) ? liveness : 'unknown';
  const claimed = claimOccupied(run.recoveryLease, config, NOW, effective);
  const guarded = Number.isFinite(run.tickGuard?.expiresAt) && run.tickGuard.expiresAt > NOW;
  return { claimed, guarded, effective, any: claimed || guarded };
}

function supervisorDeps(value, liveness, spawned) {
  return {
    store: value, config, now: () => NOW,
    readObservationBatch: async () => [], commitObservationBatch: async () => {},
    readHeartbeats: async () => ({}), readLedgerHeartbeat: async () => null,
    runnerLiveness: async () => liveness,
    processStartedAt: async () => 1_700_000_000_000,
    notifyStuck: async () => {}, notifyWindow: async () => {},
    spawnRunner: (attempt) => { spawned.push(attempt); return { pid: 5150, unref() {} }; },
    randomUUID: () => 'challenger',
  };
}

function cliDeps(value, liveness, reconciled) {
  return {
    configStore: { read: async () => config, write: async (next) => next },
    stateStore: value,
    currentConfig: config,
    runnerLiveness: async () => liveness,
    callerAttemptId: () => null,          // a session that is NOT the one the supervisor resumed
    reconcile: async () => { reconciled.push(true); return { code: 'skip:no-active-run' }; },
    now: () => NOW,
    output: [],
    writeOutput(text) { this.output.push(text); },
  };
}

test('a claim held by an orphaned Claude is eventually released, not held for ever', async () => {
  // The other half of the invariant. Refusing to double-drive is easy if you simply
  // never drive anything again — and that is what the retained claim did: kept by a
  // runner that had already exited, so nothing renewed it, nothing killed the child,
  // `notBefore` re-armed every pass so the pruner never reaped it, and `--force`
  // refused because the child was alive. A run that can never recover is as broken as
  // a run driven twice. Something has to end it, so the supervisor reaps the orphan.
  const root = await mkdtemp(join(tmpdir(), 'afk-invariant-orphan-'));
  const value = new StateStore(root);
  await value.update(() => ({
    ...defaultState(),
    runs: {
      'run-1': runWith({
        lastRenewedAt: NOW - config.recoveryAttemptTimeoutSeconds - 1,
        expiresAt: NOW - config.recoveryAttemptTimeoutSeconds - 1,
        pid: 4242, startedAt: 1, childPid: 6666, childStartedAt: 2,
      }, null),
    },
  }));

  const killed = [];
  const spawned = [];
  await reconcileOnce({
    ...supervisorDeps(value, 'dead', spawned),
    // The runner is gone; only its Claude child answers.
    runnerLiveness: async (lease) => (Number.isInteger(lease.childPid) ? 'alive' : 'dead'),
    killProcess: async (pid) => { killed.push(pid); return true; },
  });

  assert.deepEqual(killed, [6666], 'the orphaned Claude must actually be stopped');
  assert.equal(spawned.length, 1, 'and the run becomes recoverable again');
});

test('no second activation is started on top of a live one', async () => {
  // The activation claim is the third claim, and it was the last one still answering
  // "is something driving this?" by itself — a raw expiry check, no liveness. The
  // reconciler resolved the answer properly and then handed it only to the pruner;
  // the path that actually SELECTS never asked. So a suspend past the lease TTL, with
  // the activation runner still running, started a second one on top of it.
  const violations = [];
  const ACTIVATIONS = {
    'fresh': { lastRenewedAt: NOW - 5, expiresAt: NOW + TTL },
    'expired (a suspend)': { lastRenewedAt: NOW - 99_999, expiresAt: NOW - 99_000 },
    'clock stepped forward': { lastRenewedAt: NOW + 86_400, expiresAt: NOW + 400 * 86_400 },
    'no pid': { lastRenewedAt: NOW - 5, expiresAt: NOW - 1, pid: null },
  };

  for (const [name, shape] of Object.entries(ACTIVATIONS)) {
    for (const liveness of LIVENESS) {
      const root = await mkdtemp(join(tmpdir(), 'afk-invariant-act-'));
      const value = new StateStore(root);
      await value.update(() => {
        const next = defaultState();
        next.usage.confidence = 'exact';
        next.usage.fiveHourResetAt = NOW - config.graceSeconds;
        next.activation = {
          ...next.activation, inProgress: true, attemptId: 'incumbent', token: 'incumbent-token',
          resetAt: NOW - config.graceSeconds, lastAttemptAt: NOW - 5, lastResult: 'action:activation-leased',
          pid: 4242, startedAt: 1_700_000_000_000, childPid: null, childStartedAt: null,
          activationAttempts: [NOW - 5], ...shape,
        };
        return next;
      });

      const effective = Number.isInteger((await value.read()).activation.pid) ? liveness : 'unknown';
      const occupied = claimOccupied({ ...(await value.read()).activation }, config, NOW, effective);
      if (!occupied) continue;

      const spawned = [];
      await reconcileOnce({
        ...supervisorDeps(value, liveness, spawned),
        config: { ...config, windowMode: 'auto' },
      });
      if (spawned.length > 0) violations.push(`${name} | probe:${liveness} -> a second activation was started`);
    }
  }

  assert.deepEqual(violations, [], `\n  ${violations.join('\n  ')}\n`);
});

test('no command starts a second driver on a run something is already driving', async () => {
  const violations = [];

  for (const [claimName, claim] of Object.entries(CLAIMS)) {
    for (const [guardName, guard] of Object.entries(GUARDS)) {
      for (const liveness of LIVENESS) {
        const scenario = `${claimName} | ${guardName} | probe:${liveness}`;
        const before = runWith(claim, guard);
        const driven = alreadyDriven(before, liveness);
        if (!driven.any) continue;

        // 1. The supervisor must not spawn a runner onto it.
        const reconcileStore = await store(claim, guard);
        const spawned = [];
        await reconcileOnce(supervisorDeps(reconcileStore, liveness, spawned));
        if (spawned.length > 0) {
          violations.push(`reconcile spawned a runner: ${scenario}`);
        }

        // 2. A foreign session's tick must not take the run either. (A session the
        //    supervisor itself resumed carries the attempt id; this one does not.)
        if (driven.claimed) {
          const leaseStore = await store(claim, guard);
          const deps = cliDeps(leaseStore, liveness, []);
          await runCli(['lease', '--run-id', 'run-1', '--session-id', SESSION], deps);
          const after = (await leaseStore.read()).runs['run-1'];
          const took = after.tickGuard && after.tickGuard.expiresAt > (guard?.expiresAt ?? 0);
          if (took) violations.push(`lease took the guard: ${scenario}`);
        }

        // 3. trigger-now must not release a claim something is still behind. With
        //    --force the operator may release one we cannot VERIFY — never a live one.
        for (const force of [false, true]) {
          if (!driven.claimed) continue;
          const triggerStore = await store(claim, guard);
          const reconciled = [];
          const deps = cliDeps(triggerStore, liveness, reconciled);
          const argv = ['trigger-now', '--run-id', 'run-1', ...(force ? ['--force'] : [])];
          await runCli(argv, deps);
          const after = (await triggerStore.read()).runs['run-1'];
          const released = before.recoveryLease.attemptId && !after.recoveryLease.attemptId;
          const mayRelease = force && driven.effective !== 'alive';
          if (released && !mayRelease) {
            violations.push(`trigger-now${force ? ' --force' : ''} released a claim (probe:${driven.effective}): ${scenario}`);
          }
        }
      }
    }
  }

  assert.deepEqual(violations, [], `\n  ${violations.join('\n  ')}\n`);
});
