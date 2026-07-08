# CLAUDE.md

Read [`AGENTS.md`](AGENTS.md) first — it is the canonical instruction file for
this repository and everything there applies.

Claude Code specifics:

- Skills are addressed as `afk-skills:<name>`; their bundled `.mjs` helpers
  resolve via `${CLAUDE_PLUGIN_ROOT}` (set by the plugin installer). Under a
  drop-in install that variable is unset, so skills fall back to the `pluginRoot`
  recorded in `.afk/config.md`.
- When the user types `/<skill-name>`, invoke the matching skill.
