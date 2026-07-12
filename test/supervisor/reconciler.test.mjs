import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { defaultConfig } from '../../scripts/supervisor/config.mjs';
import { reconcileOnce } from '../../scripts/supervisor/reconciler.mjs';
import { StateStore } from '../../scripts/supervisor/state-store.mjs';

const now = 20_000;

async function harness(run, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'afk-supervisor-reconcile-'));
  const store = new StateStore(root);
  await store.update((state) => ({ ...state, runs: { [run.runId]: run } }));
  const spawnCalls = [];
  return {
    store,
    spawnCalls,
    deps: {
      store, config: defaultConfig(), now: () => now,
      readObservationBatch: async () => [], commitObservationBatch: async () => {},
      readHeartbeats: async () => ({}), readLedgerHeartbeat: async () => null,
      runnerLiveness: async () => 'dead',
      notifyStuck: async () => {},
      spawnRunner: (attempt) => { spawnCalls.push(attempt); return { unref() {} }; },
      notifyWindow: async () => {},
      randomUUID: () => 'attempt-1',
      ...overrides,
    },
  };
}

function run(overrides = {}) {
  return {
    runId: 'run-1', sessionId: '00000000-0000-4000-8000-000000000001',
    state: 'RUNNING', cwd: 'C:\\repo', ledgerPath: 'C:\\repo\\.afk\\afk-ledger.md',
    lastHeartbeatAt: now - 2_000, nextExpectedTickAt: now - 500,
    scheduledResetAt: null, scheduledResumeAt: null, scheduleState: null,
    recoveryLease: { attemptId: null, token: null, expiresAt: null, pid: null, startedAt: null, stuckNotifiedAt: null },
    tickGuard: null, retry: { attempts: 0, nextAttemptAt: null },
    quotaRejections: { consecutive: 0, backoffLevel: 0, nextProbeAt: null },
    ...overrides,
  };
}

const OBSERVATION = {
  sessionId: '00000000-0000-4000-8000-000000000001', observedAt: 1_000,
  fiveHourResetAt: 30_000, fiveHourUsedPercentage: 95,
  sevenDayResetAt: null, sevenDayUsedPercentage: null,
  source: 'statusline', confidence: 'exact',
};

test('a lease records the runner it started, at the moment it starts it', async () => {
  // The pid was written only by the runner's own first renewal, a minute later. A
  // runner that died inside that minute — a suspend, which is the very scenario
  // this machinery exists for — left a claim carrying no pid, and an unverifiable
  // claim was skipped by the liveness pass and read as free. The supervisor then
  // started a second Claude on the same session. The reconciler has held the pid
  // in its hand the whole time.
  const h = await harness(run());
  h.deps.spawnRunner = (attempt) => { h.spawnCalls.push(attempt); return { pid: 4242, unref() {} }; };
  h.deps.processStartedAt = async () => 1_700_000_000_000;
  assert.equal((await reconcileOnce(h.deps)).code, 'action:runner-started');
  const lease = (await h.store.read()).runs['run-1'].recoveryLease;
  assert.equal(lease.pid, 4242);
  assert.equal(lease.startedAt, 1_700_000_000_000);
});

test('the reconciler never downgrades the identity the runner verified', async () => {
  // The runner stamps its own {pid, startedAt} from inside itself and usually wins
  // the race. The reconciler's probe is a PowerShell shell-out and lands after — and
  // when it comes back `undefined` ("could not ask"), writing that as `null` DOWNGRADED
  // a live, verified claim to an unverifiable one, which then reads as `unknown`.
  const h = await harness(run());
  h.deps.spawnRunner = (attempt) => { h.spawnCalls.push(attempt); return { pid: 4242, unref() {} }; };
  h.deps.processStartedAt = async () => {
    // The runner stamps its own verified identity from inside itself, and gets there
    // first — while our slower shell-out is still running.
    await h.store.update((state) => {
      const lease = state.runs['run-1'].recoveryLease;
      lease.pid = 4242;
      lease.startedAt = 1_700_000_000_000;
      return state;
    });
    return undefined;   // ...and then our probe comes back "could not ask"
  };

  await reconcileOnce(h.deps);
  const lease = (await h.store.read()).runs['run-1'].recoveryLease;
  assert.equal(lease.startedAt, 1_700_000_000_000, 'a probe that could not ask must not erase what we know');
});

