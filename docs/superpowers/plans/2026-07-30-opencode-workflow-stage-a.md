# OpenCode Workflow Stage A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已审计的 OpenCode V2 内核旁新增可靠的持久 Workflow 底座，并完成 Kimi/DeepSeek 的最薄 Provider 接线，使工作流具备可重放事件、SQLite 队列、租约、防双跑、持久取消、分类重试、有限恢复和 typed HTTP/SSE API。

**Architecture:** 保留 `@opencode-ai/llm` 的 `LLMEvent` 作为唯一模型事件边界；新增独立的 Workflow aggregate，不扩张 `SessionInput`，也不复用进程内 `BackgroundJob` 伪装成持久任务。`EventV2` 是持久命令日志和事务投影入口，SQLite 投影表是查询与调度事实来源；本地 worker 只持有临时 fiber，所有可恢复意图必须先落盘。

**Tech Stack:** TypeScript、Bun、Effect 4、Effect Schema、Effect HttpApi、Drizzle ORM、SQLite、EventV2、Bun Test、OpenCode client codegen。

## Global Constraints

- 实施基线固定为 2026-07-30 再核对的最新上游 `dev` 提交 `ff0382e97145cb6585b575dcc1269fa1512e853b`。从完整审计提交 `7565e03536d19e850f9996c407f9bf5e932b5f7a` 到该提交的增量未修改 `packages/llm`、Schema、Protocol、Server、Core `src/test`、Client、sdk-next 或 V2 specs；唯一相关 package 变化是 `gitlab-ai-provider 6.12.0 -> 6.12.1`，不改变本计划接口。
- 当前审计工作树 `D:\OpenCode-Audit` 的本地 `dev` 已包含审计文档提交；实施时先使用 `superpowers:using-git-worktrees` 创建隔离工作树，分支名不超过三个连字符分隔词。
- 依赖方向保持 `Schema -> Core & Protocol -> Server`；Client 只能依赖 Schema/Protocol，不能依赖 Core/Server；`sdk-next` 负责组合。
- 不新增“Kimi 事件”“DeepSeek 事件”或第二套事件总线；Provider wire event 必须先归一为现有 `LLMEvent`。
- Workflow 只记录阶段边界、工件和汇总，不把 token delta 写入 Workflow durable log；高频模型 delta 仍归 Session live stream。
- `packages/llm` 不引入 Session 或 Workflow 依赖；Moonshot/Kimi 仅作为 OpenAI-compatible Chat facade。
- 第一版仅支持 SQLite 共享数据库上的本地 worker；租约语义必须能防止两个 worker 同时结算同一阶段。
- 租约默认 `30_000 ms`，续租间隔 `10_000 ms`，空队列轮询 `250 ms`；测试使用 TestClock 或显式时间参数，不等待真实时钟。
- `attempt` 从 `0` 开始，每次成功取得新 lease 时加一，并与 `lease_owner` 一起构成 fencing token。
- 无 `Retry-After` 时，阶段级重试基数为 `1_000 ms`、指数倍增、抖动范围 `0.8–1.2`、上限 `60_000 ms`；Provider HTTP executor 内部的最多两次瞬时重试不计为新的 Workflow attempt。
- Workflow usage 固定累计 `tokens/turns/toolCalls/attempts`；阶段 executor 无论成功或失败都必须返回该 attempt 的 usage delta。
- 当任一有限预算维度首次跨过 `50%`、`80%`、`100%` 时发布 durable threshold event；达到 `100%` 后不得取得下一阶段 lease，run 进入 `waiting_approval`。
- 提额只能通过 typed `updateBudget` 命令增加或补充上限，不能降低或删除既有上限；提额事件落盘后才能继续调度。
- 自动重试只适用于 `transient`；`authentication`、`quota`、`invalid_request`、`schema`、`build`、`visual`、`ambiguous` 和 `unknown` 默认不自动重放。
- 恢复策略固定为 `restart_safe | reconcile_required | manual_required`。过期的 `restart_safe` 阶段进入 `retry_wait`；另外两类进入 `waiting_approval`，不得自动重放。
- Workflow run 状态固定为 `queued | running | waiting_approval | succeeded | failed | cancelled`。
- Workflow stage 状态固定为 `pending | leased | running | retry_wait | waiting_input | waiting_approval | succeeded | failed | cancelled | skipped`。
- ID 前缀固定为 Workflow `wfl_`、Stage `wfs_`、Artifact `wfa_`。
- Workflow API 不接收 API Key、Authorization 或 Provider secret；只允许以后通过现有 Credential/Integration 边界引用凭据。
- 写入事件、`workflow_run.input`、阶段 checkpoint、工件 metadata 和持久 failure 前必须执行 secret guard；持久 failure 只保存 `category/code/message/retryAfterMs/ref`，不保存原始 Error、headers 或响应 body。
- Stage A 不包含 Kimi 设计状态机、浏览器渲染、DeepSeek 文件实现、视觉复审 UI 或 Responses facade；这些属于 Stage B。
- 默认测试不访问真实模型，不消耗 API 额度；录制 Kimi/DeepSeek 窄样本时才使用用户临时提供的环境变量，cassette 必须脱敏。
- 测试不能从仓库根目录运行；每条命令都在对应 package 目录执行。TypeScript 检查使用 `bun typecheck`，不直接运行 `tsc`。

---

## File and Interface Map

### Schema

- Create `packages/schema/src/workflow.ts`
  - Workflow/Stage/Artifact ID、状态、预算、输入、投影 DTO、failure 和恢复动作的唯一浏览器安全定义。
- Create `packages/schema/src/workflow-event.ts`
  - Workflow durable event definitions、`DurableDefinitions`、`Durable` 和 `All`。
- Modify `packages/schema/src/index.ts`
  - 从 Schema 包主入口导出 `Workflow`。
- Modify `packages/schema/src/event-manifest.ts`
  - 把 Workflow 事件加入 Server/public manifest。
- Modify `packages/schema/src/durable-event-manifest.ts`
  - 导出 `WorkflowDurable`，并把 Workflow definitions 加入全局 durable map。

### LLM Provider

- Modify `packages/llm/src/providers/openai-compatible-profile.ts`
  - 增加 `moonshot` profile，Base URL 固定为 `https://api.moonshot.cn/v1`。
- Modify `packages/llm/src/providers/openai-compatible.ts`
  - 导出 `moonshot` facade。
- Modify `packages/llm/src/protocols/openai-chat.ts`
  - 兼容 Kimi usage 顶层 `cached_tokens`，仍输出现有 `LLM.Usage`。
- Modify `packages/llm/test/provider/openai-compatible-chat.test.ts`
  - 验证 Moonshot facade、`reasoning_content`、tool-call 参数分片和 cached usage 都进入现有 `LLMEvent`。
- Modify `packages/llm/test/provider/golden.recorded.test.ts`
  - 增加 Kimi 窄录制目标；把 DeepSeek 扩为 text + tool-call。
- Modify `packages/llm/script/setup-recording-env.ts`
  - 增加 `MOONSHOT_API_KEY` 的交互式验证入口。
- Create `packages/llm/test/fixtures/recordings/openai-compatible-chat/moonshot-streams-text.json`
- Create `packages/llm/test/fixtures/recordings/openai-compatible-chat/moonshot-streams-tool-call.json`
  - 仅由 key-gated 录制产生并脱敏。

### Core Workflow

- Create `packages/core/src/workflow/sql.ts`
  - `workflow_run`、`workflow_stage`、`workflow_artifact` Drizzle 表。
- Generated `packages/core/src/database/migration/20260730*_workflow_stage_a.ts`
  - 由仓库迁移脚本生成；实际时间戳使用生成器输出，不手写迁移。
- Modify generated `packages/core/src/database/migration.gen.ts`
  - 由迁移脚本登记新迁移。
- Modify generated `packages/core/src/database/schema.gen.ts`
  - 由迁移脚本刷新完整 schema。
- Modify generated `packages/core/schema.json`
  - 由 Drizzle 更新快照。
- Create `packages/core/src/workflow/state.ts`
  - 纯状态转换、终态判断和上游阶段阻塞规则。
- Create `packages/core/src/workflow/projector.ts`
  - EventV2 事务投影；对 stale lease/非法转换抛出生命周期冲突并回滚事件。
- Create `packages/core/src/workflow/store.ts`
  - 查询 run/stage/artifact、挑选 claim candidate、续租和恢复扫描。
- Create `packages/core/src/workflow/retry.ts`
  - LLM/Stage failure 分类与确定性 retry decision。
- Create `packages/core/src/workflow/budget.ts`
  - usage 累计、50/80/100% 阈值、提额验证和剩余额度。
- Create `packages/core/src/workflow/secret-guard.ts`
  - 拒绝或脱敏持久化敏感值。
- Create `packages/core/src/workflow/executor.ts`
  - Stage executor contract；Stage B 只需实现此接口，不改 scheduler。
- Create `packages/core/src/workflow/execution.ts`
  - `wake/interrupt/active` 进程边界。
- Create `packages/core/src/workflow/execution/local.ts`
  - SQLite polling、claim、heartbeat、本地 fiber、取消和恢复。
- Create `packages/core/src/workflow.ts`
- `Workflow.Service`：create/list/get/history/events/artifacts/cancel/updateBudget/resolveRecovery。

### Protocol, Server, Client

- Create `packages/protocol/src/groups/workflow.ts`
  - typed REST/SSE contract。
- Modify `packages/protocol/src/api.ts`
  - 注册 `server.workflow` group。
- Modify `packages/protocol/src/errors.ts`
  - `WorkflowNotFoundError`、`WorkflowStageNotFoundError`、`WorkflowConflictError`。
- Create `packages/server/src/handlers/workflow.ts`
  - Core error 到 Protocol error 的唯一映射。
- Modify `packages/server/src/handlers.ts`
  - 合并 Workflow handler。
- Modify `packages/server/src/routes.ts`
  - 装配 Workflow、projector 和 local execution node。
- Modify `packages/client/src/contract.ts`
  - 将 `server.workflow` 映射为 `workflows`。
- Regenerate `packages/client/src/generated/*`
  - Promise client。
- Regenerate `packages/client/src/generated-effect/*`
  - Effect client。
- Modify `packages/client/test/promise.test.ts`
  - 检查 URL、payload、SSE 和 typed errors。
- Modify `packages/client/test/effect.test.ts`
  - 检查 Effect DTO 和 durable sequence 解码。
- Modify `packages/client/test/contract-identity.test.ts`
  - 检查 Core/Schema/Server contract identity。
- Modify `packages/sdk-next/test/embedded.test.ts`
  - 使用真实 router、handler 和临时 SQLite 做端到端验证。

### Core Tests

- Create `packages/core/test/workflow-state.test.ts`
- Create `packages/core/test/workflow-projector.test.ts`
- Create `packages/core/test/workflow-store.test.ts`
- Create `packages/core/test/workflow-retry.test.ts`
- Create `packages/core/test/workflow-budget.test.ts`
- Create `packages/core/test/workflow-execution.test.ts`
- Create `packages/core/test/workflow-recovery.test.ts`
- Create `packages/core/test/workflow-secret-guard.test.ts`
- Modify `packages/core/test/database-migration.test.ts`
  - 覆盖旧库升级和新索引。

## Public Contracts Locked by This Plan

