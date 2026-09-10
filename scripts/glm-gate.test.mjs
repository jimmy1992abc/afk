import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { after, test } from 'node:test';

import { createReviewFixture, gateTestEnv, spawnGate } from './gate-test-env.mjs';

const reviewFixture = createReviewFixture();
after(reviewFixture.cleanup);
const TEST_COMMIT = reviewFixture.commit;
const MODEL = 'glm-5.3';

const GATE = fileURLToPath(new URL('../skills/afk-glm-review/glm-gate.mjs', import.meta.url));

function runGate({ args = [], env = {} } = {}) {
  return spawnGate([GATE, ...args], {
    cwd: reviewFixture.cwd,
    encoding: 'utf8',
    env: gateTestEnv(env),
  });
}

async function runGateAsync({ args = [], env = {} } = {}) {
  const child = spawn(process.execPath, [GATE, ...args], {
    cwd: reviewFixture.cwd,
    env: gateTestEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [status] = await once(child, 'close');
  return { status, stdout, stderr };
}

function withDesignDoc(text, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'glm-gate-design-'));
  try {
    const path = join(dir, 'spec.md');
    writeFileSync(path, text);
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('glm gate disabled flag emits a clean skipped review', () => {
  const result = runGate({ args: ['--base', 'main'], env: { GLM_REVIEW_GATE: 'off' } });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /===== GLM REVIEW \(final message\) =====/);
  assert.match(result.stdout, /SKIPPED: GLM gate disabled via GLM_REVIEW_GATE\./);
  assert.match(result.stdout, /===== END GLM REVIEW =====/);
});

test('glm defaults to GLM-5.3 over the OpenAI Coding Plan endpoint', () => {
  const result = runGate({ args: ['--commit', TEST_COMMIT, '--print-args'] });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.model, MODEL);
  assert.equal(parsed.protocol, 'openai');
  assert.equal(parsed.baseUrl, 'https://api.z.ai/api/coding/paas/v4');
  assert.equal(parsed.maxContextBytes, 160000);
  assert.equal(parsed.maxTokens, 65536);
});

