# AFK Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dependency-free macOS and Windows supervisor that preserves AFK sessions across usage-window resets, frontend exits, sleep, login, and reboot.

**Architecture:** A short OS-scheduled reconciler selects work under an atomic state lock and detached-spawns a lease-renewing runner. Exact usage comes from a chained status-line bridge; headless retry frames only classify quota outcomes; window anchors and per-run upper bounds provide estimated fallback recovery.

**Tech Stack:** Node.js ESM, built-in `node:test`, JSON/JSONL, launchd plist, Windows Task Scheduler XML and PowerShell.

## Global Constraints

- Keep the existing approximately 15-minute AFK tick and ledger as the in-session continuity layer.
- Use dependency-free Node ESM and built-in operating-system facilities only.
- Never make a real Claude request in automated tests.
- Mutable global state must live under `~/Library/Application Support/afk-supervisor/` or `%LOCALAPPDATA%/afk-supervisor/`, never in the plugin cache.
- Use atomic writes, schema validation, migrations, short locks, revision compare-and-set, bounded logs, and distinct skip reasons.
- Use `claude --resume <session-id> --print --verbose --output-format stream-json` for AFK recovery.
- Exact five-hour and seven-day reset timestamps come only from documented status-line JSON.
- Estimated resets never arm the proactive 90% queue.
- Preserve and chain an existing user status-line command; setup and uninstall are explicit and idempotent.
- Do not log credentials, prompts, transcripts, repository contents, or rendered API errors.
- Bump the plugin version and regenerate every manifest because bundled scripts, hooks, and skills change.

---

### Task 1: State schema, configuration, atomic store, and lock

**Files:**

- Create: `scripts/supervisor/constants.mjs`
- Create: `scripts/supervisor/config.mjs`
- Create: `scripts/supervisor/state-store.mjs`
- Create: `scripts/supervisor/lock.mjs`
- Create: `test/supervisor/state-store.test.mjs`
- Create: `test/supervisor/lock.test.mjs`

**Interfaces:**

- Produces: `defaultConfig()`, `validateConfig(value)`, `defaultState()`, `migrateState(value)`, `StateStore`, `withFileLock(options, fn)`.
- `StateStore` methods: `read()`, `write(next, expectedRevision)`, `update(mutator)`.
- State writes increment `revision`; stale revisions throw `StateConflictError`.

- [ ] **Step 1: Write failing state and lock tests**

```js
test('write increments revision and rejects stale compare-and-set', async () => {
  const store = new StateStore(tempRoot);
  const initial = await store.read();
  const saved = await store.write({ ...initial, usage: { ...initial.usage, confidence: 'estimated' } }, 0);
  assert.equal(saved.revision, 1);
  await assert.rejects(() => store.write(initial, 0), StateConflictError);
});

test('stale lock is replaced but live lock is retained', async () => {
  await writeLock(tempRoot, { token: 'old', expiresAt: now - 1 });
  const value = await withFileLock({ root: tempRoot, now: () => now }, async () => 'ok');
  assert.equal(value, 'ok');
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/supervisor/state-store.test.mjs test/supervisor/lock.test.mjs`
Expected: FAIL with missing module errors for `state-store.mjs` and `lock.mjs`.

- [ ] **Step 3: Implement schema, migration, atomic writes, and stale lock recovery**

```js
export class StateConflictError extends Error {}

export class StateStore {
  constructor(root, io = defaultIo) { this.root = root; this.io = io; }
  async read() { return migrateState(await readJsonOrDefault(this.path, defaultState())); }
  async write(next, expectedRevision) {
    const current = await this.read();
    if (current.revision !== expectedRevision) throw new StateConflictError('state revision changed');
    const saved = validateState({ ...next, revision: expectedRevision + 1 });
    await atomicWriteJson(this.path, saved, this.io);
    return saved;
  }
}
```

- [ ] **Step 4: Verify GREEN and full regression**

Run: `node --test test/supervisor/state-store.test.mjs test/supervisor/lock.test.mjs && node --test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/supervisor/constants.mjs scripts/supervisor/config.mjs scripts/supervisor/state-store.mjs scripts/supervisor/lock.mjs test/supervisor/state-store.test.mjs test/supervisor/lock.test.mjs
git commit -m "feat: add supervisor state store"
```

