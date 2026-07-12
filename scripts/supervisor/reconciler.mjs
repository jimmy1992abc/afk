import { randomUUID } from 'node:crypto';

import { applyUsageObservation } from './usage-provider.mjs';
import { pruneState, selectCandidate, transitionRun } from './state-machine.mjs';

function applyBatch(state, batch, config) {
  return batch.reduce((current, item) => applyUsageObservation(current, item.observation, config), state);
}

function heartbeatDecision(run, heartbeat, config, now) {
  if (Number.isFinite(run.scheduledResetAt) && Number.isFinite(heartbeat) && heartbeat > run.scheduledResetAt) {
    return 'skip:heartbeat-satisfied-reset';
  }
  if (Number.isFinite(heartbeat) && now - heartbeat < config.heartbeatStaleSeconds) {
    return 'skip:heartbeat-fresh';
  }
  return null;
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
  const decision = selectCandidate(state, { heartbeats }, deps.config, now);
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
      const currentDecision = selectCandidate(current, { heartbeats }, deps.config, now);
      if (currentDecision.kind !== 'activate' || currentDecision.resetAt !== decision.resetAt) return current;
      const token = deps.randomUUID?.() ?? randomUUID();
      current.activation = {
        ...current.activation, inProgress: true, attemptId, token,
        resetAt: decision.resetAt, lastAttemptAt: now,
        lastRenewedAt: now,
        expiresAt: now + deps.config.leaseRenewalSeconds * deps.config.leaseMissedRenewals,
        lastResult: 'action:activation-leased',
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

  // A lease must not be re-issued just because the previous one expired: a
  // suspended machine stops the renewal timer while the runner and its Claude
  // child stay alive, and a second runner would then resume the same session.
  const held = state.runs[decision.runId].lease;
  if (Number.isFinite(held?.pid) && await deps.isRunnerAlive(held.pid)) {
    return { code: 'skip:runner-alive', runId: decision.runId };
  }

  const attemptId = deps.randomUUID?.() ?? randomUUID();
  let attempt = null;
  await deps.store.update((current) => {
    // The re-check must see the same inputs the selection did. Narrowing the
    // heartbeat map to one run makes every other run fall back to its persisted
    // heartbeat, so the re-check can disagree with the selection even though the
    // state never changed — and the pass then skips for ever.
    const currentDecision = selectCandidate(current, { heartbeats: { ...heartbeats, [decision.runId]: heartbeat } }, deps.config, now);
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
