# Forge adapter: Azure DevOps alongside GitHub

Imported design history. Current decisions are recorded in the
[1.0 integration record](../../port-v1.md).

Issue: AlvinShenSSW/afk#46, narrowed by the operator to the adapter seam and its
degradation; the Azure DevOps policy verdict is deferred to a follow-up.

## Frozen issue contract

Acceptance criteria:

1. One place resolves which forge a repository lives on, and no skill or bundled
   script names a forge CLI. `skills/afk-agent-relay/lib/gather.mjs:71` held the
   only executable coupling, and neither CLI may take the tracker from ambient
   state where config or the remote can name it.
2. Resolution is `.afk/config.md` `forge:` if set, else the `origin` remote,
   else GitHub, and the resolved value and its source are stated once at
   kickoff the way the gate profile already is. An Azure organization comes
   from `azure-organization` if set, else an Azure-shaped remote, else nothing.
3. A forge with no adapter degrades to a named reason, never a silent omission.
4. A credential in a URL's userinfo is redacted whatever its shape.
5. The pilot's CI-watch step and the driver's PR-lifecycle prose name the
   operation, not one vendor's command.

Engineering invariants: dependency-free Node ESM; no silent skips; fail toward
less exposure. `scripts/external-gate-profile.test.mjs:41` pins the kickoff
restatement sentence, so the forge clause attaches to it rather than rewording
it.

Non-goals: no third forge; no Azure DevOps Pipelines authoring, work-item
creation, or board manipulation; no change to gate ordering or run-state layout;
no vendoring of `az`.

## Design

Dispatch is keyed to the **resolved forge**, never to which CLI happens to run.
That is the whole point of the module. `gh` installed and authenticated against
a different host answers `issue view 42` from some other repository and exits 0,
so a helper that tries the command and reads failure as absence gets no signal
at all — the brief comes back well-formed with the wrong requirement in it. A
forge the adapter cannot serve is therefore named before any command is built,
not discovered by attempting one.

Detection matches host suffixes after the userinfo is stripped, over a parsed
URL rather than a substring test, so `github.com.<attacker>` does not resolve to
GitHub. scp-style remotes (`git@host:path`) are not URLs and are matched
separately. An unrecognised host detects nothing rather than guessing.

An unrecognised **configured** value keeps its name and travels with
`known: false` instead of falling back. Substituting the default there would run
a GitHub command against whatever the operator actually meant, which is the
failure above with the operator's own configuration as the cause.

The issue reference is constrained to a positive integer before it reaches an
argv: it is operator-supplied and lands on a command line, where a leading dash
is read as a flag by either CLI.

Only one operation is dispatched in code, because only one exists in code. The
remaining forge operations live in skill prose, which now names the operation
rather than a command; adding unused dispatch entries would be speculation
about commands nothing calls.

Redaction gains a URL-userinfo rule, placed before the shape rules so none of
them can half-redact a userinfo it only partly matches. The rule is positional
rather than alphabetical: a credential in a URL is a credential whatever it
looks like. Userinfo runs to the last `@` before the host, because both `:` and
`@` are legal inside a password — a capture that stops at the first of either
leaves the credential in the payload, or rewrites the line so it reads as
redacted while the tail survives, which is worse than not matching. The
single-component form keeps a length floor because a bare `git@` in an ssh URL
is a user name, and redacting it would cost the reader which remote a line
names.

## Verified against the installed CLI

`az` 2.89.1 with the `azure-devops` extension 1.0.6, on this machine. The
`--help` and failure-shape items below were established before any organization
was reachable; the response-shape items were confirmed later against a live one
(see *Verified against a live organization*).

- `az boards work-item show` takes `--id` as its only required argument and has
  **no** `--project` parameter, which is what confirms a work item id is
  organization-scoped rather than per-repository — it is not a renamed issue
  number.
- `--draft` on `az repos pr create` is documented `Allowed values: false, true`,
  so it is not a bare flag; emitting one would swallow the next argument.
- Both failure modes reachable without an organization — no Azure DevOps remote
  to auto-detect, and an unauthenticated organization — exit **1** with empty
  stdout, so the status check in `gather.mjs` produces the named skip rather
  than pushing an error string into the brief as an issue body.

- With an organization configured as `az`'s global default and no Azure remote
  to detect, `az boards work-item show --id 42` does **not** refuse for a
  missing organization — it proceeds to authenticate against that default. The
  ambient default therefore answers when the remote cannot, which is the
  wrong-tracker read this module exists to prevent, so the organization is
  derived from the remote and passed explicitly with `--detect false`, and a
  remote that names none builds no command at all.