### Task 2: Usage observations, status-line parser, scheduling, and retention

**Files:**

- Create: `scripts/supervisor/usage-provider.mjs`
- Create: `scripts/supervisor/observation-inbox.mjs`
- Create: `scripts/supervisor/statusline-bridge.mjs`
- Create: `test/supervisor/usage-provider.test.mjs`
- Create: `test/supervisor/observation-inbox.test.mjs`

**Interfaces:**

- Produces: `parseStatuslineSnapshot(json, observedAt)`, `publishObservation(root, snapshot)`, `readObservationBatch(root)`, `applyUsageObservation(state, observation, config)`, `stableJitterSeconds(run, resetAt, config)`.
- Status-line `resets_at` accepts plausible Unix epoch seconds only; `/usage` ISO strings are rejected.

- [ ] **Step 1: Write failing provider and inbox tests**

```js
test('exact 90 percent observation schedules every recoverable run once', () => {
  const next = applyUsageObservation(stateWithRuns(['a', 'b']), exactSnapshot({ used: 90, resetAt: 2_000 }), config);
  for (const run of Object.values(next.runs)) {
    assert.ok(run.scheduledResumeAt >= 2_060 && run.scheduledResumeAt <= 2_180);
  }
  assert.deepEqual(applyUsageObservation(next, exactSnapshot({ used: 91, resetAt: 2_000 }), config), next);
});

test('estimated reset never arms threshold schedules', () => {
  const next = applyUsageObservation(stateWithRuns(['a']), estimatedSnapshot(2_000), config);
  assert.equal(next.runs.a.scheduledResumeAt, null);
});

test('bridge throttles unchanged snapshots but publishes reset changes', async () => {
  assert.equal(await publishObservation(root, snapshotA), 'published');
  assert.equal(await publishObservation(root, snapshotA), 'throttled');
  assert.equal(await publishObservation(root, { ...snapshotA, fiveHourResetAt: 3_000 }), 'published');
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/supervisor/usage-provider.test.mjs test/supervisor/observation-inbox.test.mjs`
Expected: FAIL because provider and inbox modules do not exist.

- [ ] **Step 3: Implement parsing, stable jitter, account watermark, unique inbox events, and write throttling**

```js
export function stableJitterSeconds(run, resetAt, config) {
  const digest = createHash('sha256').update(`${run.runId}\0${run.sessionId}\0${resetAt}`).digest();
  const width = config.thresholdJitterMaxSeconds - config.thresholdJitterMinSeconds + 1;
  return config.thresholdJitterMinSeconds + digest.readUInt32BE(0) % width;
}

export function parseStatuslineSnapshot(value, observedAt) {
  const five = value?.rate_limits?.five_hour;
  return validateSnapshot({
    fiveHourResetAt: unixSecondsOrNull(five?.resets_at),
    fiveHourUsedPercentage: percentageOrNull(five?.used_percentage),
    observedAt,
    source: 'statusline',
    confidence: 'exact'
  });
}
```

- [ ] **Step 4: Verify GREEN and regression**

Run: `node --test test/supervisor/usage-provider.test.mjs test/supervisor/observation-inbox.test.mjs && node --test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/supervisor/usage-provider.mjs scripts/supervisor/observation-inbox.mjs scripts/supervisor/statusline-bridge.mjs test/supervisor/usage-provider.test.mjs test/supervisor/observation-inbox.test.mjs
git commit -m "feat: capture supervisor usage observations"
```

### Task 3: AFK run registration, ledger guard, and Claude hooks

**Files:**

- Create: `scripts/supervisor/ledger.mjs`
- Create: `scripts/supervisor/hook-handler.mjs`
- Create: `hooks/hooks.json`
- Create: `test/supervisor/ledger.test.mjs`
- Create: `test/supervisor/hooks.test.mjs`

**Interfaces:**

- Produces: `parseSupervisorLedger(text)`, `registerRun(store, input)`, `transitionRun(store, input)`, `handleHook(event, deps)`.
- Accepted hook events: `SessionStart` and `StopFailure`; no SessionEnd hook is installed.

- [ ] **Step 1: Write failing ledger and hook tests**

