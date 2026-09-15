import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { relative } from 'node:path';
import { test } from 'node:test';
import { supportVisible } from './evaluate-agent-behavior.mjs';
import { repository, readInstruction as read, section, localLinks, anchors, checkInstructionLink, assertRoute } from './instruction-test-helpers.mjs';

import { ADVERTISED_FORMS as triggers } from '../lib/evaluation/scenarios.mjs';
const references = ['environment', 'kickoff', 'design-review', 'review-convergence', 'external-review', 'review-evidence', 'publication', 'continuity', 'output', 'direction-state'];
const gateNames = Object.keys(triggers).filter((name) => /-(codex|claude|kimi|glm|deepseek|mimo)-review$/.test(name));
const reference = (name) => `skills/afk/references/${name}.md`;

test('public names and explicit invocation forms remain textually compatible', () => {
  assert.deepEqual(readdirSync(new URL('../skills/', import.meta.url)).sort(), Object.keys(triggers).sort());
  for (const [name, forms] of Object.entries(triggers)) {
    const text = read(`skills/${name}/SKILL.md`);
    const front = text.match(/^---\n([\s\S]*?)\n---/)[1];
    assert.match(front, new RegExp(`^name: ${name}$`, 'm'));
    assert.ok(front.includes(`${name}: Part of the afk pipeline.`));
    assert.ok(front.includes(forms[0]), `${name} explicit trigger`);
  }
});

test('natural-language trigger retention is a text check, not host auto-selection evidence', () => {
  for (const [name, forms] of Object.entries(triggers)) {
    const front = read(`skills/${name}/SKILL.md`).split('\n---')[0];
    for (const form of forms.slice(1)) assert.ok(front.includes(form), `${name}: ${form}`);
  }
});

test('driver and standalone entry points explicitly route their applicable shared rules', () => {
  const driver = read('skills/afk/SKILL.md');
  for (const name of references) assertRoute(driver, `references/${name}.md`);
  for (const name of Object.keys(triggers).filter((name) => name !== 'afk')) {
    const text = read(`skills/${name}/SKILL.md`);
    assertRoute(text, '../afk/references/environment.md');
    assert.match(text, /Read|read/);
  }
  for (const name of [...gateNames, 'afk-implementation-pilot', 'afk-internal-review']) {
    assertRoute(read(`skills/${name}/SKILL.md`), '../afk/references/review-convergence.md');
  }
  for (const name of gateNames) {
    const text = read(`skills/${name}/SKILL.md`);
    for (const target of ['external-review.md', 'review-evidence.md', 'design-review.md#external-design-review']) {
      assertRoute(text, `../afk/references/${target}`);
    }
    assert.match(text, /before (?:invoking|running)/i);
    assert.match(text, /`CLEAN`/); assert.match(text, /`OUTSTANDING`/);
  }
  const planner = read('skills/afk-spec-planner/SKILL.md');
  assert.doesNotMatch(planner, /references\/(?:external-review|publication)\.md/);
  assertRoute(planner, '../afk/references/design-review.md');
  assert.match(planner, /Produce no code/);
  for (const name of ['afk-implementation-pilot', 'afk-internal-review']) {
    const text = read(`skills/${name}/SKILL.md`);
    assertRoute(text, '../afk/references/publication.md#remote-checks');
    assertRoute(text, '../afk/references/continuity.md');
  }
});

test('common finding and implementer definitions occur once, with no satellite copies', () => {
  const convergence = read(reference('review-convergence'));
  const external = read(reference('external-review'));
  assert.match(external, /standalone invocation selects the requested gate/);
  assert.match(external, /not start the driver's full waterfall or authorize extra roles/);
  for (const phrase of ['A finding asserts two things', 'Fix confirmed in-scope structural findings, including P2', 'The loop ends']) {
    assert.equal(convergence.split(phrase).length - 1, 1, phrase);
    for (const name of gateNames) assert.ok(!read(`skills/${name}/SKILL.md`).includes(phrase), name);
  }
  assert.equal(external.split('Pass `--implementer <family>` when another model wrote the change.').length - 1, 1);
  for (const name of gateNames) assert.doesNotMatch(read(`skills/${name}/SKILL.md`), /Pass `--implementer <family>` when another model wrote the change\./);
});

test('repository authority remains visible and conditional authoring has one route', () => {
  const text = read('AGENTS.md');
  for (const pattern of [/owner\/maintainer/, /Never commit to/, /English only/, /Secrets/, /Epistemic/, /Artifact/, /Workflow/, /enforced when invoked/, /node --test/, /sync-marketplace/]) assert.match(text, pattern);
  assertRoute(text, 'docs/maintaining-skills.md');
  assertRoute(text, 'skills/afk/references/external-review.md');
  assert.match(text, /operational instructions/i);
  assert.match(text, /Each actual reviewer differs from the implementer\s+and every other review role/);
  for (const name of ['CLAUDE.md', 'GEMINI.md']) assertRoute(read(name), 'AGENTS.md');
});

test('active instruction links and fragments resolve; runtime dependencies stay export-visible', () => {
  const paths = [...Object.keys(triggers).map((name) => `skills/${name}/SKILL.md`), ...references.map(reference)];
  for (const source of [...paths, 'AGENTS.md', 'docs/maintaining-skills.md', 'CONTRIBUTING.md', 'README.md']) {
    for (const target of localLinks(read(source))) {
      const destination = checkInstructionLink(source, target);
      if (paths.includes(source) && target.includes('.md')) {
        assert.equal(supportVisible(relative(repository, destination).replaceAll('\\', '/')), true, `${source} -> ${target}`);
      }
    }
  }
  const driverAnchors = anchors(read('skills/afk/SKILL.md'));
  assert.ok(driverAnchors.has('supported-review-context'));
  assert.ok(driverAnchors.has('canonical-review-receipts'));
});

test('section and route checks fail on absent sections, routes, files and fragments', () => {
  assert.throws(() => section('# Present\nbody', 'Missing'), /missing instruction section/);
  assert.throws(() => assertRoute('Read this.', 'missing.md'), /missing explicit route/);
  assert.throws(() => checkInstructionLink('entry.md', 'missing.md', () => { throw new Error('missing file'); }), /missing file/);
  assert.throws(() => checkInstructionLink('entry.md', 'target.md#absent', () => '# Present\nbody'), /missing fragment/);
  assert.equal(section('# One\na\n## Child\nb\n# Two\nc', 'One'), '# One\na\n## Child\nb');
  assert.ok(anchors('# One\n# One').has('one-1'));
});

test('external repair batches self-review before a paid role re-review through the shared route', () => {
  const text = section(read(reference('review-convergence')), 'Finding admission');
  assert.match(text, /After a repair batch, self-review the affected surface before rerunning an\s+external role/);
  for (const name of gateNames) assertRoute(read(`skills/${name}/SKILL.md`), '../afk/references/review-convergence.md');
});

test('native Codex context restrictions do not exclude supported receipt capture', () => {
  const text = section(read('skills/afk-codex-review/SKILL.md'), 'Review context');
  assert.match(text, /Native diff review rejects custom context and re-review focus/);
  assert.match(text, /Native diff review still supports `--review-receipt`/);
  assert.doesNotMatch(text, /cannot accept this input/);
});
