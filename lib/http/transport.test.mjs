import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { postClassifiedJson, providerError } from './transport.mjs';

async function listen(server, t) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const header of ['x-api-key', 'api-key']) {
  test(`redirects cannot forward ${header} or review content to another origin`, async (t) => {
    let destinationRequests = 0;
    const destination = await listen(createServer((_req, res) => {
      destinationRequests++;
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    }), t);
    const source = await listen(createServer((_req, res) => {
      res.writeHead(307, { Location: destination }); res.end();
    }), t);
    await assert.rejects(postClassifiedJson({ name: 'fixture', url: source,
      headers: { [header]: 'fixture-key-123' }, body: { source: 'fixture-review' },
      credential: 'fixture-key-123', httpTimeoutMs: 2000, fail: providerError,
    }), (error) => error.code === 'transport' && !error.message.includes('fixture-key-123'));
    assert.equal(destinationRequests, 0);
  });
}
