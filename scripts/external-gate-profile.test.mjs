// Active-artifact contract for issue #1. AFK role orchestration is driver
// doctrine, so these tests pin the one shipped story rather than pretending to
// execute an orchestration runtime that does not exist.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const afk = read('../skills/afk/SKILL.md');
const template = read('../templates/afk-config.example.md');
const internal = read('../skills/afk-internal-review/SKILL.md');
const readme = read('../README.md');
const agents = read('../AGENTS.md');
const contributing = read('../CONTRIBUTING.md');
const gates = {
  codex: read('../skills/afk-codex-review/SKILL.md'),
  kimi: read('../skills/afk-kimi-review/SKILL.md'),
  claude: read('../skills/afk-claude-review/SKILL.md'),
  glm: read('../skills/afk-glm-review/SKILL.md'),
  deepseek: read('../skills/afk-deepseek-review/SKILL.md'),
  mimo: read('../skills/afk-mimo-review/SKILL.md'),
};

test('new configs choose a single Codex gate; ordered doubles are explicit opt-in', () => {
  assert.match(template, /^gates:\s+codex\s*$/m);
  assert.match(template, /^# gates:\s+codex > kimi\b/m, 'the double profile stays visible as a commented opt-in');
  assert.doesNotMatch(template, /^gates:\s+codex > kimi\s*$/m);
  assert.doesNotMatch(template, /^min-pass:/m);
  assert.doesNotMatch(template, /^mode:/m);
  assert.match(afk, /built-in `gates: codex`/);
  assert.match(afk, /-codex -kimi/);
  for (const text of [afk, readme, agents, contributing]) {
    assert.match(text, /single[^\n]*Codex|Codex[^\n]*single/i, 'each active doc names the single default');
    assert.match(text, /Codex[^\n]*(?:outer|外门)/i);
    assert.match(text, /Kimi[\s\S]{0,80}?(?:final|终审)/i);
  }
});

test('kickoff restates the resolved forge with its source', () => {
  // The restatement is what makes a misdetected forge visible before any paid
  // work; without a pin it can be dropped while the gate-profile half survives.
  assert.match(afk, /resolved forge with\s+its source/i);
  assert.match(afk, /`config` \/ `remote` \/ `default`/);
});

test('handoff role flags are a defined, bounded per-run channel', () => {
  // The grammar and lifetime rules from the 2026-08-03 design (F10, F13, F4,
  // F5, F17, F19, F22): affirmative form, collapse, lookalike recording,
  // ledger-held lifetime, and the fail-closed config exception.
  assert.match(afk, /one or two (?:leading )?dashes/i);
  assert.match(afk, /case-insensitively/);
  assert.match(afk, /repeated family collapses/i);
  assert.match(afk, /ignored lookalike/i);
  assert.match(afk, /Flags never mutate/);
  assert.match(afk, /flag absence[^\n.]*no statement/i);
  assert.match(afk, /affirmation/i);
  assert.match(afk, /never mask a broken config/i);
  // Visibility control: kickoff restates the effective profile and its source.
  assert.match(afk, /Restate the scope and the effective gate profile/i);
  assert.match(afk, /`flags` \/ `config` \/ `legacy` \/ `built-in`/);
});

test('the driver doctrine distinguishes ordered roles from fallback priority', () => {
  assert.match(afk, /`gates`[^\n]*ordered/i);
  assert.match(afk, /`priority`[^\n]*fallback/i);
  assert.match(afk, /outer/);
  assert.match(afk, /intermediate-N/);
  assert.match(afk, /final/);
  assert.match(afk, /left-to-right/);
});

test('the implementer and unavailable-provider matrix stays role-safe', () => {
  assert.match(
    afk,
    /single role: Codex for a Claude\/GLM\/Kimi\/DeepSeek\/MiMo implementer; Claude for a Codex\s+implementer/,
  );
  for (const row of [
    /Codex outer \+ Kimi final for a Claude\/GLM implementer/,
    /Claude outer \+ Kimi final for a Codex implementer/,
    /Codex outer \+ Claude final\s+for a Kimi implementer/,
  ]) assert.match(afk, row);
  assert.match(afk, /Stable-unavailable `SKIPPED` reasons[\s\S]{0,300}?trigger fallback/);
  assert.match(afk, /one pass is never presented as two/i);
});

test('legacy and profileless config behavior is explicit and total', () => {
  assert.match(afk, /legacy external-gate field/i);
  assert.match(afk, /`design-gate`[^\n]*`implementer`[^\n]*do not select/i);
  assert.match(afk, /present-but-empty `gates`/i);
  assert.match(afk, /one-time default-change notice/i);
  assert.match(afk, /Legacy `min-pass` and `mode`[\s\S]{0,120}?ignored for PR roles/i);
});

test('ordered role convergence and final revision stamps are pinned', () => {
  for (const phrase of [
    /material progress/,
    /root-cause checkpoint/,
    /one transient retry/,
    /merge-base/,
    /effective role-profile hash/,
    /minus its `gates` key/,
    /later-role content change/,
  ]) assert.match(afk, phrase);
  assert.doesNotMatch(afk, /refuses to start a fourth\s+sequence|four finding-bearing verdicts/i);
  assert.match(internal, /all configured roles/i);
  assert.match(internal, /same `HEAD`[^\n]*merge-base/i);
});

test('design-stage review remains exactly one independent gate', () => {
  assert.match(afk, /Exactly one gate per design evaluation, regardless of PR `gates` length or\s+legacy `min-pass`/);
});

test('gate skills name stable default roles instead of interchangeability', () => {
  assert.match(gates.codex, /default outer/i);
  assert.match(gates.kimi, /default final/i);
  assert.match(gates.claude, /fallback/i);
  assert.match(gates.glm, /fallback/i);
  assert.match(gates.deepseek, /optional/i);
  assert.match(gates.mimo, /optional/i);
  for (const text of Object.values(gates)) assert.doesNotMatch(text, /interchangeable/i);
});