```ts
// packages/schema/src/workflow.ts
export const ID = Schema.String.check(Schema.isStartsWith("wfl_")).pipe(Schema.brand("Workflow.ID"))
export type ID = typeof ID.Type
export const StageID = Schema.String.check(Schema.isStartsWith("wfs_")).pipe(Schema.brand("Workflow.StageID"))
export type StageID = typeof StageID.Type
export const ArtifactID = Schema.String.check(Schema.isStartsWith("wfa_")).pipe(Schema.brand("Workflow.ArtifactID"))
export type ArtifactID = typeof ArtifactID.Type

export const RunStatus = Schema.Literals([
  "queued",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
])
export type RunStatus = typeof RunStatus.Type

export const StageStatus = Schema.Literals([
  "pending",
  "leased",
  "running",
  "retry_wait",
  "waiting_input",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
])
export type StageStatus = typeof StageStatus.Type

export const RecoveryPolicy = Schema.Literals(["restart_safe", "reconcile_required", "manual_required"])
export type RecoveryPolicy = typeof RecoveryPolicy.Type
export const FailureCategory = Schema.Literals([
  "transient",
  "authentication",
  "quota",
  "invalid_request",
  "schema",
  "build",
  "visual",
  "cancelled",
  "ambiguous",
  "unknown",
])
export type FailureCategory = typeof FailureCategory.Type

export interface CreateInput {
  readonly id?: ID
  readonly type: string
  readonly input: Readonly<Record<string, unknown>>
  readonly budget: Budget
  readonly stages: ReadonlyArray<StageInput>
}

export interface StageInput {
  readonly id?: StageID
  readonly type: string
  readonly ordinal: number
  readonly maxAttempts: number
  readonly recoveryPolicy: RecoveryPolicy
  readonly idempotencyKey: string
  readonly input: Readonly<Record<string, unknown>>
}
```

```ts
// packages/core/src/workflow/executor.ts
export interface ExecutionInput {
  readonly workflow: Workflow.Info
  readonly stage: Workflow.Stage
  readonly lease: {
    readonly owner: string
    readonly attempt: number
    readonly expiresAt: DateTime.Utc
  }
}

export interface Result {
  readonly checkpoint?: Readonly<Record<string, unknown>>
  readonly artifacts?: ReadonlyArray<Workflow.ArtifactCommit>
  readonly usage: Workflow.Usage
}

export interface ExecutionFailure {
  readonly failure: Workflow.Failure
  readonly usage: Workflow.Usage
}

export interface Interface {
  readonly execute: (
    input: ExecutionInput,
  ) => Effect.Effect<Result, ExecutionFailure, Scope.Scope>
}
```

```ts
// packages/core/src/workflow/execution.ts
export interface Interface {
  readonly wake: Effect.Effect<void>
  readonly interrupt: (workflowID: Workflow.ID) => Effect.Effect<void>
  readonly active: Effect.Effect<ReadonlySet<Workflow.ID>>
}
```

```ts
// packages/core/src/workflow.ts
export interface Interface {
  readonly create: (input: Workflow.CreateInput) => Effect.Effect<Workflow.Info, UnsafePersistenceError | ConflictError>
  readonly list: (input?: { readonly status?: Workflow.RunStatus; readonly limit?: number }) => Effect.Effect<Workflow.Info[]>
  readonly get: (workflowID: Workflow.ID) => Effect.Effect<Workflow.Detail, NotFoundError>
  readonly events: (input: {
    readonly workflowID: Workflow.ID
    readonly after?: number
  }) => Stream.Stream<WorkflowEvent.DurableEvent, NotFoundError>
  readonly history: (input: {
    readonly workflowID: Workflow.ID
    readonly after?: number
    readonly limit: number
  }) => Effect.Effect<{ readonly events: ReadonlyArray<WorkflowEvent.DurableEvent>; readonly hasMore: boolean }, NotFoundError>
  readonly artifacts: (workflowID: Workflow.ID) => Effect.Effect<ReadonlyArray<Workflow.Artifact>, NotFoundError>
  readonly cancel: (workflowID: Workflow.ID) => Effect.Effect<void, NotFoundError | ConflictError>
  readonly updateBudget: (input: {
    readonly workflowID: Workflow.ID
    readonly budget: Workflow.Budget
  }) => Effect.Effect<Workflow.Info, NotFoundError | ConflictError | UnsafePersistenceError>
  readonly resolveRecovery: (input: {
    readonly workflowID: Workflow.ID
    readonly stageID: Workflow.StageID
    readonly action: "retry" | "fail"
  }) => Effect.Effect<void, NotFoundError | StageNotFoundError | ConflictError>
}
```

## Execution Preflight

- [ ] **Step 1: Confirm the audited base and document-only commits**

Run from `D:\OpenCode-Audit`:

```powershell
git status --short --branch
git fetch --prune origin dev --tags
git rev-parse origin/dev
git log -2 --oneline
```

Expected before creating the implementation worktree:

```text
origin/dev = ff0382e97145cb6585b575dcc1269fa1512e853b
local dev contains the audit/spec and this plan commits
no uncommitted files
```

If `origin/dev` moved, stop and produce a focused delta audit for files named in this plan. Do not silently transplant the plan onto changed V2 semantics.

- [ ] **Step 2: Create the isolated implementation worktree**

Use `superpowers:using-git-worktrees`; suggested branch:

```text
workflow-stage-a
```

- [ ] **Step 3: Confirm package tooling before editing**

Run:

```powershell
bun --version
git status --short
```

Expected: Bun is available and the new worktree is clean. Install dependencies only in the implementation worktree if absent; do not request Kimi/DeepSeek keys during this preflight.

---

### Task 1: Add the Moonshot/Kimi facade and lock compatible Chat event behavior

**Files:**
- Modify: `packages/llm/src/providers/openai-compatible-profile.ts`
- Modify: `packages/llm/src/providers/openai-compatible.ts`
- Modify: `packages/llm/src/protocols/openai-chat.ts`
- Modify: `packages/llm/test/provider/openai-compatible-chat.test.ts`
- Modify: `packages/llm/test/auth-options.types.ts`
- Modify: `packages/llm/script/setup-recording-env.ts`
- Modify: `packages/llm/test/provider/golden.recorded.test.ts`
- Create by recorder: `packages/llm/test/fixtures/recordings/openai-compatible-chat/moonshot-streams-text.json`
- Create by recorder: `packages/llm/test/fixtures/recordings/openai-compatible-chat/moonshot-streams-tool-call.json`
- Create by recorder: `packages/llm/test/fixtures/recordings/openai-compatible-chat/deepseek-streams-tool-call.json`

**Interfaces:**
- Consumes: existing `OpenAICompatible.configure`, `OpenAIChat.protocol`, `LLMEvent`, recorded-golden runner.
- Produces: `OpenAICompatible.moonshot.configure({ apiKey }).model("kimi-k3")`; no new protocol or event type.

- [ ] **Step 1: Write failing facade and stream-shape tests**

Add Moonshot to `providerFamilies` and add a focused stream test using existing `dynamicResponse`:

```ts
["moonshot", OpenAICompatible.moonshot, "https://api.moonshot.cn/v1"],
```

Add a facade compatibility assertion so Kimi automatically activates the repository’s existing Moonshot tool-schema projection:

```ts
const kimi = OpenAICompatible.moonshot.configure({ apiKey: "test-key" }).model("kimi-k3")
expect(kimi.compatibility?.toolSchema).toBe("moonshot")
```

```ts
it.effect("normalizes Moonshot reasoning, fragmented tool input, and cached usage", () =>
  Effect.gen(function* () {
    const response = yield* LLMClient.generate(
      LLM.updateRequest(request, {
        model: OpenAICompatible.moonshot.configure({ apiKey: "test-key" }).model("kimi-k3"),
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          input.respond(
            sseEvents(
              deltaChunk({ role: "assistant", reasoning_content: "check " }),
              deltaChunk({
                tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":" } }],
              }),
              deltaChunk({ tool_calls: [{ index: 0, function: { arguments: "\"moon\"}" } }] }, "tool_calls"),
              usageChunk({
                prompt_tokens: 9,
                completion_tokens: 4,
                total_tokens: 13,
                cached_tokens: 3,
              }),
            ),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
      ),
    )

    expect(response.reasoning).toBe("check ")
    expect(response.toolCalls).toMatchObject([{ id: "call_1", name: "lookup", input: { q: "moon" } }])
    expect(response.usage).toMatchObject({ inputTokens: 9, outputTokens: 4, cacheReadInputTokens: 3 })
  }),
)
```

- [ ] **Step 2: Run the focused test and verify the missing export failure**

Run from `packages/llm`:

```powershell
bun test test/provider/openai-compatible-chat.test.ts
```

Expected: FAIL because `OpenAICompatible.moonshot` does not exist.

- [ ] **Step 3: Add the thin profile and facade export**

Extend the profile type and add Moonshot:

```ts
import type { ModelCompatibility } from "../schema"

export interface OpenAICompatibleProfile {
  readonly provider: string
  readonly baseURL: string
  readonly compatibility?: ModelCompatibility.Input
}

moonshot: {
  provider: "moonshot",
  baseURL: "https://api.moonshot.cn/v1",
  compatibility: { toolSchema: "moonshot" },
},
```

Add to the provider exports:

```ts
export const moonshot = define(profiles.moonshot)
```

Refactor the private facade builder so `define(profile)` passes `profile.compatibility` into:

```ts
route.model({
  id: modelID,
  provider: ProviderID.make(provider),
  compatibility,
})
```

Keep the public generic `configure(...)` behavior unchanged and keep family `.model(...)` as a one-argument method.

Extend `OpenAIChatUsage` and preserve OpenAI’s nested field precedence:

```ts
const OpenAIChatUsage = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.Number),
  completion_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
  cached_tokens: Schema.optional(Schema.Number),
  prompt_tokens_details: optionalNull(
    Schema.Struct({ cached_tokens: Schema.optional(Schema.Number) }),
  ),
  completion_tokens_details: optionalNull(
    Schema.Struct({ reasoning_tokens: Schema.optional(Schema.Number) }),
  ),
})
```

```ts
const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens
```

Add the type-level auth usage:

```ts
OpenAICompatible.moonshot.configure({ apiKey: "moonshot-key" }).model("kimi-k3")
```

- [ ] **Step 4: Run unit tests and typecheck**

Run from `packages/llm`:

```powershell
bun test test/provider/openai-compatible-chat.test.ts test/auth-options.types.ts
bun typecheck
```

Expected: PASS. The stream test proves the existing protocol already handles Kimi’s documented `reasoning_content`, tool fragments and usage shape.

- [ ] **Step 5: Add key-gated recording targets without embedding secrets**

Add to `setup-recording-env.ts`:

```ts
{
  id: "moonshot",
  label: "Moonshot / Kimi",
  tier: "compatible",
  note: "OpenAI-compatible Chat text and tool-call samples",
  vars: [{ name: "MOONSHOT_API_KEY" }],
  validate: (env) =>
    validateBearer("https://api.moonshot.cn/v1/models", Redacted.make(env.MOONSHOT_API_KEY)),
},
```

Add the configured model:

```ts
const moonshot = OpenAICompatible.moonshot
  .configure({ apiKey: process.env.MOONSHOT_API_KEY ?? "fixture" })
  .model("kimi-k3")
```

Add the target and expand DeepSeek:

```ts
{
  name: "Moonshot Kimi K3",
  prefix: "openai-compatible-chat",
  model: moonshot,
  requires: ["MOONSHOT_API_KEY"],
  scenarios: ["text", "tool-call"],
},
```

```ts
{
  name: "DeepSeek Chat",
  prefix: "openai-compatible-chat",
  model: deepseek,
  requires: ["DEEPSEEK_API_KEY"],
  scenarios: ["text", "tool-call"],
},
```

- [ ] **Step 6: Run replay-only tests before asking for keys**

Run from `packages/llm`:

```powershell
$env:RECORDED_PROVIDER='deepseek,moonshot'
bun test test/provider/golden.recorded.test.ts
Remove-Item Env:RECORDED_PROVIDER
```

Expected: existing DeepSeek text cassette replays; missing new cassettes are reported as skipped/missing according to the recorded runner, never as a live request.

- [ ] **Step 7: Pause at the explicit API-cost gate**

Only when the user supplies temporary `MOONSHOT_API_KEY` and `DEEPSEEK_API_KEY`, record exactly:

```text
Kimi: text + one tool-call scenario
DeepSeek: one tool-call scenario
```

Use two bounded recordings so the existing DeepSeek text cassette is not re-recorded:

```powershell
$env:RECORD='true'
$env:RECORDED_PROVIDER='moonshot'
$env:RECORDED_TEST='text,tool-call'
bun test test/provider/golden.recorded.test.ts
$env:RECORDED_PROVIDER='deepseek'
$env:RECORDED_TEST='tool-call'
bun test test/provider/golden.recorded.test.ts
Remove-Item Env:RECORD
Remove-Item Env:RECORDED_PROVIDER
Remove-Item Env:RECORDED_TEST
```

Then remove the environment variables from the shell and inspect every cassette for credentials. Do not record a tool loop or vision sample in Stage A.

- [ ] **Step 8: Commit the provider slice**

```powershell
git add packages/llm/src/providers/openai-compatible-profile.ts packages/llm/src/providers/openai-compatible.ts packages/llm/src/protocols/openai-chat.ts packages/llm/test/provider/openai-compatible-chat.test.ts packages/llm/test/auth-options.types.ts packages/llm/script/setup-recording-env.ts packages/llm/test/provider/golden.recorded.test.ts packages/llm/test/fixtures/recordings/openai-compatible-chat
git commit -m "feat(llm): add moonshot compatible provider"
```

---

### Task 2: Define Workflow DTOs, durable events, and pure transition rules

**Files:**
- Create: `packages/schema/src/workflow.ts`
- Create: `packages/schema/src/workflow-event.ts`
- Modify: `packages/schema/src/index.ts`
- Modify: `packages/schema/src/event-manifest.ts`
- Modify: `packages/schema/src/durable-event-manifest.ts`
- Create: `packages/core/src/workflow/state.ts`
- Create: `packages/core/test/workflow-state.test.ts`

**Interfaces:**
- Consumes: `Event.define`, `Event.inventory`, `DateTimeUtcFromMillis`, `ascending`, `statics`.
- Produces: all Workflow wire/storage types and `WorkflowState.assertStageTransition(from, to)`.

- [ ] **Step 1: Write failing schema/transition tests**

Create `workflow-state.test.ts` with these assertions:

```ts
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import { WorkflowState } from "@opencode-ai/core/workflow/state"

describe("workflow schema", () => {
  test("uses stable prefixed identifiers", () => {
    expect(Workflow.ID.create()).toStartWith("wfl_")
    expect(Workflow.StageID.create()).toStartWith("wfs_")
    expect(Workflow.ArtifactID.create()).toStartWith("wfa_")
  })

  test("decodes a durable created event", () => {
    const decoded = Schema.decodeUnknownSync(WorkflowEvent.Durable)({
      id: "evt_created",
      type: "workflow.created",
      durable: { aggregateID: "wfl_test", seq: 0, version: 1 },
      data: {
        workflowID: "wfl_test",
        timestamp: 1_717_171_717_000,
        type: "development",
        input: { brief: "Build a page" },
        budget: { maxAttempts: 3 },
        stages: [{
          id: "wfs_design",
          type: "design",
          ordinal: 0,
          maxAttempts: 3,
          recoveryPolicy: "restart_safe",
          idempotencyKey: "wfl_test/design",
          input: {},
        }],
      },
    })
    expect(decoded.type).toBe("workflow.created")
  })
})

describe("workflow stage transitions", () => {
  test.each([
    ["pending", "leased"],
    ["leased", "running"],
    ["running", "succeeded"],
    ["running", "retry_wait"],
    ["running", "waiting_approval"],
    ["retry_wait", "leased"],
    ["waiting_approval", "retry_wait"],
  ] as const)("%s -> %s is allowed", (from, to) => {
    expect(() => WorkflowState.assertStageTransition(from, to)).not.toThrow()
  })

  test("a terminal stage cannot return to running", () => {
    expect(() => WorkflowState.assertStageTransition("succeeded", "running")).toThrow("succeeded -> running")
  })
})
```

- [ ] **Step 2: Run the test and verify missing modules**

Run from `packages/core`:

```powershell
bun test test/workflow-state.test.ts
```

Expected: FAIL because Workflow schema and state modules do not exist.

- [ ] **Step 3: Implement stable ID and DTO schemas**

Start `workflow.ts` with the repository self-export pattern and explicit IDs:

```ts
export * as Workflow from "./workflow"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, PositiveInt, statics } from "./schema"
import { SessionID } from "./session-id"

export const ID = Schema.String.check(Schema.isStartsWith("wfl_")).pipe(
  Schema.brand("Workflow.ID"),
  statics((schema) => ({ create: () => schema.make("wfl_" + ascending()) })),
)
export type ID = typeof ID.Type
export const StageID = Schema.String.check(Schema.isStartsWith("wfs_")).pipe(
  Schema.brand("Workflow.StageID"),
  statics((schema) => ({ create: () => schema.make("wfs_" + ascending()) })),
)
export type StageID = typeof StageID.Type
export const ArtifactID = Schema.String.check(Schema.isStartsWith("wfa_")).pipe(
  Schema.brand("Workflow.ArtifactID"),
  statics((schema) => ({ create: () => schema.make("wfa_" + ascending()) })),
)
export type ArtifactID = typeof ArtifactID.Type
```

Define the locked literals from “Public Contracts” and these concrete shapes:

```ts
export const Budget = Schema.Struct({
  maxTokens: NonNegativeInt.pipe(optional),
  maxTurns: NonNegativeInt.pipe(optional),
  maxToolCalls: NonNegativeInt.pipe(optional),
  maxAttempts: PositiveInt.pipe(optional),
  maxDurationMs: PositiveInt.pipe(optional),
}).annotate({ identifier: "Workflow.Budget" })
export interface Budget extends Schema.Schema.Type<typeof Budget> {}

export const Usage = Schema.Struct({
  tokens: NonNegativeInt,
  turns: NonNegativeInt,
  toolCalls: NonNegativeInt,
  attempts: NonNegativeInt,
}).annotate({ identifier: "Workflow.Usage" })
export interface Usage extends Schema.Schema.Type<typeof Usage> {}

export const Failure = Schema.Struct({
  category: FailureCategory,
  code: Schema.String,
  message: Schema.String,
  retryAfterMs: NonNegativeInt.pipe(optional),
  ref: Schema.String.pipe(optional),
}).annotate({ identifier: "Workflow.Failure" })
export interface Failure extends Schema.Schema.Type<typeof Failure> {}

export const StageInput = Schema.Struct({
  id: StageID.pipe(optional),
  type: Schema.NonEmptyString,
  ordinal: NonNegativeInt,
  maxAttempts: PositiveInt,
  recoveryPolicy: RecoveryPolicy,
  idempotencyKey: Schema.NonEmptyString,
  input: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "Workflow.StageInput" })
export interface StageInput extends Schema.Schema.Type<typeof StageInput> {}

export const CreateInput = Schema.Struct({
  id: ID.pipe(optional),
  type: Schema.NonEmptyString,
  input: Schema.Record(Schema.String, Schema.Unknown),
  budget: Budget,
  stages: Schema.NonEmptyArray(StageInput),
}).annotate({ identifier: "Workflow.CreateInput" })
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}
```

Define the projection and artifact contracts exactly:

```ts
export const RecoveryAction = Schema.Literals(["retry", "fail"])
export type RecoveryAction = typeof RecoveryAction.Type

export const Info = Schema.Struct({
  id: ID,
  type: Schema.String,
  status: RunStatus,
  currentStageID: StageID.pipe(optional),
  input: Schema.Record(Schema.String, Schema.Unknown),
  budget: Budget,
  usage: Usage,
  cancelRequestedAt: DateTimeUtcFromMillis.pipe(optional),
  version: NonNegativeInt,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Workflow.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Stage = Schema.Struct({
  id: StageID,
  workflowID: ID,
  type: Schema.String,
  ordinal: NonNegativeInt,
  status: StageStatus,
  attempt: NonNegativeInt,
  maxAttempts: PositiveInt,
  notBefore: DateTimeUtcFromMillis.pipe(optional),
  leaseOwner: Schema.String.pipe(optional),
  leaseExpiresAt: DateTimeUtcFromMillis.pipe(optional),
  sessionID: SessionID.pipe(optional),
  checkpoint: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  recoveryPolicy: RecoveryPolicy,
  recoveryAction: RecoveryAction.pipe(optional),
  idempotencyKey: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown),
  error: Failure.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    started: DateTimeUtcFromMillis.pipe(optional),
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Workflow.Stage" })
export interface Stage extends Schema.Schema.Type<typeof Stage> {}

export const ArtifactCommit = Schema.Struct({
  kind: Schema.NonEmptyString,
  uri: Schema.NonEmptyString,
  mime: Schema.NonEmptyString,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  size: NonNegativeInt,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "Workflow.ArtifactCommit" })
export interface ArtifactCommit extends Schema.Schema.Type<typeof ArtifactCommit> {}

export const Artifact = Schema.Struct({
  id: ArtifactID,
  workflowID: ID,
  stageID: StageID,
  ...ArtifactCommit.fields,
  timeCreated: DateTimeUtcFromMillis,
}).annotate({ identifier: "Workflow.Artifact" })
export interface Artifact extends Schema.Schema.Type<typeof Artifact> {}

export const Detail = Schema.Struct({
  run: Info,
  stages: Schema.Array(Stage),
  artifacts: Schema.Array(Artifact),
}).annotate({ identifier: "Workflow.Detail" })
export interface Detail extends Schema.Schema.Type<typeof Detail> {}
```

- [ ] **Step 4: Define durable events once**

Use one shared durable descriptor:

```ts
import { NonNegativeInt, optional } from "./schema"

const durable = { version: 1, aggregate: "workflowID" } as const
const base = {
  workflowID: Workflow.ID,
  timestamp: DateTimeUtcFromMillis,
}
```

Define these exact event names:

```text
workflow.created
workflow.started
workflow.stage.queued
workflow.stage.leased
workflow.stage.started
workflow.artifact.created
workflow.stage.retry_scheduled
workflow.stage.succeeded
workflow.stage.failed
workflow.approval.requested
workflow.approval.resolved
workflow.budget.threshold_reached
workflow.budget.updated
workflow.cancel.requested
workflow.stage.cancelled
workflow.cancelled
workflow.succeeded
workflow.failed
```

`Stage.Leased`, `Stage.Started`, `Stage.RetryScheduled`, `Stage.Succeeded`, `Stage.Failed`, and `Stage.Cancelled` must carry:

```ts
{
  ...base,
  stageID: Workflow.StageID,
  attempt: NonNegativeInt,
  leaseOwner: Schema.String.pipe(optional),
}
```

`Stage.Leased` additionally carries `leaseExpiresAt`; leased/running settlement events require a non-empty `leaseOwner` at projector validation time, while cancelling a never-leased pending stage omits it. `RetryScheduled` carries `failure`, `usage` and `notBefore`; `Stage.Succeeded` carries `usage`; `Stage.Failed` carries `usage` and `source: execution | recovery`; `Stage.Cancelled` carries `source: execution | request`. `Artifact.Created` carries the complete immutable artifact DTO. `Approval.Requested` carries `stageID`, `reason: ambiguous_execution | budget_exhausted` and an optional sanitized `failure`; `Approval.Resolved` carries `stageID` and `action: retry | fail`. `Budget.ThresholdReached` carries `percent: 50 | 80 | 100`, `dimension`, current `usage` and `budget`; `Budget.Updated` carries the full replacement budget.

Finish with:

```ts
export const DurableDefinitions = Event.inventory(
  Created,
  Started,
  Stage.Queued,
  Stage.Leased,
  Stage.Started,
  Artifact.Created,
  Stage.RetryScheduled,
  Stage.Succeeded,
  Stage.Failed,
  Approval.Requested,
  Approval.Resolved,
  Budget.ThresholdReached,
  Budget.Updated,
  CancelRequested,
  Stage.Cancelled,
  Cancelled,
  Succeeded,
  Failed,
)
export const Definitions = DurableDefinitions
export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" })
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "WorkflowDurableEvent" })
export type DurableEvent = typeof Durable.Type
export const All = Durable
```

