// relay.mjs — shared core for the agent-relay dev workflow.
//
// Holds the pieces every entry script shares: env-flag parsing, the
// enabled/manual/strict gating semantics, the SKIPPED/ERROR/content marker
// protocol (parseable like codex-gate.mjs), a small CLI arg parser, and the
// AGENT BRIEF / AGENT SCOPE output validators.
//
// Development-time tooling only — never wire this into a production/runtime
// code path.

// ----- env flag helpers ------------------------------------------------------

const ON = new Set(['on', '1', 'true', 'yes', 'enabled']);
const OFF = new Set(['off', '0', 'false', 'no', 'disabled']);

export function isOn(v) {
  return ON.has(String(v ?? '').trim().toLowerCase());
}
export function isOff(v) {
  return OFF.has(String(v ?? '').trim().toLowerCase());
}

export function envInt(env, name, def) {
  const v = parseInt(String(env?.[name] ?? '').trim(), 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

// A relay-domain error carries a stable `code` so callers can branch without
// string-matching messages. `relay: true` marks it as one we produced.
export function relayError(code, message) {
  const e = new Error(message);
  e.code = code;
  e.relay = true;
  return e;
}

// ----- gating ----------------------------------------------------------------
//
// AGENT_RELAY_ENABLED (default off) gates AUTOMATIC paths only. A `--manual`
// invocation (the skill always passes it) bypasses the master switch. The
// hook additionally needs AGENT_RELAY_HOOK=on. AGENT_RELAY_STRICT flips
// graceful skips into hard failures.

export function gate(args, env) {
  const manual = !!args.manual;
  const enabled = isOn(env.AGENT_RELAY_ENABLED);
  const hook = isOn(env.AGENT_RELAY_HOOK);
  const strict = isOn(env.AGENT_RELAY_STRICT);
  const shouldSkip = !manual && !enabled;
  return {
    manual,
    enabled,
    hook,
    strict,
    shouldSkip,
    skipReason:
      'AGENT_RELAY_ENABLED is off and this is not a --manual invocation ' +
      '(automatic relay disabled)',
  };
}

// ----- marker protocol -------------------------------------------------------

export function markerBlock(label, content) {
  return `===== ${label} =====\n${content}\n===== END ${label} =====\n`;
}
export function skipBlock(label, reason) {
  return markerBlock(label, `SKIPPED: ${reason}`);
}
export function errorBlock(label, reason) {
  return markerBlock(label, `ERROR: ${reason}`);
}

// Pull just the labelled block out of a model response, trimming any prose the
// model added before/after. Returns null if the block (incl. END marker) is not
// present — which is itself a validation failure (catches truncation).
export function extractBlock(text, label) {
  const re = new RegExp(
    `=====\\s*${label}\\s*=====([\\s\\S]*?)=====\\s*END ${label}\\s*=====`,
  );
  const m = String(text ?? '').match(re);
  return m ? `===== ${label} =====${m[1]}===== END ${label} =====\n` : null;
}

// ----- output validators ------------------------------------------------------

export function validateBrief(text) {
  const t = String(text ?? '');
  const missing = [];
  if (!/=====\s*AGENT BRIEF\s*=====/.test(t)) missing.push('start marker');
  if (!/=====\s*END AGENT BRIEF\s*=====/.test(t)) missing.push('end marker');
  for (let n = 1; n <= 6; n++) {
    if (!new RegExp(`(^|\\n)\\s*${n}\\.`).test(t)) missing.push(`section ${n}`);
  }
  return { ok: missing.length === 0, missing };
}

export function validateScope(text) {
  const t = String(text ?? '');
  const missing = [];
  if (!/=====\s*AGENT SCOPE\s*=====/.test(t)) missing.push('start marker');
  if (!/=====\s*END AGENT SCOPE\s*=====/.test(t)) missing.push('end marker');
  if (!/Title\s*:/i.test(t)) missing.push('Title');
  if (!/Acceptance/i.test(t)) missing.push('Acceptance criteria');
  return { ok: missing.length === 0, missing };
}

// ----- CLI arg parser --------------------------------------------------------
//
// Supports: --manual (bool); --task/--provider/--model (single value);
// --diff (optional value — bare --diff means "default base"); --issue/--grep
// (repeatable single); --files/--logs (multi-value until the next --flag).

export function parseArgs(argv) {
  const out = { _: [], files: [], logs: [], grep: [], issue: [] };
  const isFlag = (s) => typeof s === 'string' && s.startsWith('--');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manual') {
      out.manual = true;
    } else if (a === '--task') {
      out.task = argv[++i];
    } else if (a === '--provider') {
      out.provider = argv[++i];
    } else if (a === '--model') {
      out.model = argv[++i];
    } else if (a === '--diff') {
      if (argv[i + 1] !== undefined && !isFlag(argv[i + 1])) out.diff = argv[++i];
      else out.diff = '';
    } else if (a === '--issue') {
      if (argv[i + 1] !== undefined && !isFlag(argv[i + 1])) out.issue.push(argv[++i]);
    } else if (a === '--grep') {
      if (argv[i + 1] !== undefined && !isFlag(argv[i + 1])) out.grep.push(argv[++i]);
    } else if (a === '--files') {
      while (argv[i + 1] !== undefined && !isFlag(argv[i + 1])) out.files.push(argv[++i]);
    } else if (a === '--logs') {
      while (argv[i + 1] !== undefined && !isFlag(argv[i + 1])) out.logs.push(argv[++i]);
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function parseExcludeList(v) {
  return String(v ?? '')
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
