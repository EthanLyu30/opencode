# OpenCode Kimi K3 + DeepSeek Responses Stage B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan one task at a time, and use superpowers:test-driven-development for every behavior change. Keep the review gate after each commit.

**Goal:** 在已经完成的 Workflow 持久化底座上，实现 Kimi K3 负责设计、拆解与视觉复审，DeepSeek 负责主要编码、测试、修复与交付的自动路由；DeepSeek 原生 Responses 能力直接使用，缺失的资源、会话、后台任务、取消、恢复和重放语义由 OpenCode 本地运行时补齐，并对外提供 Responses 风格兼容接口。

**Architecture:** Provider 层只处理模型原生 wire protocol 并统一为现有 `LLMEvent`；Workflow 层负责跨模型阶段状态机、预算、租约、取消、重试、恢复与工件；Responses Runtime 把 OpenAI Responses 的资源语义映射到 Workflow 和本地 SQLite。Kimi 仅允许 `kimi-k3`，不配置 K2.6/K2.7 降级；DeepSeek `deepseek-v4-flash` 与 `deepseek-v4-pro` 均走原生 Responses，具体型号由精确的角色策略选择，绝不静默互相降级。

**Tech Stack:** TypeScript、Bun、Effect 4、Effect Schema、Effect HttpApi、SQLite、Drizzle ORM、现有 `@opencode-ai/llm` route/protocol、Workflow V2、OpenCode client codegen、浏览器渲染截图。

## Rebaseline: What Changes and What Does Not

- Original Stage A Tasks 2–12 remain valid and are preserved unchanged. Task10–12 are complete in commits `3285c10d8`, `800372b20`, and `e15e2fc27`.
- Original Stage A Task1 is superseded, not merely postponed. It incorrectly treated both providers as generic Chat-compatible facades.
- Kimi remains Chat Completions at the provider boundary, but the supported model set is exactly `kimi-k3`. K2.6, K2.7, and K2.7 Code are not fallback candidates.
- DeepSeek is no longer Chat-first. `deepseek-v4-flash` uses native `/responses`; Chat is a separately named legacy capability and must never be selected implicitly for a Responses-required stage.
- The local runtime targets OpenAI Responses architecture and lifecycle semantics. It does not claim that `api.deepseek.com` itself supports `previous_response_id`, conversations, `store`, background jobs, retrieval, cancellation, or replay.
- A third-party client receives the completed semantics only when its `base_url` points to the OpenCode Responses gateway. A client that calls `api.deepseek.com` directly bypasses all local persistence and orchestration.
- API keys are not required for Tasks 13–20. They are introduced only in Task21's narrow, opt-in live contract check.
- Per the user's repository workflow, Stage B tasks are implemented directly on local `dev`, reviewed and committed one at a time, then pushed to `fork/dev`; do not create an isolation branch or worktree unless the user later requests one.

## Non-Negotiable Product Rules

- `kimi-k3` is the only Kimi model ID admitted by the Stage B router.
- There is no silent model downgrade and no silent protocol downgrade.
- A missing capability produces a typed error containing provider, model, required capability, and supported alternatives; the stage then follows its explicit Workflow recovery policy.
- Automatic assignment is role-based, not a generic model toggle:

  `request -> Kimi K3 design/decompose -> DeepSeek implement/test -> Kimi K3 visual review -> DeepSeek repair/deliver`

- Every handoff is a durable artifact with a schema and hash. Prompt text alone is not a handoff contract.
- Kimi K3 produces both design specification and a runnable reference implementation. High-fidelity reference images are rendered from that reference implementation; the plan does not pretend that a text/vision API returns generated pixels.
- Kimi K3 visual review receives the reference screenshots and implementation screenshots as image inputs and returns a strict structured review.
- Model deltas remain non-durable. Response terminal objects, stage boundaries, tool calls/results needed for continuation, artifacts, checkpoints, usage, and errors are durable.
- Provider secrets remain behind the existing Credential/Integration boundary and are never accepted in Workflow or Responses payloads.
- All default tests use fakes or recorded, redacted fixtures and spend zero provider credits.