- [ ] **Step 5: Add Workflow events to both manifests**

In `event-manifest.ts`:

```ts
import { WorkflowEvent } from "./workflow-event"
```

Add `...WorkflowEvent.Definitions` to `foundationDefinitions`.

In `durable-event-manifest.ts`:

```ts
import { WorkflowEvent } from "./workflow-event"

export const WorkflowDurable = {
  definitions: Event.durable(WorkflowEvent.DurableDefinitions),
  schema: WorkflowEvent.Durable,
} as const
```

Add `...WorkflowEvent.DurableDefinitions` to the global `Durable` map.

Add to `packages/schema/src/index.ts`:

```ts
export { Workflow } from "./workflow"
```

- [ ] **Step 6: Implement the pure transition table**

```ts
const transitions = {
  pending: ["leased", "cancelled", "skipped"],
  leased: ["running", "retry_wait", "waiting_approval", "cancelled"],
  running: ["succeeded", "retry_wait", "waiting_approval", "failed", "cancelled"],
  retry_wait: ["leased", "cancelled"],
  waiting_input: ["retry_wait", "failed", "cancelled"],
  waiting_approval: ["retry_wait", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  skipped: [],
} as const satisfies Record<Workflow.StageStatus, ReadonlyArray<Workflow.StageStatus>>

export function assertStageTransition(from: Workflow.StageStatus, to: Workflow.StageStatus) {
  if ((transitions[from] as ReadonlyArray<Workflow.StageStatus>).includes(to)) return
  throw new InvalidStageTransition(`${from} -> ${to}`)
}

export const terminal = (status: Workflow.StageStatus) =>
  status === "succeeded" || status === "failed" || status === "cancelled" || status === "skipped"
```

Also export `previousStagesComplete(stages, candidate)` that returns true only when every smaller ordinal is `succeeded` or `skipped`.

- [ ] **Step 7: Run tests and package typechecks**

Run:

```powershell
Set-Location packages/core
bun test test/workflow-state.test.ts
bun typecheck
Set-Location ..\schema
bun typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit the schema slice**

```powershell
git add packages/schema/src/workflow.ts packages/schema/src/workflow-event.ts packages/schema/src/index.ts packages/schema/src/event-manifest.ts packages/schema/src/durable-event-manifest.ts packages/core/src/workflow/state.ts packages/core/test/workflow-state.test.ts
git commit -m "feat(core): define workflow lifecycle"
```

---

### Task 3: Add Workflow tables, generated migration, and transactional projector

**Files:**
- Create: `packages/core/src/workflow/sql.ts`
- Create by generator: `packages/core/src/database/migration/20260730*_workflow_stage_a.ts`
- Modify by generator: `packages/core/src/database/migration.gen.ts`
- Modify by generator: `packages/core/src/database/schema.gen.ts`
- Modify by generator: `packages/core/schema.json`
- Create: `packages/core/src/workflow/projector.ts`
- Create: `packages/core/test/workflow-projector.test.ts`
- Modify: `packages/core/test/database-migration.test.ts`

**Interfaces:**
- Consumes: `WorkflowEvent`, `WorkflowState`, `EventV2.project`, `Database.Service`.
- Produces: three SQL projections and atomic lifecycle conflict enforcement.

- [ ] **Step 1: Write failing projection tests**

Create a test layer:

```ts
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, WorkflowProjector.node]),
  ),
)
```

Test creation and stage rows:

```ts
it.effect("projects one run and ordered immutable stages", () =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    yield* events.publish(WorkflowEvent.Created, createdData)

    const runs = yield* db.select().from(WorkflowRunTable).all().pipe(Effect.orDie)
    const stages = yield* db.select().from(WorkflowStageTable).orderBy(WorkflowStageTable.ordinal).all().pipe(Effect.orDie)

    expect(runs).toMatchObject([{ id: "wfl_test", status: "queued", version: 0 }])
    expect(stages.map((stage) => [stage.id, stage.status, stage.attempt])).toEqual([
      ["wfs_design", "pending", 0],
      ["wfs_build", "pending", 0],
    ])
  }),
)
```

Test stale lease fencing:

```ts
it.effect("rolls back a stale completion event", () =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(WorkflowEvent.Created, createdData)
    yield* events.publish(WorkflowEvent.Stage.Leased, leasedData({ owner: "worker-a", attempt: 1 }))
    yield* events.publish(WorkflowEvent.Stage.Started, startedData({ owner: "worker-a", attempt: 1 }))
    yield* events.publish(WorkflowEvent.Stage.RetryScheduled, retryData({ owner: "worker-a", attempt: 1 }))
    yield* events.publish(WorkflowEvent.Stage.Leased, leasedData({ owner: "worker-b", attempt: 2 }))

    const failed = yield* events
      .publish(WorkflowEvent.Stage.Succeeded, succeededData({ owner: "worker-a", attempt: 1 }))
      .pipe(Effect.exit)
    expect(Exit.isFailure(failed)).toBe(true)
  }),
)
```

- [ ] **Step 2: Run the focused test and verify missing tables/projector**

Run from `packages/core`:

```powershell
bun test test/workflow-projector.test.ts
```

Expected: FAIL because SQL and projector modules are missing.

- [ ] **Step 3: Define the Drizzle tables**

Use snake_case property names. The claim index must start with status and `not_before`:

```ts
export const WorkflowRunTable = sqliteTable(
  "workflow_run",
  {
    id: text().$type<Workflow.ID>().primaryKey(),
    type: text().notNull(),
    status: text().$type<Workflow.RunStatus>().notNull(),
    current_stage_id: text().$type<Workflow.StageID>(),
    input: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    budget: text({ mode: "json" }).$type<Workflow.Budget>().notNull(),
    usage: text({ mode: "json" }).$type<Workflow.Usage>().notNull(),
    budget_notified: integer().notNull().default(0),
    cancel_requested_at: integer(),
    time_completed: integer(),
    version: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [
    index("workflow_run_status_updated_idx").on(table.status, table.time_updated),
  ],
)
```

```ts
export const WorkflowStageTable = sqliteTable(
  "workflow_stage",
  {
    id: text().$type<Workflow.StageID>().primaryKey(),
    workflow_id: text().$type<Workflow.ID>().notNull()
      .references(() => WorkflowRunTable.id, { onDelete: "cascade" }),
    stage_type: text().notNull(),
    ordinal: integer().notNull(),
    status: text().$type<Workflow.StageStatus>().notNull(),
    attempt: integer().notNull().default(0),
    max_attempts: integer().notNull(),
    not_before: integer(),
    lease_owner: text(),
    lease_expires_at: integer(),
    session_id: text().$type<SessionSchema.ID>(),
    checkpoint: text({ mode: "json" }).$type<Record<string, unknown>>(),
    recovery_policy: text().$type<Workflow.RecoveryPolicy>().notNull(),
    recovery_action: text().$type<Workflow.RecoveryAction>(),
    idempotency_key: text().notNull(),
    input: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    error: text({ mode: "json" }).$type<Workflow.Failure>(),
    time_started: integer(),
    time_completed: integer(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("workflow_stage_workflow_ordinal_idx").on(table.workflow_id, table.ordinal),
    uniqueIndex("workflow_stage_workflow_idempotency_idx").on(table.workflow_id, table.idempotency_key),
    index("workflow_stage_claim_idx").on(table.status, table.not_before, table.lease_expires_at, table.ordinal),
    index("workflow_stage_workflow_status_idx").on(table.workflow_id, table.status, table.ordinal),
  ],
)
```

```ts
export const WorkflowArtifactTable = sqliteTable(
  "workflow_artifact",
  {
    id: text().$type<Workflow.ArtifactID>().primaryKey(),
    workflow_id: text().$type<Workflow.ID>().notNull()
      .references(() => WorkflowRunTable.id, { onDelete: "cascade" }),
    stage_id: text().$type<Workflow.StageID>().notNull()
      .references(() => WorkflowStageTable.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    uri: text().notNull(),
    mime: text().notNull(),
    sha256: text().notNull(),
    size: integer().notNull(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("workflow_artifact_stage_kind_sha_idx").on(table.stage_id, table.kind, table.sha256),
    index("workflow_artifact_workflow_created_idx").on(table.workflow_id, table.time_created),
  ],
)
```

- [ ] **Step 4: Generate the migration using the repository script**

Run from `packages/core`:

```powershell
bun run migration --name workflow_stage_a
bun run migration --check
```

Expected:

```text
one new timestamped migration ending in _workflow_stage_a.ts
schema.json, migration.gen.ts, and schema.gen.ts updated
migration --check exits 0
```

Do not rename the generated timestamped file.

- [ ] **Step 5: Implement projector lifecycle conflicts**

Define:

```ts
export class LifecycleConflict extends Error {
  constructor(readonly workflowID: Workflow.ID, readonly stageID?: Workflow.StageID) {
    super(stageID ? `Workflow stage lifecycle conflict: ${workflowID}/${stageID}` : `Workflow lifecycle conflict: ${workflowID}`)
  }
}
```

Register projectors in a `Layer.effectDiscard`. For every stage transition:

1. Read the current stage in the event transaction.
2. Call `WorkflowState.assertStageTransition`.
3. For leased/running settlement, require the event’s `attempt` and `leaseOwner` to match the row.
4. For execution-sourced success/failure/cancel, require `lease_expires_at >= event timestamp`.
5. Update with a guarded `WHERE`; if `rowsAffected !== 1`, die with `LifecycleConflict`.

Recovery-sourced failure requires `status = waiting_approval` and `recovery_action = fail`, and does not require a live lease. Request-sourced cancellation requires the parent run’s durable `cancel_requested_at` and may cancel any nonterminal stage even after its lease expired.

Run terminal projectors are guarded too:

```text
workflow.succeeded -> no cancel request and every stage is succeeded/skipped
workflow.failed -> at least one failed stage and run is not already terminal
workflow.cancelled -> cancel_requested_at is set and every stage is terminal
```

Any stage success arriving after `workflow.cancel.requested` is a lifecycle conflict and rolls back.

The lease projection uses:

```ts
assertStageTransition(row.status, "leased")
if (event.data.attempt !== row.attempt + 1) throw new LifecycleConflict(event.data.workflowID, event.data.stageID)
```

The create projection inserts run and all stages in the same EventV2 transaction. Duplicate workflow ID with byte-equivalent create data is handled later by `Workflow.create`; conflicting data remains a conflict.

Initialize run usage as:

```ts
{ tokens: 0, turns: 0, toolCalls: 0, attempts: 0 }
```

`Stage.Leased` atomically increments `usage.attempts`; success/retry/failure settlement atomically adds the event’s other usage delta. `Budget.ThresholdReached` sets the corresponding bit (`50 -> 1`, `80 -> 2`, `100 -> 4`) in `budget_notified`; `Budget.Updated` replaces the budget and recomputes the bitmask from current usage so an increased limit can cross thresholds again later.

- [ ] **Step 6: Add migration coverage**

Extend `database-migration.test.ts` to assert:

```ts
expect(tableNames).toContain("workflow_run")
expect(tableNames).toContain("workflow_stage")
expect(tableNames).toContain("workflow_artifact")
expect(indexNames).toContain("workflow_stage_claim_idx")
```

Also migrate an existing fixture database and assert existing Session rows remain unchanged.

- [ ] **Step 7: Run focused database/projector verification**

Run from `packages/core`:

```powershell
bun test test/workflow-projector.test.ts test/database-migration.test.ts
bun run migration --check
bun typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit the persistence slice**

```powershell
git add packages/core/src/workflow/sql.ts packages/core/src/workflow/projector.ts packages/core/src/database/migration packages/core/src/database/migration.gen.ts packages/core/src/database/schema.gen.ts packages/core/schema.json packages/core/test/workflow-projector.test.ts packages/core/test/database-migration.test.ts
git commit -m "feat(core): persist workflow projections"
```

---

### Task 4: Add secret-safe Store and the Workflow command/query service

**Files:**
- Create: `packages/core/src/workflow/secret-guard.ts`
- Create: `packages/core/src/workflow/store.ts`
- Create: `packages/core/src/workflow/execution.ts`
- Create: `packages/core/src/workflow.ts`
- Create: `packages/core/test/workflow-secret-guard.test.ts`
- Create: `packages/core/test/workflow-store.test.ts`

**Interfaces:**
- Consumes: schema/projector/tables/EventV2.
- Produces: the locked `Workflow.Service` interface; execution defaults to a no-op advisory wake until Task 6.

- [ ] **Step 1: Write failing secret guard tests**

```ts
test.each([
  [{ apiKey: "sk-test-secret" }, "apiKey"],
  [{ headers: { Authorization: "Bearer live-secret" } }, "Authorization"],
  [{ uri: "https://example.test/file?token=live-secret" }, "token"],
])("rejects sensitive persisted input %#", (value, field) => {
  expect(() => WorkflowSecretGuard.assertSafe(value)).toThrow(field)
})

test("sanitizes failure text without retaining the secret", () => {
  const value = WorkflowSecretGuard.sanitizeText("request failed: Bearer live-secret and sk-test-secret")
  expect(value).toBe("request failed: Bearer [REDACTED] and [REDACTED]")
})
```

- [ ] **Step 2: Write failing idempotent create/query/artifact tests**

```ts
it.effect("reconciles an exact create retry and rejects a conflicting reuse", () =>
  Effect.gen(function* () {
    const workflow = yield* WorkflowV2.Service
    const first = yield* workflow.create(createInput)
    const same = yield* workflow.create(createInput)
    expect(same).toEqual(first)

    const conflict = yield* workflow.create({ ...createInput, type: "other" }).pipe(Effect.flip)
    expect(conflict._tag).toBe("Workflow.ConflictError")
  }),
)
```

```ts
it.effect("returns immutable artifacts in creation order", () =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore.Service
    const artifacts = yield* store.artifacts(Workflow.ID.make("wfl_test"))
    expect(artifacts.map((artifact) => artifact.sha256)).toEqual(["a".repeat(64), "b".repeat(64)])
  }),
)
```

- [ ] **Step 3: Run tests and verify missing services**

Run from `packages/core`:

```powershell
bun test test/workflow-secret-guard.test.ts test/workflow-store.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement the secret guard**

Use a recursive walk with these case-insensitive key patterns:

```ts
const sensitiveKey = /^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|cookie|set-cookie)$/i
const sensitiveQuery = /^(token|key|signature|sig|credential|x-amz-signature)$/i
const sensitiveValue = /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9_-]{8,})\b/g
```

`assertSafe` throws `UnsafePersistenceError` with only the JSON path, never the value. `sanitizeText` replaces matching values with `[REDACTED]`. Reject cyclic structures and values that are not JSON-compatible.

Define the typed error as:

```ts
export class UnsafePersistenceError extends Schema.TaggedErrorClass<UnsafePersistenceError>()(
  "Workflow.UnsafePersistenceError",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}
```

`Workflow.create` and `Workflow.updateBudget` wrap the synchronous guard with `Effect.try` so this error remains in the declared Effect error channel rather than becoming a defect.

- [ ] **Step 5: Implement Store query conversion**

`WorkflowStore.Interface` must expose:

```ts
readonly list: (input?: { readonly status?: Workflow.RunStatus; readonly limit?: number }) => Effect.Effect<Workflow.Info[]>
readonly get: (workflowID: Workflow.ID) => Effect.Effect<Workflow.Detail | undefined>
readonly stage: (stageID: Workflow.StageID) => Effect.Effect<Workflow.Stage | undefined>
readonly artifacts: (workflowID: Workflow.ID) => Effect.Effect<Workflow.Artifact[]>
readonly claimCandidates: (input: { readonly now: number; readonly limit: number }) => Effect.Effect<Workflow.Stage[]>
readonly renew: (input: {
  readonly stageID: Workflow.StageID
  readonly owner: string
  readonly attempt: number
  readonly now: number
  readonly expiresAt: number
}) => Effect.Effect<boolean>
readonly expired: (now: number) => Effect.Effect<Workflow.Stage[]>
```

`claimCandidates` selects only:

```text
status = pending
or status = retry_wait and not_before <= now
```

and excludes a candidate when any lower ordinal stage in the same workflow is not `succeeded` or `skipped`. It only admits runs in `queued` or `running`, and excludes any run with `cancel_requested_at`.

- [ ] **Step 6: Implement the Workflow execution boundary**

```ts
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    wake: Effect.void,
    interrupt: () => Effect.void,
    active: Effect.succeed(new Set<Workflow.ID>()),
  }),
)
```

Expose a `node` so tests can map it to `noopLayer` and Task 6 can map it to the local worker.

- [ ] **Step 7: Implement command/query service**

Define the Core error channel:

```ts
export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()(
  "Workflow.NotFoundError",
  { workflowID: Workflow.ID },
) {}