test('a tick guard from a stepped clock is repaired on disk, so it cannot hold for ever', async () => {
  // The guard fails closed — any future expiry holds — which without a repair means a
  // guard expiring in the year 2400 holds the run until the year 2400. Failing closed
  // is only safe when something bounds it, and for every other claim that something is
  // the persisted repair. The guard was the one claim nothing repaired.
  const h = await harness(run({
    state: 'RUNNING',
    tickGuard: { sessionId: '00000000-0000-4000-8000-000000000001', expiresAt: now + 400 * 86_400 },
    lastHeartbeatAt: now - 99_999, nextExpectedTickAt: null,
  }));

  await reconcileOnce(h.deps);
  const guard = (await h.store.read()).runs['run-1'].tickGuard;
  assert.equal(guard.expiresAt, now + defaultConfig().heartbeatStaleSeconds,
    'the guard holds for its normal window, and the clamp is written down');
  assert.equal(h.spawnCalls.length, 0, 'and meanwhile the session behind it is left alone');
});

test('a claim stamped in the future is repaired on disk, so the bound is real', async () => {
  // A clamp that lives only in the reader resets on every pass, and is therefore no
  // bound at all — that is precisely how the first version of this bound came to hold
  // a run for ever. The repair has to be WRITTEN DOWN.
  const skew = now + 365 * 86_400;
  const h = await harness(run({
    state: 'RECOVERING',
    recoveryLease: {
      attemptId: 'a', token: 't', lastRenewedAt: skew, expiresAt: skew,
      pid: 4242, startedAt: 1, childPid: null, childStartedAt: null, stuckNotifiedAt: null,
    },
    lastHeartbeatAt: now - 99_999, nextExpectedTickAt: null,
  }));
  h.deps.runnerLiveness = async () => 'unknown';

  await reconcileOnce(h.deps);
  const lease = (await h.store.read()).runs['run-1'].recoveryLease;
  assert.equal(lease.lastRenewedAt, now, 'the claim is dated now, and the date is persisted');
  assert.equal(lease.expiresAt, now, 'and dated EXPIRED, so liveness decides rather than a corrupt clock');
  assert.equal(h.spawnCalls.length, 0, 'and it is held meanwhile: a live runner may be behind it');
});

test('an expired claim with no verifiable identity is occupied, not free', async () => {
  // An upgrade in the middle of a recovery leaves an old-shape lease with no pid at
  // all. It was skipped by the liveness pass entirely — so the live runner was
  // orphaned and a second one started on top of it.
  const h = await harness(run({
    state: 'RECOVERING',
    recoveryLease: { attemptId: 'from-the-old-version', token: 't', expiresAt: now - 1, pid: null, startedAt: null, stuckNotifiedAt: null },
  }));
  const result = await reconcileOnce(h.deps);
  assert.notEqual(result.code, 'action:runner-started');
  assert.equal(h.spawnCalls.length, 0, 'a claim we cannot verify must never be double-driven');
});

test('an operator force actually resumes the run, and is spent once', async () => {
  // This test used to pass while the feature did nothing at all, because it left the
  // harness's ledger heartbeat at null — and the LEDGER heartbeat is the gate that
  // killed the force. The selector honoured `forcedUntil`; `reconcileOnce` then read
  // the ledger, found a fresh heartbeat, and returned skip:heartbeat-fresh. The one
  // escape hatch from a wedged run did nothing, and printed success while doing it.
  //
  // So drive BOTH layers: a fresh heartbeat in the state AND a fresh one in the
  // ledger. That is exactly the run an operator reaches for --force on.
  const h = await harness(run({
    forcedUntil: now + 900, lastHeartbeatAt: now - 1, nextExpectedTickAt: now + 900,
  }), { readLedgerHeartbeat: async () => now });

  assert.equal((await reconcileOnce(h.deps)).code, 'action:runner-started');
  assert.equal(h.spawnCalls.length, 1, 'the force must actually start a runner');
  assert.equal((await h.store.read()).runs['run-1'].forcedUntil, null, 'and be spent, not left to re-fire');
});

