import { randomUUID } from 'node:crypto';

import { applyUsageObservation } from './usage-provider.mjs';
import { pruneState, runnerOwns, selectCandidate, transitionRun, usableHeartbeat } from './state-machine.mjs';

function applyBatch(state, batch, config) {
  return batch.reduce((current, item) => applyUsageObservation(current, item.observation, config), state);
}

// The same clamp the selector applies. A ledger heartbeat from the future would
// otherwise satisfy the reset here, discard the run's schedule, and be persisted
// — after which the run reads "fresh" for ever and is never selectable again.
function heartbeatDecision(run, rawHeartbeat, config, now) {
  const heartbeat = usableHeartbeat(rawHeartbeat, now, config);
  if (Number.isFinite(run.scheduledResetAt) && Number.isFinite(heartbeat) && heartbeat > run.scheduledResetAt) {
    return 'skip:heartbeat-satisfied-reset';
  }
  if (Number.isFinite(heartbeat) && now - heartbeat < config.heartbeatStaleSeconds) {
    return 'skip:heartbeat-fresh';
  }
  return null;
}

// Liveness only has to be resolved for a lease that has already expired. While it
// is live the lease itself says the run is occupied, so the steady state costs
// nothing — the OS is asked only after a crash or a suspend.
//
// A pid is not an identity: the OS reuses it, aggressively on Windows. Only a pid
// whose process *start time* matches the one we recorded is our runner. That is
// what lets a live runner be trusted with no time bound — which suspend requires,
// because suspend stops the very timers any time bound would rely on.
//
//   alive   — our runner is still working. Occupied, and it is a real Claude
//             invocation, so it consumes a slot.
//   dead    — gone, or a stranger wearing its number. Free to re-lease.
//   unknown — we could not tell. Occupied, so we never double-drive it, but it
//             does NOT consume the global slot: an unverifiable pid must be able
//             to wedge at most its own run, never the whole supervisor.
async function resolveLiveness(state, deps, now) {
  const aliveRuns = new Set();
  const unknownRuns = new Set();
  for (const [runId, run] of Object.entries(state.runs)) {
    const lease = run.recoveryLease;
    if (!Number.isInteger(lease?.pid)) continue;
    if (runnerOwns(run, now, deps.config)) continue;

    const liveness = await deps.runnerLiveness(lease);
    if (liveness === 'alive') aliveRuns.add(runId);
    else if (liveness === 'unknown') unknownRuns.add(runId);
    else continue;

    const overdue = Number.isFinite(lease.expiresAt)
      && now - lease.expiresAt > deps.config.recoveryAttemptTimeoutSeconds;
    const quiet = !Number.isFinite(lease.stuckNotifiedAt)
      || now - lease.stuckNotifiedAt > deps.config.recoveryAttemptTimeoutSeconds;
    if (overdue && quiet) {
      await deps.notifyStuck(run, liveness);
      await deps.store.update((current) => {
        const held = current.runs[runId];
        if (held?.recoveryLease) held.recoveryLease.stuckNotifiedAt = now;
        return current;
      });
    }
  }
  return { aliveRuns, unknownRuns };
}