test('glm diagnostics preserve explicit model, protocol, and endpoint overrides', () => {
  const result = runGate({
    args: ['--commit', TEST_COMMIT, '--print-args'],
    env: {
      GLM_REVIEW_MODEL: 'glm-5.3-20260904',
      GLM_REVIEW_PROTOCOL: 'anthropic',
      GLM_REVIEW_BASE_URL: 'https://example.test/anthropic',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.model, 'glm-5.3-20260904');
  assert.equal(parsed.protocol, 'anthropic');
  assert.equal(parsed.baseUrl, 'https://example.test/anthropic');
});

test('a GLM response body that never finishes ends as a non-zero timeout error', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"partial":');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    const result = await runGateAsync({
      args: ['--commit', TEST_COMMIT],
      env: {
        ZAI_API_KEY: 'test-only',
        GLM_REVIEW_BASE_URL: `http://127.0.0.1:${port}`,
        GLM_REVIEW_TIMEOUT_MS: '30',
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /timed out/i);
    assert.doesNotMatch(result.stdout, /SKIPPED/);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('a GLM upstream error never echoes its response body', async () => {
  const key = 'glm-key-must-not-echo';
  const token = `tp-${'R8w'.repeat(12)}`;
  const server = createServer((_request, response) => {
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: `echo ${key} ${token}` }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    const result = await runGateAsync({
      args: ['--commit', TEST_COMMIT],
      env: {
        ZAI_API_KEY: key,
        GLM_REVIEW_BASE_URL: `http://127.0.0.1:${port}`,
      },
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /ERROR: .*HTTP 500/);
    assert.doesNotMatch(result.stdout, /SKIPPED/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(key));
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /tp-/);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('a GLM successful response cannot echo the configured key', async () => {
  const key = 'glm-success-key-with-arbitrary-shape';
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      model: MODEL,
      choices: [{
        finish_reason: 'stop',
        message: { reasoning_content: 'private reasoning', content: `Credential ${key}\nAPPROVE` },
      }],
      usage: {},
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    // GLM_API_KEY-only environment: pins the documented ZAI -> GLM key
    // fallback surviving the lifecycle's provider-env injection.
    const result = await runGateAsync({
      args: ['--commit', TEST_COMMIT],
      env: {
        GLM_API_KEY: key,
        GLM_REVIEW_BASE_URL: `http://127.0.0.1:${port}`,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /APPROVE/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(key));
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

// ── design mode ─────────────────────────────────────────────────────────────

test('glm design mode resolves the design kind, not a diff selector', () => {
  withDesignDoc('# Spec\n', (path) => {
    const result = runGate({ args: ['--design', path, '--print-args'] });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.kind, 'design');
    assert.equal(parsed.base, null);
    assert.equal(parsed.commit, null);
  });
});

test('glm design mode sends the doc text as the payload, not a diff+files snapshot', () => {
  const body = '# Title\n\nA DESIGN-ONLY claim GLM must review.\n';
  withDesignDoc(body, (path) => {
    const result = runGate({ args: ['--design', path, '--print-prompt'] });
    assert.equal(result.status, 0, result.stderr);
    const out = result.stdout;
    // The document text is the payload GLM receives...
    assert.match(out, /A DESIGN-ONLY claim GLM must review\./);
    // ...under a design system prompt, not a code-diff one.
    assert.match(out, /SOUND WITH CONCERNS/);
    assert.doesNotMatch(out, /file:line/);
    // The diff-mode payload sections must be absent.
    assert.doesNotMatch(out, /## Full diff/);
    assert.doesNotMatch(out, /## Full current contents of changed files/);
  });
});

test('glm design mode fails loudly on a missing doc, never a skip', () => {
  const missing = join(tmpdir(), 'glm-gate-no-such-design-xyz.md');
  const result = runGate({ args: ['--design', missing] });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /ERROR: cannot review/);
  assert.match(result.stdout, /--design/);
  assert.doesNotMatch(result.stdout, /SKIPPED/);
});

test('glm rejects an over-budget design doc loudly, not a masked skip', () => {
  // The design stage runs exactly one gate. Sending an oversized doc whole lets
  // Z.ai reject it and glm report that as SKIPPED — the design stage then
  // proceeds with no review. An over-budget doc is operator/config error: fail
  // loud (ERROR) so the operator scopes it or raises the budget.
  const big = `# Spec\n${'x'.repeat(5000)}\n`;
  withDesignDoc(big, (path) => {
    const result = runGate({ args: ['--design', path], env: { GLM_REVIEW_MAX_CTX_BYTES: '500' } });
    assert.notEqual(result.status, 0, 'an over-budget design doc must ERROR, not skip');
    assert.match(result.stdout, /ERROR/);
    assert.doesNotMatch(result.stdout, /SKIPPED/);
  });
});

test('glm design mode: an unavailable reviewer skips and proceeds (Decision 6 asymmetry)', () => {
  withDesignDoc('# Spec\n', (path) => {
    const result = runGate({ args: ['--design', path], env: { GLM_REVIEW_GATE: 'off' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SKIPPED: GLM gate disabled/);
    assert.doesNotMatch(result.stdout, /ERROR/);
  });
});

test('every external gate is listed on every plugin surface', () => {
  // A gate nobody can discover is a gate that never runs, so each surface that
  // advertises the set must advertise all of it.
  const afkSkill = readFileSync(new URL('../skills/afk/SKILL.md', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../templates/afk-config.example.md', import.meta.url), 'utf8');

  for (const gate of [
    'afk-codex-review', 'afk-claude-review', 'afk-kimi-review',
    'afk-glm-review', 'afk-deepseek-review', 'afk-mimo-review',
  ]) {
    assert.match(afkSkill, new RegExp(gate), `afk/SKILL.md must list ${gate}`);
    assert.match(readme, new RegExp(gate), `README must list ${gate}`);
  }
  assert.match(config, /priority: codex > claude > kimi > glm/);
});

// ── lifecycle failure directions (post-fold firsts) ─────────────────────────

async function withGlmServer(handler, fn) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    return await fn(port);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

test('a GLM non-JSON body is an error, not a skip', async () => {
  await withGlmServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('not-json');
  }, async (port) => {
    const result = await runGateAsync({
      args: ['--commit', TEST_COMMIT],
      env: { ZAI_API_KEY: 'test-only', GLM_REVIEW_BASE_URL: `http://127.0.0.1:${port}` },
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /ERROR: .*bad_json/);
    assert.doesNotMatch(result.stdout, /SKIPPED/);
  });
});

test('a GLM empty completion is an error, not a skip', async () => {
  await withGlmServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      model: MODEL,
      choices: [{ finish_reason: 'stop', message: { content: '' } }],
      usage: {},
    }));
  }, async (port) => {
    const result = await runGateAsync({
      args: ['--commit', TEST_COMMIT],
      env: { ZAI_API_KEY: 'test-only', GLM_REVIEW_BASE_URL: `http://127.0.0.1:${port}` },
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /ERROR: .*empty.*retry once.*GLM_REVIEW_MAX_CTX_BYTES.*GLM_REVIEW_MAX_OUTPUT_TOKENS/i);
    assert.doesNotMatch(result.stdout, /SKIPPED/);
  });
});

test('a truncated GLM completion is discarded as an error', async () => {
  await withGlmServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      model: MODEL,
      choices: [{ finish_reason: 'length', message: { content: 'partial review that ran out of tok' } }],
      usage: {},
    }));
  }, async (port) => {
    const result = await runGateAsync({
      args: ['--commit', TEST_COMMIT],
      env: { ZAI_API_KEY: 'test-only', GLM_REVIEW_BASE_URL: `http://127.0.0.1:${port}` },
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /finish_reason "length"/);
    assert.doesNotMatch(result.stdout, /partial review/);
  });
});

test('a GLM reviewer identity outside the glm-5.3 lineage is discarded', async () => {
  await withGlmServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      model: 'other-model-9',
      choices: [{ finish_reason: 'stop', message: { content: 'APPROVE' } }],
      usage: {},
    }));
  }, async (port) => {
    const result = await runGateAsync({
      args: ['--commit', TEST_COMMIT],
      env: { ZAI_API_KEY: 'test-only', GLM_REVIEW_BASE_URL: `http://127.0.0.1:${port}` },
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /identity unverified/);
    assert.match(result.stdout, /GLM_REVIEW_MODEL/);
    assert.match(result.stdout, /GLM_REVIEW_BASE_URL/);
  });
});

test('an invalid GLM protocol fails before sending a request', async () => {
  let requests = 0;
  await withGlmServer((_request, response) => {
    requests += 1;
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end('{}');
  }, async (port) => {
    const result = await runGateAsync({
      args: ['--commit', TEST_COMMIT],
      env: {
        ZAI_API_KEY: 'test-only',
        GLM_REVIEW_PROTOCOL: 'automatic',
        GLM_REVIEW_BASE_URL: `http://127.0.0.1:${port}`,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /ERROR: .*GLM_REVIEW_PROTOCOL/);
    assert.equal(requests, 0);
  });
});

test('the default GLM request is OpenAI-shaped with max reasoning', async () => {
  let seen;
  await withGlmServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      seen = { url: request.url, headers: request.headers, body: JSON.parse(body) };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        model: MODEL,
        choices: [{ finish_reason: 'stop', message: { content: 'Shape probe\nAPPROVE' } }],
        usage: {},
      }));
    });
  }, async (port) => {
    const result = await runGateAsync({
      args: ['--commit', TEST_COMMIT],
      env: {
        ZAI_API_KEY: 'shape-probe-key',
        GLM_REVIEW_BASE_URL: `http://127.0.0.1:${port}`,
        GLM_REVIEW_MAX_OUTPUT_TOKENS: '4096',
      },
    });
    assert.equal(result.status, 0, result.stdout);
    assert.equal(seen.url, '/chat/completions');
    assert.equal(seen.headers.authorization, 'Bearer shape-probe-key');
    assert.equal(seen.body.max_tokens, 4096);
    assert.deepEqual(seen.body.thinking, { type: 'enabled' });
    assert.equal(seen.body.reasoning_effort, 'max');
    assert.equal(seen.body.messages.length, 2);
    assert.equal(seen.body.messages[0].role, 'system');
    assert.equal(seen.body.messages[1].role, 'user');
  });
});

