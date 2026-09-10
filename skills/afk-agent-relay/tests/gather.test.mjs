import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  boundNotes, gatherContext, filterGrepByExcludes,
} from '../lib/gather.mjs';
import { runRole } from '../lib/role.mjs';
import { mainWorktree } from '../../../lib/gate/git.mjs';

const noRun = () => ({ status: 1, stdout: '', stderr: '', error: new Error('nope') });

test('excluded files are skipped with a loud note', () => {
  const g = gatherContext(
    { files: ['.env', 'app.py'] },
    { run: noRun, readFile: (p) => (p === 'app.py' ? 'print(1)' : 'SECRET=1') },
  );
  assert.ok(g.notes.some((n) => n.includes('excluded') && n.includes('.env')));
  assert.match(g.text, /print\(1\)/);
  assert.doesNotMatch(g.text, /SECRET=1/);
});

test('byte cap truncates and emits a loud note', () => {
  const big = 'x'.repeat(5000);
  const g = gatherContext(
    { files: ['a.py', 'b.py'] },
    { run: noRun, readFile: () => big, maxBytes: 1000 },
  );
  assert.ok(g.notes.some((n) => /truncated|dropped/.test(n)));
  assert.ok(g.bytes <= 1000, `${g.bytes} bytes exceeded the 1000-byte cap`);
});

test('redaction note when secrets present', () => {
  const g = gatherContext(
    { files: ['cfg.py'] },
    { run: noRun, readFile: () => 'token = "abcdef1234567890"' },
  );
  assert.ok(g.notes.some((n) => n.includes('redacted')));
  assert.doesNotMatch(g.text, /abcdef1234567890/);
});

test('git diff is gathered via the injected run', () => {
  const run = (cmd, args) => {
    if (args.includes('--name-status')) return { status: 0, stdout: 'M\0x.py\0' };
    if (cmd === 'git' && args[0] === 'diff') {
      return { status: 0, stdout: 'diff --git a/x.py b/x.py\n+DIFFBODY', stderr: '', error: null };
    }
    return { status: 0, stdout: 'main', stderr: '', error: null };
  };
  const g = gatherContext({ diff: 'main' }, { run, readFile: () => null });
  assert.match(g.text, /DIFFBODY/);
});

test('filterGrepByExcludes drops hits from excluded files (incl. secret dirs)', () => {
  const out = ['.env:3:SECRET=abc', 'app.py:10:foo()', 'secrets/x.json:1:bar'].join('\n');
  const { text, dropped } = filterGrepByExcludes(out);
  assert.ok(dropped.includes('.env'));
  assert.ok(dropped.includes('secrets/x.json'));
  assert.match(text, /app\.py:10:foo/);
  assert.doesNotMatch(text, /SECRET=abc/);
});

// The issue read dispatches on the resolved forge rather than on which CLI
// answers, so these pin which command is built and that every path that does
// not produce issue text says which one it was.

const runnerFor = (remoteUrl, issueResult) => {
  const calls = [];
  const run = (bin, args) => {
    calls.push([bin, ...args].join(' '));
    if (bin === 'git' && args[0] === 'remote') {
      return { status: 0, stdout: remoteUrl, stderr: '', error: undefined };
    }
    return issueResult;
  };
  return { run, calls };
};

const ok = (body) => ({ status: 0, stdout: body, stderr: '', error: undefined });
const failed = { status: 1, stdout: '', stderr: 'boom', error: undefined };

test('a github remote reads the issue through gh', () => {
  const { run, calls } = runnerFor('https://github.com/o/r.git', ok('issue body here'));
  const g = gatherContext({ issue: ['42'] }, { run, readFile: () => null });
  assert.ok(calls.includes('gh issue view 42 --repo o/r'), calls.join(' | '));
  assert.match(g.text, /issue body here/);
  assert.equal(g.notes.length, 0);
});

test('an azure devops remote reads the work item through az', () => {
  const { run, calls } = runnerFor(
    'https://dev.azure.com/org/proj/_git/repo',
    ok('{"fields":{"System.Title":"t"}}'),
  );
  gatherContext({ issue: ['42'] }, { run, readFile: () => null });
  assert.ok(
    calls.includes(
      'az boards work-item show --id 42 --organization'
        + ' https://dev.azure.com/org --detect false --output json',
    ),
    calls.join(' | '),
  );
  assert.ok(!calls.some((c) => c.startsWith('gh ')), 'gh must not be tried');
});