test('a force is spent even by a pass that could not claim the run', async () => {
  // A supervisor pass claims the run in the gap between the heartbeat gate and the
  // claim, so this pass cannot take it. The force must still be spent: left set, the
  // run is re-selected on every pass — and selection stops at the first runnable run.
  const h = await harness(run({
    forcedUntil: now + 900, lastHeartbeatAt: now - 1, nextExpectedTickAt: now + 900,
  }));
  const ttl = defaultConfig().leaseRenewalSeconds * defaultConfig().leaseMissedRenewals;
  h.deps.readLedgerHeartbeat = async () => {
    await h.store.update((state) => {
      state.runs['run-1'].recoveryLease = {
        attemptId: 'someone-else', token: 'tok', lastRenewedAt: now, expiresAt: now + ttl,
        pid: 1111, startedAt: 1, stuckNotifiedAt: null,
      };
      return state;
    });
    return now;
  };

  assert.equal((await reconcileOnce(h.deps)).code, 'skip:state-changed');
  assert.equal(h.spawnCalls.length, 0);
  assert.equal((await h.store.read()).runs['run-1'].forcedUntil, null, 'the force is spent by the pass that acted on it');
});

test('a forced run does not starve the repository behind it', async () => {
  // `forcedUntil` was cleared ONLY when the run was successfully claimed, and the
  // ledger gate meant it never could be. Selection returns the FIRST runnable run
  // and stops, so the forced run was re-selected on every pass and aborted the pass
  // — every other repository starved until the force expired.
  const h = await harness(run({
    runId: 'a-forced', forcedUntil: now + 900, lastHeartbeatAt: now - 1, nextExpectedTickAt: now + 900,
  }), {
    // Only the forced run has a fresh ledger heartbeat — that is the gate that used
    // to defeat the force. The run behind it is genuinely stale and genuinely due.
    readLedgerHeartbeat: async (target) => (target.runId === 'a-forced' ? now : null),
    // Two slots, so that what the second pass proves is the absence of starvation
    // and not merely the concurrency cap doing its job.
    config: { ...defaultConfig(), maxConcurrentInvocations: 2 },
  });
  await h.store.update((state) => {
    state.runs['z-genuine'] = run({
      runId: 'z-genuine', sessionId: '00000000-0000-4000-8000-000000000002',
      state: 'RATE_LIMITED', rateLimitedUntil: now - 1_000, resetConfidence: 'exact',
      lastHeartbeatAt: now - 99_999, nextExpectedTickAt: null,
    });
    return state;
  });

  assert.equal((await reconcileOnce(h.deps)).code, 'action:runner-started');
  assert.equal(h.spawnCalls.at(-1).runId, 'a-forced', 'the force is acted on first');

  // Second pass: the force is spent, so the healthy run behind it gets its turn.
  h.deps.runnerLiveness = async () => 'alive';
  assert.equal((await reconcileOnce(h.deps)).code, 'action:runner-started');
  assert.equal(h.spawnCalls.at(-1).runId, 'z-genuine');
});

