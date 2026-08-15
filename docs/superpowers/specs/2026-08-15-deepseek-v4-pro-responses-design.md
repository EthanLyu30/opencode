# DeepSeek V4 Pro Native Responses Promotion Design

**Date:** 2026-08-15

**Status:** Approved

## Goal

Promote `deepseek-v4-pro` from a planned Chat-only capability to a first-class native Responses model, while keeping deterministic role routing: `implement`, `repair`, and `deliver` use Pro; `test` continues to use Flash. Both models use `POST https://api.deepseek.com/responses`, and the runtime never silently falls back to another model or protocol.

## Official Contract Baseline

The design is based on DeepSeek's official documentation as verified on 2026-08-15:

- The Responses API reference lists both `deepseek-v4-flash` and `deepseek-v4-pro` as accepted `model` values: <https://api-docs.deepseek.com/api/create-response/>.
- The Responses compatibility guide states that both models support the same native Responses entry point and compatibility matrix: <https://api-docs.deepseek.com/guides/responses_api/>.
- The models and pricing page lists both models as available, with a 1M context window and model-specific pricing/concurrency: <https://api-docs.deepseek.com/quick_start/pricing/>.
- The models endpoint documents `deepseek-v4-pro` as an available model identifier: <https://api-docs.deepseek.com/api/list-models/>.

The upstream API remains stateless. OpenCode continues to own `previous_response_id`, conversations, storage, background jobs, cancellation, recovery, and replay locally.

## Capability and Provider Design

The canonical capability profile for `deepseek-v4-pro` changes to:

- protocol: `openai-responses`
- capabilities: `chat`, `responses`, `structured_output`, `required_tool_choice`
- planned capabilities: empty

`DeepSeek.model("deepseek-v4-pro")` and `DeepSeek.responses("deepseek-v4-pro")` therefore select the existing native Responses route. `DeepSeek.chat("deepseek-v4-pro")` remains an explicit legacy-compatible escape hatch, but no Responses-required workflow may select it implicitly.

The existing DeepSeek Responses validator, body projection, SSE parser, tool handling, structured output, hosted web search, incomplete/failed terminal handling, and usage accounting are shared by Flash and Pro. The model ID must pass through unchanged on the wire and in local response resources.

## Deterministic Workflow Routing

Role routing becomes:

| Role            | Provider | Model               | Protocol  | Effort |
| --------------- | -------- | ------------------- | --------- | ------ |
| `design`        | Kimi     | `kimi-k3`           | Chat      | max    |
| `decompose`     | Kimi     | `kimi-k3`           | Chat      | high   |
| `implement`     | DeepSeek | `deepseek-v4-pro`   | Responses | max    |
| `test`          | DeepSeek | `deepseek-v4-flash` | Responses | high   |
| `visual_review` | Kimi     | `kimi-k3`           | Chat      | max    |
| `repair`        | DeepSeek | `deepseek-v4-pro`   | Responses | max    |
| `deliver`       | DeepSeek | `deepseek-v4-pro`   | Responses | high   |

The policy remains exact and role-based. A caller may restate the exact route for a stage, but may not replace Pro with Flash on a Pro stage, replace Flash with Pro on the test stage, or change Responses to Chat. Such changes remain typed policy violations rather than fallbacks.

That stage-route rule is distinct from the public Responses API's explicit `model` field. A `deliver` stage bound to a direct Responses request executes the requested, capability-validated DeepSeek Responses model (`deepseek-v4-flash` or `deepseek-v4-pro`) for that Response only. This preserves existing Flash gateway behavior while keeping the automatic role policy on Pro. The explicit choice is carried through tool continuations and never becomes a fallback or a stage `route` override.

## Responses Gateway Behavior

Direct OpenCode Responses requests using `model: "deepseek-v4-pro"` are admitted through the same capability and native transport boundary as Flash. Local lifecycle semantics remain identical:

- foreground JSON and SSE
- background admission and retrieval
- durable cancellation
- idempotent request hashes
- conversations and `previous_response_id`
- tool continuation and crash recovery
- incomplete/failed usage fidelity
- `store:false` transient cleanup
- complete event replay

No Pro-specific local storage or event schema is needed.

## Error Handling

- Unknown DeepSeek model IDs remain `UnsupportedModelCapability` errors.
- A Pro request containing unsupported Responses fields receives the existing typed capability/invalid-request diagnostic.
- There is no automatic Pro-to-Flash fallback for quota, rate limit, overload, malformed output, or provider failure. Workflow retry/recovery policy handles those failures without changing models.
- Explicit Chat use remains separate and cannot satisfy the workflow's `responses` requirement.

## Testing Strategy

All implementation uses TDD and recorded/deterministic transports; no provider key or paid request is required.

Tests must prove:

1. The capability profile and default provider model route expose Pro as native Responses with no planned flag.
2. The exact role matrix selects Pro for implement/repair/deliver and Flash for test.
3. Incompatible model/protocol overrides fail with non-planned typed diagnostics.
4. A native Pro request reaches `/responses` with `model: "deepseek-v4-pro"` and preserves structured output, tools, SSE terminal events, and usage.
5. The embedded Responses gateway admits Pro and returns a terminal resource through the existing local workflow runtime.
6. The embedded Responses gateway also continues to execute an explicitly requested Flash Response, including multi-turn tool continuation, without changing the automatic `deliver` policy.
7. Existing Flash behavior and all Kimi K3-only constraints remain unchanged.
8. No API key, authorization header, provider body, or reasoning marked non-persistable enters durable state or logs.

## Documentation and Task Placement

The Stage B plan receives a new Task22 named “Promote DeepSeek V4 Pro to Native Responses and Tiered Routing.” Task21 remains the separate, opt-in live-provider recording task and is not started by this work.

The old capability matrix and dated DeepSeek baseline in the Stage B plan are updated to reflect verified Pro Responses support. Historical completed tasks and commits remain unchanged.

## Non-Goals

- No live DeepSeek request or provider spend.
- No dynamic cost-, latency-, or prompt-complexity-based model selection.
- No silent fallback between Pro and Flash.
- No changes to Kimi routing or support for Kimi 2.x models.
- No implementation of the deferred Location/browser/preview visual host.
- No execution of Task21.

## Acceptance Criteria

- `deepseek-v4-pro` is a supported native Responses model across capability, provider, workflow, and gateway boundaries.
- Automatic routing matches the approved role table exactly.
- Focused provider, workflow, protocol/gateway, SDK, typecheck, formatting, secret-scan, and diff gates pass offline.
- The change is independently reviewed, committed on `dev`, and pushed to `fork/dev` without force-push.