export async function reconcileOnce(deps) {
  const now = deps.now();
  const batch = await deps.readObservationBatch();
  const heartbeats = await deps.readHeartbeats();
  let state = await deps.store.update((current) => (
    batch.length > 0 ? applyBatch(current, batch, deps.config) : current
  ));
  if (batch.length > 0) {
    await deps.commitObservationBatch(batch);
  }
  const { aliveRuns, unknownRuns } = await resolveLiveness(state, deps, now);
  const inputs = { heartbeats, aliveRuns, unknownRuns };
  // Pruning asks the same runnability question the selector does, so it can only
  // run once liveness is known: a run held by a live runner is waiting, not
  // abandoned, and deleting it is how the mechanism meant to resume it destroyed
  // it instead.
  state = await deps.store.update((current) => pruneState(current, deps.config, now, inputs));
  const decision = selectCandidate(state, inputs, deps.config, now);
  if (decision.kind === 'notify') {
    if (deps.dryRun) return { code: 'action:would-notify-window' };
    await deps.notifyWindow(decision);
    await deps.store.update((current) => {
      current.activation.handledResetAt = decision.resetAt;
      current.activation.lastResult = decision.code;
      return current;
    });
    return { code: decision.code };
  }
  if (decision.kind === 'activate') {
    if (deps.dryRun) return { code: 'action:would-activate-window' };
    const attemptId = deps.randomUUID?.() ?? randomUUID();
    let attempt = null;
    await deps.store.update((current) => {
      const currentDecision = selectCandidate(current, inputs, deps.config, now);
      if (currentDecision.kind !== 'activate' || currentDecision.resetAt !== decision.resetAt) return current;
      const token = deps.randomUUID?.() ?? randomUUID();
      current.activation = {
        ...current.activation, inProgress: true, attemptId, token,
        resetAt: decision.resetAt, lastAttemptAt: now,
        lastRenewedAt: now,
        expiresAt: now + deps.config.leaseRenewalSeconds * deps.config.leaseMissedRenewals,
        lastResult: 'action:activation-leased',
        // The attempt counts from the moment it is leased, not from the moment it
        // finishes. An activation whose runner crashes never finalizes, so a cap
        // counted at finalize never trips and activations run without bound.
        activationAttempts: [...current.activation.activationAttempts, now],
      };
      attempt = { id: attemptId, token, kind: 'activation', resetAt: decision.resetAt };
      return current;
    });
    if (!attempt) return { code: 'skip:state-changed' };
    deps.spawnRunner(attempt).unref();
    return { code: 'action:activation-runner-started', attemptId };
  }
  if (decision.kind === 'handle') {
    await deps.store.update((current) => {
      const run = current.runs[decision.runId];
      if (!run) return current;
      // The same write the invoke path performs for the same decision. The two
      // used to diverge, one persisting the heartbeat that satisfied the reset and
      // the other not.
      const heartbeat = usableHeartbeat(heartbeats[decision.runId], now, deps.config);
      current.runs[decision.runId] = {
        ...run, scheduleState: 'handled', scheduleOutcome: decision.code, updatedAt: now,
        ...(Number.isFinite(heartbeat) ? { lastHeartbeatAt: heartbeat } : {}),
      };
      return current;
    });
    return { code: decision.code };
  }
  if (decision.kind !== 'invoke') return { code: decision.code };
  if (deps.dryRun) return { code: 'action:would-start-runner', runId: decision.runId };

  const heartbeat = await deps.readLedgerHeartbeat(state.runs[decision.runId]);
  const fresh = heartbeatDecision(state.runs[decision.runId], heartbeat, deps.config, now);
  if (fresh) {
    if (fresh === 'skip:heartbeat-satisfied-reset') {
      await deps.store.update((current) => {
        const run = current.runs[decision.runId];
        if (run) current.runs[decision.runId] = { ...run, scheduleState: 'handled', scheduleOutcome: fresh, lastHeartbeatAt: heartbeat, updatedAt: now };
        return current;
      });
    }
    return { code: fresh };
  }

  const attemptId = deps.randomUUID?.() ?? randomUUID();
  let attempt = null;
  await deps.store.update((current) => {
    // The re-check must see the same inputs the selection did. Narrowing the
    // heartbeat map to one run makes every other run fall back to its persisted
    // heartbeat, so the re-check can disagree with the selection even though the
    // state never changed — and the pass then skips for ever.
    const recheck = { ...inputs, heartbeats: { ...heartbeats, [decision.runId]: heartbeat } };
    const currentDecision = selectCandidate(current, recheck, deps.config, now);
    if (currentDecision.kind !== 'invoke' || currentDecision.runId !== decision.runId) return current;
    const run = current.runs[decision.runId];
    const token = deps.randomUUID?.() ?? randomUUID();
    const expiresAt = now + deps.config.leaseRenewalSeconds * deps.config.leaseMissedRenewals;
    const recovering = run.state === 'RUNNING'
      ? transitionRun(transitionRun(run, 'RECOVERY_DUE', now), 'RECOVERING', now)
      : transitionRun(run.state === 'RATE_LIMITED' ? transitionRun(run, 'RECOVERY_DUE', now) : run, 'RECOVERING', now);
    current.runs[decision.runId] = {
      ...recovering,
      recoveryLease: { attemptId, token, lastRenewedAt: now, expiresAt, pid: null, startedAt: null, stuckNotifiedAt: null },
      scheduleState: run.scheduleState === 'pending' ? 'leased' : run.scheduleState,
    };
    attempt = { id: attemptId, token, runId: decision.runId, sessionId: run.sessionId, cwd: run.cwd, ledgerPath: run.ledgerPath };
    return current;
  });
  if (!attempt) return { code: 'skip:state-changed' };
  deps.spawnRunner(attempt).unref();
  return { code: 'action:runner-started', attemptId };
}
