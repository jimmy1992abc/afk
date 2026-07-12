import assert from 'node:assert/strict';
import test from 'node:test';

import { platformAdapter } from '../../scripts/supervisor/platform.mjs';
import { renderLaunchAgent } from '../../scripts/supervisor/platform-macos.mjs';
import { createWindowsAdapter, renderWindowsTask } from '../../scripts/supervisor/platform-windows.mjs';
import { processStartedAt, runnerLiveness } from '../../scripts/supervisor/platform.mjs';

test('LaunchAgent runs at load and every 60 seconds with escaped paths', () => {
  const plist = renderLaunchAgent({ nodePath: '/Library/Node & Tools/node', workerPath: '/User Data/supervisor.mjs', stdoutPath: '/Logs/out.log', stderrPath: '/Logs/error.log' });
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
  assert.match(plist, /Node &amp; Tools/);
});

test('Windows task quotes paths with spaces and ignores overlapping instances', () => {
  const xml = renderWindowsTask({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', workerPath: 'C:\\User Data\\supervisor.mjs' });
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /&quot;C:\\User Data\\supervisor\.mjs&quot;/);
  assert.match(xml, /<Interval>PT1M<\/Interval>/);
  assert.match(xml, /<LogonTrigger>/);
});

test('the scheduler pins the data root it installed into', () => {
  // The worker otherwise re-derives its root from its own environment, which the
  // scheduler does not share. Setup and the running supervisor would then use
  // two different state directories and the supervisor would never see a run.
  const values = { nodePath: 'node.exe', workerPath: 'C:\\data\\worker\\supervisor.mjs', userId: 'OMEN\\jimmy', dataRoot: 'C:\\data' };
  assert.match(renderWindowsTask(values), /--root &quot;C:\\data&quot;/);
  assert.match(
    renderLaunchAgent({ ...values, workerPath: '/data/worker/supervisor.mjs', dataRoot: '/data', stdoutPath: '/dev/null', stderrPath: '/dev/null' }),
    /<string>--root<\/string>\s*<string>\/data<\/string>/,
  );
});

test('the Windows logon trigger is scoped to the installing user', () => {
  // A LogonTrigger with no UserId means "at log on of ANY user", which Task
  // Scheduler only lets an administrator register. Windows setup fails outright
  // with "Access is denied" for every ordinary user without this.
  const xml = renderWindowsTask({ nodePath: 'node.exe', workerPath: 'supervisor.mjs', userId: 'OMEN\\jimmy' });
  assert.match(xml, /<LogonTrigger>[^<]*<Enabled>true<\/Enabled><UserId>OMEN\\jimmy<\/UserId>/);
  assert.match(xml, /<Principal id="Author"><UserId>OMEN\\jimmy<\/UserId>/);
});

test('the Windows task keeps running on battery power', () => {
  const xml = renderWindowsTask({ nodePath: 'node.exe', workerPath: 'supervisor.mjs' });
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.doesNotMatch(xml, /<ExecutionTimeLimit>PT1M<\/ExecutionTimeLimit>/);
});

test('the Windows task document is written as UTF-16 with a byte-order mark', async () => {
  const written = [];
  const adapter = createWindowsAdapter({
    writeFile: async (path, content, encoding) => written.push({ path, content, encoding }),
    execFile: async () => ({}),
  });
  await adapter.installScheduler({ nodePath: 'node.exe', workerPath: 'supervisor.mjs', taskXmlPath: 'task.xml' });
  const bytes = Buffer.from(written[0].content, written[0].encoding);
  assert.equal(written[0].encoding, 'utf16le');
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xfe]);
});

test('a Windows notification is detached and never awaited by the caller', async () => {
  const spawned = [];
  const adapter = createWindowsAdapter({ spawnDetached: (file, args) => { spawned.push({ file, args }); return { pid: 1 }; } });
  await adapter.notify('title', 'message', { notifyScript: 'notify.ps1' });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].file, 'powershell.exe');
  assert.ok(spawned[0].args.includes('notify.ps1'));
});

test('scheduler status asks the operating system whether the task exists', async () => {
  const queries = [];
  const failing = createWindowsAdapter({
    execFile: async (file, args) => { queries.push([file, ...args]); return { error: new Error('not found') }; },
  });
  const missing = await failing.queryScheduler({ taskXmlPath: 'task.xml' });
  assert.deepEqual(queries[0], ['schtasks.exe', '/query', '/tn', 'AFK Supervisor']);
  assert.equal(missing.registered, false);

  const present = createWindowsAdapter({ execFile: async () => ({ stdout: 'AFK Supervisor' }) });
  assert.equal((await present.queryScheduler({})).registered, true);
});

test('platformAdapter rejects unsupported systems', () => {
  assert.equal(platformAdapter('darwin', {}).name, 'macos');
  assert.equal(platformAdapter('win32', {}).name, 'windows');
  assert.throws(() => platformAdapter('linux', {}), /unsupported platform/);
});