test('a new activation claim carries no trace of the last one', async () => {
  // The run lease is built from a literal at claim time. The ACTIVATION claim was
  // spread from the previous one, so it inherited the last activation's pid and
  // child — and `fillIdentity`, which never overwrites, then made recording this
  // attempt's real identity a permanent no-op. The liveness check would spend the
  // rest of its life probing a process that was never part of this attempt, and a
  // suspend past the lease TTL would start a second activation on top of a live one.
  const h = await harness(run({ state: 'COMPLETED', updatedAt: now }), { config: { ...defaultConfig(), windowMode: 'auto' } });
  await h.store.update((state) => {
    state.usage.confidence = 'exact';
    state.usage.fiveHourResetAt = now - defaultConfig().graceSeconds;
    // ...left behind by an activation that has long since finished.
    state.activation.pid = 1111;
    state.activation.startedAt = 1;
    state.activation.childPid = 2222;
    state.activation.childStartedAt = 2;
    return state;
  });
  h.deps.spawnRunner = (attempt) => { h.spawnCalls.push(attempt); return { pid: 5555, unref() {} }; };
  h.deps.processStartedAt = async () => 1_700_000_009_000;

  assert.equal((await reconcileOnce(h.deps)).code, 'action:activation-runner-started');
  const activation = (await h.store.read()).activation;
  assert.equal(activation.pid, 5555, 'the claim must identify THIS attempt, not the last');
  assert.equal(activation.startedAt, 1_700_000_009_000);
  assert.equal(activation.childPid, null, 'and this attempt has not started a child yet');
  assert.equal(activation.childStartedAt, null);
});

test('an activation whose runner is still alive is never reclaimed', async () => {
  // The activation lease was reclaimed on expiry alone, with no liveness check at
  // all — the very defect that was fixed for recovery leases. A machine that sleeps
  // longer than the lease expires it while the detached activation runner is still
  // running, so the next pass starts a SECOND activation on top of it and burns
  // another attempt from the daily cap.
  const h = await harness(run({ state: 'RUNNING', lastHeartbeatAt: now - 10, nextExpectedTickAt: now + 900 }));
  h.deps.runnerLiveness = async () => 'alive';
  await h.store.update((state) => {
    state.activation = {
      ...state.activation, inProgress: true, attemptId: 'activation-1', token: 'tok',
      resetAt: now - 90, lastAttemptAt: now - 5_000, lastRenewedAt: now - 5_000,
      expiresAt: now - 1, pid: 4242, startedAt: 1_700_000_000_000, activationAttempts: [now - 5_000],
    };
    return state;
  });

  await reconcileOnce(h.deps);
  const after = (await h.store.read()).activation;
  assert.equal(after.inProgress, true, 'a live activation runner must keep its claim');
  assert.notEqual(after.lastResult, 'error:activation-lease-expired', 'and must not be written off as expired');
  assert.equal(after.attemptId, 'activation-1', 'its claim is intact');
  assert.equal(h.spawnCalls.length, 0, 'and no second activation may be started');
});

test('a pass that lost the race never leases a run a second time', async () => {
  const h = await harness(run({ lastHeartbeatAt: now - 99_999, nextExpectedTickAt: null }));
  h.deps.readLedgerHeartbeat = async () => {
    // Another pass leased this run while we were reading its ledger.
    await h.store.update((state) => {
      state.runs['run-1'].state = 'RECOVERING';
      state.runs['run-1'].recoveryLease = { attemptId: 'other', token: 'other-token', expiresAt: now + 180, pid: null, startedAt: null };
      return state;
    });
    return null;
  };
  const result = await reconcileOnce(h.deps);
  assert.equal(result.code, 'skip:state-changed');
  assert.equal(h.spawnCalls.length, 0);
  assert.equal((await h.store.read()).runs['run-1'].recoveryLease.attemptId, 'other');
});

test('a runner that outlived its lease still occupies its invocation slot', async () => {
  // A suspended machine stops the renewal timer while the runner and its Claude
  // child stay alive. An expired lease is not an abandoned one: counting only
  // unexpired leases leaves a running Claude uncounted, and the next pass starts
  // a second one against the same session.
  const h = await harness(run({
    state: 'RECOVERING', lastHeartbeatAt: now - 99_999, nextExpectedTickAt: null,
    recoveryLease: { attemptId: 'a', token: 't', expiresAt: now - 1, pid: 4242, startedAt: 1 },
  }), { runnerLiveness: async (l) => (l.pid === 4242 ? 'alive' : 'dead'), notifyStuck: async () => {} });
  const result = await reconcileOnce(h.deps);
  assert.equal(result.code, 'skip:concurrency-exhausted');
  assert.equal(h.spawnCalls.length, 0);
});

