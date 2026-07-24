---
name: afk-agent-relay
description: Part of the afk pipeline. Provider-pluggable dev-tooling that shells out to cheap/independent models so the coding agent burns fewer of its own tokens. Two roles — a context COMPRESSOR (default deepseek) that reads big context out of process and returns a 6-section brief, and a SCOPE gate (default codex) that turns a raw request into a reviewable issue draft. Development-time only; never wired into a live production system. Triggers include "/afk-agent-relay", "compress context", "relay brief", "scope this".
---

# afk-agent-relay

A small, provider-pluggable workflow that offloads two token-heavy jobs from
the coding agent to cheaper/independent models: the external model reads the
raw bytes; only a short delimited block re-enters the agent's context (same
out-of-process pattern as the external review gate skills).

```text
1. SCOPE GATE   (scope.mjs, default codex)     raw request  -> issue draft
2. COMPRESSOR   (brief.mjs, default deepseek)  big context  -> 6-section brief
3. AGENT                                        implements from the brief
4. REVIEW GATE  (external review gate — NOT part of this skill)
```

**Development-time tooling only.** It never runs against a production or
runtime code path.

## When to use the compressor (the token-saver)

Reach for it before a context-heavy task — a big issue, a large diff, long
failure logs — instead of reading all of it into your own window. **Do the cheap
discovery yourself** (glob/grep for the relevant *filenames*, `git diff --stat`),
then hand the script *pointers*, not contents. It reads the bytes out of process
and returns a compact brief — up to ~6000 tokens (a ceiling, not a target;
simple tasks get shorter briefs). It distils; it does not just truncate.

## How to run it

The bundled scripts (`brief.mjs`, `scope.mjs`, `hooks/`) sit beside this
SKILL.md. Locate their directory as `${CLAUDE_PLUGIN_ROOT}/skills/afk-agent-relay`
if the env var is set, else `<pluginRoot>/skills/afk-agent-relay` from
`.afk/config.md`, else this skill's own directory. Resolve `.afk/` from the
repository's main working tree — the first `worktree` line of
`git worktree list --porcelain` — never the current directory. Always pass
`--manual`
(bypasses the default-off `AGENT_RELAY_ENABLED` master switch). Run in the
background with a generous timeout and capture stdout to a file (the codex-backed
scope can be slow); then read the marker block.

```text
node "<relay-dir>/brief.mjs" --manual --task "<one line>" --diff main --files a.py b.py
```

Scope gate:

```text
node "<relay-dir>/scope.mjs" --manual --task "<raw request>"
```

### Flags

`--task "<one line>"` (required) · `--issue N` (repeatable; runs `gh issue view`)
· `--diff [base]` (runs `git diff`; bare = default base) · `--files a b …`
(reads files) · `--logs path …` (tails) · `--grep "pat"` (repeatable; ripgrep) ·
`--provider <name>` / `--model <id>` (override for this call).

## Reading the result

Output is one marker block: `===== AGENT BRIEF =====` … `===== END AGENT BRIEF
=====` (or `AGENT SCOPE`). Three verdicts, all parseable:

- **content** — the brief/draft. Use it.
- **`SKIPPED: …`** — no provider key, or Codex not logged in, or not a `--manual`
  call. Not a failure — just read the context yourself the normal way.
- **`ERROR: …`** — a real failure (HTTP error, codex timeout, or the model's
  output failed marker/section validation). The raw output is included; do not
  act on a malformed brief.

## Trust but verify

The brief is a **hypothesis from a cheaper model**, not ground truth. Before
acting, spot-check its file:line claims against the real files (exactly how you
triage external-gate findings). If it cites a
file/function that doesn't exist, discard that part. Never let an unverified
brief drive a risky edit.

## Swapping providers (no code change)

Roles are decoupled from models. One env var each:

- `AGENT_RELAY_SCOPE_PROVIDER` (default `codex`)
- `AGENT_RELAY_BRIEF_PROVIDER` (default `deepseek`)

Known providers: `deepseek`, `mimo`, `kimi`, `openai` (OpenAI-compatible API,
need their `DEV_*_API_KEY`) and `codex` (CLI, `codex login`). Pin a model per
role with `AGENT_RELAY_SCOPE_MODEL` / `AGENT_RELAY_BRIEF_MODEL`.

## Setup (per machine, once)

- **Compressor:** set the provider's dedicated **dev** key — e.g.
  `DEV_DEEPSEEK_API_KEY` for the default provider — as a shell env var, or in a
  gitignored `.env` a host loads before invoking these scripts. Never commit a
  key, and never reuse a production key's name for a dev key.
- **Scope (codex):** `npm i -g @openai/codex && codex login` (no API key). To
  hand a dev key to a sandboxed codex run that can't inherit it from the shell,
  set it in Codex's `.codex/config.toml` (`[shell_environment_policy.set]`) and
  gitignore `.codex/` first — that file is not a `.env`, so no default rule keeps
  its key out of `git add -A`.
- Self-skips cleanly if its key/tool is absent (dormant until configured). Set
  `AGENT_RELAY_STRICT=on` to make a missing key a hard error instead of a skip.

### Optional hybrid hook (default OFF)

`hooks/precompress-hook.mjs` is a `UserPromptSubmit` hook that auto-compresses
when a prompt references `#<issue>`. It stays dormant unless **both**
`AGENT_RELAY_ENABLED=on` and `AGENT_RELAY_HOOK=on`. Wire it in a host's local
settings (e.g. Claude Code's gitignored `.claude/settings.local.json`):

```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [
  { "type": "command", "command": "node \"<relay-dir>/hooks/precompress-hook.mjs\"" }
] } ] } }
```

## Security

Before any content leaves the machine the gather step **excludes** secret files
(`.env`, `*.pem`, `*.key`, `auth.json`, `*credentials*`, …) and **redacts**
secret-shaped strings. This is best-effort defense-in-depth, not a guarantee —
don't point `--files` at a secret and rely on redaction. Extend excludes with
`AGENT_RELAY_EXCLUDE`; disable redaction (not recommended) with
`AGENT_RELAY_REDACT=off`.
