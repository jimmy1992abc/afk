# Issue 98 pilot: environment blocked

Imported historical evidence from the parallel implementation. These observations
belong to the revisions named below and do not measure this integration.

The prerequisite allowance was exhausted before behavioral evaluation could begin. Three real host invocations ran; **0 of 14 planned behavior trials were covered**. Issue 98's actual-behavior acceptance remains **OUTSTANDING**, and its PR remains draft. Passing evaluator tests and a successful prerequisite resume do not substitute for the eight behavior cases.

## Recorded prerequisites

The host was Codex CLI 0.153.4. Local turn metadata confirms `gpt-6-astra` and `gpt-5.6-sol`, both at medium effort; this is not provider attestation.

| Slot | Model | Operation | Observed outcome | Host wall time | Retained output |
| --- | --- | --- | --- | --- | --- |
| P01 | gpt-6-astra | Initial exec | Completed; qualification failed | 38.988 s | 6,186 bytes |
| P02 | gpt-6-astra | Resume using P01's recorded session ID | Completed; qualification failed | 29.105 s | 6,188 bytes |
| P03 | gpt-5.6-sol | Alternate-model exec | Timed out; no terminal decision | 90.015 s | 11,443 bytes |

P01 and P02 passed the command filesystem, network, environment, original Node-test and Git probes. Exact session continuity was verified. However, the model-visible tool inventory still exposed `web__run` despite invocation-local disable settings. Denied command network access does not establish denial through every exposed tool. The required `toolSurface` qualification therefore remained false.

P03 contains an actual Sol turn, but exceeded the frozen 90-second limit without complete events or a terminal decision. Its timeout outcome takes precedence over the recorded process exit code. Alternate-model qualification is incomplete; this does not establish that the model is unavailable.

Cleanup passed for all three invocations. Total prerequisite host wall time was 158.108 seconds. Active model intervals are unavailable; external reviewer wait was zero. The three prerequisite slots are consumed. No retry, configuration change or behavioral launch followed the failed qualification.

| Slot | Reported input tokens | Reported cached input tokens | Reported output tokens |
| --- | --- | --- | --- |
| P01 | 62,200 | 44,672 | 566 |
| P02 | 55,456 | 52,992 | 537 |
| P03 | Unknown | Unknown | Unknown |

Cached input is a separately reported field, not an additional input total. Usage is incomplete for P03; these figures are neither a complete billing record nor a count of internal provider requests.

## Planned matrix and coverage

The frozen implementation/skill snapshot C is `b7d1f0f69dd24bd3b57b9a5f014c8e4b6ca34a5b` (plugin 0.9.4, fixture version 1). Baseline B is `f56361f40e7fcdcae602d08739bc3e928d4d57d7` (plugin 0.9.0). The [design](../designs/specs/issue-98-behavior-evaluations.md) fixes the fixtures, observations, comparison inputs and limits.

Every planned cell uses medium effort. All cells below are **not run**, with semantic adjudication unverified and zero behavior host launches.

| Trial | Behavior | Revision | Model | Planned launches | Outcome |
| --- | --- | --- | --- | --- | --- |
| T01 | S1: repeated refuted finding | C | gpt-6-astra | 1 | Not run |
| T02 | S2: minor-only observation | C | gpt-6-astra | 1 | Not run |
| T03 | S3: new blocker during closure, repetition 1 | C | gpt-6-astra | 1 | Not run |
| T04 | S3, repetition 1 | B | gpt-6-astra | 1 | Not run |
| T05 | S3, repetition 1 | C | gpt-5.6-sol | 1 | Not run |
| T06 | S3, repetition 2 | B | gpt-6-astra | 1 | Not run |
| T07 | S3, repetition 2 | C | gpt-6-astra | 1 | Not run |
| T08 | S3, repetition 2 | C | gpt-5.6-sol | 1 | Not run |
| T09 | S4: repair regression and lost coverage | C | gpt-6-astra | 1 | Not run |
| T10 | S5: exhausted-budget exec and real resume, repetition 1 | C | gpt-6-astra | 2 | Not run |
| T11 | S5, repetition 2 | C | gpt-6-astra | 2 | Not run |
| T12 | S6: missing review context | C | gpt-6-astra | 1 | Not run |
| T13 | S7: stale revision receipt | C | gpt-6-astra | 1 | Not run |
| T14 | S8: unavailable required reviewer | C | gpt-6-astra | 1 | Not run |

The matrix contains eight behaviors, selected repetitions, an alternate model and paired skill revisions: 14 trials and 16 behavior launches. None of those empirical comparisons was exercised. P02's real prerequisite resume did not exercise S5's exhausted repair allowance.

Acceptance completion, seeded-defect detection, unsafe readiness, excess repairs, evidence-free reopening and minor-driven edits are **not observed**. Each behavioral metric has zero eligible observations; aggregate zero counts have denominator zero and are not compliance rates. No reinforcement, convergence, version-improvement or population-reliability conclusion follows. A fully exercised failure would be valid evaluation data; these unexecuted cells are not failures of the subject's AFK behavior and do not count as coverage.

## Evaluator evidence and review trace

The implementation passed **29 of 29 targeted deterministic tests**. Controls include a third repair in either exhausted-budget phase, stale revision/profile readiness, ignored defects or lost acceptance coverage, premature abandonment and a minor edit falsely reported as no edit. Positive controls cover clean completion, a valid exhausted resume/stop and an unavailable prerequisite. These tests include synthetic CLI trajectories and actual local product helpers with a controlled reviewer; they are not real-agent behavior samples.

No-model utility probes also verified that configured external diff, textconv and fsmonitor helpers could not write an owned sibling outside the sandbox, and that the actual confined receipt checker could accept fresh evidence while preserving the prior receipt.

| Finding | Closed contract |
| --- | --- |
| I98-D1 | Identical production-only support visibility for C/B; evaluator, scorer, tests, design and report excluded from subject support |
| I98-D2 | Immutable execution snapshot C distinguished from later report head R; report-only byte comparison |
| I98-I1 | Post-subject Git/helper execution confined; subject artifact reads and resume probe validation confined |
| I98-I2 | Recorded launches retain incomplete/error outcomes after observation failure; missing terminals are not mislabeled not-run |

These named design/implementation findings were closed before the real prerequisites. They do not close the separate behavioral coverage gap.

## Bounds and publication

The frozen bounds were 19 total host launches (3 prerequisites plus 16 behavior launches), 90 seconds per prerequisite, 180 seconds per behavior invocation, 360 seconds per S5 trial, at most four trials per 24-minute slice, 60 minutes globally, 8 MiB output per invocation and a 3-second cleanup grace. Host invocation, wall-time and output bounds are not hard dollar, token or internal-request caps. Actual usage was 3 prerequisite launches and 0 behavior launches; no additional slots were introduced.

This report is published at report head R as the sole change after C. Carryforward verification compares the complete C-to-R path/byte change and permits only this report; the execution evidence remains attributed to C. Report-only publication adds no behavior coverage and calls for no replacement pilot. Final required review applies to R.

Only this sanitized aggregate is published. Raw prompts, sessions, transcripts, local paths, receipts and qualification evidence remain in the ignored run. The observed tool-surface mismatch and incomplete alternate prerequisite are the known environment blockage. Evaluator implementation evidence is available; actual-behavior acceptance remains outstanding. Refs #98.
