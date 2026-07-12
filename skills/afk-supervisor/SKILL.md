---
name: afk-supervisor
description: Part of the afk pipeline. Install, inspect, configure, repair, trigger, or remove the cross-platform AFK supervisor. Triggers include "/afk-supervisor", "AFK supervisor status", and "set up AFK window recovery".
---

# afk-supervisor

Manage the per-user operating-system supervisor that complements the AFK
session tick. Setup is explicit. It never deploys, reads credentials, or sends a
Claude request merely to inspect status.

## Resolve the command

Resolve the plugin root from `${CLAUDE_PLUGIN_ROOT}`, then `pluginRoot` in the
repository's `.afk/config.md`, then this skill's installed directory. Invoke:

```text
node "<plugin-root>/scripts/supervisor/cli.mjs" <command>
```

## Commands

- `setup`: verify prerequisites, copy the stable worker, chain the current
  status line, and install the per-user scheduler.
- `status --json`: report installation, configuration, usage confidence, active
  runs, leases, retries, and capability limitations.
- `enable` / `disable`: toggle reconciliation without removing state.
- `configure`: accept documented global supervisor fields only.
- `repair`: refresh the stable worker and scheduler without layering wrappers.
- `trigger-now --run-id <id>`: clear inferred quota backoff for one registered
  run and reconcile it immediately.
- `uninstall`: remove scheduler integration and restore the prior status line
  only when AFK still owns it. Preserve state unless purge is explicitly added
  in a future version.

Report every action or skip code exactly. Never claim an exact reset when the
state confidence is `estimated` or `unknown`.