## Target Capability Matrix

| Provider/model      | Native wire protocol | Required Stage B use                 | Local additions                                                                           | Failure behavior                                                |
| ------------------- | -------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `kimi-k3`           | Chat Completions     | design, decomposition, visual review | preserved reasoning replay, image lowering, strict structured output, artifact validation | typed `unsupported_model` for every older Kimi ID               |
| `deepseek-v4-flash` | Responses            | tests                                | durable response resource, chaining, background, cancellation, replay, conversations      | typed capability error if the native contract changes           |
| `deepseek-v4-pro`   | Responses            | implementation, fixes, delivery      | 与 Flash 共享本地 Responses 生命周期；按角色使用 Pro                                      | typed capability/provider failure, never Flash or Chat fallback |

Official baseline reverified on 2026-08-15:

- Kimi's [model parameter reference](https://platform.kimi.com/docs/api/models-overview) defines `kimi-k3` as a 1M-context model with `low | high | max` reasoning effort, required tool choice, fixed sampling parameters, and preserved assistant reasoning replay.
- Kimi's [K3 guide](https://platform.kimi.com/docs/guide/kimi-k3-quickstart) documents Chat Completions, image input, strict structured output, tools, and complete assistant-message replay.
- DeepSeek's [current model table](https://api-docs.deepseek.com/quick_start/pricing/) marks Responses as supported for both `deepseek-v4-flash` and `deepseek-v4-pro`; its [models endpoint](https://api-docs.deepseek.com/api/list-models/) lists both identifiers.
- OpenAI's [Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses), [background mode](https://developers.openai.com/api/docs/guides/background), and [conversation state](https://developers.openai.com/api/docs/guides/conversation-state) define the target resource and lifecycle semantics for the local compatibility layer.

## Responses Compatibility Boundary

The OpenCode gateway must expose and test these user-visible semantics:

- `POST /v1/responses` with foreground streaming and `background: true` admission.
- `GET /v1/responses/:responseID` retrieval for stored/background responses.
- `POST /v1/responses/:responseID/cancel` durable cancellation.
- `DELETE /v1/responses/:responseID` deletion/tombstone semantics.
- `GET /v1/responses/:responseID/input_items` stable, ordered input replay.
- `previous_response_id` chaining without requiring the caller to resend prior output.
- Conversation creation, retrieval, item append/list, and use through `conversation`.
- `store: false` behavior: no terminal response retrieval or future chaining after foreground completion; only the minimum transient execution state survives until terminal cleanup.
- Semantic SSE events with monotonic `sequence_number`, replay after an exclusive cursor, exactly one terminal event, and no `[DONE]` sentinel.
- Stable status/error/usage fields for completed, incomplete, failed, cancelled, and in-progress responses.
- Idempotent admission so retried client requests do not create duplicate executions.

The gateway does not fabricate unsupported model capabilities such as server-side MCP, file search, code interpreter, or provider-hosted image understanding. Such fields are rejected or reported through the capability contract instead of being silently ignored.

---

### Task 13: Add Explicit Provider Capability Contracts and Deterministic Route Selection

**Files:**

- Create: `packages/llm/src/capabilities.ts`
- Modify: `packages/llm/src/index.ts`
- Create: `packages/llm/src/providers/deepseek.ts`
- Create: `packages/llm/src/providers/kimi.ts`
- Modify: `packages/llm/src/providers/index.ts`
- Modify: `packages/llm/package.json`
- Test: `packages/llm/test/capabilities.test.ts`
- Test: `packages/llm/test/exports.test.ts`

**Interfaces:**

