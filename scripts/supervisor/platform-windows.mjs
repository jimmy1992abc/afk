import { xmlEscape } from './platform.mjs';

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
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT1M</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>${xmlEscape(values.nodePath)}</Command><Arguments>${argumentsValue}</Arguments></Exec></Actions>
</Task>
`;
}

export function createWindowsAdapter(deps = {}) {
  return {
    name: 'windows',
    intervalSeconds: 60,
    async installScheduler(values) {
      await deps.writeFile(values.taskXmlPath, renderWindowsTask(values), 'utf16le');
      await deps.execFile('schtasks.exe', ['/create', '/tn', 'AFK Supervisor', '/xml', values.taskXmlPath, '/f']);
    },
    async uninstallScheduler() {
      await deps.execFile('schtasks.exe', ['/delete', '/tn', 'AFK Supervisor', '/f'], { allowFailure: true });
    },
    async notify(title, message, values) {
      return deps.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', values.notifyScript, '-Title', title, '-Message', message]);
    },
  };
}
