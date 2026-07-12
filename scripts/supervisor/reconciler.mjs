import { randomUUID } from 'node:crypto';

import { applyUsageObservation } from './usage-provider.mjs';
import { pruneState, selectCandidate, transitionRun, usableHeartbeat } from './state-machine.mjs';

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

// A lease that expired while its machine slept still has a live runner behind it.
// A pid alone is not proof for ever, though: Windows recycles pids, so once a
// lease is older than a whole action timeout the pid is no longer believed —
// otherwise one recycled pid would wedge that run permanently.
async function aliveRunIds(state, deps, now) {
  const alive = new Set();
  for (const [runId, run] of Object.entries(state.runs)) {
    const lease = run.lease;
    if (!Number.isFinite(lease?.pid)) continue;
    const abandoned = Number.isFinite(lease.expiresAt)
      && now - lease.expiresAt > deps.config.recoveryAttemptTimeoutSeconds;
    if (abandoned) continue;
    if (await deps.isRunnerAlive(lease.pid)) alive.add(runId);
  }
  return alive;
}

export async function reconcileOnce(deps) {
  const now = deps.now();
  const batch = await deps.readObservationBatch();
  const heartbeats = await deps.readHeartbeats();
  let state = await deps.store.update((current) => {
    pruneState(current, deps.config, now);
    return batch.length > 0 ? applyBatch(current, batch, deps.config) : current;
  });
  if (batch.length > 0) {
    await deps.commitObservationBatch(batch);
  }
  const aliveRuns = await aliveRunIds(state, deps, now);
  const inputs = { heartbeats, aliveRuns };
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
      if (run) current.runs[decision.runId] = { ...run, scheduleState: 'handled', scheduleOutcome: decision.code, updatedAt: now };
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
      lease: { attemptId, token, lastRenewedAt: now, expiresAt, pid: null },
      scheduleState: run.scheduleState === 'pending' ? 'leased' : run.scheduleState,
    };
    attempt = { id: attemptId, token, runId: decision.runId, sessionId: run.sessionId, cwd: run.cwd, ledgerPath: run.ledgerPath };
    return current;
  });
  if (!attempt) return { code: 'skip:state-changed' };
  deps.spawnRunner(attempt).unref();
  return { code: 'action:runner-started', attemptId };
}