test('a configured forge with no adapter names itself and builds no command', () => {
  // The failure this replaces is not a crash: gh authed against another host
  // answers for id 42 and exits 0, so the brief comes back well-formed with
  // another tracker's issue in it. An unrecognised configured value must not
  // fall back for the same reason — the fallback would be that command.
  const dir = mkdtempSync(join(tmpdir(), 'afk-gather-'));
  const configPath = join(dir, 'config.md');
  writeFileSync(configPath, '## forge\nforge: bitbucket\n');
  const { run, calls } = runnerFor('https://github.com/o/r.git', ok('wrong issue'));
  const g = gatherContext({ issue: ['42'] }, { run, readFile: () => null, configPath });
  assert.ok(!calls.some((c) => c.startsWith('gh ') || c.startsWith('az ')), calls.join(' | '));
  assert.doesNotMatch(g.text, /wrong issue/);
  assert.equal(g.notes.length, 1);
  assert.match(g.notes[0], /no issue adapter for forge: bitbucket/);
});

test('an unrecognised remote host falls back to github, still bound to its repo', () => {
  // Self-hosted GitHub is the common case behind an unrecognised host, so the
  // fallback is deliberate; the host stays in the selector so the read is not
  // left for GH_REPO to decide, and gh refuses a host it does not know.
  const { run, calls } = runnerFor('https://git.example.com/o/r.git', ok('body'));
  gatherContext({ issue: ['42'] }, { run, readFile: () => null });
  assert.ok(
    calls.includes('gh issue view 42 --repo git.example.com/o/r'),
    calls.join(' | '),
  );
});

test('a CLI that fails and a forge that is unsupported give different notes', () => {
  const { run: failingRun } = runnerFor('https://github.com/o/r.git', failed);
  const cliFailed = gatherContext({ issue: ['42'] }, { run: failingRun, readFile: () => null });
  assert.equal(cliFailed.notes.length, 1);
  assert.match(cliFailed.notes[0], /gh could not read issue 42 on github/);

  const { run: badRefRun } = runnerFor('https://github.com/o/r.git', ok('x'));
  const badRef = gatherContext({ issue: ['--help'] }, { run: badRefRun, readFile: () => null });
  assert.equal(badRef.notes.length, 1);
  assert.match(badRef.notes[0], /not a positive issue reference/);
  assert.notEqual(cliFailed.notes[0], badRef.notes[0]);
});

test('the role pipeline hands gather the main worktree config path', async () => {
  // The forge override is read from `.afk/config.md`. Without it reaching the
  // one caller that runs in production, the shipped key resolves only in tests.
  let seen = 'GATHER NEVER CALLED';
  // Only the argument gather receives is under test; the provider call after it
  // is stubbed just far enough to be reached, and may fail past that point.
  await runRole(
    {
      label: 'BRIEF',
      defaultProvider: 'deepseek',
      providerEnv: 'P',
      modelEnv: 'M',
      systemPrompt: 's',
      validate: () => ({ ok: true }),
      buildInput: () => ({ prefix: 'u', context: '' }),
    },
    {
      argv: ['--manual', '--task', 't', '--issue', '1'],
      env: { DEV_DEEPSEEK_API_KEY: 'k' },
      gather: (_sources, opts) => {
        seen = opts.configPath;
        return { text: '', notes: [], bytes: 0 };
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'x' } }] }),
        text: async () => '{}',
      }),
    },
  ).catch(() => {});
  assert.notEqual(seen, 'GATHER NEVER CALLED', 'gather was never reached');
  assert.equal(seen, join(mainWorktree({}), '.afk', 'config.md'));
});

test('a cross-host azure setup reads the organization from config', () => {
  // forge: azure-devops with a non-Azure origin is the case the key exists for;
  // deriving from that origin would name a plausible wrong organization.
  const dir = mkdtempSync(join(tmpdir(), 'afk-gather-'));
  const configPath = join(dir, 'config.md');
  writeFileSync(
    configPath,
    '## forge\nforge: azure-devops\nazure-organization: https://dev.azure.com/contoso\n',
  );
  const { run, calls } = runnerFor('https://github.com/code-owner/repo.git', ok('{}'));
  const g = gatherContext({ issue: ['42'] }, { run, readFile: () => null, configPath });
  assert.ok(calls.some((c) => c.includes('https://dev.azure.com/contoso')), calls.join(' | '));
  assert.ok(!calls.some((c) => c.includes('code-owner')), calls.join(' | '));
  assert.equal(g.notes.length, 0);
});

test('a cross-host azure setup without the organization builds no command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afk-gather-'));
  const configPath = join(dir, 'config.md');
  writeFileSync(configPath, '## forge\nforge: azure-devops\n');
  const { run, calls } = runnerFor('https://github.com/code-owner/repo.git', ok('{}'));
  const g = gatherContext({ issue: ['42'] }, { run, readFile: () => null, configPath });
  assert.ok(!calls.some((c) => c.startsWith('az ') || c.startsWith('gh ')), calls.join(' | '));
  assert.match(g.notes[0], /azure-organization/);
});

// A read whose payload carries a comment count but no comment bodies loses the
// discussion. The count makes the loss knowable, so leaving it unsaid is the
// silent skip the rules forbid.

