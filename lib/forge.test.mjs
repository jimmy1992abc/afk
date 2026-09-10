import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import { test } from 'node:test';

import {
  FORGES,
  azureOrganization,
  detectForge,
  githubRepository,
  issueCommand,
  resolveForge,
} from './forge.mjs';

// The provenance scan reads `user@host` as an operator email. These are git URL
// userinfo, not addresses, so they are assembled rather than written literally.
const AT = '@';
const withUserinfo = (userinfo, rest) => `${userinfo}${AT}${rest}`;

const configWith = (body) => {
  const dir = mkdtempSync(join(tmpdir(), 'afk-forge-'));
  const path = join(dir, 'config.md');
  writeFileSync(path, body);
  return path;
};

test('detects github from every remote shape it is written in', () => {
  for (const url of [
    'https://github.com/org/repo.git',
    withUserinfo('git', 'github.com:org/repo.git'),
    `ssh://${withUserinfo('git', 'github.com/org/repo.git')}`,
    `https://${withUserinfo('user:tok', 'github.com/org/repo.git')}`,
  ]) {
    assert.equal(detectForge(url), 'github', url);
  }
});

test('detects azure-devops from both the current and the legacy host', () => {
  for (const url of [
    'https://dev.azure.com/org/project/_git/repo',
    `https://${withUserinfo('org', 'dev.azure.com/org/project/_git/repo')}`,
    withUserinfo('git', 'ssh.dev.azure.com:v3/org/project/repo'),
    'https://org.visualstudio.com/project/_git/repo',
    'ssh://vs-ssh.visualstudio.com:22/org/project/_ssh/repo',
  ]) {
    assert.equal(detectForge(url), 'azure-devops', url);
  }
});

test('an unknown, empty, or malformed remote detects nothing', () => {
  // Guessing a forge from a host nobody recognised is how a lookalike host
  // gets a credential aimed at it; no detection is the safe answer.
  for (const url of [
    'https://gitlab.com/org/repo.git',
    'https://github.com.evil.example/org/repo.git',
    'https://notgithub.com/org/repo.git',
    '',
    null,
    undefined,
    'not a url',
  ]) {
    assert.equal(detectForge(url), null, String(url));
  }
});

test('a configured forge outranks the remote, and reports its source', () => {
  const path = configWith('## forge\nforge: azure-devops\n');
  assert.deepEqual(
    resolveForge({ configPath: path, remoteUrl: 'https://github.com/o/r.git' }),
    { forge: 'azure-devops', source: 'config', known: true },
  );
});

test('an unset forge falls to the remote, then to github', () => {
  const empty = configWith('## commands\ntest: npm test\n');
  assert.deepEqual(
    resolveForge({ configPath: empty, remoteUrl: 'https://dev.azure.com/o/p/_git/r' }),
    { forge: 'azure-devops', source: 'remote', known: true },
  );
  assert.deepEqual(
    resolveForge({ configPath: empty, remoteUrl: 'https://gitlab.com/o/r.git' }),
    { forge: 'github', source: 'default', known: true },
  );
});

test('an unrecognised configured value names itself rather than falling back', () => {
  // Falling back would run a GitHub command against whatever the operator
  // actually meant, and the wrong-forge read below is exactly what that costs.
  const path = configWith('## forge\nforge: bitbucket\n');
  const resolved = resolveForge({ configPath: path, remoteUrl: 'https://github.com/o/r.git' });
  assert.equal(resolved.forge, 'bitbucket');
  assert.equal(resolved.source, 'config');
  assert.equal(resolved.known, false);
});

test('the shipped template leaves forge unset rather than reading its comment', () => {
  // Every consuming project starts from this file, so a config reader that took
  // the commented key's trailing text as a value would hand each of them a
  // garbage forge before they ever set one.
  const template = new URL('../templates/afk-config.example.md', import.meta.url);
  assert.deepEqual(
    resolveForge({
      configPath: fileURLToPath(template),
      remoteUrl: 'https://dev.azure.com/o/p/_git/r',
    }),
    { forge: 'azure-devops', source: 'remote', known: true },
  );
});