Neither CLI is left to choose the tracker. `gh` takes `GH_REPO` over the
checkout's own origin — verified: with it set, `gh issue view 45` in this
repository returned a different repository's item and exited 0 — and `az` falls
through to its configured default organization. Every read is therefore bound
by an explicit selector, derived from the remote or configured, and no command
is built when neither names one. An unrecognised host keeps its host in the
GitHub selector: a self-hosted install still has to be named, and `gh` refuses
one it was never authenticated against, which is the wanted answer. A remote
belonging to a known *different* forge names no GitHub repository at all, since
deriving one from its path would build a plausible bogus selector.

`github-repository` and `azure-organization` name the tracker for a checkout
whose remote cannot. Both are stripped of any userinfo before reaching an argv:
`.afk/config.md` holds no secret by rule, but argv is readable by any process on
the machine, so a pasted credential is dropped rather than trusted.

The redaction count moves only when a replacement differs from what it matched.
Several rules — the userinfo floor and the base64 catch-all's hex and no-digit
guards — match a candidate and return it unchanged, and the count is what a
reader is shown in place of the payload, so counting those reported a redaction
that did not happen.

Deriving that organization is restricted to an Azure-shaped remote. The first
path segment of any other host reads as an organization of the same name, and
one may exist — which is precisely the cross-host setup the `forge:` key is set
for, so the derivation would be wrong exactly where the key is needed. That case
takes `azure-organization` from config instead, and builds no command when
neither source names one.

## Verified against a live organization

The command this adapter emits was later run end to end, which settles three
things the design had recorded as assumptions:

- The emitted argv works unchanged and exits 0 with a work item's field bag.
- `System.Description` is **HTML**, not markdown — the read is a REST field bag
  rather than the rendered body `gh issue view` returns.
- The state vocabulary belongs to the project's process template, so no
  open/closed mapping can be hardcoded: one Scrum project produced `New`,
  `To Do`, `In Progress`, `Done`, and `Removed` across three work item types.
- The payload carries `System.CommentCount` and **no comment bodies**. That
  asymmetry against the GitHub read is a defect in its own right, tracked and
  fixed separately; it is recorded here because this is where the claim that
  the two reads are equivalent would otherwise live.

Still unverified, and therefore out of this change: whether `az repos pr policy
list` can express "the checks for this commit". It cannot, on the documentation:
policy evaluations attach to the PR artifact and a push resets them, the status
vocabulary (`queued`/`running`/`approved`/`rejected`/`notApplicable`/`broken`)
does not map onto pass/fail, an empty list means "no policies configured" rather
than "green", non-CI gates such as minimum-reviewers appear in the same list,
and `configuration.isBlocking` decides what actually gates a merge. A command
swap would report green where nothing was checked, so the operation stays prose
until it can be verified against a live organization.

`lib/forge.mjs` carries a small CLI, the way `lib/plugin-root.mjs` does.
`afk-init` records the forge, and the value it writes outranks the remote at
every later read, so a second derivation in that prose would be a second source
of truth that can disagree with the adapter it feeds.

## Test plan

`lib/forge.test.mjs`: detection across every remote shape each host is written
in, including scp-style and the legacy `visualstudio.com`; the lookalike host
`github.com.evil.example` detecting nothing; config outranking remote and each
source label; an unrecognised configured value keeping its name with
`known: false`; both dispatches; the same organization derived from all five
Azure remote shapes; an Azure remote naming no organization building no command;
a non-numeric or dash-leading reference never reaching a command line; and a
consistency test that every forge in the exported list can build a command from
its own remote.

`skills/afk-agent-relay/tests/redact.test.mjs`: a short userinfo credential, a
userinfo credential with no distinguishing alphabet, host and user preserved
while the credential goes, a URL with no credential left byte-identical, and an
Azure DevOps PAT pinned across the three shapes it travels in — that coverage
was incidental before this change and is now intentional.

## Correction record

The issue claimed Azure DevOps PATs were unredacted and called it the one
security defect in the set. That was asserted without running it, and it was
wrong: a 52-character base32 PAT is caught by the base64 catch-all, whose guard
tests for a digit, and the base32 alphabet supplies one. The defect that does
exist is narrower and forge-neutral — there was no URL-userinfo rule at all, so
a short credential in a remote URL survived whole regardless of host.
