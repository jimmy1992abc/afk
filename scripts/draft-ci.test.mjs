import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/validate.yml', import.meta.url), 'utf8');
const events = workflow.match(/pull_request:\s*\n\s+types: \[([^\]]+)\]/)?.[1]
  .split(',').map((value) => value.trim());
const expression = workflow.match(/checks:\s*\n\s+if: \$\{\{ (.+) \}\}/)?.[1];

test('Draft filtering keeps every required trigger', () => {
  for (const event of ['opened', 'synchronize', 'reopened', 'ready_for_review']) {
    assert.ok(events?.includes(event), `missing ${event} trigger`);
  }
  assert.match(workflow, /push:\s*\n\s+branches: \[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
});

test('the validation job runs only for non-Draft PRs and non-PR events', () => {
  assert.ok(expression, 'validation needs an explicit job condition');
  // This expression uses the shared boolean subset of Actions and JavaScript.
  assert.match(expression, /^[a-zA-Z0-9_.' !=|&()]+$/);
  const runs = new Function('github', `return (${expression});`);
  for (const action of events) {
    for (const draft of [true, false]) {
      assert.equal(runs({ event_name: 'pull_request', event: { action, pull_request: { draft } } }),
        !draft, `${action}, draft=${draft}`);
    }
  }
  for (const event_name of ['push', 'workflow_dispatch']) {
    assert.equal(runs({ event_name, event: {} }), true, event_name);
  }
});
