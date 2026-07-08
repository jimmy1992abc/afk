// codex_provider.mjs — separate adapter for the OpenAI Codex CLI.
//
// Codex is not an OpenAI-compatible HTTP endpoint: it authenticates via
// `codex login` (ChatGPT subscription, no API key) and runs as a local CLI.
//   - Availability pre-check: `codex login status` (local, no metered call).
//   - Hard timeout: AGENT_RELAY_CODEX_TIMEOUT_MS (so a hung exec can't wedge).
//   - Read-only sandbox: native `--sandbox read-only` on macOS/Linux; on
//     Windows it bypasses the OS sandbox (matching codex-gate.mjs) — safe only
//     because the call is read-only.
//
// Caller's extractBlock() pulls the marker block from captured stdout,
// independent of `--output-last-message` flag form. `spawnImpl` is injectable
// for tests.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { relayError } from './relay.mjs';

function resolveCodex(env, isWin) {
  if (isWin && env.APPDATA) {
    const shim = join(env.APPDATA, 'npm', 'codex.cmd');
    if (existsSync(shim)) return shim;
  }
  return 'codex';
}

export function makeCodexProvider() {
  return {
    name: 'codex',
    kind: 'codex-cli',
    keyEnv: null,

    available(env, spawnImpl, isWin = process.platform === 'win32') {
      const sp = spawnImpl || spawnSync;
      const codex = resolveCodex(env, isWin);
      const a = sp(codex, ['login', 'status'], { encoding: 'utf8', shell: isWin });
      if (a.error && a.error.code === 'ENOENT') {
        return {
          ok: false,
          reason: 'Codex CLI not installed (npm i -g @openai/codex && codex login)',
        };
      }
      const out = `${a.stdout || ''}${a.stderr || ''}`;
      if (/not logged in/i.test(out) || !/logged in/i.test(out)) {
        return { ok: false, reason: 'Codex not authenticated (run `codex login`)' };
      }
      return { ok: true };
    },

    // Codex uses its account/config default model. The caller already applies
    // the current role's own model env, so a provider fallback must not
    // cross-read another role's model — omit `-m` (null).
    defaultModel() {
      return null;
    },

    async complete({
      system,
      user,
      model,
      env,
      spawnImpl,
      isWin = process.platform === 'win32',
      timeoutMs = 300000,
    }) {
      const sp = spawnImpl || spawnSync;
      const codex = resolveCodex(env, isWin);
      const reasoning = String(env?.AGENT_RELAY_CODEX_REASONING ?? '').trim() || 'medium';

      // Lean context (cost): no project docs, medium reasoning — same posture as
      // codex-gate.mjs. Read-only sandbox; Windows bypasses (can't sandbox under
      // a normal token) — safe because the call only reads.
      //
      // SECURITY: the prompt carries arbitrary repo content. On Windows we need
      // shell:true to launch the codex.cmd shim, and cmd.exe would re-parse a
      // positional prompt arg — a command-injection vector. So the prompt goes
      // via STDIN (`input`), never the command line; only fixed flags are argv.
      // `codex exec` reads the prompt from stdin when no positional PROMPT given.
      const args = ['exec', '-c', `model_reasoning_effort=${reasoning}`, '-c', 'project_doc_max_bytes=0'];
      if (model) args.push('-m', model);
      if (isWin) args.push('--dangerously-bypass-approvals-and-sandbox');
      else args.push('--sandbox', 'read-only');

      const res = sp(codex, args, {
        input: `${system}\n\n${user}`,
        encoding: 'utf8',
        shell: isWin,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });

      if (res.error) {
        if (res.error.code === 'ETIMEDOUT') {
          throw relayError('timeout', `codex exec timed out after ${timeoutMs}ms`);
        }
        if (res.error.code === 'ENOENT') throw relayError('not_installed', 'codex CLI not found');
        throw relayError('codex_error', `codex exec failed: ${res.error.message}`);
      }
      // spawnSync sets `signal` (e.g. SIGTERM) when it kills on timeout.
      if (res.signal) {
        throw relayError('timeout', `codex exec killed (${res.signal}); timeout ${timeoutMs}ms`);
      }

      const text = String(res.stdout || '').trim();
      if (!text) {
        throw relayError(
          'empty',
          `codex produced no output (exit ${res.status}); stderr: ${String(res.stderr || '').slice(0, 200)}`,
        );
      }
      return { text, usage: { input: 0, output: 0, cacheRead: 0 } };
    },
  };
}