test('an occupied run is skipped, never re-leased, and never starves the others', async () => {
  // With a spare slot the occupied run must be stepped over rather than
  // re-selected — and stepping over it must not end the pass, or one long
  // recovery would starve every other due run for up to its whole timeout.
  const busy = run({
    runId: 'a-busy', state: 'RECOVERING', scheduledResumeAt: 100, scheduleState: 'leased',
    lastHeartbeatAt: now - 99_999, nextExpectedTickAt: null,
    recoveryLease: { attemptId: 'a', token: 't', expiresAt: now - 1, pid: 4242, startedAt: 1 },
  });
  const h = await harness(busy, {
    config: { ...defaultConfig(), maxConcurrentInvocations: 2 },
    runnerLiveness: async (l) => (l.pid === 4242 ? 'alive' : 'dead'),
    notifyStuck: async () => {},
  });
  await h.store.update((state) => {
    state.runs['b-due'] = run({
      runId: 'b-due', sessionId: '00000000-0000-4000-8000-000000000002',
      state: 'RATE_LIMITED', rateLimitedUntil: now - 1_000, resetConfidence: 'exact',
      lastHeartbeatAt: now - 99_999, nextExpectedTickAt: null,
    });
    return state;
  });

  const result = await reconcileOnce(h.deps);
  assert.equal(result.code, 'action:runner-started');
  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.spawnCalls[0].runId, 'b-due', 'the occupied run must not be resumed a second time');
  assert.equal((await h.store.read()).runs['a-busy'].recoveryLease.attemptId, 'a', 'its lease is untouched');
});

test('a ledger heartbeat from the future never satisfies a reset', async () => {
  // A ledger written by a machine whose clock runs ahead. Trusting it here marks
  // the schedule handled, discards the reset, and persists the future timestamp —
  // after which the run reads "fresh" for ever and is never selectable again.
  const h = await harness(run({
    scheduledResetAt: now - 200, scheduledResumeAt: now - 10, scheduleState: 'pending',
    lastHeartbeatAt: now - 99_999, nextExpectedTickAt: null,
  }), { readLedgerHeartbeat: async () => now + 86_400 });

  const result = await reconcileOnce(h.deps);
  assert.equal(result.code, 'action:runner-started');
  assert.equal(h.spawnCalls.length, 1);
  assert.notEqual((await h.store.read()).runs['run-1'].lastHeartbeatAt, now + 86_400,
    'a future heartbeat must never be persisted');
});

test('a live runner occupies its slot however long the machine slept', async () => {
  // The lease expiry is a wall-clock value but the runner's own action timeout is
  // a timer, and suspend stops timers while the clock keeps running. Bounding the
  // pid check by that timeout would therefore give up in exactly the case it
  // exists for — a lid closed for hours — and start a second resume of the same
  // session. A live pid occupies, with no time bound.
  const h = await harness(run({
    state: 'RECOVERING', lastHeartbeatAt: now - 99_999, nextExpectedTickAt: null,
    recoveryLease: { attemptId: 'a', token: 't', expiresAt: now - 5 * defaultConfig().recoveryAttemptTimeoutSeconds, pid: 4242, startedAt: 1 },
  }), { runnerLiveness: async () => 'alive', notifyStuck: async () => {} });
  const result = await reconcileOnce(h.deps);
  assert.equal(result.code, 'skip:concurrency-exhausted');
  assert.equal(h.spawnCalls.length, 0);
});