```js
test('SessionStart reconstructs only recent explicit unfinished runs', async () => {
  const active = await handleHook(sessionStart, depsWithLedger(recoverableLedger));
  assert.equal(active.code, 'action:run-reconstructed');
  assert.equal((await store.read()).runs.run1.state, 'RUNNING');
  assert.equal((await handleHook(sessionStart, depsWithLedger(completedLedger))).code, 'skip:ledger-terminal');
  assert.equal(spawn.calls.length, 0);
});

test('rate-limit StopFailure records per-run upper bound without spawning', async () => {
  await handleHook({ ...stopFailure, error: 'rate_limit' }, deps);
  const run = (await store.read()).runs.run1;
  assert.equal(run.firstRateLimitedAt, now);
  assert.equal(run.rateLimitedUntil, now + 18_000);
  assert.equal(spawn.calls.length, 0);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/supervisor/ledger.test.mjs test/supervisor/hooks.test.mjs`
Expected: FAIL because ledger and hook modules do not exist.

- [ ] **Step 3: Implement explicit ledger metadata parsing and side-effect-only hooks**

```js
export async function handleHook(event, deps) {
  if (event.hook_event_name === 'SessionStart') return reconcileSessionStart(event, deps);
  if (event.hook_event_name === 'StopFailure' && event.error === 'rate_limit') {
    return recordRateLimit(event, deps);
  }
  return { code: 'skip:hook-event-ignored' };
}
```

- [ ] **Step 4: Verify GREEN and regression**

Run: `node --test test/supervisor/ledger.test.mjs test/supervisor/hooks.test.mjs && node --test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/supervisor/ledger.mjs scripts/supervisor/hook-handler.mjs hooks/hooks.json test/supervisor/ledger.test.mjs test/supervisor/hooks.test.mjs
git commit -m "feat: register AFK supervisor runs"
```

### Task 4: State machine, reconciler, leases, quota backoff, and duplicate guard

**Files:**

- Create: `scripts/supervisor/state-machine.mjs`
- Create: `scripts/supervisor/reconciler.mjs`
- Create: `scripts/supervisor/supervisor.mjs`
- Create: `test/supervisor/state-machine.test.mjs`
- Create: `test/supervisor/reconciler.test.mjs`

**Interfaces:**

- Produces: `transitionRun(run, event)`, `selectCandidate(state, inputs, config, now)`, `reconcileOnce(deps)`, `main()`.
- `reconcileOnce` reads external files outside the lock, applies state under CAS, re-reads the selected ledger outside the lock, then leases and detached-spawns at most one runner.

- [ ] **Step 1: Write failing transition and reconciliation tests**

```js
test('stale anchor falls back to first-rate-limit upper bound', () => {
  const candidate = selectCandidate(stateWithStaleAnchor, inputs, config, now);
  assert.equal(candidate.dueAt, run.firstRateLimitedAt + 18_000 + config.graceSeconds);
});

test('fresh post-reset heartbeat handles a schedule without spawning', async () => {
  const result = await reconcileOnce(depsWithHeartbeat(resetAt + 1));
  assert.equal(result.code, 'skip:heartbeat-satisfied-reset');
  assert.equal(spawn.calls.length, 0);
});

test('capacity prevents a second runner but does not block reconciliation', async () => {
  const result = await reconcileOnce(depsWithActiveLease());
  assert.equal(result.code, 'skip:concurrency-exhausted');
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/supervisor/state-machine.test.mjs test/supervisor/reconciler.test.mjs`
Expected: FAIL because state-machine and reconciler modules do not exist.

- [ ] **Step 3: Implement legal transitions, candidate order, CAS leasing, and detached runner launch**

```js
export async function reconcileOnce(deps) {
  const external = await deps.readExternalInputs();
  const provisional = await deps.store.update(state => selectAndMerge(state, external, deps));
  if (!provisional.candidate) return provisional.result;
  const ledger = await deps.readLedger(provisional.candidate);
  const leased = await deps.store.update(state => leaseIfRevisionAndHeartbeatMatch(state, provisional, ledger, deps));
  if (!leased.attempt) return leased.result;
  deps.spawnRunner(leased.attempt, { detached: true, stdio: 'ignore' }).unref();
  return { code: 'action:runner-started', attemptId: leased.attempt.id };
}
```

