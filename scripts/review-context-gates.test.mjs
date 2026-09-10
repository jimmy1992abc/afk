import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { describeReviewTarget, loadReviewContext } from '../lib/gate/review-context.mjs';
import { parseTarget } from '../lib/gate/target.mjs';
import { createReviewFixture, gateTestEnv, spawnGate } from './gate-test-env.mjs';

const fixture = createReviewFixture();
after(fixture.cleanup);
const { cwd } = fixture;
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const priorRevision = fixture.commit;
writeFileSync(join(cwd, 'safe.txt'), 'Repaired target\n');
git('commit', '-qam', 'repair');
const revision = git('rev-parse', 'HEAD');
mkdirSync(join(cwd, '.afk'));
writeFileSync(join(cwd, '.git', 'info', 'exclude'), '.afk/\n');
writeFileSync(join(cwd, '.afk', 'design.md'), '# Complete design target\nPreserve all required proof.\n');
const contextPath = join(cwd, '.afk', 'history.json');
const proofPath = join(cwd, '.afk', 'proof.txt');
const proof = 'Verified 閉鎖 — "quotes" $& $` $\' $$\nF96-001 regression passed.';
const gate = (family) => fileURLToPath(new URL(`../skills/afk-${family}-review/${family}-gate.mjs`, import.meta.url));
function prepare(selector = ['--base', priorRevision], text = proof) {
  const target = parseTarget(selector, { cwd });
  writeFileSync(proofPath, text);
  const packet = {
    version: 1, target: describeReviewTarget(target, { cwd }),
    acceptance: 'The complete selected target and exact proof must reach the reviewer.', priorRevision,
    findings: [{ id: 'F96-001', disposition: 'fixed', claim: 'Required proof was absent.', evidence: [{ revision, path: 'proof.txt' }] }],
  };
  writeFileSync(contextPath, JSON.stringify(packet));
  const args = [...selector, '--review-phase=re-review', '--review-context', contextPath];
  const context = loadReviewContext({ argv: args, target, cwd });
  assert.equal(context.error, null);
  return { args, context, packet };
}
function run(family, args, env = {}) {
  return spawnGate([gate(family), ...args], { cwd, encoding: 'utf8', env: gateTestEnv(env) });
}
function stub(family) {
  const capture = join(cwd, '.afk', `${family}-capture.json`);
  const js = join(cwd, '.afk', `${family}-stub.cjs`);
  writeFileSync(js, `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture'); process.exit(0); }
if (args.includes('--help')) { console.log('Usage: kimi [options]\\n  -p, --prompt <p> prompt\\n  --output-format <f> format'); process.exit(0); }
if (args.includes('login')) { console.log('Logged in'); process.exit(0); }
let prompt = '';
if (${JSON.stringify(family)} === 'kimi') {
  prompt = args[args.indexOf('-p') + 1];
  const match = prompt.match(/^Read the review brief at (.+) in full;/);
  if (match) prompt = fs.readFileSync(match[1], 'utf8');
} else prompt = fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, prompt }));
if (${JSON.stringify(family)} === 'claude') console.log(JSON.stringify({ is_error: false, result: 'F96-001 verified.\\nAPPROVE', modelUsage: { 'claude-opus-5': {} } }));
else if (${JSON.stringify(family)} === 'codex') fs.writeFileSync(args[args.indexOf('-o') + 1], 'F96-001 verified.\\nSOUND');
else console.log('F96-001 verified.\\nAPPROVE');
`);
  const bin = join(cwd, '.afk', `${family}-stub.${process.platform === 'win32' ? 'cmd' : 'sh'}`);
  writeFileSync(bin, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(bin, 0o755);
  return { bin, capture };
}

for (const family of ['claude', 'kimi', 'codex']) {
  test(`${family} sends actual context with unchanged target and exact proof`, () => {
    const selector = family === 'codex' ? ['--design', '.afk/design.md'] : ['--base', priorRevision];
    const { args, context } = prepare(selector);
    const { bin, capture } = stub(family);
    const env = { [`${family.toUpperCase()}_GATE_BIN`]: bin };
    const result = run(family, [...args, '--implementer', family === 'codex' ? 'claude' : 'codex'], env);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const sent = JSON.parse(readFileSync(capture, 'utf8'));
    assert.ok(sent.prompt.includes(context.section));
    assert.ok(sent.prompt.includes(family === 'codex' ? 'Complete design target' : priorRevision));
    assert.equal(context.context.findings[0].evidence[0].text, proof);
    assert.ok(!sent.args.includes('--review-context'));
  });
}

for (const mode of ['shim', 'large-native']) {
  test(`Kimi ${mode} brief preserves complete Unicode context`, () => {
    const text = mode === 'large-native' ? proof + '\n' + '界 '.repeat(10000) : proof;
    const { args, context } = prepare(['--base', priorRevision], text);
    const { bin, capture } = stub('kimi');
    const result = run('kimi', [...args, '--implementer', 'codex'], {
      KIMI_GATE_BIN: bin, KIMI_GATE_FORCE_SHIM: mode === 'shim' ? '1' : '0', KIMI_GATE_CONSOLE: 'legacy',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const sent = JSON.parse(readFileSync(capture, 'utf8'));
    assert.ok(sent.prompt.includes(context.section));
    assert.ok(sent.args.join(' ').length < 3000);
    assert.match(sent.args[sent.args.indexOf('-p') + 1], /^Read the review brief/);
    if (mode === 'large-native' && process.platform !== 'win32') assert.match(result.stderr, /native brief.*no shell/);
  });
}

for (const family of ['claude', 'kimi', 'codex', 'glm', 'deepseek', 'mimo']) {
  test(`${family} refuses required missing context and duplicate context options before skip`, () => {
    for (const args of [['--review-phase', 're-review'], ['--review-context=x', '--review-context=y']]) {
      const result = run(family, ['--commit', revision, ...args], { [`${family.toUpperCase()}_REVIEW_GATE`]: 'off' });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /ERROR/);
      assert.doesNotMatch(result.stdout, /SKIPPED/);
    }
  });
}

test('native Codex diff limitation never substitutes another target or mode', () => {
  const { args } = prepare();
  const result = run('codex', [...args, '--print-args', '--implementer', 'claude']);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /native Codex diff review cannot deliver/);
  assert.match(result.stdout, /no context was delivered/);
  const plain = run('codex', ['--commit', revision, '--review-phase=initial', '--print-args', '--implementer', 'claude']);
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  const parsed = JSON.parse(plain.stdout);
  assert.ok(parsed.args.includes('review'));
  assert.ok(parsed.args.includes(revision));
  assert.ok(!parsed.args.includes('--review-phase=initial'));
});

async function httpCall(family, args, env, response, verify) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    let raw = ''; for await (const chunk of req) raw += chunk;
    verify?.(JSON.parse(raw));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const child = spawn(process.execPath, [gate(family), ...args], {
      cwd, env: gateTestEnv({ ...env, [`${family.toUpperCase()}_REVIEW_BASE_URL`]: `http://127.0.0.1:${server.address().port}` }),
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => stdout += chunk); child.stderr.on('data', (chunk) => stderr += chunk);
    const [status] = await once(child, 'close');
    return { status, stdout, stderr, calls };
  } finally { server.closeAllConnections?.(); server.close(); }
}

