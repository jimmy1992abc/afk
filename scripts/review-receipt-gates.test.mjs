import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { createReviewFixture, gateTestEnv, spawnGate } from './gate-test-env.mjs';

const fixture = createReviewFixture();
after(fixture.cleanup);
const { cwd } = fixture;
mkdirSync(join(cwd, '.afk', 'runs', 'receipt-run'), { recursive: true });
writeFileSync(join(cwd, '.git', 'info', 'exclude'), '.afk/\n');
writeFileSync(join(cwd, '.afk', 'design.md'), '# Fixture design\nRequired behavior is explicit.\n');
const gate = (family) => fileURLToPath(new URL(`../skills/afk-${family}-review/${family}-gate.mjs`, import.meta.url));
const models = { claude: 'claude-opus-5', codex: 'gpt-5.6-sol', kimi: null,
  glm: 'glm-5.3', deepseek: 'deepseek-v4-pro', mimo: 'mimo-v2.5-pro' };
let sequence = 0;
function attempt(family, overrides = {}) {
  const attemptId = `gate-${++sequence}`;
  const request = { version: 1, runId: 'receipt-run', issue: '97', attemptId, roleIndex: 0,
    profile: { source: 'flags', roles: [{ preferred: family, reviewer: family,
      model: models[family], effort: ['claude', 'codex'].includes(family) ? 'medium' : null }] }, ...overrides };
  const path = join(cwd, '.afk', `${attemptId}.json`);
  writeFileSync(path, JSON.stringify(request));
  const output = join(cwd, '.afk', 'runs', 'receipt-run', 'receipts', attemptId);
  return { args: ['--review-receipt', path], output, request,
    terminal: () => JSON.parse(readFileSync(join(output, 'terminal.json'), 'utf8')) };
}
function run(family, args, env = {}) {
  return spawnGate([gate(family), '--design', '.afk/design.md', '--implementer', family === 'codex' ? 'claude' : 'codex', ...args],
    { cwd, encoding: 'utf8', env: gateTestEnv(env) });
}
function stub(family) {
  const js = join(cwd, '.afk', `${family}-receipt-stub.cjs`);
  writeFileSync(js, `const fs=require('node:fs'); const args=process.argv.slice(2);
if(args.includes('--version')){console.log('fixture');process.exit(0);}
if(args.includes('--help')){console.log('Usage: kimi [options]\\n  -p, --prompt <p> prompt\\n  --output-format <f> format');process.exit(0);}
if(args.includes('login')){console.log('Logged in');process.exit(0);}
if(args.some(x=>x.startsWith('--review-receipt'))) throw new Error('receipt flag leaked');
if(process.env.RECEIPT_STUB_NONZERO==='1'){console.log('SOUND');process.exit(1);}
if(process.env.RECEIPT_STUB_HANG==='1') {process.stderr.write('fixture waiting\\n');setInterval(()=>{},1000);}
else if(${JSON.stringify(family)}==='claude')console.log(JSON.stringify({is_error:false,result:'Fixture review.\\nSOUND',modelUsage:{[process.env.RECEIPT_STUB_MODEL||'claude-opus-5']:{}}}));
else if(${JSON.stringify(family)}==='codex')fs.writeFileSync(args[args.indexOf('-o')+1],'Fixture review.\\nSOUND');
else console.log('Fixture review.\\nSOUND');
`);
  const path = join(cwd, '.afk', `${family}-receipt-stub.${process.platform === 'win32' ? 'cmd' : 'sh'}`);
  writeFileSync(path, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(path, 0o755);
  return { [`${family.toUpperCase()}_GATE_BIN`]: path, CODEX_GATE_NO_LOCK: '1' };
}

for (const family of Object.keys(models)) {
  test(`S1 ${family} rejects sensitive configuration before preview delivery`, () => {
    const path = join(cwd, '.afk', 'config.md');
    const secret = `sk-${'x'.repeat(24)}`;
    try {
      writeFileSync(path, `## external gate\nhead: ${secret}\n`);
      const receipt = attempt(family);
      const result = run(family, [...receipt.args, '--print-prompt']);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /sensitive metadata/);
      assert.equal(receipt.terminal().outcome.kind, 'error');
      assert.equal(receipt.terminal().input, null);
      assert.deepEqual(readdirSync(receipt.output).sort(), ['started.json', 'terminal.json']);
      assert.ok(!(result.stdout + result.stderr).includes(secret));
      for (const name of readdirSync(receipt.output)) {
        assert.ok(!readFileSync(join(receipt.output, name), 'utf8').includes(secret));
      }
    } finally { writeFileSync(path, ''); }
  });

  test(`${family} receipt captures early skip and caller error without approval`, () => {
    const skipped = attempt(family);
    const result = run(family, skipped.args, { [`${family.toUpperCase()}_REVIEW_GATE`]: 'off' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(skipped.terminal().outcome.kind, 'skipped');
    assert.equal(skipped.terminal().outcome.verdict, null);
    const failed = attempt(family);
    const error = run(family, [...failed.args, '--review-phase', 'unsupported']);
    assert.notEqual(error.status, 0);
    assert.equal(failed.terminal().outcome.kind, 'error');
  });

  test(`${family} preview receipt is explicit and never a review`, () => {
    const receipt = attempt(family);
    const result = run(family, [...receipt.args, '--print-prompt'], ['claude', 'codex', 'kimi'].includes(family) ? stub(family) : {});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(receipt.terminal().outcome.kind, 'preview');
    assert.equal(receipt.terminal().review, null);
  });
}

for (const family of ['claude', 'codex', 'kimi']) {
  test(`${family} actual stub review records factual identity and consumes receipt flag`, () => {
    const receipt = attempt(family);
    const result = run(family, receipt.args, stub(family));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const terminal = receipt.terminal();
    assert.equal(terminal.outcome.kind, 'review');
    assert.equal(terminal.outcome.verdict, family === 'codex' ? null : 'SOUND');
    assert.equal(terminal.model.verification, family === 'claude' ? 'verified' : 'unavailable');
    assert.equal(terminal.model.requested.model, models[family]);
    assert.equal(terminal.execution.exitCode, 0);
  });

  test(`${family} positive text on a failed child records an error`, () => {
    const receipt = attempt(family);
    const result = run(family, receipt.args, { ...stub(family), RECEIPT_STUB_NONZERO: '1' });
    assert.notEqual(result.status, 0);
    assert.equal(receipt.terminal().outcome.kind, 'error');
    assert.equal(receipt.terminal().outcome.verdict, null);
    assert.equal(receipt.terminal().execution.exitCode, 1);
  });
}

test('Claude mismatched observed identity stays separate from the requested model', () => {
  const receipt = attempt('claude');
  const result = run('claude', receipt.args, { ...stub('claude'), RECEIPT_STUB_MODEL: 'claude-opus-4' });
  assert.notEqual(result.status, 0);
  const terminal = receipt.terminal();
  assert.equal(terminal.model.requested.model, 'claude-opus-5');
  assert.deepEqual(terminal.model.observed, ['claude-opus-4']);
  assert.equal(terminal.model.verification, 'mismatch');
  assert.equal(terminal.outcome.kind, 'error');
});

test('GLM protocol error has one started attempt and a distinct error terminal', () => {
  const receipt = attempt('glm');
  const result = run('glm', receipt.args, { GLM_REVIEW_PROTOCOL: 'invalid' });
  assert.notEqual(result.status, 0);
  assert.equal(receipt.terminal().outcome.kind, 'error');
  assert.equal(readdirSync(receipt.output).filter((name) => name === 'started.json').length, 1);
});

for (const [family, key] of [['glm', 'ZAI_API_KEY'], ['deepseek', 'DEEPSEEK_REVIEW_API_KEY'], ['mimo', 'MIMO_REVIEW_API_KEY']]) {
  test(`${family} actual HTTP receipt records response model and sanitizes saved review`, async () => {
    let calls = 0;
    const server = createServer(async (req, res) => {
      calls++; for await (const chunk of req) void chunk;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: models[family], choices: [{ message: { content: 'fixture-http-private-key\nSOUND' }, finish_reason: 'stop' }] }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const receipt = attempt(family);
      const child = spawn(process.execPath, [gate(family), '--design', '.afk/design.md', '--implementer', 'codex', ...receipt.args], {
        cwd, env: gateTestEnv({ [key]: 'fixture-http-private-key', [`${family.toUpperCase()}_REVIEW_BASE_URL`]: `http://127.0.0.1:${server.address().port}` }),
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
      });
      let output = ''; child.stdout.on('data', (chunk) => output += chunk); child.stderr.on('data', (chunk) => output += chunk);
      const [status] = await once(child, 'close');
      assert.equal(status, 0, output); assert.equal(calls, 1);
      const terminal = receipt.terminal();
      assert.equal(terminal.model.verification, 'verified');
      assert.deepEqual(terminal.model.observed, [models[family]]);
      assert.equal(terminal.execution.completion, 'stop');
      assert.doesNotMatch(readFileSync(join(receipt.output, 'review.txt'), 'utf8'), /fixture-http-private-key/);
    } finally { server.closeAllConnections?.(); server.close(); }
  });
}