- [ ] **Step 4: Verify GREEN and regression**

Run: `node --test test/supervisor/state-machine.test.mjs test/supervisor/reconciler.test.mjs && node --test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/supervisor/state-machine.mjs scripts/supervisor/reconciler.mjs scripts/supervisor/supervisor.mjs test/supervisor/state-machine.test.mjs test/supervisor/reconciler.test.mjs
git commit -m "feat: reconcile AFK supervisor runs"
```

### Task 5: Detached runner and Claude process control

**Files:**

- Create: `scripts/supervisor/claude-runner.mjs`
- Create: `scripts/supervisor/runner.mjs`
- Create: `test/supervisor/claude-runner.test.mjs`
- Create: `test/supervisor/runner.test.mjs`

**Interfaces:**

- Produces: `buildResumeArgs(run)`, `classifyStreamFrame(frame)`, `runClaude(attempt, deps)`, `runAttempt(attemptId, deps)`.
- `runAttempt` renews leases, kills the process group on quota classification or timeout, and finalizes only a matching lease token.

- [ ] **Step 1: Write failing runner tests**

```js
test('quota retry frame kills child and does not consume normal attempts', async () => {
  const result = await runClaude(attempt, depsWithFrames([{ type: 'system', subtype: 'api_retry', error: 'rate_limit', error_status: 429 }]));
  assert.equal(result.kind, 'quota');
  assert.equal(child.killed, true);
  assert.equal(result.incrementRecoveryAttempts, false);
});

test('second success in one window does not move the anchor', async () => {
  await finalizeSuccess(state, anchor + 600);
  assert.equal(state.usage.windowAnchorAt, anchor);
});

test('third consecutive quota rejection notifies and escalates backoff', async () => {
  const result = await finalizeQuota(stateWithQuotaCount(2), now, config);
  assert.equal(result.code, 'result:quota-backoff-escalated');
  assert.equal(result.run.quotaRejections.nextProbeAt, now + 86_400);
  assert.equal(notify.calls.length, 1);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/supervisor/claude-runner.test.mjs test/supervisor/runner.test.mjs`
Expected: FAIL because runner modules do not exist.

- [ ] **Step 3: Implement argument arrays, JSONL classification, renewal, process groups, timeout, anchor rules, and quota escalation**

```js
export function buildResumeArgs(run) {
  return ['--resume', run.sessionId, '--print', '--verbose', '--output-format', 'stream-json', RESUME_PROMPT];
}

export function classifyStreamFrame(frame) {
  return frame?.type === 'system' && frame?.subtype === 'api_retry' &&
    frame?.error === 'rate_limit' && Number.isInteger(frame?.error_status)
    ? { kind: 'quota', status: frame.error_status }
    : null;
}
```

- [ ] **Step 4: Verify GREEN and regression**

Run: `node --test test/supervisor/claude-runner.test.mjs test/supervisor/runner.test.mjs && node --test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/supervisor/claude-runner.mjs scripts/supervisor/runner.mjs test/supervisor/claude-runner.test.mjs test/supervisor/runner.test.mjs
git commit -m "feat: run headless AFK recovery"
```

### Task 6: Platform schedulers, stable installation, notifications, and status-line chaining

**Files:**

- Create: `scripts/supervisor/platform.mjs`
- Create: `scripts/supervisor/platform-macos.mjs`
- Create: `scripts/supervisor/platform-windows.mjs`
- Create: `scripts/supervisor/install.mjs`
- Create: `scripts/supervisor/notify-windows.ps1`
- Create: `templates/supervisor/launch-agent.plist`
- Create: `templates/supervisor/windows-task.xml`
- Create: `test/supervisor/platform.test.mjs`
- Create: `test/supervisor/install.test.mjs`

**Interfaces:**

- Produces: `platformAdapter(platform, deps)`, `renderLaunchAgent(values)`, `renderWindowsTask(values)`, `installSupervisor(options)`, `uninstallSupervisor(options)`, `repairSupervisor(options)`, `statusSupervisor(options)`.

- [ ] **Step 1: Write failing platform and idempotence tests**

