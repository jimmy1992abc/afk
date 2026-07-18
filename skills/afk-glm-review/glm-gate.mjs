#!/usr/bin/env node
// glm-gate.mjs — Z.ai GLM external review wrapper.
//
// The one gate reached through a REST API rather than an agentic CLI: it packs
// the diff AND the full current contents of changed files into a bounded
// context and sends that. The reviewer has no tools, so anything outside that
// snapshot is invisible to it — which is why this gate's context clause tells
// the model so explicitly.
//
// Usage:
//   node glm-gate.mjs                 # current branch vs default base
//   node glm-gate.mjs --base master   # vs an explicit base
//   node glm-gate.mjs --commit <sha>  # one commit
//   node glm-gate.mjs --uncommitted   # staged/unstaged/untracked
//   node glm-gate.mjs --design <path> # review a design doc (sends the doc text, not a diff)
//   node glm-gate.mjs --print-args    # resolve and print the target; no API call
//
// Opt out with GLM_REVIEW_GATE=off.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { isGateDisabled } from '../../lib/gate/env.mjs';
import { git } from '../../lib/gate/git.mjs';
import { guardFor } from '../../lib/gate/implementer.mjs';
import { buildDesignReviewPrompt, buildReviewPrompt } from '../../lib/gate/prompt.mjs';
import { createProtocol } from '../../lib/gate/protocol.mjs';
import { collectDiff, parseTarget, readDesign, validateTarget } from '../../lib/gate/target.mjs';

const { emitSkip, emitReview, emitError } = createProtocol({ label: 'GLM', slug: 'glm-gate' });

if (isGateDisabled('GLM_REVIEW_GATE')) {
  emitSkip('GLM gate disabled via GLM_REVIEW_GATE.');
}

function keyFromDotenv() {
  const gitTop = git(['rev-parse', '--show-toplevel']).trim();
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  const mainWorktree = commonDir ? dirname(commonDir) : '';
  const candidates = [
    join(process.cwd(), '.env'),
    gitTop && join(gitTop, '.env'),
    mainWorktree && join(mainWorktree, '.env'),
  ].filter(Boolean);

  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const match = line.match(/^\s*(?:export\s+)?(ZAI_API_KEY|GLM_API_KEY)\s*=\s*(.+?)\s*$/);
        if (match) return match[2].replace(/^["']|["']$/g, '').trim();
      }
    } catch {
      // Continue probing other local key locations.
    }
  }
  return '';
}

const userArgs = process.argv.slice(2);
const printArgsOnly = userArgs.includes('--print-args');
// Prints the exact system + user prompt GLM would receive, and calls no API. In
// design mode the argv is not the review — only the prompt reveals whether the
// document text (not a diff) is what got sent.
const printPromptOnly = userArgs.includes('--print-prompt');

const model = (process.env.GLM_REVIEW_MODEL || 'glm-5.2').trim();
const baseUrl = (process.env.GLM_REVIEW_BASE_URL || 'https://api.z.ai/api/anthropic').replace(/\/+$/, '');
const maxCtx = Number.parseInt(process.env.GLM_REVIEW_MAX_CTX_BYTES || '400000', 10) || 400000;

const guard = guardFor('glm', userArgs);
if (!guard.run) {
  emitSkip(`independence check — ${guard.reason}`);
}

const target = parseTarget(userArgs);
const valid = validateTarget(target);
if (!valid.ok) {
  emitError(`cannot review — ${valid.reason}`, 1);
}

const isDesign = target.kind === 'design';

// A design target never touches the diff path: collectDiff has no design branch,
// so a leaked design kind would diff `undefined...HEAD`.
let diff = '';
let stat = '';
let changedFiles = [];
if (!isDesign) {
  const collected = collectDiff(target);
  if (collected.error) {
    // Never a skip: a target git cannot read is unreviewable, not unchanged.
    emitError(`cannot review — ${collected.error}`, 1);
  }
  ({ diff, stat, changedFiles } = collected);
}
const hasChanges = isDesign ? true : Boolean(diff.trim() || changedFiles.length);

if (printArgsOnly) {
  // Dry run: resolve the target, call nothing. Runs before every skip so a dry
  // run on a clean tree can still report which base it resolved.
  process.stdout.write(`${JSON.stringify({
    kind: target.kind,
    base: target.base ?? null,
    commit: target.commit ?? null,
    label: target.label,
    command: target.command ?? null,
    hasChanges,
    changedFiles,
    model,
    baseUrl,
  }, null, 2)}\n`);
  process.exit(0);
}

