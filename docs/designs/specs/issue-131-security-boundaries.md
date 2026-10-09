# Review credential and executable boundaries

## Frozen contract

Issue #131 repairs three demonstrated outbound-review boundaries: quoted JSON
credentials survive redaction, Windows bare executable names permit checkout
search, and provider redirects forward custom key headers and review content.

- Redact known credential assignments with quoted keys while preserving ordinary
  JSON, punctuation, and existing unquoted assignment behavior. This is a bounded
  known-shape filter, not a claim that arbitrary secrets can be recognized.
- Resolve Windows bare reviewer names, including known executable extensions,
  only from absolute PATH entries. Preserve native-before-shim precedence and
  explicit caller-selected paths. A miss returns a classified unavailable result
  without launching a current-directory executable. POSIX selection is unchanged.
- Refuse HTTP redirects in the shared provider transport. Existing success,
  timeout and sanitized failure contracts remain unchanged.

No process-tree timeout changes, arbitrary executable hardening, provider/model
changes, new dependencies, or live provider requests belong to the implementation.
PR #95 retains its separate Windows timeout scope. Helper checks constrain only
invocations routed through these helpers; they do not compel a driver to use them.

## Approach and consumers

Extend the assignment rule in `lib/secret.mjs`; snapshot, relay, receipt and
state consumers retain the same API. Keep the documented minimum value length
and known labels; test quoted values with spaces/escapes and adjacent fields so
partial replacement does not leave secret tails or consume unrelated content.

`resolveCliBin` returns an absolute native or shim path on Windows, or null for
an unresolved bare name. Explicit paths remain an intentional caller choice.
`spawnCli` maps null to the same ENOENT-shaped result consumed by Codex/Kimi;
Claude handles the unavailable value before its direct spawn. All resolver
consumers are enumerated before editing; evaluator consumers must classify the
same refusal, not pass null to Node's spawn API. The relay's Codex adapter uses
the same resolver, avoiding its independent bare-name Windows shell fallback.

Set `redirect: 'error'` in `postClassifiedJson`. Both OpenAI-compatible and
Anthropic-compatible providers use it. Direction already rejects redirects and
keeps that stronger fixed-endpoint policy. Redirect refusal is a sanitized
transport error, never accepted review output.

## Validation and risk

Tests first: known JSON credential shapes and non-secret controls; complete
snapshot and relay output; absolute native selection, extensioned bare names,
missing-name launch refusal and existing shims; local two-origin redirects with
both custom key header forms. A Windows-only test copies the Node executable
into a disposable trusted PATH directory and places a same-named executable in
the disposable checkout, then verifies actual process identity. Run this test
on Windows CI; macOS platform skips are explicit and not Windows evidence.

Upstream libuv searches cwd before PATH for bare names under the default Windows
policy: <https://github.com/libuv/libuv/blob/v1.x/src/win/process.c>.
Real local loopback transport tests establish redirect behavior without sending
credentials to an external service. Synthetic values only are used in tests.

Run targeted suites, self-review and the full native suite on the final commit.
Owner review and configured external roles remain the merge boundary.

## Execution surface and release

Allowed writes are the shared modules named above, their direct consumers and
regression tests, this design, a narrow Windows validation job, and synchronized
version metadata. Read surrounding provider, gate and test code. Tests create
and remove only owned temporary directories and local HTTP servers.

Bump the canonical plugin version to 1.2.0 in
`.claude-plugin/marketplace.json`; `node scripts/sync-marketplace.mjs` regenerates
host manifests and package metadata. No generated mirror is a version source.
Leave the independently reviewed PR open; no live settings changes or
merge are part of this issue.