test('a lease held past its timeout by a live pid tells the operator', async () => {
  // The residual risk of trusting a pid for ever is pid reuse, which wedges the
  // run. The supervisor says so rather than guessing the runner is dead.
  const stuck = [];
  const h = await harness(run({
    state: 'RECOVERING', lastHeartbeatAt: now - 99_999, nextExpectedTickAt: null,
    recoveryLease: { attemptId: 'a', token: 't', expiresAt: now - defaultConfig().recoveryAttemptTimeoutSeconds - 1, pid: 4242, startedAt: 1 },
  }), { runnerLiveness: async () => 'alive', notifyStuck: async (r) => { stuck.push(r.runId); } });
  await reconcileOnce(h.deps);
  assert.deepEqual(stuck, ['run-1']);
});

test('an in-session AFK lease never consumes the supervisor invocation slot', async () => {
  // The in-session tick leases its own run for 25 minutes and refreshes it every
  // tick. Counting that as a supervisor invocation would let one interactively
  // running repo disable recovery for every other repo, continuously.
  const insession = run({
    runId: 'a-interactive', state: 'RUNNING',
    tickGuard: { sessionId: '00000000-0000-4000-8000-000000000001', expiresAt: now + 1_500 },
    lastHeartbeatAt: now - 10, nextExpectedTickAt: now + 900,
  });
  const h = await harness(insession, { runnerLiveness: async () => 'dead' });
  await h.store.update((state) => {
    state.runs['b-due'] = run({
      runId: 'b-due', sessionId: '00000000-0000-4000-8000-000000000002',
      state: 'RATE_LIMITED', rateLimitedUntil: now - 1_000, resetConfidence: 'exact',
      lastHeartbeatAt: now - 99_999, nextExpectedTickAt: null,
    });
    return state;
  });

  const result = await reconcileOnce(h.deps);
  assert.equal(result.code, 'action:runner-started');
  assert.equal(h.spawnCalls[0].runId, 'b-due');
});

test('a lease expiry from a stepped clock does not occupy its slot for ever', async () => {
  // A forward clock step during a renewal persists an expiry years out. Nothing
  // reaps run leases, so an unclamped one holds the only invocation slot for good.
  // The claim carries an identity because every claim now does — it is stamped at
  // the spawn — and the runner behind this one is gone (the harness says `dead`).
  // Without the clamp the run reads as still-owned and the pass skips for ever.
  const h = await harness(run({
    state: 'RECOVERING', lastHeartbeatAt: now - 99_999, nextExpectedTickAt: null,
    recoveryLease: { attemptId: 'a', token: 't', expiresAt: now + 400 * 86_400, pid: 4242, startedAt: 1 },
  }));
  const result = await reconcileOnce(h.deps);
  assert.equal(result.code, 'action:runner-started');
});

test('observations are committed only after the import that used them is durable', async () => {
  const committed = [];
  const h = await harness(run(), {
    readObservationBatch: async () => [{ path: 'obs-1.json', observation: OBSERVATION }],
  });
  h.deps.commitObservationBatch = async (batch) => {
    committed.push(batch.length);
    // Committing first would destroy the observations if the state write threw.
    assert.equal((await h.store.read()).usage.fiveHourResetAt, 30_000,
      'the import must already be durable when its files are deleted');
  };
  await reconcileOnce(h.deps);
  assert.deepEqual(committed, [1], 'an imported batch must be committed exactly once');
});

test('the lease re-check sees the same heartbeats the selection did', async () => {
  // The re-check used to be handed a heartbeat map narrowed to the selected run,
  // so every other run fell back to its persisted heartbeat. A run that the
  // ledger shows is healthy then looked stale to the re-check, the re-check
  // picked it instead, the decisions disagreed, and the pass skipped — for ever,
  // while the genuinely due run was never resumed.
  const busy = run({
    runId: 'a-busy', scheduledResumeAt: 100, scheduledResetAt: now - 5, scheduleState: 'pending',
    lastHeartbeatAt: now - 99_999, nextExpectedTickAt: null,
  });
  const h = await harness(busy, {
    readHeartbeats: async () => ({ 'a-busy': now - 10 }),
    readLedgerHeartbeat: async () => null,
  });
  await h.store.update((state) => {
    state.runs['b-due'] = run({
      runId: 'b-due', sessionId: '00000000-0000-4000-8000-000000000002',
      state: 'RATE_LIMITED', rateLimitedUntil: now - 1_000, resetConfidence: 'exact',
      lastHeartbeatAt: now - 99_999, nextExpectedTickAt: null,
    });
    return state;
  });

  const result = await reconcileOnce(h.deps);
  assert.equal(result.code, 'action:runner-started');
  assert.equal(h.spawnCalls[0].runId, 'b-due');
});