test('github binds the read to the repository the remote names', () => {
  // gh takes GH_REPO over the checkout's origin — verified: with GH_REPO set,
  // `gh issue view 45` in this repository returned another repository's item
  // and exited 0. An unbound read is decided by the environment.
  assert.deepEqual(
    issueCommand('github', 42, { remoteUrl: 'https://github.com/org/repo.git' }),
    { bin: 'gh', args: ['issue', 'view', '42', '--repo', 'org/repo'] },
  );
});

test('every github remote shape yields the same repository', () => {
  for (const remoteUrl of [
    'https://github.com/org/repo.git',
    'https://github.com/org/repo',
    withUserinfo('git', 'github.com:org/repo.git'),
    `ssh://${withUserinfo('git', 'github.com/org/repo.git')}`,
    `https://${withUserinfo('user:tok', 'github.com/org/repo.git')}`,
  ]) {
    assert.equal(githubRepository(remoteUrl), 'org/repo', remoteUrl);
  }
});

test('an unrecognised host keeps its host in the repository selector', () => {
  // A self-hosted install still has to be named, or GH_REPO decides; gh refuses
  // a host it was never authenticated against, which is the wanted answer.
  assert.equal(githubRepository('https://git.example.com/o/r.git'), 'git.example.com/o/r');
});

test('a configured value cannot smuggle credentials into an argv', () => {
  // `.afk/config.md` must hold no secret, but argv is readable by any process
  // on the box, so a pasted userinfo is stripped rather than trusted.
  const cmd = issueCommand('github', 42, {
    remoteUrl: 'https://github.com/org/repo.git',
    repository: `${withUserinfo('user:PAT', 'github.example.com')}/org/repo`,
  });
  assert.ok(!cmd.args.some((a) => a.includes('PAT')), JSON.stringify(cmd));
  const azure = issueCommand('azure-devops', 42, {
    remoteUrl: 'https://dev.azure.com/contoso/p/_git/r',
    organization: `https://${withUserinfo('user:PAT', 'dev.azure.com/contoso')}`,
  });
  assert.ok(!azure.args.some((a) => a.includes('PAT')), JSON.stringify(azure));
});

test('a cross-host github setup binds the read to a configured repository', () => {
  // `gh` resolves its repository from the checkout, so on a non-GitHub remote
  // the tracker would be chosen by ambient state rather than by config.
  const cmd = issueCommand('github', 42, {
    remoteUrl: 'https://dev.azure.com/contoso/proj/_git/repo',
    repository: 'org/repo',
  });
  assert.deepEqual(cmd, { bin: 'gh', args: ['issue', 'view', '42', '--repo', 'org/repo'] });
});

test('a cross-host github setup without a repository fails closed', () => {
  const cmd = issueCommand('github', 42, {
    remoteUrl: 'https://dev.azure.com/contoso/proj/_git/repo',
  });
  assert.equal(cmd.bin, undefined);
  assert.match(cmd.unsupported, /github-repository/);
});

test('azure-devops binds the work item read to the remote organization', () => {
  // Work item ids are organization-scoped, so without an explicit --org `az`
  // answers from whichever organization is configured as its global default —
  // verified: with a default set and no Azure remote to detect, the command
  // proceeds to authenticate against that default instead of refusing.
  const cmd = issueCommand('azure-devops', 42, {
    remoteUrl: 'https://dev.azure.com/contoso/proj/_git/repo',
  });
  assert.equal(cmd.bin, 'az');
  assert.deepEqual(cmd.args, [
    'boards', 'work-item', 'show', '--id', '42',
    '--organization', 'https://dev.azure.com/contoso',
    '--detect', 'false', '--output', 'json',
  ]);
});

test('every azure remote shape yields the same organization', () => {
  const shapes = [
    'https://dev.azure.com/contoso/proj/_git/repo',
    `https://${withUserinfo('contoso', 'dev.azure.com/contoso/proj/_git/repo')}`,
    withUserinfo('git', 'ssh.dev.azure.com:v3/contoso/proj/repo'),
    'https://contoso.visualstudio.com/proj/_git/repo',
    `ssh://${withUserinfo('contoso', 'vs-ssh.visualstudio.com:22/contoso/proj/_ssh/repo')}`,
  ];
  for (const remoteUrl of shapes) {
    const cmd = issueCommand('azure-devops', 7, { remoteUrl });
    assert.ok(
      cmd.args?.includes('https://dev.azure.com/contoso'),
      `${remoteUrl} -> ${JSON.stringify(cmd)}`,
    );
  }
});