```ts
export type ProviderCapability =
  | "chat"
  | "responses"
  | "reasoning_replay"
  | "vision_input"
  | "structured_output"
  | "required_tool_choice"

export interface ModelCapabilityProfile {
  readonly provider: ProviderID
  readonly model: ModelID
  readonly protocol: "openai-chat" | "openai-responses"
  readonly capabilities: ReadonlySet<ProviderCapability>
}

export class UnsupportedModelCapability extends Data.TaggedError("UnsupportedModelCapability")<{
  readonly provider: ProviderID
  readonly model: ModelID
  readonly required: ProviderCapability
  readonly supported: ReadonlyArray<ProviderCapability>
}> {}
```

- [ ] Write failing tests proving `kimi-k3` is admitted, all `kimi-k2.*` IDs are rejected, DeepSeek Flash resolves to `openai-responses`, and DeepSeek Pro cannot satisfy `responses` unless explicitly added to the matrix.
- [ ] Run `bun test test/capabilities.test.ts test/exports.test.ts` from `packages/llm` and confirm the new exports and errors do not exist yet.
- [ ] Implement immutable capability profiles and purpose-built Kimi/DeepSeek facades. Do not add Kimi or DeepSeek conditionals to the generic compatible facade.
- [ ] Export `@opencode-ai/llm/providers/kimi` and `@opencode-ai/llm/providers/deepseek` from `packages/llm/package.json`.
- [ ] Run `bun test test/capabilities.test.ts test/exports.test.ts` and `bun typecheck` from `packages/llm`.
- [ ] Commit with `feat(llm): add explicit model capability routing`.

### Task 14: Route DeepSeek Flash Through Native Responses Without Translating Chat Events

**Files:**

- Modify: `packages/llm/src/providers/deepseek.ts`
- Modify: `packages/llm/src/protocols/openai-responses.ts`
- Create: `packages/llm/test/provider/deepseek-responses.test.ts`
- Create: `packages/llm/test/fixtures/deepseek-responses/text-stream.json`
- Create: `packages/llm/test/fixtures/deepseek-responses/tool-stream.json`
- Create: `packages/llm/test/fixtures/deepseek-responses/incomplete-stream.json`
- Create: `packages/llm/test/fixtures/deepseek-responses/failed-stream.json`

**Required contract:**

- Base URL is `https://api.deepseek.com`; the existing Responses route supplies `/responses`.
- Request lowering includes only parameters DeepSeek documents as effective.
- Native `response.*` SSE frames enter the existing Responses parser directly.
- `response.reasoning_text.*`, output text, function arguments, custom `apply_patch`, web search status, usage, incomplete, and failed terminals retain their typed meaning.
- Unsupported request features are rejected locally when their meaning matters; they are not sent to be silently ignored.

- [ ] Add fixture-driven failing tests for request URL/body and each terminal/event family listed above.
- [ ] Run `bun test test/provider/deepseek-responses.test.ts` from `packages/llm` and confirm failure against the old generic Chat facade.
- [ ] Add provider-specific option projection around the existing Responses protocol; change the shared parser only where a recorded DeepSeek event proves a real shape difference.
- [ ] Prove tool-call arguments are assembled once, `sequence_number` ordering errors are surfaced, and usage includes cached/reasoning token details.
- [ ] Run the new test plus `bun test test/provider/openai-responses.test.ts test/provider/openai-compatible-chat.test.ts` and `bun typecheck`.
- [ ] Commit with `feat(llm): use native responses for deepseek flash`.

### Task 15: Implement the Kimi K3-Only Chat, Vision, and Structured-Output Adapter

**Files:**

- Modify: `packages/llm/src/providers/kimi.ts`
- Modify: `packages/llm/src/protocols/openai-compatible-chat.ts`
- Modify: `packages/llm/src/schema/messages.ts`
- Create: `packages/llm/test/provider/kimi-k3.test.ts`
- Create: `packages/llm/test/fixtures/kimi-k3/text-stream.json`
- Create: `packages/llm/test/fixtures/kimi-k3/tool-stream.json`
- Create: `packages/llm/test/fixtures/kimi-k3/vision-request.json`
- Create: `packages/llm/test/fixtures/kimi-k3/structured-request.json`