test('reconciler leases and detached-spawns one stale run', async () => {
  const h = await harness(run());
  const result = await reconcileOnce(h.deps);
  assert.equal(result.code, 'action:runner-started');
  assert.equal(h.spawnCalls.length, 1);
  assert.equal((await h.store.read()).runs['run-1'].state, 'RECOVERING');
});

test('empty reset notification is finalized once', async () => {
  const h = await harness(run({ state: 'COMPLETED', updatedAt: now }));
  await h.store.update((state) => {
    state.usage.confidence = 'exact';
    state.usage.fiveHourResetAt = now - defaultConfig().graceSeconds;
    return state;
  });
  let notifications = 0;
  h.deps.notifyWindow = async () => { notifications += 1; };
  const result = await reconcileOnce(h.deps);
  assert.equal(result.code, 'action:notify-window-reset');
  assert.equal(notifications, 1);
  assert.equal((await h.store.read()).activation.handledResetAt, now - defaultConfig().graceSeconds);
});

test('empty reset auto mode detached-spawns activation runner', async () => {
  const h = await harness(run({ state: 'COMPLETED', updatedAt: now }), { config: { ...defaultConfig(), windowMode: 'auto' } });
  await h.store.update((state) => {
    state.usage.confidence = 'exact';
    state.usage.fiveHourResetAt = now - defaultConfig().graceSeconds;
    return state;
  });
  h.deps.spawnRunner = (attempt) => { h.spawnCalls.push(attempt); return { pid: 5150, unref() {} }; };
  h.deps.processStartedAt = async () => 1_700_000_000_000;
  const result = await reconcileOnce(h.deps);
  assert.equal(result.code, 'action:activation-runner-started');
  assert.equal(h.spawnCalls[0].kind, 'activation');
  // Counted at lease time: an activation whose runner crashes never finalizes,
  // so a cap counted at finalize would never trip and activations run unbounded.
  const activation = (await h.store.read()).activation;
  assert.deepEqual(activation.activationAttempts, [now]);
  // And the claim is verifiable from the first second: without an identity, a
  // sleeping machine expires the lease and a second activation starts on top of a
  // live one. Same rule as a recovery runner.
  assert.equal(activation.pid, 5150);
  assert.equal(activation.startedAt, 1_700_000_000_000);
});

test('fresh heartbeat after provisional selection prevents spawn', async () => {
  const h = await harness(run(), { readLedgerHeartbeat: async () => now });
  const result = await reconcileOnce(h.deps);
  assert.equal(result.code, 'skip:heartbeat-fresh');
  assert.equal(h.spawnCalls.length, 0);
});

test('post-reset heartbeat handles schedule without spawn', async () => {
  const h = await harness(run({ scheduledResetAt: now - 100, scheduledResumeAt: now - 10, scheduleState: 'pending' }), {
    readLedgerHeartbeat: async () => now - 50,
  });
  const result = await reconcileOnce(h.deps);
  assert.equal(result.code, 'skip:heartbeat-satisfied-reset');
  assert.equal(h.spawnCalls.length, 0);
  assert.equal((await h.store.read()).runs['run-1'].scheduleState, 'handled');
});

test('dry run reports action without writing lease or spawning', async () => {
  const h = await harness(run(), { dryRun: true });
  const before = await h.store.read();
  const result = await reconcileOnce(h.deps);
  assert.equal(result.code, 'action:would-start-runner');
  assert.equal(h.spawnCalls.length, 0);
  assert.equal((await h.store.read()).runs['run-1'].recoveryLease.attemptId, before.runs['run-1'].recoveryLease.attemptId);
});