const workItem = (commentCount) =>
  JSON.stringify({ id: 42, fields: { 'System.Title': 't', 'System.CommentCount': commentCount } });

test('an issue read that drops its discussion says how much it dropped', () => {
  const { run } = runnerFor('https://dev.azure.com/org/proj/_git/repo', ok(workItem(12)));
  const g = gatherContext({ issue: ['42'] }, { run, readFile: () => null });
  assert.equal(g.notes.length, 1, g.notes.join(' | '));
  assert.match(g.notes[0], /issue 42/);
  assert.match(g.notes[0], /12/);
  assert.doesNotMatch(g.notes[0], /\baz\b|\bgh\b/, 'the note must not name a CLI');
  assert.match(g.text, /System\.Title/, 'the payload still reaches the brief');
});

test('an issue with no discussion adds no note', () => {
  // A note on every read is noise, and noise is how a real one gets missed.
  const { run } = runnerFor('https://dev.azure.com/org/proj/_git/repo', ok(workItem(0)));
  const g = gatherContext({ issue: ['42'] }, { run, readFile: () => null });
  assert.deepEqual(g.notes, []);
});

test('a payload carrying no count at all adds no note', () => {
  // The GitHub read renders its comments inline and has no count field; a note
  // derived from the forge rather than the response would fire spuriously.
  const { run } = runnerFor('https://github.com/o/r.git', ok('#42 issue body\n\nsome comment text'));
  const g = gatherContext({ issue: ['42'] }, { run, readFile: () => null });
  assert.deepEqual(g.notes, []);
});

test('a count that is not a positive integer adds no note', () => {
  // The note stands in for a payload the reader cannot see, so a fractional or
  // negative count would read as a defect in the note rather than in the read.
  for (const count of ['many', 2.7, -3, null, Number.NaN]) {
    const { run } = runnerFor('https://dev.azure.com/org/proj/_git/repo', ok(
      JSON.stringify({ fields: { 'System.CommentCount': count } }),
    ));
    const g = gatherContext({ issue: ['42'] }, { run, readFile: () => null });
    assert.deepEqual(g.notes, [], String(count));
  }
});

test('an unparseable payload is passed through without a note', () => {
  // The read succeeded; guessing at a shape it does not have would invent a
  // loss that may not exist.
  const { run } = runnerFor('https://dev.azure.com/org/proj/_git/repo', ok('not json at all'));
  const g = gatherContext({ issue: ['42'] }, { run, readFile: () => null });
  assert.deepEqual(g.notes, []);
  assert.match(g.text, /not json at all/);
});

// The cap is named in bytes, bounds what is sent to a paid model, and was
// measured in UTF-16 code units — about a third of the real payload for CJK.

test('the cap counts bytes, not UTF-16 code units', () => {
  const cjk = '需求'.repeat(2000); // 4000 chars, 12000 bytes
  const g = gatherContext(
    { files: ['a.md'] },
    { run: noRun, readFile: () => cjk, maxBytes: 3000, redact: false },
  );
  assert.ok(
    Buffer.byteLength(g.text, 'utf8') <= 3200,
    `payload was ${Buffer.byteLength(g.text, 'utf8')} bytes against a 3000-byte cap`,
  );
  assert.equal(g.bytes, Buffer.byteLength(g.text, 'utf8'));
});

test('truncation never splits a character', () => {
  const astral = '🙂'.repeat(2000);
  const g = gatherContext(
    { files: ['a.md'] },
    { run: noRun, readFile: () => astral, maxBytes: 1000, redact: false },
  );
  assert.doesNotMatch(g.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'a lone high surrogate survived');
  assert.doesNotMatch(g.text, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'a lone low surrogate survived');
});

test('an ascii payload under the cap is unchanged', () => {
  const g = gatherContext(
    { files: ['a.md'] },
    { run: noRun, readFile: () => 'plain ascii body', maxBytes: 4000, redact: false },
  );
  assert.match(g.text, /plain ascii body/);
  // redact:false adds its own warning; what matters is that the cap added none.
  assert.ok(!g.notes.some((n) => /truncated|dropped/.test(n)), g.notes.join(' | '));
});