test('a recycled pid is not our runner', async () => {
  // A pid is not an identity: the OS reuses it, aggressively on Windows. Only a
  // process whose start time matches the one the runner recorded is that runner.
  // That is what lets a live pid be trusted with no time bound at all — which
  // suspend requires, because suspend stops the very timers a time bound needs.
  const LSTART = 'Wed Nov 15 03:33:20 2023';
  const started = Date.parse(LSTART);
  const deps = { platform: 'darwin', execFile: async () => ({ stdout: LSTART }) };

  assert.equal(await runnerLiveness({ pid: 4242, startedAt: started }, deps), 'alive');
  assert.equal(await runnerLiveness({ pid: 4242, startedAt: started - 900_000 }, deps), 'dead',
    'a process wearing a recycled number must never pass as our runner');
  assert.equal(await runnerLiveness({ pid: 4242, startedAt: null }, deps), 'unknown',
    'a claim with no recorded identity can never be verified, only distrusted');
  assert.equal(await runnerLiveness({ pid: null }, deps), 'dead');

  // `ps -p` exits 1 to say "no such process". That is an answer, and it means dead.
  const absent = { platform: 'darwin', execFile: async () => { throw Object.assign(new Error('no such process'), { code: 1 }); } };
  assert.equal(await runnerLiveness({ pid: 4242, startedAt: started }, absent), 'dead');
});

test('an orphaned Claude keeps the run occupied even when its runner is gone', async () => {
  // The claim recorded the RUNNER's identity. But the thing that actually drives the
  // session is the `claude --resume` child, and it outlives its runner: Windows does
  // not kill a child when its parent dies, and on POSIX the child has its own process
  // group. A runner killed by the OOM killer, or a killTree that failed, therefore
  // left a live Claude writing to the session while the claim read `dead` — and the
  // supervisor started a SECOND Claude on top of it. The run is occupied while either
  // process is alive.
  const runnerStarted = 1_700_000_000_000;
  const childStarted = 1_700_000_005_000;
  const probe = (pid) => (pid === 9001 ? childStarted : null);   // the runner is gone; the child is not
  const deps = {
    platform: 'darwin',
    execFile: async (file, args) => {
      const pid = Number(args[1]);
      const started = probe(pid);
      if (started === null) throw Object.assign(new Error('no such process'), { code: 1 });
      return { stdout: new Date(started).toUTCString() };
    },
  };
  const claim = {
    pid: 4242, startedAt: runnerStarted,
    childPid: 9001, childStartedAt: Date.parse(new Date(childStarted).toUTCString()),
  };
  assert.equal(await runnerLiveness(claim, deps), 'alive');
});

test('a probe that could not run is unknown, never dead', async () => {
  // This test used to assert the opposite, and so certified the defect: ANY throw
  // from the probe was read as "the process is gone". On a host where the probe
  // itself cannot execute — a locked-down box, an ExecutionPolicy, a PATH problem,
  // a transient EPERM — every live runner read as dead and the supervisor started
  // a second Claude on top of each one. Not being able to ask is not an answer.
  const started = Date.parse('Wed Nov 15 03:33:20 2023');
  const spawnFailed = Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' });
  const cannotAsk = { platform: 'darwin', execFile: async () => { throw spawnFailed } };
  assert.equal(await runnerLiveness({ pid: 4242, startedAt: started }, cannotAsk), 'unknown');

  const powershellBroke = { platform: 'win32', execFile: async () => { throw new Error('ExecutionPolicy'); } };
  assert.equal(await runnerLiveness({ pid: 4242, startedAt: started }, powershellBroke), 'unknown');

  // An absent process is empty stdout and exit 0. Anything else that will not parse
  // is a probe answering incoherently, and reading THAT as "gone" fails open — a
  // second Claude on a live run.
  const garbled = { platform: 'win32', execFile: async () => ({ stdout: 'Get-Process : Access is denied.' }) };
  assert.equal(await runnerLiveness({ pid: 4242, startedAt: started }, garbled), 'unknown');

  const timedOut = { platform: 'darwin', execFile: async () => { throw Object.assign(new Error('timed out'), { killed: true, code: 1 }); } };
  assert.equal(await runnerLiveness({ pid: 4242, startedAt: started }, timedOut), 'unknown',
    'a probe we killed for hanging told us nothing about the process');
});

test('the liveness probe cannot hang the supervisor', async () => {
  // launchd has no ExecutionTimeLimit, so a hung `ps` would stall the whole
  // supervisor indefinitely under its single-job semantics.
  const seen = [];
  await processStartedAt(4242, {
    platform: 'darwin',
    execFile: async (file, args, options) => { seen.push(options); return { stdout: 'Wed Nov 15 03:33:20 2023' }; },
  });
  assert.ok(seen[0]?.timeout > 0, 'the probe must be bounded');
});