```js
test('Windows XML quotes paths with spaces and ignores overlapping instances', () => {
  const xml = renderWindowsTask({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', workerPath: 'C:\\User Data\\supervisor.mjs' });
  assert.match(xml, /IgnoreNew/);
  assert.match(xml, /&quot;C:\\User Data\\supervisor\.mjs&quot;/);
});

test('repeated setup and uninstall preserve user status-line changes', async () => {
  await installSupervisor(options);
  await installSupervisor(options);
  assert.equal(settings.statusLine.command.match(/afk-supervisor/g).length, 1);
  settings.statusLine.command = 'user-new-command';
  await uninstallSupervisor(options);
  assert.equal(settings.statusLine.command, 'user-new-command');
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/supervisor/platform.test.mjs test/supervisor/install.test.mjs`
Expected: FAIL because platform and installer modules do not exist.

- [ ] **Step 3: Implement platform rendering, stable-copy replacement, scheduler commands, bounded logs, notification adapters, and marked status-line wrapper**

```js
export function platformAdapter(platform, deps) {
  if (platform === 'darwin') return createMacAdapter(deps);
  if (platform === 'win32') return createWindowsAdapter(deps);
  throw new Error(`unsupported platform: ${platform}`);
}

export async function replaceStableWorker(source, target, io) {
  const staged = `${target}.tmp-${randomUUID()}`;
  await io.copyDirectory(source, staged);
  await io.verifyWorker(staged);
  await io.atomicReplaceDirectory(staged, target);
}
```

- [ ] **Step 4: Verify GREEN and regression**

Run: `node --test test/supervisor/platform.test.mjs test/supervisor/install.test.mjs && node --test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/supervisor/platform.mjs scripts/supervisor/platform-macos.mjs scripts/supervisor/platform-windows.mjs scripts/supervisor/install.mjs scripts/supervisor/notify-windows.ps1 templates/supervisor/launch-agent.plist templates/supervisor/windows-task.xml test/supervisor/platform.test.mjs test/supervisor/install.test.mjs
git commit -m "feat: install cross-platform AFK supervisor"
```

### Task 7: Supervisor CLI and user-facing skill

**Files:**

- Create: `scripts/supervisor/cli.mjs`
- Create: `skills/afk-supervisor/SKILL.md`
- Create: `test/supervisor/cli.test.mjs`

**Interfaces:**

- Produces commands: `setup`, `status`, `enable`, `disable`, `configure`, `repair`, `uninstall`, `trigger-now`, `register`, `transition`, `lease`.

- [ ] **Step 1: Write failing CLI tests**

```js
test('configure validates values and status reports effective scheduler interval', async () => {
  assert.equal((await runCli(['configure', '--window-mode', 'notify'], deps)).code, 0);
  const status = await runCli(['status', '--json'], deps);
  assert.equal(JSON.parse(status.stdout).config.windowMode, 'notify');
  assert.equal(JSON.parse(status.stdout).scheduler.intervalSeconds, 60);
});

test('every benign skip prints a distinct reason', async () => {
  const result = await runCli(['trigger-now'], disabledDeps);
  assert.match(result.stdout, /skip:disabled/);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/supervisor/cli.test.mjs`
Expected: FAIL because CLI module does not exist.

- [ ] **Step 3: Implement argument parsing, commands, JSON status, and skill instructions with plugin-root resolution**

```js
export async function runCli(argv, deps = productionDeps()) {
  const [command, ...args] = argv;
  const handler = COMMANDS[command];
  if (!handler) return fail(`error:unknown-command:${command ?? ''}`);
  return handler(parseCommandArgs(command, args), deps);
}
```

- [ ] **Step 4: Verify GREEN and regression**

Run: `node --test test/supervisor/cli.test.mjs && node --test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/supervisor/cli.mjs skills/afk-supervisor/SKILL.md test/supervisor/cli.test.mjs
git commit -m "feat: add AFK supervisor commands"
```

### Task 8: Integrate AFK lifecycle, documentation, manifests, and release version

**Files:**