**Required contract:**

- Exact model ID: `kimi-k3`.
- Base URL: `https://api.moonshot.cn/v1`.
- `reasoning_effort` accepts `low | high | max` and defaults to `max` at workflow role admission.
- `temperature`, `top_p`, `n`, presence penalty, and frequency penalty are omitted rather than sent at fixed values.
- The full assistant message, including `reasoning_content` and tool calls, is preserved for the next turn.
- Image input lowers to Chat content arrays using data URLs or Moonshot file references; public HTTP image URLs fail before sending.
- Design/review DTOs use `response_format: { type: "json_schema", json_schema: { strict: true, ... } }`.

- [ ] Write failing tests for every rule above, including explicit rejection of K2.6/K2.7 and unsupported public image URLs.
- [ ] Run `bun test test/provider/kimi-k3.test.ts` from `packages/llm` and confirm failure.
- [ ] Implement the smallest K3-specific lowering layer; keep the normalized output as existing `LLMEvent` reasoning/text/tool events.
- [ ] Add a multi-turn tool fixture proving complete assistant replay and no lost `reasoning_content`.
- [ ] Run the new test, the compatible Chat regression suite, the LLM full suite, and `bun typecheck`.
- [ ] Commit with `feat(llm): add kimi k3 only adapter`.

### Task 16: Add Durable Responses and Conversation Resource State

**Files:**

- Create: `packages/schema/src/responses.ts`
- Create: `packages/schema/src/response-event.ts`
- Modify: `packages/schema/src/index.ts`
- Modify: `packages/schema/src/event-manifest.ts`
- Modify: `packages/schema/src/durable-event-manifest.ts`
- Create: `packages/core/src/responses/sql.ts`
- Create: `packages/core/src/responses/store.ts`
- Create: `packages/core/src/responses/projector.ts`
- Create: `packages/core/src/responses.ts`
- Modify generated: `packages/core/src/database/migration.gen.ts`
- Modify generated: `packages/core/src/database/schema.gen.ts`
- Create generated migration with: `packages/core/script/migration.ts`
- Test: `packages/schema/test/responses.test.ts`
- Test: `packages/core/test/responses-store.test.ts`
- Test: `packages/core/test/responses-projector.test.ts`

**Persisted resources:**

```ts
ResponseResource {
  id, workflowID, model, status, background, store,
  previousResponseID?, conversationID?, requestHash,
  output, error?, usage?, createdAt, completedAt?, deletedAt?
}

ResponseItem { responseID, ordinal, kind, payload }
Conversation { id, metadata, createdAt, deletedAt? }
ConversationItem { conversationID, ordinal, responseID?, payload }
```

- [ ] Write schema and projector tests for created/in-progress/completed/incomplete/failed/cancelled/deleted lifecycles, ordered items, chaining, conversations, and request-hash idempotency.
- [ ] Run the focused Schema/Core tests and confirm the resource service is missing.
- [ ] Generate the migration with the repository script; do not handwrite migration registration files.
- [ ] Implement transactional persistence and Workflow ID linkage. Response projection failures must roll back with the durable event.
- [ ] Implement `store: false` terminal cleanup and prove completed payloads cannot be retrieved or used as a later parent.
- [ ] Run focused tests, Core migration verification, Schema/Core typechecks, and `git diff --check`.
- [ ] Commit with `feat(core): persist responses runtime resources`.

### Task 17: Expose the Local Responses and Conversation REST/SSE Gateway

**Files:**

- Create: `packages/protocol/src/groups/responses.ts`
- Create: `packages/protocol/src/groups/conversation.ts`
- Modify: `packages/protocol/src/api.ts`
- Modify: `packages/protocol/src/errors.ts`
- Create: `packages/server/src/handlers/responses.ts`
- Create: `packages/server/src/handlers/conversation.ts`
- Modify: `packages/server/src/handlers.ts`
- Test: `packages/protocol/test/responses.test.ts`
- Test: `packages/sdk-next/test/responses-embedded.test.ts`