// Build the payload and the mode-specific context clause. GLM has NO tools in
// either mode: it must be told the snapshot is all it has, and never told to
// "inspect" or "run" anything — that invites a fabricated "I checked X" from a
// reviewer that cannot check. See lib/gate/prompt.mjs for why this is not shared.
let payload;
let systemPrompt;
if (isDesign) {
  // Design mode replaces the whole payload builder: send the document text, not
  // the diff + per-file contents + byte budget a code review needs.
  const doc = readDesign(target);
  if (doc.error) {
    // A read that failed after validateTarget passed (TOCTOU) is unreviewable,
    // not unchanged — fail loud, never skip.
    emitError(`cannot review — ${doc.error}`, 1);
  }
  payload = `## Design document (${target.path})\n${doc.text}\n`;
  const context = 'You are given the full text of a design document. That document is everything you have: you cannot run commands or open other files, so never claim to have done either. Where a judgement would require a file you were not given, say so rather than assume.';
  systemPrompt = buildDesignReviewPrompt({ scope: target.label, context });
} else {
  const diffCap = Math.floor(maxCtx * 0.6);
  let diffText = diff;
  if (diffText.length > diffCap) {
    diffText = `${diffText.slice(0, diffCap)}\n\n[diff truncated at ${diffCap} bytes of ${diff.length}; raise GLM_REVIEW_MAX_CTX_BYTES or scope the review to fewer files]\n`;
  }

  payload = `## Diff stat\n${stat}\n\n## Full diff\n${diffText}\n`;
  let budget = maxCtx - payload.length;
  let filesBlock = '\n## Full current contents of changed files\n';

  for (const file of changedFiles) {
    if (budget <= 0) {
      filesBlock += '\n[omitted remaining files; context budget reached]\n';
      break;
    }

    let content = '';
    try {
      const fileStat = statSync(file);
      if (!fileStat.isFile()) continue;
      if (fileStat.size > 200000) {
        filesBlock += `\n### ${file}\n[skipped; file >200KB]\n`;
        continue;
      }
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const block = `\n### ${file}\n\`\`\`\n${content}\n\`\`\`\n`;
    if (block.length > budget) {
      filesBlock += `\n### ${file}\n[truncated; context budget reached]\n`;
      break;
    }
    filesBlock += block;
    budget -= block.length;
  }

  payload += filesBlock;

  const context = 'You are given the diff and the full current contents of the changed files. That snapshot is everything you have: you cannot run commands or open other files, so never claim to have done either. Where a judgement would require a file you were not given, say so rather than assume.';
  systemPrompt = buildReviewPrompt({ scope: target.label, context });
}

const userPrompt = `Review ${target.label}.\n\n${payload}`;

if (printPromptOnly) {
  process.stdout.write(`${systemPrompt}\n\n----- user -----\n${userPrompt}\n`);
  process.exit(0);
}

const apiKey = (process.env.ZAI_API_KEY || process.env.GLM_API_KEY || keyFromDotenv()).trim();
if (!apiKey) {
  emitSkip('No API key; set ZAI_API_KEY or GLM_API_KEY in env or .env, or GLM_REVIEW_GATE=off to disable.');
}

if (!hasChanges) {
  emitSkip(`No changes found for ${target.label}.`);
}

const isAnthropic = /\/anthropic(\/|$)/.test(baseUrl);
const url = isAnthropic ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`;
process.stderr.write(`[glm-gate] POST ${url} model=${model} mode=${isAnthropic ? 'anthropic' : 'openai'} payload=${payload.length}B files=${changedFiles.length}\n`);

const headers = { 'Content-Type': 'application/json' };
let reqBody;
if (isAnthropic) {
  headers.Authorization = `Bearer ${apiKey}`;
  headers['x-api-key'] = apiKey;
  headers['anthropic-version'] = '2023-06-01';
  reqBody = JSON.stringify({
    model,
    max_tokens: 8192,
    temperature: 0.2,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
} else {
  headers.Authorization = `Bearer ${apiKey}`;
  reqBody = JSON.stringify({
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });
}

let response;
try {
  response = await fetch(url, { method: 'POST', headers, body: reqBody });
} catch (error) {
  emitSkip(`network error calling Z.ai (${error?.message || error}). Gate skipped.`);
}

const raw = await response.text();
if (!response.ok) {
  if (response.status === 401 || response.status === 403) {
    emitSkip(`Z.ai auth failed (HTTP ${response.status}); check ZAI_API_KEY. ${raw.slice(0, 200)}`);
  }
  process.stderr.write(`[glm-gate] HTTP ${response.status}: ${raw.slice(0, 500)}\n`);
  emitSkip(`Z.ai HTTP ${response.status}; gate could not run. ${raw.slice(0, 200)}`);
}

let data;
try {
  data = JSON.parse(raw);
} catch {
  emitSkip(`Z.ai returned non-JSON: ${raw.slice(0, 200)}`);
}

const review = (isAnthropic
  ? (Array.isArray(data?.content) ? data.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n') : '')
  : (data?.choices?.[0]?.message?.content || '')
).trim();

if (!review) {
  emitSkip(`Z.ai returned no content: ${JSON.stringify(data).slice(0, 300)}`);
}

emitReview(review);
