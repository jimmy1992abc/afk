# Models, prices, and aliases

Checked on 2026-09-10. Prices below are reference rates, not a billing engine.
AFK reports provider usage where available; it does not calculate an invoice.

## Current selections

| Role | Selection | Release decision |
| --- | --- | --- |
| Codex review | `gpt-5.6-sol`, medium effort | Fixed default; `astra`, `sol`, `terra`, and `luna` are explicit AFK shortcuts |
| Claude review | `claude-opus-5`, medium effort | Retained; `fable` now expands to `claude-fable-5-1` |
| GLM review | `glm-5.3` | Updated from GLM-5.1 |
| DeepSeek review/relay | `deepseek-v4-pro` | Retained; the provider currently resolves it to V4-Pro-0813 |
| MiMo review/relay | `mimo-v2.5-pro` | Retained |
| Kimi review | Installed CLI selection | Preserve account/CLI selection; no invented API model default |
| Kimi/OpenAI API relay | Explicit model configuration | Preserve the endpoint-specific choice |

OpenAI lists GPT-6 Astra and the GPT-5.6 family for Codex. Sol remains a
supported default; Astra is an explicit option for demanding reviews, with no
quality-improvement claim for this plugin without task-level evaluations.
[OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model),
[Codex models](https://learn.chatgpt.com/docs/models).

Claude's current lineup includes Fable 5.1, Opus 5, Sonnet 5, and Haiku 4.5.
Fable 5.1 requires Claude Code 2.1.257 or later; Opus 5 requires 2.1.219 or
later. Full model IDs remain usable when an account or gateway does not
support the new AFK shortcut target.
[Claude models](https://platform.claude.com/docs/en/models/overview),
[Claude Code configuration](https://code.claude.com/docs/en/model-config).

## API reference rates

USD per million tokens, except the separately labeled CNY table. OpenAI rows
use Standard short-context rates. Cache writes, long context, Fast/Batch/Flex
processing, regional processing, tools, and taxes may change the total.

| Model | Uncached input | Cached input | Output |
| --- | ---: | ---: | ---: |
| GPT-6 Astra | $10.00 | $1.00 | $50.00 |
| GPT-5.6 Sol | $4.00 | $0.40 | $20.00 |
| GPT-5.6 Terra | $2.00 | $0.20 | $12.00 |
| GPT-5.6 Luna | $0.20 | $0.02 | $1.20 |

OpenAI Standard cache writes are respectively $12.50, $5.00, $2.50, and
$0.25 per million tokens. Long-context input/cache-read/cache-write rates are
twice the short-context rates; long-context output rates are $75, $30, $18,
and $1.80 respectively. These are API rates, not a conversion from Codex
subscription percentages. [OpenAI pricing](https://developers.openai.com/api/docs/pricing).

| Model | Uncached input | Cached input | Output |
| --- | ---: | ---: | ---: |
| Claude Fable 5.1 | $10.00 | See provider cache pricing | $50.00 |
| Claude Opus 5 | $5.00 | See provider cache pricing | $25.00 |
| Claude Sonnet 5 | $2.00 | See provider cache pricing | $10.00 |
| Claude Haiku 4.5 | $1.00 | See provider cache pricing | $5.00 |

[Claude model rates](https://platform.claude.com/docs/en/models/overview).

| Model | Uncached input | Cached input | Output |
| --- | ---: | ---: | ---: |
| GLM-5.3 | $1.40 | $0.26 | $4.40 |
| GLM-5.3-Flash | $0.15 | $0.03 | $0.50 |

GLM-5.3-Flash is a documented lower-cost alternative, not this release's
review default. The GLM gate defaults to the Coding Plan endpoint; a Coding
Plan quota is separate from these ordinary API reference rates.
[Z.ai pricing](https://docs.z.ai/guides/overview/pricing).

| DeepSeek model / period | Uncached input | Cached input | Output |
| --- | ---: | ---: | ---: |
| V4 Pro / peak | $1.32 | $0.044 | $3.96 |
| V4 Pro / off-peak | $0.66 | $0.022 | $1.98 |
| V4 Flash / peak | $0.44 | $0.014 | $1.32 |
| V4 Flash / off-peak | $0.22 | $0.007 | $0.66 |

Peak periods are Monday through Friday, 01:00–04:00 and 06:00–10:00 UTC;
all other times use off-peak rates. Earlier promotional prices are obsolete.
[DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/).

| MiMo model | Uncached input | Cached input | Output |
| --- | ---: | ---: | ---: |
| MiMo-V2.5-Pro / overseas USD | $0.435 | $0.0036 | $0.87 |
| MiMo-V2.5-Pro / domestic CNY | ¥3.00 | ¥0.025 | ¥6.00 |

The gate and relay default to MiMo's domestic Token Plan endpoint. Token Plan
uses a separate subscription key/quota; ordinary API balance and Token Plan
credits are not interchangeable. Monthly Lite/Standard/Pro/Max list prices
are $6/$16/$50/$100 or ¥39/¥99/¥329/¥659. Pro-model tokens consume
300 credits per uncached input token, 2.5 per cached input token, and 600 per
output token. [MiMo API pricing](https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go),
[MiMo Token Plan](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription).

Kimi now lists `kimi-k3`, `kimi-k2.7-code`, its high-speed variant, and
`kimi-k2.6`. Its pricing overview delegates token rates to individual model
pages; a complete K3 rate table was not retrievable during this check, so no
unverified numerical rate is reproduced here. CLI membership remains distinct
from API billing. [Kimi models](https://platform.kimi.com/docs/models),
[Kimi API pricing](https://platform.kimi.com/docs/pricing/chat).

## Which aliases reduce maintenance?

| Provider/surface | Verified behavior | AFK decision |
| --- | --- | --- |
| DeepSeek API | `deepseek-v4-pro` and `deepseek-v4-flash` already follow updates within their V4 lines | Keep the documented identifiers; no `-latest` suffix |
| Claude API | IDs from generation 4.6 onward, even dateless ones, identify fixed snapshots | Keep explicit IDs for review identity checks |
| Claude Code | `opus`, `sonnet`, `fable`, and `best` can move and depend on provider/account configuration | Document as host options; AFK shortcuts expand to explicit IDs instead |
| Codex | No general-purpose evergreen coding alias was established in the checked docs; model inheritance remains available | Keep the fixed review default; `CODEX_REVIEW_MODEL=inherit` is an explicit opt-in |
| OpenAI API | `chat-latest` is a ChatGPT model alias; Daybreak aliases require separately approved access | Neither is a substitute for AFK's general coding reviewer |
| Kimi API | `kimi-latest` retired on 2026-01-28 | Do not use it; select a currently available API model |
| Kimi CLI | The host selects its configured model; current Kimi Code releases refresh API-key model lists | Keep CLI selection; availability is not proof of which model answered |
| GLM / MiMo API | No general evergreen alias was established in the checked model documentation | Keep versioned IDs and environment overrides |

DeepSeek explicitly documents the moving V4 mapping in its
[API introduction](https://api-docs.deepseek.com/). Claude distinguishes fixed
API snapshots from [CLI aliases](https://code.claude.com/docs/en/model-config)
in its [versioning guide](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions).
Kimi lists its retired aliases in the [model catalog](https://platform.kimi.com/docs/models);
CLI updates are documented in the [Kimi Code changelog](https://www.kimi.com/code/docs/en/kimi-code/whats-new.html).
OpenAI documents [API prices and specialized aliases](https://developers.openai.com/api/docs/pricing)
and [Daybreak access](https://developers.openai.com/api/docs/guides/safety-checks/cybersecurity).

Moving aliases reduce identifier maintenance but can change price, capability,
and results without a plugin release. Receipts retain requested selection and
observed identity separately; a moving identifier is not an immutable-model
guarantee. No new background model lookup or paid validation call is added.