**HTTP surface:**

```text
POST   /v1/responses
GET    /v1/responses/:responseID
DELETE /v1/responses/:responseID
POST   /v1/responses/:responseID/cancel
GET    /v1/responses/:responseID/input_items
GET    /v1/responses/:responseID/event?after=<exclusive-sequence>
POST   /v1/conversations
GET    /v1/conversations/:conversationID
DELETE /v1/conversations/:conversationID
POST   /v1/conversations/:conversationID/items
GET    /v1/conversations/:conversationID/items
```

- [ ] Write failing protocol identity tests and an embedded server test covering foreground JSON, foreground SSE, background admission/retrieval, cancellation, deletion, input items, and conversations.
- [ ] Run the focused Protocol/SDK tests and confirm the groups and handlers are absent.
- [ ] Implement the groups and handlers as mappings to the Responses Core service and Workflow service; do not invoke a provider directly from an HTTP handler.
- [ ] Emit semantic SSE frames with monotonically increasing sequence numbers and one terminal event. `after` must be exclusive and work after process restart.
- [ ] Make unsupported capabilities return typed 4xx errors instead of dropping request fields.
- [ ] Regenerate Client and SDK bindings using the same codegen commands proven in Stage A Task11; run generated-client drift checks.
- [ ] Run Protocol/Server/Client/SDK typechecks and focused tests.
- [ ] Commit with `feat(server): expose durable responses gateway`.

### Task 18: Implement the Automatic Kimi/DeepSeek Role State Machine

**Files:**

- Create: `packages/schema/src/workflow-role.ts`
- Modify: `packages/schema/src/workflow.ts`
- Create: `packages/core/src/workflow/routing.ts`
- Create: `packages/core/src/workflow/stage-machine.ts`
- Create: `packages/core/src/workflow/execution/model.ts`
- Modify: `packages/core/src/workflow/executor.ts`
- Test: `packages/core/test/workflow-routing.test.ts`
- Test: `packages/core/test/workflow-stage-machine.test.ts`

**Roles and default route:**

```ts
type WorkflowRole =
  | "design"
  | "decompose"
  | "implement"
  | "test"
  | "visual_review"
  | "repair"
  | "deliver"

design | decompose | visual_review -> kimi/kimi-k3
implement | test | repair | deliver -> deepseek/deepseek-v4-flash/responses
```

- [ ] Write failing table-driven routing tests for every role, required capability, model ID, reasoning effort, and budget inheritance.
- [ ] Add negative tests proving no Kimi downgrade, no DeepSeek Responses-to-Chat downgrade, and no ad-hoc user model override that violates a role requirement.
- [ ] Run the focused Core tests and confirm the router/state machine is absent.
- [ ] Implement deterministic routing and a stage machine whose transitions are driven only by validated artifact outcomes.
- [ ] Map provider authentication/quota/capability failures to Workflow failure categories and recovery policies without leaking secrets.
- [ ] Run focused Workflow tests, the entire Workflow suite, and Core typecheck.
- [ ] Commit with `feat(core): route workflow roles across kimi and deepseek`.

### Task 19: Add Design, High-Fidelity Reference, and Visual Review Artifacts

**Files:**

- Create: `packages/schema/src/design-artifact.ts`
- Create: `packages/schema/src/visual-review.ts`
- Modify: `packages/schema/src/index.ts`
- Create: `packages/core/src/workflow/artifacts/design.ts`
- Create: `packages/core/src/workflow/artifacts/visual-review.ts`
- Create: `packages/core/src/workflow/render.ts`
- Modify: `packages/core/src/workflow/stage-machine.ts`
- Test: `packages/schema/test/design-artifact.test.ts`
- Test: `packages/core/test/workflow-design-loop.test.ts`

