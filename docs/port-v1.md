# 1.0 integration record

## Compared revisions

- Canonical base: `735f5a1ce6d8ebed95a9ce7efc0e45cd0bb91bb0` (0.2.11).
- Parallel source: `1b6f77c` from [the parallel repository](https://github.com/AlvinShenSSW/afk).
- Relationship: the canonical base is an ancestor of the source; 55 additional
  commits were examined, covering 181 changed paths.
- The initial canonical checkout was clean and one commit behind its remote.
  Integration starts from the fetched remote tip on a separate topic branch.

## Functional coverage

| Area | Integrated capabilities |
| --- | --- |
| Review providers | Optional DeepSeek and MiMo gates; GLM OpenAI/Anthropic protocols; shared HTTP/snapshot lifecycle |
| CLI execution | Bounded waits, abnormal-exit classification, Windows shim resolution, Kimi help-derived flags and console encoding |
| Input integrity | Confined reads, exclusions before patch reads, raw bounded Git patches, required snapshot coverage, exact credential redaction |
| Review protocol | Explicit terminal verdicts, sanitized marker lookalikes, synchronous bounded output |
| Review selection | Ordered optional roles, legacy profile compatibility, per-run model/effort qualifiers, profile notices |
| Review evidence | Prior-review context and proof transport, canonical local receipts, explicit candidate consistency checking |
| Forge support | GitHub and Azure DevOps issue reading; remote/config source attribution and discussion-loss reporting |
| Continuation | Main-worktree resolution, CRLF config handling, shared notices, mixed-model dirty-tree handoffs |
| Repository checks | YAML frontmatter validation, tracked provenance scanning, template version coverage, complete manifest checks, owner-review pagination |
| Governance | Read-only protection audit and manifest workflow; no live protection changes |
| Evaluations | Bounded manual behavior harness, eight fixtures, independent deterministic scoring; no paid run in CI |

## Selected behavior

| Decision | Outcome | Benefit | Tradeoff |
| --- | --- | --- | --- |
| Freeze the issue contract | Adopted | Less scope expansion during review | Explicit contract maintenance |
| Requirement completeness sweep | Adopted | Earlier lifecycle/authority/consumer coverage | Additional planning work |
| Evidence-based P1 admission | Adopted | Fewer edits from unsupported findings | More verification effort |
| P2/minor record-only restriction | Rejected | Confirmed structural P2 remains repairable | More work than blocker-only repair |
| Focused re-review | Adopted | Less repeated full-diff review | Broader rereads need evidence |
| Default shared two-cycle limit | Rejected | Continue progress toward closure | No implicit numeric spend cap |
| Automatic progress checkpoint | Adopted | Less permission churn and decision oscillation | Stalled issues can remain outstanding |
| Remote CI reading | Adopted with expected default | Missing CI cannot silently satisfy readiness | CI-less projects need an explicit policy |
| Fixed Codex reviewer | Adopted | Stable selection and explicit overrides | Model identifiers need occasional maintenance |

An explicit `max-fix-cycles` remains supported and survives resumes, but blank
or absent configuration imposes no numeric cap. Confirmed in-scope structural
P2 can be fixed in the structural batch or deliberately deferred with a recorded
merge-boundary decision. Cosmetic/documentation fixes remain one final pass.

The driver and satellites are the active policy. Imported design documents
retain historical decisions; this record identifies where the integration differs.
[Model and pricing reference](models-and-pricing.md) records the current source check.

The Draft-first lifecycle is retained explicitly: local validation and reviews
finish before Ready for review triggers CI. The original and imported workflow
snapshots lacked Draft job guards; this integration adds them and separates
the Ready transition from merge readiness. Draft-stage skips cannot satisfy
the post-promotion CI reading. The expected-CI wait starts after promotion.

## Per-commit disposition

Functional fixes and their tests are carried forward in their final source form;
intermediate superseded versions are not layered into the implementation.

| Source commit | Change | Disposition |
| --- | --- | --- |
| `c983bc5` | feat: default to ordered double external gates (#3) | Ordered-role capability retained; obsolete double default not adopted. |
| `fc5e48e` | feat: detach fork identity and bound external review gates (#5) | Timeouts retained; fork identity changes excluded. |
| `290f81c` | feat: converge AFK reviews on evidence and scope (#6) | Evidence/scope rules adopted; structural P2 repairs retained. |
| `9999a2f` | fix: batch valuable review findings with P1 repairs (#7) | Batching retained with confirmed structural P2 repairs and final cosmetic pass. |
| `4b87f70` | feat: add optional DeepSeek and MiMo review gates (#9) | Functional change/tests retained. |
| `f1e9867` | fix(kimi-gate): the prompt must never be a payload in a shelled argv (#10) | Functional change/tests retained. |
| `3dcbf74` | feat: default to a single Codex external gate; ordered roles by explicit flags (#13) | Single default and explicit ordered profiles adopted; legacy profiles retained. |
| `853ca73` | fix(gates): resolve a bare CLI name to its Windows shim path (#14) | Functional change/tests retained. |
| `feb3468` | fix(kimi-gate): drive the CLI through the flags it actually documents (#15) | Functional change/tests retained. |
| `5d6dc88` | fix(gates): report an unusable temp root, and give Kimi 45 minutes (#18) | Functional change/tests retained. |
| `e5add9e` | fix(check-version-bump): ship templates/, fail closed on an unreadable base (#30) | Functional change/tests retained. |
| `a688e2a` | fix(config): tolerate CRLF line endings in the shared config readers (#31) | Functional change/tests retained. |
| `c4725d6` | docs(skills): reconcile --implementer semantics across driver and gate skills (#32) | Supporting documentation/release history reconciled to 1.0.0. |
| `240db84` | fix(secret): redact GitHub PAT, GitLab, Slack, and JWT/JWE token shapes (#33) | Functional change/tests retained. |
| `5ef66e3` | fix(gates): an abnormal child exit is never a verdict (#34) | Functional change/tests retained. |
| `cd75e4d` | feat(gate): one skip-vs-error table for upstream review failures (#35) | Functional change/tests retained. |
| `9292c3b` | refactor(glm-gate): fold onto the shared snapshot lifecycle (#36) | Functional change/tests retained. |
| `df0cd15` | fix(scan-provenance): scan tracked files only; exact self-exemption (#37) | Functional change/tests retained. |
| `b65b5bb` | feat(protocol): neutralize marker lookalikes; shared verified-review emit (#38) | Functional change/tests retained. |
| `05199af` | ci(sync-marketplace): cover all six managed files; validate pushes to main (#39) | Functional change/tests retained. |
| `23a0a4a` | chore(release): v0.5.0 — the #19 audit hardening wave | Supporting documentation/release history reconciled to 1.0.0. |
| `c03994e` | test(gates): survive the pull_request merge-ref checkout shape (#42) | Functional change/tests retained. |
| `ef7dbd1` | docs(readme): lead with the problem, document roles and limits (#43) | Supporting documentation/release history reconciled to 1.0.0. |
| `ef6aab4` | feat(spec-planner): close the requirement set before acceptance criteria (#47) | Requirement completeness sweep adopted. |
| `7ec02c7` | feat(forge): resolve the forge once; add Azure DevOps alongside GitHub (#48) | Functional change/tests retained. |
| `6a97d59` | fix(relay): say how much discussion an issue read dropped (#51) | Functional change/tests retained. |
| `688c708` | feat(driver): remote checks are a reading, not an assumed bar (#53) | Remote-check reading adopted with expected as the default. |
| `0f18d0b` | fix(gates): four fail-closed control points a detail walked through (#56) | Functional change/tests retained. |
| `c54dd60` | fix(output): write marker blocks synchronously; count the cap in bytes (#57) | Functional change/tests retained. |
| `dc8cd3a` | fix(kimi-gate): derive the flag list from the installed CLI, not a table (#60) | Functional change/tests retained. |
| `9e4bdb0` | fix(kimi-gate): a non-UTF-8 console must not silently destroy a paid review (#62) | Functional change/tests retained. |
| `6648340` | chore: make the local lint mirror CI, and release 0.8.0 (#63) | Supporting documentation/release history reconciled to 1.0.0. |
| `0ff47d8` | feat(glm-gate): upgrade reviewer to GLM-5.3 (#65) | Functional change/tests retained. |
| `9f53d83` | fix(skills): validate YAML frontmatter (#67) (#70) | Functional change/tests retained. |
| `05a6c6a` | fix(agent-relay): confine reads and input bytes (#71) | Functional change/tests retained. |
| `57d441c` | fix(gates): reject abnormal Claude and Codex exits (#72) | Functional change/tests retained. |
| `c34bcd0` | Improve mixed-model AFK handoffs and review snapshots (#74) | Mixed-model handoffs and snapshot coverage adopted. |
| `7d446d7` | docs(readme): refresh current review defaults (#66) | Supporting documentation/release history reconciled to 1.0.0. |
| `a1c9898` | fix(codex-review): default to GPT-5.6 Sol (#75) | Fixed supported Sol review default adopted. |
| `578c29e` | feat: per-run reviewer model and effort qualifiers (#76) | Per-run model/effort selection adopted; Fable shortcut refreshed. |
| `9c15cd2` | fix: harden audit remainder boundaries and recovery (#77) | Functional change/tests retained. |
| `35a8d0d` | fix(tests): drain Claude stdin and isolate review fixtures (#86) | Functional change/tests retained. |
| `27481e2` | fix(afk): bound review-driven iteration and focus re-review (#87) | Focused re-review and progress checkpoints adopted; implicit two-cycle cap and record-only P2 excluded. |
| `6fadf71` | fix(governance): audit main protection and stop direct sync pushes (#88) | Functional change/tests retained. |
| `3fad1ed` | fix(relay): exclude sensitive paths before reading patches (#89) | Functional change/tests retained. |
| `16bcd44` | fix: refuse incomplete required snapshot coverage (#90) | Functional change/tests retained. |
| `6a8a8e2` | fix(review): validate explicit mode-specific verdicts (#91) | Functional change/tests retained. |
| `409c43e` | fix(git): collect bounded raw review patches (#92) | Functional change/tests retained. |
| `3e3731f` | fix(ci): paginate owner approval reviews (#93) | Functional change/tests retained. |
| `f56361f` | chore(release): prepare v0.9.0 (#94) | Supporting documentation/release history reconciled to 1.0.0. |
| `056cb35` | feat(review): provide a supported prior-review context channel (#99) | Context transport retained with the selected structural-fix policy. |
| `8c5b1df` | feat(review): add canonical receipts and consistency checking (#100) | Receipt artifacts and consistency checker retained. |
| `8cac7eb` | test(afk): add bounded real-agent behavior evaluations (#101) | Evaluation harness retained; explicit baseline required; inherited results labeled historical. |
| `f10101f` | chore(release): bump plugin version to 1.0.0 (#102) | Version set to this repository's 1.0.0 release. |
| `1b6f77c` | docs(readme): explain 1.0.0 review evidence and evaluations (#103) | Documentation reconciled to this integration and historical evidence. |

## Integration-specific corrections

- Preserve canonical marketplace ownership, update discovery, installation
  routes, repository links, and CODEOWNERS.
- Require explicit immutable evaluation baseline and candidate revisions.
  Deterministic tests build a disposable production-support Git fixture instead
  of requiring a commit that exists only in the parallel repository.
- Run CLI transport and missing-temp-root tests against small disposable Git
  fixtures, so a large release commit or a clone without `origin/main` cannot
  prevent the tests from reaching the boundary they exercise.
- Keep the imported pilot report tied to its original revision. This integration
  makes no empirical claim of improved agent quality from deterministic tests.
- Refresh the Fable shortcut to `claude-fable-5-1` and add the current Luna
  shortcut while retaining the supported Sol/Opus defaults.

Local tests validate helpers when invoked. They do not attest real provider
availability, actual Windows execution, behavioral success of paid agents, or
permission to merge or publish this release.