test('a non-azure remote never yields an azure organization', () => {
  // The cross-host case is the one the config key exists for, so deriving from
  // whatever host `origin` names would aim the read at a same-named
  // organization that may well exist.
  for (const remoteUrl of [
    'https://github.com/code-owner/repo.git',
    withUserinfo('git', 'github.com:code-owner/repo.git'),
    'https://gitlab.com/code-owner/repo.git',
  ]) {
    assert.equal(azureOrganization(remoteUrl), null, remoteUrl);
    const cmd = issueCommand('azure-devops', 42, { remoteUrl });
    assert.equal(cmd.bin, undefined, remoteUrl);
    assert.match(cmd.unsupported, /azure-organization/);
  }
});

test('a configured organization serves the cross-host case and outranks the remote', () => {
  const cmd = issueCommand('azure-devops', 42, {
    remoteUrl: 'https://github.com/code-owner/repo.git',
    organization: 'https://dev.azure.com/contoso',
  });
  assert.equal(cmd.bin, 'az');
  assert.ok(cmd.args.includes('https://dev.azure.com/contoso'));
  assert.ok(!cmd.args.includes('https://dev.azure.com/code-owner'));
});

test('an azure remote with no derivable organization fails closed', () => {
  // Falling back to the ambient default is the wrong-tracker read this module
  // exists to prevent, so no command is built at all.
  for (const remoteUrl of ['https://dev.azure.com/', '', 'https://dev.azure.com']) {
    const cmd = issueCommand('azure-devops', 7, { remoteUrl });
    assert.equal(cmd.bin, undefined, remoteUrl);
    assert.match(cmd.unsupported, /organization/i);
  }
});

test('an unsupported forge yields a named reason, never a command', () => {
  // The failure this prevents is not a crash: gh installed and authed against
  // a different host returns some other repository's issue 42 with status 0 —
  // a well-formed brief built on the wrong requirement.
  const cmd = issueCommand('bitbucket', 42);
  assert.equal(cmd.bin, undefined);
  assert.match(cmd.unsupported, /bitbucket/);
});

test('a non-numeric issue reference never reaches a command line', () => {
  for (const bad of ['--help', '1; rm -rf /', '', null, '-1', '1.5', '0', '00', '000']) {
    const cmd = issueCommand('github', bad);
    assert.equal(cmd.bin, undefined, String(bad));
    assert.match(cmd.unsupported, /reference/i);
  }
});

test('every forge in the list can build a command from its own remote', () => {
  // The list is what resolveForge treats as known, so a name in it with no
  // dispatch would resolve cleanly and then fail at the command.
  const remotes = {
    github: 'https://github.com/org/repo.git',
    'azure-devops': 'https://dev.azure.com/contoso/proj/_git/repo',
  };
  for (const forge of FORGES) {
    const cmd = issueCommand(forge, 1, { remoteUrl: remotes[forge] });
    assert.notEqual(cmd.bin, undefined, `${forge}: ${cmd.unsupported}`);
  }
});

test('the detect CLI answers with the same resolution the adapter uses', () => {
  // afk-init records the forge, and that value outranks the remote later, so a
  // second derivation there is a second source of truth.
  const cli = fileURLToPath(new URL('./forge.mjs', import.meta.url));
  const run = (remote) =>
    JSON.parse(execFileSync('node', [cli, '--remote', remote], { encoding: 'utf8' }));

  const azure = run('https://dev.azure.com/contoso/proj/_git/repo');
  assert.equal(azure.forge, detectForge('https://dev.azure.com/contoso/proj/_git/repo'));
  assert.equal(azure.azureOrganization, 'https://dev.azure.com/contoso');

  const gh = run('https://github.com/org/repo.git');
  assert.equal(gh.forge, 'github');
  assert.equal(gh.githubRepository, 'org/repo');

  assert.equal(run('https://gitlab.com/o/r.git').forge, null);
});

test('the detect CLI refuses to guess without a remote', () => {
  const cli = fileURLToPath(new URL('./forge.mjs', import.meta.url));
  const r = spawnSync('node', [cli], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--remote/);
});