**Durable artifact contract:**

- `design-spec.json`: goals, routes, layout constraints, component tree, states, typography, colors, responsive rules, accessibility rules, and acceptance criteria.
- `reference-app/`: Kimi K3-authored runnable HTML/CSS/JS or framework files constrained to the selected project stack.
- `reference-screenshot-<viewport>.png`: browser-rendered high-fidelity reference images.
- `implementation-screenshot-<viewport>.png`: browser-rendered DeepSeek implementation images.
- `visual-review.json`: strict findings with severity, viewport, selector/region, expected, actual, evidence image IDs, and pass/fail verdict.

- [ ] Write failing schema tests rejecting incomplete, unhashed, secret-bearing, or unbounded visual review artifacts.
- [ ] Write a failing fake-model loop test covering design spec + reference app + reference screenshots, implementation, Kimi image review, one DeepSeek repair, and final pass.
- [ ] Run the focused tests and confirm artifact codecs and renderer service are absent.
- [ ] Implement artifact validation and a renderer interface. The test renderer is deterministic; the production renderer captures all configured viewports.
- [ ] Bound repair loops by explicit maximum revisions and token/turn/tool budgets. Exhaustion enters approval instead of continuing indefinitely.
- [ ] Feed both reference and implementation screenshots to Kimi K3 as supported image content; require strict `visual-review.json` output.
- [ ] Run focused Schema/Core tests, the Workflow suite, and typechecks.
- [ ] Commit with `feat(workflow): add kimi visual design review loop`.

### Task 20: Prove Responses Architecture Parity Through Crash, Replay, and Client Conformance Tests

**Files:**

- Create: `packages/sdk-next/test/responses-conformance.test.ts`
- Create: `packages/sdk-next/test/responses-crash-worker.ts`
- Modify: `packages/client/test/contract-identity.test.ts`
- Modify: `packages/client/test/effect.test.ts`
- Modify: `packages/client/test/promise.test.ts`
- Modify: `packages/core/test/workflow-crash.test.ts`
- Create: `packages/core/test/workflow-model-state-machine.test.ts`

**Acceptance scenarios:**

1. Foreground and background responses yield the same terminal object shape.
2. A process exits after native DeepSeek `response.created`; restart resumes or reconciles exactly once according to the stage policy.
3. SSE reconnect after cursor `N` returns only events `> N` and reaches one terminal event.
4. `previous_response_id` reconstructs input items without caller replay and rejects missing/deleted/non-stored parents.
5. Conversations maintain stable order under concurrent append attempts.
6. Cancellation survives restart and prevents later tool settlement through the existing fencing token.
7. An idempotently retried `POST /v1/responses` maps to one response and one workflow.
8. Unsupported DeepSeek fields are surfaced in capability diagnostics and never silently treated as supported.
9. Kimi design and visual stages always use `kimi-k3`; DeepSeek coding stages always use the native Responses route.
10. No API key, authorization header, reasoning content marked non-persistable, or provider response body leaks into event/database/test logs.

- [ ] Add the tests above and first run them against the incomplete implementation to demonstrate the missing guarantees.
- [ ] Fix only conformance defects revealed by those tests; do not add new provider features in this task.
- [ ] Regenerate both clients and prove generated output is stable after a second generation pass.
- [ ] Run all Workflow, Responses, LLM provider, Protocol, Server, Client, SDK, migration, typecheck, secret scan, and `git diff --check` gates.
- [ ] Commit with `test: prove responses workflow conformance`.

### Task 21: Run Narrow Opt-In Live Provider Contract Checks

**Files:**

- Modify: `packages/llm/script/setup-recording-env.ts`
- Modify: `packages/llm/test/provider/golden.recorded.test.ts`
- Create after redaction: `packages/llm/test/fixtures/recordings/deepseek-responses/flash-text-tool.json`
- Create after redaction: `packages/llm/test/fixtures/recordings/kimi-k3/design-vision-review.json`
- Test: `packages/llm/test/recorded-golden.ts`