export class StageNotFoundError extends Schema.TaggedErrorClass<StageNotFoundError>()(
  "Workflow.StageNotFoundError",
  { workflowID: Workflow.ID, stageID: Workflow.StageID },
) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()(
  "Workflow.ConflictError",
  { workflowID: Workflow.ID, operation: Schema.String },
) {}
```

`create`:

1. Runs `assertSafe` over input/budget/stages.
2. Validates unique ordinals and idempotency keys.
3. Reconciles an existing byte-equivalent Workflow ID.
4. Publishes `workflow.created`.
5. Publishes `workflow.stage.queued` for audit visibility.
6. Calls advisory `execution.wake`.

Use:

```ts
const workflowID = input.id ?? Workflow.ID.create()
const stages = input.stages.map((stage) => ({
  ...stage,
  id: stage.id ?? Workflow.StageID.create(),
}))
```

`history` uses:

```ts
EventV2.readAggregate(db, {
  aggregateID: input.workflowID,
  after: input.after,
  limit: input.limit,
  manifest: WorkflowDurable,
})
```

`events` follows `SessionV2.events`: verify existence, call `events.durable`, filter with `Schema.is(WorkflowEvent.Durable)`.

At this task, `cancel` only publishes the durable request and calls the execution boundary; detailed stage settlement is added in Task 7.

- [ ] **Step 8: Run focused tests and typecheck**

Run from `packages/core`:

```powershell
bun test test/workflow-secret-guard.test.ts test/workflow-store.test.ts test/workflow-projector.test.ts
bun typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit the service slice**

```powershell
git add packages/core/src/workflow.ts packages/core/src/workflow packages/core/test/workflow-secret-guard.test.ts packages/core/test/workflow-store.test.ts
git commit -m "feat(core): add workflow service"
```

---

### Task 5: Add the stage executor contract and atomic lease acquisition

**Files:**
- Create: `packages/core/src/workflow/executor.ts`
- Modify: `packages/core/src/workflow/store.ts`
- Modify: `packages/core/src/workflow/projector.ts`
- Create: `packages/core/test/workflow-execution.test.ts`

**Interfaces:**
- Consumes: Workflow Store and transactional `workflow.stage.leased`.
- Produces: `WorkflowExecutor.Service`, `claim(owner, now, leaseDurationMs)`, fencing-token tests.

- [ ] **Step 1: Write a failing two-claimer test**

```ts
it.effect("allows only one worker to lease a stage", () =>
  Effect.gen(function* () {
    const workflow = yield* WorkflowV2.Service
    const store = yield* WorkflowStore.Service
    yield* workflow.create(createInput)

    const results = yield* Effect.all(
      [
        store.claim({ owner: "worker-a", now: 1_000, leaseDurationMs: 30_000 }),
        store.claim({ owner: "worker-b", now: 1_000, leaseDurationMs: 30_000 }),
      ],
      { concurrency: "unbounded" },
    )

    expect(results.filter(Option.isSome)).toHaveLength(1)
    const stage = yield* store.stage(Workflow.StageID.make("wfs_design"))
    expect(stage?.attempt).toBe(1)
    expect(["worker-a", "worker-b"]).toContain(stage?.leaseOwner)
  }),
)
```

Add a stale renew test:

```ts
expect(yield* store.renew({
  stageID,
  owner: "worker-a",
  attempt: 1,
  now: 31_001,
  expiresAt: 61_001,
})).toBe(false)
```

- [ ] **Step 2: Run the test and verify `claim` is missing**

Run from `packages/core`:

```powershell
bun test test/workflow-execution.test.ts
```

Expected: FAIL because `claim` and executor are missing.

- [ ] **Step 3: Define the executor service**

Use the locked interface. Provide an explicit empty layer:

```ts
export const emptyLayer = Layer.succeed(
  Service,
  Service.of({
    execute: (input) =>
      Effect.fail({
        failure: {
          category: "invalid_request",
          code: "unsupported_stage",
          message: `No executor is registered for stage type ${input.stage.type}`,
        },
        usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
      }),
  }),
)
```

No API key, provider object or raw Error appears in `ExecutionInput`.

- [ ] **Step 4: Implement optimistic claim through EventV2**

`claim` loops through at most 20 candidates:

```ts
readonly claim: (input: {
  readonly owner: string
  readonly now: number
  readonly leaseDurationMs: number
}) => Effect.Effect<Option.Option<Workflow.Stage>>
```

For each candidate, publish:

```ts
yield* events.publish(WorkflowEvent.Stage.Leased, {
  workflowID: candidate.workflowID,
  stageID: candidate.id,
  timestamp: DateTime.makeUnsafe(input.now),
  attempt: candidate.attempt + 1,
  leaseOwner: input.owner,
  leaseExpiresAt: DateTime.makeUnsafe(input.now + input.leaseDurationMs),
})
```

If `WorkflowProjector.LifecycleConflict` rolls back the event, continue to the next candidate. Return the freshly read stage only after the event commits.

- [ ] **Step 5: Make renew a direct guarded operational update**

Lease renewal is intentionally not a durable event. Use one guarded update:

```ts
where(and(
  eq(WorkflowStageTable.id, input.stageID),
  eq(WorkflowStageTable.lease_owner, input.owner),
  eq(WorkflowStageTable.attempt, input.attempt),
  inArray(WorkflowStageTable.status, ["leased", "running"]),
  gte(WorkflowStageTable.lease_expires_at, input.now),
))
```

Return `true` only when exactly one row changes.

- [ ] **Step 6: Run concurrency and projection tests**

Run from `packages/core`:

```powershell
bun test test/workflow-execution.test.ts test/workflow-projector.test.ts
bun typecheck
```

Expected: PASS, including 100 repeated two-claimer races without duplicate success.

- [ ] **Step 7: Commit the lease slice**

```powershell
git add packages/core/src/workflow/executor.ts packages/core/src/workflow/store.ts packages/core/src/workflow/projector.ts packages/core/test/workflow-execution.test.ts
git commit -m "feat(core): lease workflow stages"
```

---

### Task 6: Add the scoped local worker, heartbeat, artifacts, and successful stage advancement

**Files:**
- Create: `packages/core/src/workflow/execution/local.ts`
- Modify: `packages/core/src/workflow/execution.ts`
- Modify: `packages/core/src/workflow.ts`
- Modify: `packages/core/test/workflow-execution.test.ts`

**Interfaces:**
- Consumes: `WorkflowExecutor.Service.execute`, Store claim/renew, EventV2 lifecycle events.
- Produces: process-local fibers backed by durable leases; `layerWith(options)` for deterministic tests.

- [ ] **Step 1: Add a failing deterministic worker test**

Provide a fake executor:

```ts
const executor = Layer.succeed(
  WorkflowExecutor.Service,
  WorkflowExecutor.Service.of({
    execute: ({ stage }) =>
      Effect.succeed({
        checkpoint: { completed: stage.type },
        usage: { tokens: 120, turns: 1, toolCalls: 0, attempts: 0 },
        artifacts: [{
          kind: "result",
          uri: "artifact://wfl_test/result.json",
          mime: "application/json",
          sha256: "a".repeat(64),
          size: 2,
          metadata: {},
        }],
      }),
  }),
)
```

Test:

```ts
const completed = yield* workflow.events({ workflowID }).pipe(
  Stream.filter((event) => event.type === "workflow.succeeded"),
  Stream.runHead,
  Effect.timeout("2 seconds"),
)
expect(Option.isSome(completed)).toBe(true)
expect((yield* workflow.get(workflowID)).run.status).toBe("succeeded")
```

- [ ] **Step 2: Run the test and verify no local worker exists**

Run from `packages/core`:

```powershell
bun test test/workflow-execution.test.ts
```

Expected: FAIL or timeout because advisory wake has no worker.

- [ ] **Step 3: Implement `layerWith` and one scoped scheduler loop**

Expose:

```ts
export interface Options {
  readonly ownerID: string
  readonly leaseDurationMs: number
  readonly heartbeatIntervalMs: number
  readonly pollIntervalMs: number
  readonly concurrency: number
}

export const defaults: Options = {
  ownerID: `worker_${crypto.randomUUID()}`,
  leaseDurationMs: 30_000,
  heartbeatIntervalMs: 10_000,
  pollIntervalMs: 250,
  concurrency: 2,
}
```

The layer owns:

```ts
const wake = yield* PubSub.sliding<void>(1)
const fibers = new Map<Workflow.ID, Set<Fiber.RuntimeFiber<void, never>>>()
const slots = yield* Semaphore.make(options.concurrency)
```

Start the poll loop with `Effect.forkScoped`; combine periodic poll and `wake` notification, but always query SQLite after a wake.

- [ ] **Step 4: Implement stage execution order**

For a claimed stage:

1. Publish `workflow.started` when run was queued.
2. Publish `workflow.stage.started` with owner/attempt.
3. Start heartbeat fiber.
4. Execute `WorkflowExecutor.Service.execute`.
5. Before each artifact and final settlement, read the run and stop if cancel was requested.
6. Validate artifact SHA-256 format, size, URI and metadata with secret guard.
7. Publish `workflow.artifact.created` for each artifact.
8. Publish `workflow.stage.succeeded` with checkpoint.
9. If no unfinished stage remains, publish `workflow.succeeded`; otherwise wake the scheduler.

Artifact creation uses:

```ts
const artifact = Workflow.Artifact.make({
  id: Workflow.ArtifactID.create(),
  workflowID: stage.workflowID,
  stageID: stage.id,
  ...commit,
  timeCreated: timestamp,
})
```

Stop heartbeat before publishing final settlement. If renew returns false, interrupt the executor and do not publish success/failure from the stale owner.

- [ ] **Step 5: Keep active fibers process-local**

`active` returns a copied `ReadonlySet`; `interrupt(workflowID)` interrupts only current-process fibers. It must be a no-op for idle/missing workflows.

- [ ] **Step 6: Test successful advancement and lease loss**

Add tests for:

```text
two sequential stages run in ordinal order
artifact is committed before stage success
duplicate stage-kind-sha artifact remains one row
forced heartbeat renewal failure prevents stale success
different workflows may run concurrently up to configured concurrency
```

- [ ] **Step 7: Run focused tests and typecheck**

Run from `packages/core`:

```powershell
bun test test/workflow-execution.test.ts test/workflow-store.test.ts
bun typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit the worker slice**

```powershell
git add packages/core/src/workflow/execution packages/core/src/workflow/execution.ts packages/core/src/workflow.ts packages/core/test/workflow-execution.test.ts
git commit -m "feat(core): run leased workflow stages"
```

---

### Task 7: Make cancellation durable, idempotent, and restart-safe

**Files:**
- Modify: `packages/core/src/workflow.ts`
- Modify: `packages/core/src/workflow/projector.ts`
- Modify: `packages/core/src/workflow/execution/local.ts`
- Modify: `packages/core/test/workflow-execution.test.ts`
- Create: `packages/core/test/workflow-cancel.test.ts`

**Interfaces:**
- Consumes: `workflow.cancel.requested`, local execution interrupt.
- Produces: cancel intent survives process restart; terminal cancel is idempotent.

- [ ] **Step 1: Write failing cancellation tests**

```ts
it.effect("persists cancellation before interrupting the local fiber", () =>
  Effect.gen(function* () {
    const workflow = yield* WorkflowV2.Service
    const created = yield* workflow.create(createInput)
    yield* workflow.cancel(created.id)
    yield* workflow.cancel(created.id)

    const detail = yield* workflow.get(created.id)
    expect(detail.run.cancelRequestedAt).toBeDefined()
    expect(detail.run.status).toBe("cancelled")
    const history = yield* workflow.history({ workflowID: created.id, limit: 50 })
    expect(history.events.filter((event) => event.type === "workflow.cancel.requested")).toHaveLength(1)
  }),
)
```

Add a restart test that closes the first scope after the request event, opens a second layer on the same SQLite file, and verifies no executor call happens.

- [ ] **Step 2: Run tests and verify current cancellation is incomplete**

Run from `packages/core`:

```powershell
bun test test/workflow-cancel.test.ts
```

Expected: FAIL because cancel currently only publishes the request.

- [ ] **Step 3: Implement atomic cancel projection**

`workflow.cancel.requested` projector:

```text
sets cancel_requested_at once
increments run version
does not overwrite terminal succeeded/failed/cancelled
```

`Workflow.cancel`:

```ts
if (run.cancelRequestedAt !== undefined) {
  yield* execution.interrupt(workflowID)
  return
}
if (run.status === "cancelled") return
if (run.status === "succeeded" || run.status === "failed") {
  return yield* new ConflictError({ workflowID, operation: "cancel" })
}
```

After the durable request commits, call `execution.interrupt(workflowID)`.

- [ ] **Step 4: Settle all unfinished stages**

The local worker publishes `workflow.stage.cancelled` with `source: execution` while it still owns a valid lease. The startup/durable-cancel scan publishes `source: request` for every remaining nonterminal stage; this form may carry the last owner/attempt for diagnostics but is authorized by the parent run’s durable cancel request, not by a live lease.

After all stages are terminal, publish `workflow.cancelled`. The projector sets `time_completed` and leaves succeeded/skipped artifacts intact.

- [ ] **Step 5: Check cancellation at required boundaries**

Add one shared effect:

```ts
const ensureNotCancelled = (workflowID: Workflow.ID) =>
  store.get(workflowID).pipe(
    Effect.flatMap((detail) =>
      detail?.run.cancelRequestedAt === undefined
        ? Effect.void
        : Effect.fail(new CancelRequested({ workflowID })),
    ),
  )
```

Call it:

```text
before executor/provider work
before any side-effecting executor step exposed by the contract
before artifact commit
before stage transition
before retry scheduling
```

- [ ] **Step 6: Run cancellation and worker tests**

Run from `packages/core`:

```powershell
bun test test/workflow-cancel.test.ts test/workflow-execution.test.ts
bun typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the cancel slice**

```powershell
git add packages/core/src/workflow.ts packages/core/src/workflow/projector.ts packages/core/src/workflow/execution/local.ts packages/core/test/workflow-cancel.test.ts packages/core/test/workflow-execution.test.ts
git commit -m "feat(core): persist workflow cancellation"
```

---

### Task 8: Add classified stage retries and durable budget gates

**Files:**
- Create: `packages/core/src/workflow/retry.ts`
- Create: `packages/core/src/workflow/budget.ts`
- Modify: `packages/core/src/workflow.ts`
- Modify: `packages/core/src/workflow/execution/local.ts`
- Modify: `packages/core/src/workflow/projector.ts`
- Create: `packages/core/test/workflow-retry.test.ts`
- Create: `packages/core/test/workflow-budget.test.ts`

**Interfaces:**
- Consumes: `LLMError.retryable`, `LLMError.retryAfterMs`, current stage attempt/maxAttempts and Workflow budget/usage.
- Produces: pure `WorkflowRetry.decide`, pure `WorkflowBudget.evaluate`, durable retry events and a `100%` pre-lease budget gate.

- [ ] **Step 1: Write the retry decision table**

```ts
test.each([
  [{ category: "transient", code: "http_503", message: "busy" }, 1, 3, "retry"],
  [{ category: "transient", code: "http_503", message: "busy" }, 3, 3, "fail"],
  [{ category: "authentication", code: "invalid_key", message: "bad key" }, 1, 3, "fail"],
  [{ category: "quota", code: "quota", message: "quota" }, 1, 3, "fail"],
  [{ category: "ambiguous", code: "lost", message: "unknown result" }, 1, 3, "approval"],
] as const)("classifies %#", (failure, attempt, maxAttempts, expected) => {
  expect(WorkflowRetry.decide({ failure, attempt, maxAttempts, now: 1_000, randomUnit: 0.5 }).type).toBe(expected)
})
```

Test exact timing:

```ts
expect(WorkflowRetry.decide({
  failure: { category: "transient", code: "rate_limit", message: "wait", retryAfterMs: 7_500 },
  attempt: 1,
  maxAttempts: 3,
  now: 1_000,
  randomUnit: 0,
})).toEqual({ type: "retry", notBefore: 8_500 })
```

- [ ] **Step 2: Run the test and verify missing classifier**

Run from `packages/core`:

```powershell
bun test test/workflow-retry.test.ts
```

Expected: FAIL because `workflow/retry.ts` does not exist.

- [ ] **Step 3: Implement the pure decision**

```ts
export type Decision =
  | { readonly type: "retry"; readonly notBefore: number }
  | { readonly type: "fail" }
  | { readonly type: "approval" }

export function decide(input: {
  readonly failure: Workflow.Failure
  readonly attempt: number
  readonly maxAttempts: number
  readonly now: number
  readonly randomUnit: number
}): Decision {
  if (input.failure.category === "ambiguous") return { type: "approval" }
  if (input.failure.category !== "transient" || input.attempt >= input.maxAttempts) return { type: "fail" }
  if (input.failure.retryAfterMs !== undefined) {
    return { type: "retry", notBefore: input.now + Math.min(input.failure.retryAfterMs, 60_000) }
  }
  const base = Math.min(1_000 * 2 ** (input.attempt - 1), 60_000)
  const jitter = 0.8 + Math.min(1, Math.max(0, input.randomUnit)) * 0.4
  return { type: "retry", notBefore: input.now + Math.round(base * jitter) }
}
```

- [ ] **Step 4: Add an LLM error adapter without persisting raw errors**

Map:

```text
RateLimit/ProviderInternal/transport timeout -> transient
Authentication -> authentication
QuotaExceeded -> quota
InvalidRequest -> invalid_request
everything else -> unknown
```

Use `WorkflowSecretGuard.sanitizeText(error.message)` and copy only `retryAfterMs`; do not copy `error.reason.http`.

- [ ] **Step 5: Integrate decision into worker settlement**

On executor failure:

```ts
const failure = WorkflowSecretGuard.sanitizeFailure(error.failure)
const decision = WorkflowRetry.decide({ failure, attempt, maxAttempts, now, randomUnit })
```

Then:

```text
retry -> publish workflow.stage.retry_scheduled, clear lease, set retry_wait/not_before
approval -> publish workflow.approval.requested, clear lease, set waiting_approval/run waiting_approval
fail -> publish workflow.stage.failed then workflow.failed
```

Every retry/approval/failure event carries `error.usage`; the projector adds it exactly once. Never increment `attempt` while scheduling; the next successful lease increments it.

- [ ] **Step 6: Write failing budget threshold and update tests**

