// One place decides which forge a repository lives on, so no skill or helper
// names a CLI. Dispatch is keyed to the resolved forge, never to which CLI
// happens to run: `gh` installed and authed against a different host answers
// `issue view 42` from some other repository with status 0, so a helper that
// tries the command and treats failure as absence gets no signal at all.

import { pathToFileURL } from 'node:url';

import { readConfigSectionValue } from './config.mjs';

export const FORGES = ['github', 'azure-devops'];

// Host suffixes, matched on the host alone after the userinfo is stripped — a
// substring test would accept `github.com.<attacker>` and aim a credential at
// it.
const HOSTS = [
  { forge: 'github', suffixes: ['github.com'] },
  {
    forge: 'azure-devops',
    suffixes: ['dev.azure.com', 'ssh.dev.azure.com', 'visualstudio.com'],
  },
];

// One parse feeds both the host match and the organization, so they can never
// disagree about where a remote's path begins.
function parseRemote(remoteUrl) {
  const url = String(remoteUrl ?? '').trim();
  if (!url) return null;
  // scp-style (`git@host:path`) is not a URL; everything else is parsed as one.
  const scp = /^(?:[^@/\s]+@)?([^@/:\s]+):(?!\/\/)(.*)$/.exec(url);
  if (scp) return { host: scp[1].toLowerCase(), path: scp[2] };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `ssh://${url}`;
  try {
    const { hostname, pathname } = new URL(withScheme);
    return hostname ? { host: hostname.toLowerCase(), path: pathname } : null;
  } catch {
    return null;
  }
}

function hostOf(remoteUrl) {
  return parseRemote(remoteUrl)?.host ?? null;
}

export function detectForge(remoteUrl) {
  const host = hostOf(remoteUrl);
  if (!host) return null;
  for (const { forge, suffixes } of HOSTS) {
    for (const suffix of suffixes) {
      if (host === suffix || host.endsWith(`.${suffix}`)) return forge;
    }
  }
  return null;
}

// `known: false` travels with an unrecognised configured value so a caller can
// say which forge it could not serve. Substituting a default here would run a
// GitHub command against whatever the operator meant instead.
export function resolveForge({ configPath, remoteUrl } = {}) {
  const configured = configPath ? readConfigSectionValue(configPath, 'forge', 'forge') : null;
  if (configured) {
    return { forge: configured, source: 'config', known: FORGES.includes(configured) };
  }
  const detected = detectForge(remoteUrl);
  if (detected) return { forge: detected, source: 'remote', known: true };
  return { forge: 'github', source: 'default', known: true };
}

// `.afk/config.md` must hold no secret, but argv is readable by any process on
// the box, so a pasted userinfo is dropped rather than trusted to be harmless.
function withoutUserinfo(value) {
  return String(value ?? '').trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)?[^/?#\s]*@/i, '$1');
}

// The repository a remote names, in the `[HOST/]OWNER/REPO` form `gh` takes.
// An unrecognised host is kept in the selector: it still has to be named, or
// `GH_REPO` decides, and `gh` refuses a host it was never authenticated against.
export function githubRepository(remoteUrl) {
  const parsed = parseRemote(remoteUrl);
  if (!parsed) return null;
  const segments = parsed.path.replace(/\.git$/, '').split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const [owner, repo] = segments.slice(-2);
  return detectForge(remoteUrl) === 'github'
    ? `${owner}/${repo}`
    : `${parsed.host}/${owner}/${repo}`;
}

// Positive-integer only: the reference reaches an argv, and a leading dash
// would be read as a flag by either CLI.
function issueId(reference) {
  const raw = String(reference ?? '').trim();
  return /^[0-9]+$/.test(raw) && Number(raw) > 0 ? raw : null;
}

