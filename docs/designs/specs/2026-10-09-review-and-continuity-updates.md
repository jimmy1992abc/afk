# Review boundaries and session continuity

## Accepted scope

Improve credential handling, executable lookup, repository-wide review inputs,
review identity, direction terminal artifacts, session handoffs and tracked
documentation validation. Use Sol 6.1 and Opus 5.5 at high effort for default
reviews, with DeepSeek Flash as the default DeepSeek reviewer.

Keep owner review before merge, uncapped default repair cycles, structural P2
repairs, expected remote CI, Draft job guards, repository identity and existing
Luna/Fable aliases. Preserve the pending direction-runtime qualification;
historical evidence cannot qualify changed runtime bytes. Prepare version 1.2.0
and release notes without publishing a release before owner review and merge.

## Review map

| Invariant | Enforcing code or doctrine | Pinning check |
| --- | --- | --- |
| Explicit model and effort selections outrank defaults | `lib/gate/model-select.mjs` | Selection and CLI argument suites |
| Distinct Claude minor versions cannot satisfy requested identity | `lib/gate/model-identity.mjs`, receipt validation | Claude gate and receipt regression suites |
| HTTP redirects cannot forward credentials or review content | `lib/http/transport.mjs` | Local HTTP redirect regression |
| Windows bare-name lookup excludes the checkout | `lib/gate/spawn.mjs` | Real executable fixture and Windows CI job |
| Uncommitted review inputs include repository-wide untracked files | `lib/gate/target.mjs`, snapshot and Claude gate | Real Git subdirectory and inventory-failure tests |
| Configuration read failures remain errors | `lib/forge.mjs`, relay gather | Real config and symlink boundary tests |
| Direction result writers and readers use the same limit | Direction schema, state, audit and transport | Large terminal-result boundary tests |
| Terminal records retain observed dispatch status after upgrades | Direction finalization | Retained exchange and runtime-drift tests |
| Yield markers add candidates without hiding stale runs | Resume detector and hook | Complete resume and malformed-marker suites |
| Later decisive reviews supersede prior approval | Owner approval workflow | Real Bash/jq pagination and dismissal tests |
| Link inventory uses tracked Markdown and current content | `scripts/check-links.mjs` | Real Git and unsafe-source tests; full repository scan |
| Canonical policies and pending qualification survive integration | Existing policy references and qualification artifact | Port-policy, Draft CI and qualification suites |

Helper and workflow artifact checks are level 2 when invoked. Owner review,
faithful stage routing and actual session takeover remain level 3 doctrine.
No helper attests improved live-agent behavior.

## Timeline and boundaries

Review inputs are inventoried before dispatch; failure cannot become an empty
diff. Executable selection precedes a change to the review working directory.
Direction reservations remain charged when finalizing a retained exchange after
an upgrade, while new dispatch still requires current qualification. Yield
markers are consumed with the first takeover heartbeat, and completed runs stay
terminal. Complete review history is collected before any approval qualifies;
the selected approval must match the current head. Draft promotion precedes
current-revision CI validation.

Run the entire deterministic suite, tracked documentation scan, provenance scan,
syntax checks and manifest/version checks. Native Windows execution requires its
CI runner; live providers and paid behavioral evaluations remain outside local
verification. Release publication follows owner approval, merge and required CI.
