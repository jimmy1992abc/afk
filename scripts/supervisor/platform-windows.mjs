import { defaultSpawnDetached, xmlEscape } from './platform.mjs';

// schtasks rejects a UTF-16 document that does not begin with a byte-order mark.
export const TASK_XML_BOM = '﻿';

export function renderWindowsTask(values) {
  const argumentsValue = `&quot;${xmlEscape(values.workerPath)}&quot; --once`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
    <CalendarTrigger>
      <Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <StartBoundary>2000-01-01T00:00:00</StartBoundary><Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <WakeToRun>false</WakeToRun>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xmlEscape(values.nodePath)}</Command><Arguments>${argumentsValue}</Arguments></Exec></Actions>
</Task>
`;
}

export function createWindowsAdapter(deps = {}) {
  const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached;
  const name = 'windows';
  const intervalSeconds = 60;
  return {
    name,
    intervalSeconds,
    async installScheduler(values) {
      await deps.writeFile(values.taskXmlPath, `${TASK_XML_BOM}${renderWindowsTask(values)}`, 'utf16le');
      await deps.execFile('schtasks.exe', ['/create', '/tn', 'AFK Supervisor', '/xml', values.taskXmlPath, '/f']);
    },
    // Status must ask the operating system. Reporting the configured interval back
    // to the caller would call a supervisor healthy that has no task at all.
    async queryScheduler() {
      const result = await deps.execFile('schtasks.exe', ['/query', '/tn', 'AFK Supervisor'], { allowFailure: true });
      return { platform: name, intervalSeconds, registered: !result?.error };
    },
    async uninstallScheduler(values) {
      await deps.execFile('schtasks.exe', ['/delete', '/tn', 'AFK Supervisor', '/f'], { allowFailure: true });
      await deps.unlink(values.taskXmlPath, { force: true });
    },
    async notify(title, message, values) {
      return spawnDetached('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', values.notifyScript, '-Title', title, '-Message', message]);
    },
  };
}