```ts
test("reports every newly crossed threshold once", () => {
  expect(WorkflowBudget.evaluate({
    budget: { maxTokens: 1_000, maxAttempts: 4 },
    usage: { tokens: 810, turns: 0, toolCalls: 0, attempts: 2 },
    notified: 0,
    elapsedMs: 1_000,
  })).toEqual({
    exhausted: false,
    thresholds: [
      { percent: 50, dimension: "tokens" },
      { percent: 80, dimension: "tokens" },
    ],
  })
})
```

```ts
it.effect("does not lease the next stage after 100 percent until budget increases", () =>
  Effect.gen(function* () {
    const workflow = yield* WorkflowV2.Service
    const created = yield* workflow.create({
      ...createInput,
      budget: { maxTokens: 100 },
    })
    yield* completeFirstStage({ usage: { tokens: 100, turns: 1, toolCalls: 0, attempts: 0 } })

    expect((yield* workflow.get(created.id)).run.status).toBe("waiting_approval")
    expect(Option.isNone(yield* store.claim({ owner: "worker-b", now: 2_000, leaseDurationMs: 30_000 }))).toBe(true)

    yield* workflow.updateBudget({ workflowID: created.id, budget: { maxTokens: 200 } })
    expect(Option.isSome(yield* store.claim({ owner: "worker-b", now: 2_001, leaseDurationMs: 30_000 }))).toBe(true)
  }),
)
```

- [ ] **Step 7: Implement pure budget evaluation and monotonic updates**

`evaluate` computes each defined ratio:

```ts
const ratios = [
  ["tokens", input.usage.tokens, input.budget.maxTokens],
  ["turns", input.usage.turns, input.budget.maxTurns],
  ["toolCalls", input.usage.toolCalls, input.budget.maxToolCalls],
  ["attempts", input.usage.attempts, input.budget.maxAttempts],
  ["duration", input.elapsedMs, input.budget.maxDurationMs],
] as const
```

Ignore undefined limits. Return all unnotified thresholds crossed by the highest ratio, using bits `1/2/4` for `50/80/100`. `exhausted` is true when any defined ratio is at least `1`.

`validateIncrease(current, next)` rejects:

```text
removing an existing limit
setting any existing limit lower
setting a limit below already consumed usage
an empty update that changes no value
```

Project `workflow.approval.requested` by reason: `budget_exhausted` leaves the next stage `pending` and moves only the run to `waiting_approval`; `ambiguous_execution` moves both the affected stage and run to `waiting_approval`. `workflow.budget.updated` resumes the run only when no stage is itself `waiting_approval`, so a budget increase cannot bypass ambiguous-side-effect review.

- [ ] **Step 8: Enforce the gate before claim and after settlement**

Before publishing `workflow.stage.leased`, evaluate the run:

```text
publish each newly crossed threshold
if exhausted, publish workflow.approval.requested with reason budget_exhausted
return no lease
```

After every success/retry/failure usage delta is projected, evaluate again. If the workflow has another stage and is exhausted, enter `waiting_approval` before waking the worker.

For `maxDurationMs`, pass the remaining duration into executor execution and wrap it with `Effect.timeoutFail`; timeout reports `transient/workflow_deadline` only when a later budget update can make progress, otherwise the 100% gate wins.

`Workflow.updateBudget` validates secrets and monotonic increase, publishes `workflow.budget.updated`, returns the updated run, and wakes execution only after the event commits.

- [ ] **Step 9: Test event history and no secret leakage**

Assert:

```ts
expect(history.events.map((event) => event.type)).toContain("workflow.stage.retry_scheduled")
expect(JSON.stringify(history.events)).not.toContain("live-secret")
```

- [ ] **Step 10: Run retry, budget, cancel, and worker tests**

Run from `packages/core`:

```powershell
bun test test/workflow-retry.test.ts test/workflow-budget.test.ts test/workflow-cancel.test.ts test/workflow-execution.test.ts
bun typecheck
```

Expected: PASS.

- [ ] **Step 11: Commit the retry and budget slice**

```powershell
git add packages/core/src/workflow/retry.ts packages/core/src/workflow/budget.ts packages/core/src/workflow.ts packages/core/src/workflow/execution/local.ts packages/core/src/workflow/projector.ts packages/core/test/workflow-retry.test.ts packages/core/test/workflow-budget.test.ts
git commit -m "feat(core): enforce workflow budgets"
```

---

### Task 9: Recover expired leases conservatively after process restart

**Files:**
- Modify: `packages/core/src/workflow/store.ts`
- Modify: `packages/core/src/workflow/execution/local.ts`
- Modify: `packages/core/src/workflow/projector.ts`
- Create: `packages/core/test/workflow-recovery.test.ts`

**Interfaces:**
- Consumes: `Workflow.Stage.recoveryPolicy`, expired lease scan.
- Produces: startup recovery and explicit `resolveRecovery`.

- [ ] **Step 1: Write three failing recovery policy tests**

Build a temp-file SQLite fixture, lease/start a stage, close the first scope, advance time past the lease, then open a second scope.

Assertions:

```ts
expect(restartSafe.status).toBe("retry_wait")
expect(reconcileRequired.status).toBe("waiting_approval")
expect(manualRequired.status).toBe("waiting_approval")
```

For `restart_safe`, assert the second worker eventually executes attempt `2`; for the other policies, assert executor call count remains `0`.

- [ ] **Step 2: Run tests and verify expired rows remain stuck**

Run from `packages/core`:

```powershell
bun test test/workflow-recovery.test.ts
```

Expected: FAIL because startup recovery is missing.

- [ ] **Step 3: Implement startup recovery before polling**

At layer acquisition:

```ts
const timestamp = yield* DateTime.now
const now = DateTime.toEpochMillis(timestamp)
for (const stage of yield* store.expired(now)) {
  if (stage.recoveryPolicy === "restart_safe") {
    yield* events.publish(WorkflowEvent.Stage.RetryScheduled, {
      workflowID: stage.workflowID,
      stageID: stage.id,
      timestamp,
      attempt: stage.attempt,
      leaseOwner: stage.leaseOwner,
      failure: {
        category: "transient",
        code: "lease_expired",
        message: "The previous worker lease expired before settlement.",
      },
      usage: { tokens: 0, turns: 0, toolCalls: 0, attempts: 0 },
      notBefore: timestamp,
    })
    continue
  }
  yield* events.publish(WorkflowEvent.Approval.Requested, {
    workflowID: stage.workflowID,
    stageID: stage.id,
    timestamp,
    reason: "ambiguous_execution",
    failure: {
      category: "ambiguous",
      code: "lease_expired",
      message: "Execution may have produced side effects before the worker lease expired.",
    },
  })
}
```

Run cancellation recovery first: if `cancel_requested_at` is set, cancel stages instead of applying their recovery policy.

- [ ] **Step 4: Implement explicit recovery resolution**

For `action: "retry"`:

```text
only waiting_approval is accepted
publish workflow.approval.resolved
transition stage to retry_wait with not_before = now
transition run from waiting_approval to running
wake worker
```

For `action: "fail"`:

```text
publish workflow.approval.resolved
publish workflow.stage.failed with category ambiguous
publish workflow.failed
```

`workflow.approval.resolved` projects its action to `workflow_stage.recovery_action`. Repeating the stored action returns successfully without publishing another event; a different second action returns `Workflow.ConflictError`.

- [ ] **Step 5: Add a working-tree checkpoint contract without implementing Stage B**

Document in `WorkflowExecutor.Result.checkpoint` that an implementation executor must record:

```ts
{
  readonly workspaceRevision?: string
  readonly dirtyPaths?: ReadonlyArray<string>
  readonly manifestArtifactID?: Workflow.ArtifactID
}
```

Stage A persists this opaque JSON after secret validation; it does not interpret Git state.

- [ ] **Step 6: Run recovery and all lifecycle tests**

Run from `packages/core`:

```powershell
bun test test/workflow-recovery.test.ts test/workflow-retry.test.ts test/workflow-cancel.test.ts test/workflow-execution.test.ts
bun typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the recovery slice**

```powershell
git add packages/core/src/workflow/store.ts packages/core/src/workflow/execution/local.ts packages/core/src/workflow/projector.ts packages/core/test/workflow-recovery.test.ts
git commit -m "feat(core): recover expired workflows"
```

---

### Task 10: Expose the typed Workflow REST/SSE API and wire the server

**Files:**
- Create: `packages/protocol/src/groups/workflow.ts`
- Modify: `packages/protocol/src/api.ts`
- Modify: `packages/protocol/src/errors.ts`
- Create: `packages/server/src/handlers/workflow.ts`
- Modify: `packages/server/src/handlers.ts`
- Modify: `packages/server/src/routes.ts`
- Modify: `packages/core/src/workflow.ts`

**Interfaces:**
- Consumes: `Workflow.Service`.
- Produces: create/list/get/history/events/artifacts/cancel/recovery endpoints.

- [ ] **Step 1: Add the Protocol error schemas**

```ts
export class WorkflowNotFoundError extends Schema.TaggedErrorClass<WorkflowNotFoundError>()(
  "WorkflowNotFoundError",
  { workflowID: Schema.String, message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class WorkflowStageNotFoundError extends Schema.TaggedErrorClass<WorkflowStageNotFoundError>()(
  "WorkflowStageNotFoundError",
  { workflowID: Schema.String, stageID: Schema.String, message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class WorkflowConflictError extends Schema.TaggedErrorClass<WorkflowConflictError>()(
  "WorkflowConflictError",
  { workflowID: Schema.String, operation: Schema.String, message: Schema.String },
  { httpApiStatus: 409 },
) {}
```

- [ ] **Step 2: Define the complete Workflow group**

Use group ID `server.workflow` and exact endpoints:

```text
POST /api/workflow                         workflow.create
GET  /api/workflow                         workflow.list
GET  /api/workflow/:workflowID             workflow.get
GET  /api/workflow/:workflowID/history     workflow.history
GET  /api/workflow/:workflowID/event       workflow.events
GET  /api/workflow/:workflowID/artifact    workflow.artifacts
POST /api/workflow/:workflowID/cancel      workflow.cancel
POST /api/workflow/:workflowID/budget      workflow.updateBudget
POST /api/workflow/:workflowID/stage/:stageID/recovery workflow.resolveRecovery
```

Use:

```ts
const WorkflowHistoryLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(100))
```

SSE success:

```ts
HttpApiSchema.StreamSse({ data: WorkflowEvent.Durable })
```

Create success:

```ts
Schema.Struct({ data: Workflow.Info })
```

List and artifact success:

```ts
Schema.Struct({ data: Schema.Array(Workflow.Info) })
Schema.Struct({ data: Schema.Array(Workflow.Artifact) })
```

Get success:

```ts
Schema.Struct({ data: Workflow.Detail })
```

Budget update payload/success:

```ts
{
  payload: Schema.Struct({ budget: Workflow.Budget }),
  success: Schema.Struct({ data: Workflow.Info }),
  error: [WorkflowNotFoundError, WorkflowConflictError, InvalidRequestError],
}
```

- [ ] **Step 3: Register the group in Protocol**

Import `WorkflowGroup` and add:

```ts
.add(WorkflowGroup)
```

Place it after Session and before Message so generated clients remain logically grouped.

- [ ] **Step 4: Implement the handler error mapping**

Use constants:

```ts
const DefaultWorkflowListLimit = 50
const DefaultWorkflowHistoryLimit = 50
```

Map Core tags explicitly:

```ts
Effect.catchTag("Workflow.NotFoundError", (error) =>
  new WorkflowNotFoundError({
    workflowID: error.workflowID,
    message: `Workflow not found: ${error.workflowID}`,
  }),
)
```

Also map:

```text
Workflow.StageNotFoundError -> WorkflowStageNotFoundError
Workflow.ConflictError -> WorkflowConflictError
Workflow.UnsafePersistenceError -> InvalidRequestError(kind = unsafe_persistence, field = error.path)
```

Never include the rejected value in an HTTP error.

SSE uses:

```ts
Stream.map(workflow.events({
  workflowID: ctx.params.workflowID,
  after: ctx.query.after,
}), HttpApiSchema.ServerSentEvent.fromData)
```

- [ ] **Step 5: Wire handlers and service nodes**

Add `WorkflowHandler` to `handlers`.

Add Workflow nodes to `applicationServices`:

```ts
WorkflowV2.node,
```

Map:

```ts
[WorkflowExecution.node, WorkflowExecutionLocal.node]
```

Ensure the local node’s dependencies include Database, EventV2, WorkflowProjector, Store and the empty/default WorkflowExecutor service.

- [ ] **Step 6: Run Protocol and Server typechecks**

Run:

```powershell
Set-Location packages/protocol
bun typecheck
Set-Location ..\server
bun typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the HTTP/server slice**

```powershell
git add packages/protocol/src/groups/workflow.ts packages/protocol/src/api.ts packages/protocol/src/errors.ts packages/server/src/handlers/workflow.ts packages/server/src/handlers.ts packages/server/src/routes.ts packages/core/src/workflow.ts
git commit -m "feat(server): expose workflow api"
```

---

### Task 11: Regenerate both clients and prove contract identity

**Files:**
- Modify: `packages/client/src/contract.ts`
- Regenerate: `packages/client/src/generated/client.ts`
- Regenerate: `packages/client/src/generated/client-error.ts`
- Regenerate: `packages/client/src/generated/index.ts`
- Regenerate: `packages/client/src/generated/types.ts`
- Regenerate: `packages/client/src/generated-effect/client.ts`
- Regenerate: `packages/client/src/generated-effect/client-error.ts`
- Regenerate: `packages/client/src/generated-effect/index.ts`
- Modify: `packages/client/test/promise.test.ts`
- Modify: `packages/client/test/effect.test.ts`
- Modify: `packages/client/test/contract-identity.test.ts`

**Interfaces:**
- Consumes: Protocol HttpApi.
- Produces: `client.workflows.*` for Promise and Effect clients.

- [ ] **Step 1: Write failing client surface tests**

Add to expected groups:

```ts
"workflows",
```

Add Promise workflow requests:

```ts
const created = await client.workflows.create({
  type: "development",
  input: { brief: "Build" },
  budget: { maxAttempts: 3 },
  stages: [{
    type: "design",
    ordinal: 0,
    maxAttempts: 3,
    recoveryPolicy: "restart_safe",
    idempotencyKey: "design",
    input: {},
  }],
})
const detail = await client.workflows.get({ workflowID: created.id })
const history = await client.workflows.history({ workflowID: created.id, after: 0, limit: 10 })
for await (const event of client.workflows.events({ workflowID: created.id, after: 0 })) {
  expect(event.durable?.aggregateID).toBe(created.id)
}
await client.workflows.cancel({ workflowID: created.id })
await client.workflows.updateBudget({
  workflowID: created.id,
  budget: { maxTokens: 2_000, maxAttempts: 3 },
})
```

Expected request paths must exactly match Task 10.

- [ ] **Step 2: Run tests and verify the group is absent**

Run from `packages/client`:

```powershell
bun test test/promise.test.ts test/effect.test.ts test/contract-identity.test.ts
```

Expected: FAIL because `workflows` is not generated.

- [ ] **Step 3: Map the group name**

Add:

```ts
"server.workflow": "workflows",
```

No manual endpoint renames are required.

- [ ] **Step 4: Regenerate, never hand-edit generated files**

Run from `packages/client`:

```powershell
bun run generate
bun run check:generated
```

Expected: generated Promise and Effect clients include the Workflow group; generated check exits 0.

- [ ] **Step 5: Add schema identity assertions**

```ts
expect(CoreWorkflow.Info).toBe(Workflow.Info)
expect(Api.groups["server.workflow"].identifier).toBe("server.workflow")
expect(Workflow.ID.create()).toStartWith("wfl_")
```

- [ ] **Step 6: Run client tests and typecheck**

Run from `packages/client`:

```powershell
bun test
bun typecheck
bun run check:generated
```

Expected: PASS.

- [ ] **Step 7: Commit generated clients with their contract**

```powershell
git add packages/client/src/contract.ts packages/client/src/generated packages/client/src/generated-effect packages/client/test
git commit -m "feat(client): generate workflow clients"
```

---

### Task 12: Prove restart, replay, cancellation, fencing, and API behavior end to end

**Files:**
- Modify: `packages/sdk-next/test/embedded.test.ts`
- Create: `packages/core/test/workflow-crash-worker.ts`
- Create: `packages/core/test/workflow-crash.test.ts`
- Modify: `packages/core/test/workflow-secret-guard.test.ts`
- Modify: `packages/core/test/workflow-recovery.test.ts`

**Interfaces:**
- Consumes: all Stage A slices.
- Produces: acceptance evidence for the audit’s Stage A criteria.

- [ ] **Step 1: Add an embedded real-router test**

Using a temp SQLite file:

```ts
const opencode = yield* OpenCode.create()
const created = yield* opencode.workflows.create(createInput)
const detail = yield* opencode.workflows.get({ workflowID: created.id })
const history = yield* opencode.workflows.history({ workflowID: created.id, limit: 50 })
const streamed = yield* opencode.workflows.events({ workflowID: created.id }).pipe(
  Stream.take(1),
  Stream.runCollect,
)

expect(detail.run.id).toBe(created.id)
expect(history.data[0]?.type).toBe("workflow.created")
expect(Array.from(streamed)[0]?.durable?.aggregateID).toBe(created.id)
```

Use an admit-only/empty executor stage or cancel immediately so the test never calls a model.

- [ ] **Step 2: Add a child-process crash fixture**

`workflow-crash-worker.ts` accepts:

```text
database path
workflow ID
recovery policy
marker-file path
```

It opens the real Core layer, obtains a lease, writes the marker after `workflow.stage.started`, then exits with code `17` without settling.

- [ ] **Step 3: Add restart assertions**

The parent test:

1. Creates the workflow in a file-backed database.
2. Spawns the fixture and waits for the marker.
3. Confirms exit code `17`.
4. Advances the persisted lease timestamp or TestClock past expiration.
5. Starts a new Core scope on the same database.
6. Asserts `restart_safe` executes attempt 2.
7. Asserts `manual_required` never executes and returns `waiting_approval`.

Expected event order for restart-safe:

```ts
expect(types).toEqual(expect.arrayContaining([
  "workflow.created",
  "workflow.stage.leased",
  "workflow.stage.started",
  "workflow.stage.retry_scheduled",
  "workflow.stage.leased",
  "workflow.stage.started",
  "workflow.stage.succeeded",
  "workflow.succeeded",
]))
```

- [ ] **Step 4: Add an event replay boundary test**

Read history page 1 with limit 2, then use the last durable sequence as exclusive `after`. Assert no duplicate or missing IDs across page 2 and SSE tail.

```ts
expect(new Set([...first.data, ...second.data].map((event) => event.id)).size)
  .toBe(first.data.length + second.data.length)
```

- [ ] **Step 5: Add a persisted-secret database scan**

After feeding rejected secret inputs and a sanitized executor error, query:

```text
event.data
workflow_run.input
workflow_stage.checkpoint
workflow_stage.error
workflow_artifact.metadata
```

Serialize them and assert absence of:

```text
sk-test-secret
Bearer live-secret
MOONSHOT_API_KEY
DEEPSEEK_API_KEY
```

Also capture test logs through `TestConsole` and apply the same assertions.

- [ ] **Step 6: Run the complete package-level verification matrix**

Run in order:

```powershell
Set-Location packages/llm
bun test
bun typecheck

Set-Location ..\schema
bun typecheck

Set-Location ..\core
bun test
bun run migration --check
bun typecheck

Set-Location ..\protocol
bun typecheck

Set-Location ..\server
bun typecheck

Set-Location ..\client
bun test
bun run check:generated
bun typecheck

Set-Location ..\sdk-next
bun test
bun typecheck
```

Expected: every command exits 0. Replay-only Provider tests must not make network requests.

- [ ] **Step 7: Review the final diff for Stage B leakage**

Run from the implementation worktree root:

```powershell
git diff --stat origin/dev...HEAD
git diff --name-only origin/dev...HEAD
rg -n 'api[_-]?key|authorization|bearer|sk-' packages/core/src/workflow packages/schema/src/workflow* packages/protocol/src/groups/workflow.ts packages/server/src/handlers/workflow.ts
```

Expected:

```text
no packages/app UI
no responses-compat files
no renderer/design/reviewer state machine
no embedded key values
```

- [ ] **Step 8: Commit end-to-end evidence**

```powershell
git add packages/sdk-next/test/embedded.test.ts packages/core/test/workflow-crash-worker.ts packages/core/test/workflow-crash.test.ts packages/core/test/workflow-secret-guard.test.ts packages/core/test/workflow-recovery.test.ts
git commit -m "test: verify durable workflow recovery"
```

---

## Stage A Acceptance Checklist

- [ ] Kimi/Moonshot and DeepSeek both use the existing OpenAI-compatible Chat protocol and produce existing `LLMEvent` values.
- [ ] Default tests replay fixtures or use deterministic fakes; real provider calls happen only behind `RECORD=true` and key checks.
- [ ] One Workflow create event atomically projects the run and ordered stage definitions.
- [ ] Two concurrent claimers cannot both lease or settle one stage.
- [ ] A stale worker cannot renew, create artifacts, succeed, fail, or reschedule after losing its fencing token.
- [ ] `workflow.cancel.requested` is durable before local interruption, remains effective after restart, and is idempotent.
- [ ] Retry history clearly distinguishes HTTP-internal retry from a new Workflow attempt.
- [ ] Usage is accumulated once per fenced attempt; 50/80/100% threshold events are durable, the 100% gate blocks new leases, and only a monotonic typed budget increase resumes work.
- [ ] Expired `restart_safe` stages retry; `reconcile_required` and `manual_required` stop for explicit approval.
- [ ] History and SSE use EventV2 aggregate sequence with exclusive `after` and no replay gaps.
- [ ] API Key/Authorization values are rejected or redacted before any event, projection, artifact metadata or log write.
- [ ] Promise and Effect clients are regenerated from the typed API and pass contract identity tests.
- [ ] Killing the worker process yields either deterministic recovery or `waiting_approval`; no stage remains silently stuck in `running`.
- [ ] No Stage B UI, renderer, design/implementation/review state machine, or Responses facade is included.

## Cost Gate

All Core, Protocol, Server, Client, migration, cancellation, retry and crash tests use fakes and cost zero model tokens. The only external-model spend in Stage A is the Task 1 recording gate:

```text
Kimi: 2 narrow scenarios
DeepSeek: 1 narrow scenario
```

Do not run that gate until the user supplies temporary keys and confirms the three-scenario cap. If the provider changes its model name or requires paid access, keep the deterministic unit coverage and report the blocked cassette separately; do not broaden the live test set.

## References

- Approved audit/spec: `docs/superpowers/specs/2026-07-29-opencode-kimi-deepseek-workflow-audit.md`
- Full-audit source: `7565e03536d19e850f9996c407f9bf5e932b5f7a`
- Stage A implementation base after delta audit: `ff0382e97145cb6585b575dcc1269fa1512e853b`
- Kimi Chat endpoint verified 2026-07-30: `https://platform.kimi.com/docs/api/chat`
- DeepSeek Chat endpoint: `https://api-docs.deepseek.com/api/create-chat-completion`

## Execution Handoff

The implementation should be executed one task at a time with a review gate after every commit. Recommended order is Task 2–12 for the zero-API-cost durable foundation, while Task 1 unit changes may run first but its live recording Step 7 remains paused until the user supplies keys and confirms the cost gate.
