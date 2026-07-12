import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('AFK skill preserves its tick and registers the supervisor lifecycle', async () => {
  const text = await readFile('skills/afk/SKILL.md', 'utf8');
  assert.match(text, /approximately 15-minute/);
  assert.match(text, /afk-supervisor register/);
  assert.match(text, /afk-supervisor lease/);
  assert.match(text, /afk-supervisor transition/);
  assert.match(text, /COMPLETED/);
  assert.match(text, /BLOCKED/);
  assert.match(text, /AUTO_PAUSED/);
  assert.match(text, /<!-- afk-supervisor/);
});

test('README documents exact and estimated reset sources without overclaiming VS Code', async () => {
  const text = await readFile('README.md', 'utf8');
  assert.match(text, /AFK Supervisor/);
  assert.match(text, /status-line.*exact/is);
  assert.match(text, /estimated/is);
  assert.match(text, /VS Code.*unconfirmed/is);
  assert.match(text, /setup.*status.*configure.*repair.*uninstall/is);
});

test('plugin version and skill manifest include afk-supervisor', async () => {
  const plugin = JSON.parse(await readFile('plugin.json', 'utf8'));
  const marketplace = JSON.parse(await readFile('.claude-plugin/marketplace.json', 'utf8'));
  assert.equal(plugin.version, '0.3.0');
  assert.equal(marketplace.plugins[0].version, '0.3.0');
  assert.ok(marketplace.plugins[0].skills.includes('./skills/afk-supervisor'));
});