- Modify: `skills/afk/SKILL.md`
- Modify: `README.md`
- Modify: `plugin.json`
- Modify: `package.json`
- Regenerate: `.claude-plugin/marketplace.json`
- Regenerate: `.agents/plugins/marketplace.json`
- Regenerate: `.github/plugin/marketplace.json`
- Regenerate: `.codex-plugin/plugin.json`
- Create: `test/supervisor/afk-integration.test.mjs`

**Interfaces:**

- AFK kickoff registers run/session/cwd/ledger and heartbeat metadata.
- Every in-session tick calls `lease` before resumable work.
- Completion, permanent block, and auto-pause call `transition` and retain global usage state.

- [ ] **Step 1: Write failing integration assertions**

```js
test('AFK skill preserves tick and registers supervisor lifecycle', async () => {
  const text = await readFile('skills/afk/SKILL.md', 'utf8');
  assert.match(text, /approximately 15-minute/);
  assert.match(text, /afk-supervisor register/);
  assert.match(text, /afk-supervisor lease/);
  assert.match(text, /COMPLETED|BLOCKED|AUTO_PAUSED/);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/supervisor/afk-integration.test.mjs`
Expected: FAIL because the AFK skill lacks supervisor lifecycle commands.

- [ ] **Step 3: Update AFK instructions and README, bump version from `0.2.1` to `0.3.0`, then regenerate manifests**

```bash
node scripts/sync-marketplace.mjs
```

Expected: every manifest lists `afk-supervisor` and version `0.3.0`.

- [ ] **Step 4: Verify GREEN, version gate, and full regression**

Run: `node --test test/supervisor/afk-integration.test.mjs && npm run check:version -- --base origin/main && node --test`
Expected: all tests PASS and version bump check succeeds.

- [ ] **Step 5: Commit**

```bash
git add skills/afk/SKILL.md skills/afk-supervisor/SKILL.md README.md plugin.json package.json .claude-plugin/marketplace.json .agents/plugins/marketplace.json .github/plugin/marketplace.json .codex-plugin/plugin.json test/supervisor/afk-integration.test.mjs
git commit -m "feat: integrate AFK supervisor lifecycle"
```

### Task 9: Adversarial self-review and final validation

**Files:**

- Modify only files with confirmed findings from review.

**Interfaces:**

- Produces a clean, PR-ready branch with no unresolved structural finding.

- [ ] **Step 1: Review the complete diff against every design requirement**

Run: `git diff --stat origin/main...HEAD && git diff --check origin/main...HEAD && git diff origin/main...HEAD`
Expected: only AFK supervisor scope, design/plan documents, integration, tests, generated manifests, and version changes.

- [ ] **Step 2: Run targeted supervisor tests**

Run: `node --test test/supervisor/*.test.mjs`
Expected: all supervisor tests PASS with zero failures.

- [ ] **Step 3: Run every repository validation command**

```bash
node scripts/sync-marketplace.mjs --check
node scripts/lint-skills.mjs
node scripts/check-links.mjs
node scripts/scan-provenance.mjs
node scripts/check-version-bump.mjs origin/main
node --test
```

Expected: every command exits 0.

- [ ] **Step 4: Perform bounded manual dry runs without Claude requests or real scheduler mutation**

Run: `node scripts/supervisor/cli.mjs status --json`
Expected: valid JSON with explicit missing-install or installed status and no Claude request.

Run: `node scripts/supervisor/supervisor.mjs --once --dry-run`
Expected: one distinct skip/action decision, no process spawn, and no state outside the configured test/dry-run directory.

- [ ] **Step 5: Commit review fixes if needed**

```bash
git add scripts/supervisor test/supervisor hooks templates/supervisor skills/afk/SKILL.md skills/afk-supervisor/SKILL.md README.md plugin.json package.json .claude-plugin/marketplace.json .agents/plugins/marketplace.json .github/plugin/marketplace.json .codex-plugin/plugin.json
git commit -m "fix: address AFK supervisor review"
```

- [ ] **Step 6: Publish branch and open a draft PR**

```bash
git push -u origin feat/afk-supervisor
gh pr create --draft --base main --head feat/afk-supervisor --title "feat: add cross-platform AFK supervisor" --body-file "$env:TEMP\afk-supervisor-pr-body.md"
```

Expected: draft PR targets `main`, includes architecture, interface limitations, platform behavior, verification, and manual validation risks.