**Cost and safety gate:**

- This task does not start until the user explicitly supplies `MOONSHOT_API_KEY` and `DEEPSEEK_API_KEY` through environment variables and approves the narrow spend.
- Exactly one minimal Kimi K3 design/vision/structured-output interaction and one minimal DeepSeek Flash text/tool Responses interaction are recorded.
- The harness enforces per-request output limits and a hard total test budget before sending.
- Raw cassettes are scanned for keys, authorization headers, cookies, request IDs that should not be durable, and personal paths before commit.

- [ ] Add a dry-run mode that prints the two planned requests, model IDs, maximum output tokens, and worst-case token ceiling without sending them.
- [ ] Run dry-run and obtain explicit user approval for the displayed ceiling.
- [ ] Record the two narrow interactions, redact immediately, and compare their event shapes to Tasks14/15 fixtures.
- [ ] Run the full relevant offline suite using the new cassettes with network disabled.
- [ ] Commit with `test(llm): record kimi k3 and deepseek responses contracts`; include only redacted fixtures and tests in that commit.

---

## Execution and Review Gates

After every task:

- Run the task's focused failing-then-passing tests.
- Run affected package typechecks.
- Run `git diff --check`.
- Scan changed production and fixture files for secrets.
- Review the diff against this plan before committing.
- Push only after the committed task is verified; never force-push `dev`.

At the end of Task20, the offline acceptance target is complete architecture parity inside the modified OpenCode runtime. Task21 validates provider wire assumptions; it does not carry the burden of proving persistence, replay, cancellation, or state-machine correctness.

### Task 22: Promote DeepSeek V4 Pro to Native Responses and Tiered Routing

**Approved design:** `docs/superpowers/specs/2026-08-15-deepseek-v4-pro-responses-design.md`

**Execution plan:** `docs/superpowers/plans/2026-08-15-deepseek-v4-pro-responses-promotion.md`

**Exact route matrix introduced by this task:**

| Role            | Provider/model               | Protocol  | Effort |
| --------------- | ---------------------------- | --------- | ------ |
| `design`        | `kimi/kimi-k3`               | Chat      | max    |
| `decompose`     | `kimi/kimi-k3`               | Chat      | high   |
| `implement`     | `deepseek/deepseek-v4-pro`   | Responses | max    |
| `test`          | `deepseek/deepseek-v4-flash` | Responses | high   |
| `visual_review` | `kimi/kimi-k3`               | Chat      | max    |
| `repair`        | `deepseek/deepseek-v4-pro`   | Responses | max    |
| `deliver`       | `deepseek/deepseek-v4-pro`   | Responses | high   |

This table controls automatic role routing. A direct `/v1/responses` request remains free to explicitly select either supported DeepSeek Responses model; its bound `deliver` execution preserves that validated model without changing the stage route policy or introducing fallback.

- [ ] Promote the canonical Pro capability profile from planned Chat-first to native Responses, retaining explicit Chat only as a legacy escape hatch.
- [ ] Prove the Pro model ID reaches the existing DeepSeek `/responses` route unchanged and shares its structured-output, tool, SSE terminal, and usage semantics.
- [ ] Change only implement/repair/deliver to Pro; retain Flash for test and Kimi K3 for design/decompose/visual review.
- [ ] Replace stale gateway diagnostics with deterministic embedded Pro execution coverage; retain unknown-model and unsupported-field errors.
- [ ] Run focused provider/workflow/protocol/SDK/typecheck/format/secret/diff gates, independently review, commit on `dev`, and push to `fork/dev`.

Task22 supersedes only Task18's original all-Flash DeepSeek tier choice. It does not alter the completed Responses lifecycle work, does not spend provider credits, and does not implement the deferred Location/browser/preview visual host.