// The organization a remote names, as the URL `az` takes. Azure DevOps writes it
// as the first path segment on `dev.azure.com`, and as the subdomain on the
// legacy host — except on its shared ssh host, which carries it in the path.
export function azureOrganization(remoteUrl) {
  const parsed = parseRemote(remoteUrl);
  // Only an Azure-shaped remote names an Azure organization. Reading the first
  // path segment of any other host would turn `<code-host>/<owner>/<repo>` into
  // an organization of the same name — which may exist, and is the case the
  // `forge:` key is set for.
  if (!parsed || detectForge(remoteUrl) !== 'azure-devops') return null;
  const { host, path } = parsed;
  if (host.endsWith('.visualstudio.com') && !host.startsWith('vs-ssh.')) {
    return `https://dev.azure.com/${host.slice(0, host.indexOf('.'))}`;
  }
  const segments = path.split('/').filter(Boolean);
  // The ssh form prefixes the path with a protocol version.
  if (segments[0] === 'v3') segments.shift();
  return segments[0] ? `https://dev.azure.com/${segments[0]}` : null;
}

const ISSUE_COMMAND = {
  // `gh` resolves its repository from the checkout, so on a remote it does not
  // recognise the tracker would be chosen by ambient state. A GitHub remote
  // already names the repository; anything else has to say which one.
  // `gh` resolves its repository from the checkout. It refuses a host it was
  // never told is GitHub, so an unrecognised remote — a self-hosted install,
  // typically — is left to it. A remote belonging to a DIFFERENT known forge is
  // not: there `gh` reads its repository from the environment instead, and the
  // tracker would be chosen by ambient state rather than by config.
  github: (id, { remoteUrl, repository } = {}) => {
    const configured = withoutUserinfo(repository);
    // A remote belonging to a known different forge names no GitHub repository;
    // deriving one from its path would build a plausible bogus selector.
    const detected = detectForge(remoteUrl);
    const repo = configured
      || (detected && detected !== 'github' ? null : githubRepository(remoteUrl));
    if (!repo) {
      return {
        unsupported: 'no GitHub repository — set `github-repository` under `## forge`',
      };
    }
    return { bin: 'gh', args: ['issue', 'view', id, '--repo', repo] };
  },
  // Work item ids are organization-scoped rather than per-repository, so the
  // directory the command runs in does not narrow the id. Without an explicit
  // organization `az` answers from whichever one is configured as its global
  // default, which is the wrong-tracker read this module exists to prevent, so
  // the organization comes from the remote and `--detect` is turned off.
  'azure-devops': (id, { remoteUrl, organization } = {}) => {
    const org = withoutUserinfo(organization) || azureOrganization(remoteUrl);
    if (!org) {
      return {
        unsupported:
          'no Azure DevOps organization — set `azure-organization` under `## forge`',
      };
    }
    return {
      bin: 'az',
      args: [
        'boards', 'work-item', 'show', '--id', id,
        '--organization', org,
        '--detect', 'false', '--output', 'json',
      ],
    };
  },
};

export function issueCommand(forge, reference, options = {}) {
  const id = issueId(reference);
  if (!id) return { unsupported: `not a positive issue reference: ${reference}` };
  const build = ISSUE_COMMAND[forge];
  if (!build) return { unsupported: `no issue adapter for forge: ${forge}` };
  return build(id, options);
}


function optVal(argv, flag) {
  const i = argv.indexOf(flag);
  const next = i >= 0 ? argv[i + 1] : undefined;
  return next && !next.startsWith('--') ? next : '';
}

// `afk-init` records the forge, and the value it writes outranks the remote at
// every later read. Deriving it by hand there would let the recorded value and
// this module disagree, so the bootstrap asks this one implementation instead.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const remote = optVal(process.argv.slice(2), '--remote');
  if (!remote) {
    process.stderr.write('forge: --remote <url> is required\n');
    process.exit(2);
  }
  const forge = detectForge(remote);
  process.stdout.write(
    `${JSON.stringify({
      forge,
      reason: forge ? 'detected from the remote host' : 'no known forge for this host',
      azureOrganization: forge === 'azure-devops' ? azureOrganization(remote) : null,
      githubRepository: forge === 'github' ? githubRepository(remote) : null,
    }, null, 2)}\n`,
  );
}
