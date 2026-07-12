import { xmlEscape } from './platform.mjs';

export function renderLaunchAgent(values) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.afk.supervisor</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(values.nodePath)}</string>
    <string>${xmlEscape(values.workerPath)}</string>
    <string>--once</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(values.stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(values.stderrPath)}</string>
</dict>
</plist>
`;
}

export function createMacAdapter(deps = {}) {
  const name = 'macos';
  const intervalSeconds = 60;
  return {
    name,
    intervalSeconds,
    async installScheduler(values) {
      const plist = renderLaunchAgent(values);
      await deps.writeFile(values.plistPath, plist, 'utf8');
      await deps.execFile('launchctl', ['unload', values.plistPath], { allowFailure: true });
      await deps.execFile('launchctl', ['load', values.plistPath]);
    },
    // Status must ask launchd. Reporting the configured interval back to the
    // caller would call a supervisor healthy that has no agent loaded.
    async queryScheduler() {
      const result = await deps.execFile('launchctl', ['list', 'com.afk.supervisor'], { allowFailure: true });
      return { platform: name, intervalSeconds, registered: !result?.error };
    },
    async uninstallScheduler(values) {
      await deps.execFile('launchctl', ['unload', values.plistPath], { allowFailure: true });
      await deps.unlink(values.plistPath, { force: true });
    },
    async notify(title, message) {
      const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
      return deps.execFile('osascript', ['-e', script]);
    },
  };
}