for (const [family, model, keyEnv, protocol] of [
  ['glm', 'glm-5.3', 'ZAI_API_KEY', 'openai'], ['glm', 'glm-5.3', 'ZAI_API_KEY', 'anthropic'],
  ['deepseek', 'deepseek-v4-pro', 'DEEPSEEK_REVIEW_API_KEY', 'openai'], ['mimo', 'mimo-v2.5-pro', 'MIMO_REVIEW_API_KEY', 'openai'],
]) {
  test(`${family} ${protocol} actual HTTP request preserves artifact digest and proof`, async () => {
    const { args, context, packet } = prepare(['--design', '.afk/design.md']);
    let payload;
    const response = protocol === 'anthropic'
      ? { model, type: 'message', content: [{ type: 'text', text: 'F96-001 verified.\nSOUND' }], stop_reason: 'end_turn' }
      : { model, choices: [{ message: { content: 'F96-001 verified.\nSOUND' }, finish_reason: 'stop' }] };
    const result = await httpCall(family, [...args, '--implementer', 'codex'], {
      [keyEnv]: 'fixture-http-key', GLM_REVIEW_PROTOCOL: protocol,
    }, response, (body) => { payload = body.messages[0].role === 'system' ? body.messages[1].content : body.messages[0].content; });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.calls, 1);
    assert.ok(payload.includes(context.section));
    assert.ok(payload.includes(packet.target.artifactDigest));
    assert.ok(payload.includes('Complete design target'));
    const metadata = run(family, [...args, '--implementer', 'codex', '--print-args'], { [keyEnv]: 'fixture-http-key', GLM_REVIEW_PROTOCOL: protocol });
    assert.equal(metadata.status, 0, metadata.stdout + metadata.stderr);
    assert.equal(JSON.parse(metadata.stdout).reviewContextDigest, context.digest);
    const preview = run(family, [...args, '--implementer', 'codex', '--print-prompt'], { [keyEnv]: 'fixture-http-key', GLM_REVIEW_PROTOCOL: protocol });
    assert.ok(preview.stdout.includes(context.section));
    const rejected = await httpCall(family, [...args, '--implementer', 'codex'], { [keyEnv]: packet.target.artifactDigest, GLM_REVIEW_PROTOCOL: protocol }, response);
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.calls, 0);
    assert.match(rejected.stdout, /credential/);
  });
}