test('file and log reads stay inside the canonical worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'afk-gather-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'afk-gather-outside-'));
  try {
    writeFileSync(join(root, 'safe.txt'), 'safe file body');
    writeFileSync(join(root, 'safe.log'), 'safe log body');
    writeFileSync(join(outside, 'secret.txt'), 'outside secret body');
    const g = gatherContext(
      {
        files: ['safe.txt', join(root, 'safe.txt'), join(outside, 'secret.txt')],
        logs: ['safe.log', join(outside, 'secret.txt')],
      },
      { run: noRun, cwd: root, repoRoot: root },
    );
    assert.match(g.text, /safe file body/);
    assert.match(g.text, /safe log body/);
    assert.doesNotMatch(g.text, /outside secret body/);
    assert.ok(g.notes.some((note) => note.includes('file') && note.includes('outside_path')));
    assert.ok(g.notes.some((note) => note.includes('log') && note.includes('outside_path')));
    assert.doesNotMatch(g.notes.join(' '), /afk-gather-outside-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('file reads resolve the current worktree instead of the shared main tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'afk-gather-linked-'));
  try {
    writeFileSync(join(root, 'safe.txt'), 'linked worktree body');
    let rootReads = 0;
    const run = (cmd, args) => {
      if (cmd === 'git' && args.join(' ') === 'rev-parse --show-toplevel') {
        rootReads++;
        return { status: 0, stdout: `${root}\n`, stderr: '', error: null };
      }
      return noRun();
    };
    const g = gatherContext({ files: ['safe.txt'] }, { run, cwd: root });
    assert.match(g.text, /linked worktree body/);
    assert.equal(rootReads, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('leaf and ancestor symlinks never enter gathered context', () => {
  const root = mkdtempSync(join(tmpdir(), 'afk-gather-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'afk-gather-outside-'));
  try {
    writeFileSync(join(outside, 'secret.txt'), 'outside secret body');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leaf.txt'));
    symlinkSync(outside, join(root, 'linked-dir'), 'dir');
    const g = gatherContext(
      { files: ['leaf.txt', 'linked-dir/secret.txt'] },
      { run: noRun, cwd: root, repoRoot: root },
    );
    assert.doesNotMatch(g.text, /outside secret body/);
    assert.ok(g.notes.some((note) => note.includes('symlink')));
    assert.ok(g.notes.some((note) => note.includes('ancestor_symlink_escape')));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('irregular files and an unresolved worktree fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'afk-gather-root-'));
  try {
    mkdirSync(join(root, 'directory'));
    writeFileSync(join(root, 'safe.txt'), 'must not be read without a root');
    const irregular = gatherContext(
      { files: ['directory'] },
      { run: noRun, cwd: root, repoRoot: root },
    );
    assert.ok(irregular.notes.some((note) => note.includes('non_regular')));
    const unresolved = gatherContext(
      { files: [join(root, 'safe.txt')] },
      { run: noRun, cwd: root, repoRoot: '' },
    );
    assert.equal(unresolved.text, '');
    assert.ok(unresolved.notes.some((note) => note.includes('root_unresolved')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('aggregate context charges every inter-chunk separator', () => {
  const first = '\n===== file a.txt =====\nx';
  const second = '\n\n===== file b.txt =====\ny';
  const cap = Buffer.byteLength(first + second, 'utf8') - 1;
  const g = gatherContext(
    { files: ['a.txt', 'b.txt'] },
    { run: noRun, readFile: (path) => (path === 'a.txt' ? 'x' : 'y'), maxBytes: cap },
  );
  assert.ok(g.bytes <= cap, `${g.bytes} bytes exceeded the ${cap}-byte cap`);
  assert.equal(g.bytes, Buffer.byteLength(g.text, 'utf8'));
});

test('a context cap smaller than its truncation marker is still strict', () => {
  const g = gatherContext(
    { files: ['a.txt'] },
    { run: noRun, readFile: () => '需求'.repeat(100), maxBytes: 32 },
  );
  assert.ok(g.bytes <= 32, `${g.bytes} bytes exceeded the 32-byte cap`);
  assert.ok(g.notes.some((note) => /drop|truncated/.test(note)));
});

test('notes are redacted, deduplicated, bounded, and report omissions', () => {
  const token = `tp-${'A7b'.repeat(20)}`;
  const notes = [
    `[redact ${token}]`,
    `[redact ${token}]`,
    ...Array.from({ length: 10000 }, (_, i) => `[note ${i}]`),
  ];
  const bounded = boundNotes(notes, 10000);
  assert.ok(bounded.length <= 51);
  assert.ok(Buffer.byteLength(bounded.join(' '), 'utf8') <= 2500);
  assert.equal(new Set(bounded).size, bounded.length);
  assert.doesNotMatch(bounded.join(' '), /tp-/);
  assert.match(bounded.at(-1), /additional gather note/);
});

test('an oversized multibyte note is dropped with a visible summary', () => {
  const bounded = boundNotes([`[${'需求'.repeat(300)}]`, '[short note]'], 4000);
  assert.deepEqual(bounded.slice(0, -1), ['[short note]']);
  assert.match(bounded.at(-1), /1 additional gather note/);
});

test('an unreportable note omission fails closed', () => {
  assert.throws(
    () => boundNotes([`[${'x'.repeat(600)}]`], 64),
    (error) => error?.code === 'notes_unreportable',
  );
});
