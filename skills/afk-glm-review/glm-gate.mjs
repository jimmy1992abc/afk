#!/usr/bin/env node
// Z.ai GLM external review wrapper.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MARK_START = '===== GLM REVIEW (final message) =====';
const MARK_END = '===== END GLM REVIEW =====';

function emitSkip(reason) {
  process.stderr.write(`[glm-gate] skipped: ${reason}\n`);
  process.stdout.write(`${MARK_START}\n`);
  process.stdout.write(`SKIPPED: ${reason}\n`);
  process.stdout.write(`${MARK_END}\n`);
  process.exit(0);
}

function emitReview(text) {
  process.stdout.write(`${MARK_START}\n`);
  process.stdout.write(`${text.trim()}\n`);
  process.stdout.write(`${MARK_END}\n`);
}

const gateFlag = (process.env.GLM_REVIEW_GATE || '').trim().toLowerCase();
if (['off', '0', 'false', 'no', 'disabled'].includes(gateFlag)) {
  emitSkip('GLM gate disabled via GLM_REVIEW_GATE.');
}

function git(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  return result.status === 0 ? (result.stdout || '') : '';
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

const apiKey = (process.env.ZAI_API_KEY || process.env.GLM_API_KEY || keyFromDotenv()).trim();
if (!apiKey) {
  emitSkip('No API key; set ZAI_API_KEY or GLM_API_KEY in env or .env, or GLM_REVIEW_GATE=off to disable.');
}

const model = (process.env.GLM_REVIEW_MODEL || 'glm-5.2').trim();
const baseUrl = (process.env.GLM_REVIEW_BASE_URL || 'https://api.z.ai/api/anthropic').replace(/\/+$/, '');
const maxCtx = Number.parseInt(process.env.GLM_REVIEW_MAX_CTX_BYTES || '400000', 10) || 400000;

function detectBase() {
  const remoteHead = git(['rev-parse', '--abbrev-ref', 'origin/HEAD']).trim();
  if (remoteHead) return remoteHead.replace(/^origin\//, '');
  for (const branch of ['main', 'master']) {
    if (git(['rev-parse', '--verify', branch]).trim()) return branch;
  }
  return 'main';
}

function optVal(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

const userArgs = process.argv.slice(2);
const commitArg = optVal(userArgs, '--commit');
const uncommitted = userArgs.includes('--uncommitted');
const baseArg = optVal(userArgs, '--base');

let scopeLabel;
let diff;
let stat;
let changedFiles;

if (commitArg) {
  scopeLabel = `the single commit ${commitArg}`;
  diff = git(['show', commitArg]);
  stat = git(['show', '--stat', '--oneline', commitArg]);
  changedFiles = git(['show', '--name-only', '--pretty=format:', commitArg]).split('\n').filter(Boolean);
} else if (uncommitted) {
  scopeLabel = 'all uncommitted changes (staged, unstaged, and untracked)';
  diff = git(['diff', 'HEAD']);
  stat = git(['diff', '--stat', 'HEAD']);
  const tracked = git(['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  changedFiles = [...new Set([...tracked, ...untracked])];
} else {
  const rawBase = baseArg || detectBase();
  const hasRef = (ref) => spawnSync('git', ['rev-parse', '--verify', '--quiet', ref]).status === 0;
  const base = /\//.test(rawBase)
    ? rawBase
    : (hasRef(`origin/${rawBase}`) ? `origin/${rawBase}` : rawBase);
  scopeLabel = `the changes on the current branch versus ${base} (git diff ${base}...HEAD)`;
  diff = git(['diff', `${base}...HEAD`]);
  stat = git(['diff', '--stat', `${base}...HEAD`]);
  changedFiles = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean);
}

if (!diff.trim() && !changedFiles.length) {
  emitSkip(`No changes found for ${scopeLabel}.`);
}

const diffCap = Math.floor(maxCtx * 0.6);
let diffText = diff;
if (diffText.length > diffCap) {
  diffText = `${diffText.slice(0, diffCap)}\n\n[diff truncated at ${diffCap} bytes of ${diff.length}; raise GLM_REVIEW_MAX_CTX_BYTES or scope the review to fewer files]\n`;
}

let payload = `## Diff stat\n${stat}\n\n## Full diff\n${diffText}\n`;
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

const systemPrompt = [
  'You are an independent senior software reviewer running the last structural gate before a pull request merges. This is a read-only review. You are given the diff and the full current contents of changed files.',
  'Focus on structural issues: architecture/design, correctness bugs, security loopholes, missed edge cases, concurrency/data-integrity, breaking changes, fail-direction. Ignore pure nitpicks unless they cause a real defect.',
  'For each finding output: a severity tag [P1]=blocker / [P2] / [minor], the file:line, the problem, and a concrete fix.',
  'Finish with a one-line overall verdict: APPROVE / APPROVE WITH COMMENTS / REQUEST CHANGES. If nothing structural is wrong, say so plainly.',
  'Output only the review.',
].join('\n');

const userPrompt = `Review ${scopeLabel}.\n\n${payload}`;
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