test('HTTP rejects combined target/context overflow without shrinking either', async () => {
  const { args } = prepare(['--design', '.afk/design.md']);
  const result = await httpCall('glm', args, { ZAI_API_KEY: 'fixture-http-key', GLM_REVIEW_MAX_CTX_BYTES: '1000' }, {});
  assert.notEqual(result.status, 0);
  assert.equal(result.calls, 0);
  assert.match(result.stdout, /full snapshot plus required review-context.*no target or history was truncated/);
});


test('I96-S1 refuses existing credential-shaped proof paths without an HTTP request', async () => {
  const { args, packet } = prepare(['--design', '.afk/design.md']);
  for (const evidencePath of ['https://reader:fixture-password@host/proof.txt', 'api_key=/fixture-value/proof.txt']) {
    if (process.platform !== 'win32' || !evidencePath.includes('://')) {
      mkdirSync(dirname(join(cwd, '.afk', evidencePath)), { recursive: true });
      writeFileSync(join(cwd, '.afk', evidencePath), 'proof');
    }
    packet.findings[0].evidence = [{ revision, path: evidencePath }];
    writeFileSync(contextPath, JSON.stringify(packet));
    const result = await httpCall('glm', args, { ZAI_API_KEY: 'fixture-http-key' }, {});
    assert.notEqual(result.status, 0);
    assert.equal(result.calls, 0);
    assert.match(result.stdout, /sensitive|URL/);
    assert.ok(!result.stdout.includes('fixture-password'));
  }
});

test('I96-S2 sends the leading BOM in the actual HTTP proof unchanged', async () => {
  const text = '\uFEFF' + proof;
  const { args, context } = prepare(['--design', '.afk/design.md'], text);
  let payload;
  const result = await httpCall('glm', args, { ZAI_API_KEY: 'fixture-http-key' }, {
    model: 'glm-5.3', choices: [{ message: { content: 'SOUND' }, finish_reason: 'stop' }],
  }, (body) => { payload = body.messages[1].content; });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.calls, 1);
  assert.equal(context.context.findings[0].evidence[0].text, text);
  assert.ok(payload.includes(context.section));
});