test('the Anthropic GLM opt-in retains its provider-native request shape', async () => {
  let seen;
  await withGlmServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      seen = { url: request.url, headers: request.headers, body: JSON.parse(body) };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        model: MODEL,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Anthropic shape probe\nAPPROVE' }],
      }));
    });
  }, async (port) => {
    const result = await runGateAsync({
      args: ['--commit', TEST_COMMIT],
      env: {
        ZAI_API_KEY: 'shape-probe-key',
        GLM_REVIEW_PROTOCOL: 'anthropic',
        GLM_REVIEW_BASE_URL: `http://127.0.0.1:${port}`,
        GLM_REVIEW_MAX_OUTPUT_TOKENS: '4096',
      },
    });
    assert.equal(result.status, 0, result.stdout);
    assert.equal(seen.url, '/v1/messages');
    assert.equal(seen.headers['x-api-key'], 'shape-probe-key');
    assert.equal(seen.headers.authorization, 'Bearer shape-probe-key');
    assert.equal(seen.headers['anthropic-version'], '2023-06-01');
    assert.equal(seen.body.max_tokens, 4096);
    assert.equal(seen.body.temperature, 0.2);
    assert.equal(typeof seen.body.system, 'string');
    assert.equal(seen.body.messages.length, 1);
    assert.equal(seen.body.messages[0].role, 'user');
  });
});
