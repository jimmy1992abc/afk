#!/usr/bin/env node
// A settings audit must never repair its own evidence or mistake an API refusal
// for an empty, compliant configuration.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const GITHUB_ACTIONS_APP_ID = 15368;
const REQUIRED_CHECKS = ['checks', 'gate'];
const SIMPLE_RULES = ['required_linear_history', 'non_fast_forward', 'deletion'];
const API_TIMEOUT_MS = 30000;

export function readGitHubJson(endpoint, { paginate = false, run = spawnSync } = {}) {
  const args = ['api', '--method', 'GET', endpoint];
  if (paginate) args.push('--paginate', '--slurp');
  const result = run('gh', args, { encoding: 'utf8', timeout: API_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('API request unavailable');
  return JSON.parse(result.stdout);
}

function rulesetDrift(detail) {
  const reasons = [];
  if (detail.target !== 'branch' || detail.enforcement !== 'active') reasons.push('branch ruleset is not active');
  if (detail.bypass_actors.length) reasons.push('bypass actors are configured');
  const rule = (type) => detail.rules.find((item) => item?.type === type);
  for (const type of SIMPLE_RULES) if (!rule(type)) reasons.push(`missing ${type}`);
  const pr = rule('pull_request')?.parameters;
  if (!pr) reasons.push('missing pull_request rule');
  else {
    if (pr.required_approving_review_count !== 0 || pr.require_code_owner_review !== false || pr.require_last_push_approval !== false) reasons.push('native approval policy differs');
    if (pr.dismiss_stale_reviews_on_push !== true) reasons.push('stale approvals are not dismissed');
    if (pr.required_review_thread_resolution !== true) reasons.push('review thread resolution is not required');
    if (!Array.isArray(pr.allowed_merge_methods) || pr.allowed_merge_methods.length !== 1 || pr.allowed_merge_methods[0] !== 'squash') reasons.push('PR rule is not squash-only');
  }
  const status = rule('required_status_checks')?.parameters;
  if (status?.strict_required_status_checks_policy !== true) reasons.push('strict status checks are not required');
  for (const context of REQUIRED_CHECKS) {
    if (!status?.required_status_checks?.some((check) => check.context === context && check.integration_id === GITHUB_ACTIONS_APP_ID)) reasons.push(`missing required ${context} from GitHub Actions`);
  }
  return reasons;
}

export function auditBranchProtection(repository, { read = readGitHubJson } = {}) {
  const result = (status, reasons) => ({ status, exitCode: { COMPLIANT: 0, DRIFT: 1, UNVERIFIABLE: 2 }[status], reasons });
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) return result('UNVERIFIABLE', ['expected explicit OWNER/REPO']);
  let reading = 'repository settings';
  try {
    const root = `repos/${repository}`;
    const settings = read(root);
    if (!['allow_squash_merge', 'allow_merge_commit', 'allow_rebase_merge'].every((key) => typeof settings?.[key] === 'boolean')) throw new Error('incomplete settings');
    const reasons = [];
    if (!settings.allow_squash_merge || settings.allow_merge_commit || settings.allow_rebase_merge) reasons.push('repository merge settings are not squash-only');
    reading = 'main branch';
    const branch = read(`${root}/branches/main`);
    if (typeof branch?.protected !== 'boolean') throw new Error('incomplete branch');
    if (!branch.protected) reasons.push('main is unprotected');
    reading = 'effective main rules';
    const pages = read(`${root}/rules/branches/main`, { paginate: true });
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('incomplete rules pages');
    const effective = pages.flat();
    if (!effective.every((rule) => typeof rule?.type === 'string' && Number.isInteger(rule.ruleset_id) && typeof rule.ruleset_source_type === 'string')) throw new Error('incomplete rule metadata');
    const ids = [...new Set(effective.filter((rule) => rule.ruleset_source_type === 'Repository').map((rule) => rule.ruleset_id))];
    let compliantRuleset = false;
    const drift = [];
    for (const id of ids) {
      reading = `source ruleset ${id}`;
      const detail = read(`${root}/rulesets/${id}`);
      if (detail?.id !== id || typeof detail.enforcement !== 'string' || !Array.isArray(detail.bypass_actors) || !Array.isArray(detail.rules)) throw new Error('incomplete ruleset');
      const missing = rulesetDrift(detail);
      if (missing.length === 0) compliantRuleset = true;
      else drift.push(...missing.map((reason) => `ruleset ${id}: ${reason}`));
    }
    if (!compliantRuleset) reasons.push(...(drift.length ? drift : ['no applicable complete repository ruleset']));
    return reasons.length ? result('DRIFT', reasons) : result('COMPLIANT', ['main controls and squash-only settings match the documented policy']);
  } catch {
    return result('UNVERIFIABLE', [`could not verify ${reading}; API unavailable or response incomplete`]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const audit = process.argv.length === 3
    ? auditBranchProtection(process.argv[2])
    : { status: 'UNVERIFIABLE', exitCode: 2, reasons: ['usage: node scripts/audit-branch-protection.mjs OWNER/REPO'] };
  console.log(`${audit.status}: ${audit.reasons.join('; ')}`);
  process.exitCode = audit.exitCode;
}
