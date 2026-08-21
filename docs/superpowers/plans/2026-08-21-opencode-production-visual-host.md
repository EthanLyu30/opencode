# OpenCode Production Visual Workflow Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete Location-bound production host that automatically runs Kimi K3 design/decomposition/visual review and DeepSeek V4 Pro/Flash implementation, repair, testing, and delivery inside the admitted local workspace.

**Architecture:** A durable visual-build admission atomically binds one immutable `Location.Ref`, one hidden real Session, one preallocated Workflow graph, and one stored Response. Core owns provider-independent placement, stage, artifact, role-execution, and `WorkflowVisualHost` contracts; Server owns the real loopback preview/process/Playwright layer and injects it into the existing Workflow runtime. Every branch, tool side effect, screenshot, terminal Response, and recovery decision is persisted through EventV2 before execution advances.

**Tech Stack:** TypeScript, Bun, Effect 4, Effect Schema, Effect HttpApi, SQLite, Drizzle ORM, EventV2, `@opencode-ai/llm`, Playwright 1.59.1, generated OpenCode clients, PowerShell deployment tooling.

**Spec:** `docs/superpowers/specs/2026-08-21-opencode-production-visual-host-design.md`

## Global Constraints

- Work directly on the existing `dev` checkout because the user explicitly selected `dev` and rejected recurring isolation branches; make one conventional commit per task so every step remains recoverable.
- Do not change or reimplement Tasks 2–22 except where Task23 must integrate through their published contracts.
- The exact route matrix is fixed: Kimi `kimi-k3` for `design`, `decompose`, and `visual_review`; DeepSeek `deepseek-v4-pro` Responses for `implement`, `repair`, and `deliver`; DeepSeek `deepseek-v4-flash` Responses for `test`.
- Do not add Kimi 2.6/2.7, model fallbacks, protocol fallbacks, or silent downgrades.
- Public request payloads never accept a directory, workspace ID, preview URL, or model-authored build command; the server derives Location and freezes the preview plan at admission.
- Background visual builds require `store: true`; direct generic `store: false` Responses remain supported but cannot back this product flow.
- Every behavior change follows RED → GREEN → focused regression → package typecheck before commit.
- Run tests and `bun typecheck` only from their package directories, never from the repository root.
- After Protocol or Server HttpApi changes, regenerate clients from `packages/client`; never edit `src/generated` or `src/generated-effect` by hand.
- Generate database migrations with `packages/core/script/migration.ts`; never hand-edit generated migration registries or schema snapshots.
- Standard tests and acceptance use deterministic fakes or recorded redacted fixtures and must spend zero provider credits.
- Do not read, print, copy, commit, or embed provider keys. Live Kimi/DeepSeek calls require a new explicit request ceiling and spend approval.
- Production screenshot limits are exactly 8 MiB per PNG and 128 MiB total visual evidence per workflow.
- Production host URLs are capability-bearing `http://127.0.0.1:<ephemeral-port>/...` URLs. Reject remote origins, `file:` URLs, userinfo, and model-authored URLs.
- Task23-owned durable data, browser binaries, caches, and temporary files in the deployed product must live under `D:\OpenCode-Local`; reusable Core contracts use configured roots rather than hard-coded drive paths.
- Cleanup may remove only verified descendants of the configured workflow-host roots and must never recursively delete or move the admitted workspace.
- Keep prior executable and SHA-256 as a rollback point when updating `D:\OpenCode-Local`.
- Push verified commits from local `dev` to `fork/dev` and report GitHub commit links.

---

## File and Interface Map

The work is one dependent product flow, not a collection of independently deployable subsystems. The task boundaries below are review gates along that dependency chain.

| Area           | Responsibility                                                                          | Primary files                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Placement      | Immutable Workflow Location, hidden Session identity, legacy-unbound behavior           | `packages/schema/src/workflow.ts`, `packages/schema/src/workflow-event.ts`, `packages/core/src/workflow/{sql,projector,store}.ts`     |
| Graph          | Preallocated revision graph, durable branch skipping, replay authority                  | `packages/core/src/workflow/graph.ts`, `packages/core/src/workflow/stage-machine.ts`, `packages/core/src/workflow/execution/local.ts` |
| Artifacts      | Strict decomposition, implementation, test, and delivery handoffs                       | `packages/schema/src/workflow-*-artifact.ts`, `packages/core/src/workflow/artifacts/*.ts`                                             |
| Tools          | Location-scoped ToolRegistry snapshot, real Session permission lineage                  | `packages/core/src/workflow/permissions.ts`, `packages/core/src/workflow/execution/model.ts`                                          |
| Host contract  | Frozen preview plans, safe paths, host handles, capture/result errors                   | `packages/core/src/workflow/visual-host.ts`, `packages/core/src/workflow/preview-plan.ts`                                             |
| Host runtime   | Reference/static/script serving, process trees, Chromium capture, scoped cleanup        | `packages/server/src/workflow/visual-host.ts`, `packages/server/src/workflow/playwright.ts`                                           |
| Role execution | Strict role-specific model contracts, snapshots, Kimi paired media, artifact validation | `packages/core/src/workflow/execution/role.ts`, `packages/core/src/workflow/execution/contract.ts`                                    |
| Admission      | Atomic Session + Workflow + Response creation and idempotent reconciliation             | `packages/core/src/workflow/admission.ts`, `packages/core/src/session/admission.ts`, `packages/core/src/responses/admission.ts`       |
| Product API    | One Location-aware visual-build operation and generated clients                         | `packages/protocol/src/groups/workflow.ts`, `packages/server/src/handlers/workflow.ts`, generated Client                              |
| CLI            | `opencode workflow run`, SSE following, terminal/artifact summary                       | `packages/opencode/src/cli/cmd/workflow.ts`, `packages/opencode/src/index.ts`                                                         |
| Acceptance     | Recorded full repair loop, process crash matrix, security checks                        | Core, Server, SDK Next, and OpenCode focused tests                                                                                    |
| Deployment     | Repeatable build, Chromium provisioning, atomic replacement, rollback smoke             | `scripts/deploy-local.ps1`, `scripts/test-local-deploy.ps1`, `D:\OpenCode-Local`                                                      |

The interfaces are fixed for neighboring tasks:

```ts
// Schema/Core placement
export interface AdmissionInput extends CreateInput {
  readonly location: Location.Ref
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
}

// Deterministic graph
export function expandVisualBuild(input: {
  readonly maxRevisions: number
  readonly maxAttempts: number
  readonly responseID: Responses.ID
}): readonly Workflow.RoleStageInput[]

export function unreachableAfter(input: {
  readonly stages: readonly Workflow.Stage[]
  readonly stageID: Workflow.StageID
  readonly outcome: WorkflowRole.Outcome
}): readonly Workflow.StageID[]

// Provider-independent host
export interface WorkflowVisualHost.Interface {
  readonly materializeReference: (input: MaterializeReferenceInput) => Effect.Effect<PreparedPreview, Failure, Scope.Scope>
  readonly prepareImplementation: (input: PrepareImplementationInput) => Effect.Effect<PreparedPreview, Failure, Scope.Scope>
  readonly capture: (input: CaptureInput) => Effect.Effect<CapturedImage, Failure, Scope.Scope>
  readonly recoverExpired: (input: RecoverExpiredInput) => Effect.Effect<void, Failure>
}

// Atomic product admission
export interface VisualBuildAdmission {
  readonly workflow: Workflow.Info
  readonly response: Responses.Resource
}
```

---

### Task 23.1: Persist Immutable Workflow Placement and Hidden Session Identity

**Files:**

- Modify: `packages/schema/src/workflow.ts`
- Modify: `packages/schema/src/workflow-event.ts`
- Modify: `packages/core/src/workflow.ts`
- Modify: `packages/core/src/workflow/sql.ts`
- Modify: `packages/core/src/workflow/projector.ts`
- Modify: `packages/core/src/workflow/store.ts`
- Modify generated: `packages/core/src/database/migration.gen.ts`
- Modify generated: `packages/core/src/database/schema.gen.ts`
- Modify generated: `packages/core/schema.json`
- Create generated: `packages/core/src/database/migration/<generated>_workflow_placement.ts`
- Create: `packages/core/test/workflow-placement.test.ts`
- Modify test: `packages/core/test/workflow-projector.test.ts`
- Modify test: `packages/core/test/workflow-store.test.ts`

**Interfaces:**

- Consumes: canonical `Location.Ref`, `Session.ID`, `Agent.ID`, existing Workflow EventV2 projection.
- Produces: `Workflow.AdmissionInput`, optional legacy-compatible `Info.location`, `Info.sessionID`, and `Info.agent`; immutable `workflow_run.directory/workspace_id/session_id/agent` columns.

- [ ] **Step 1: Write the failing placement and immutability tests.**

```ts
test("round-trips immutable placement and hidden session identity", async () => {
  const admitted = admission({ directory: workspace, workspaceID, sessionID, agent: "build" })
  const created = await run(workflow.admit(admitted))
  expect(created).toMatchObject({ location: admitted.location, sessionID, agent: "build" })
  expect(await run(workflow.admit({ ...admitted, location: otherLocation }))).rejects.toMatchObject({
    _tag: "Workflow.ConflictError",
  })
})

test("never adopts process cwd for an active legacy workflow", async () => {
  await insertLegacyUnboundWorkflow(db)
  expect(await run(store.claimCandidates({ now: 1, limit: 10 }))).toEqual([])
})
```

- [ ] **Step 2: Run the focused tests and observe RED.**

Run from `packages/core`:

```powershell
bun test test/workflow-placement.test.ts test/workflow-projector.test.ts test/workflow-store.test.ts
```

Expected: compilation or assertion failures because admitted placement fields and SQL columns do not exist.

- [ ] **Step 3: Add the browser-safe placement and admission contracts.**

```ts
export const AdmissionInput = Schema.Struct({
  ...CreateInput.fields,
  location: Location.Ref,
  sessionID: Session.ID,
  agent: Agent.ID,
}).annotate({ identifier: "Workflow.AdmissionInput" })

export const Info = Schema.Struct({
  // existing fields
  location: Location.Ref.pipe(optional),
  sessionID: Session.ID.pipe(optional),
  agent: Agent.ID.pipe(optional),
})
```

Keep `CreateInput` free of location/session fields. Add the same optional fields to `WorkflowEvent.Created` so legacy version-1 rows still decode while every new admitted workflow supplies them.

- [ ] **Step 4: Persist and project the immutable fields.**

Add snake_case columns to `WorkflowRunTable`, map them in `runRow`, and make the `workflow.created` projector insert them exactly once. Exact-create reconciliation must compare placement, Session, and agent; mismatches return `Workflow.ConflictError`.

- [ ] **Step 5: Generate and verify the migration.**

Run from `packages/core`:

```powershell
bun run migration -- --name workflow_placement
bun run migration -- --check
```

Expected: one generated migration plus updated registry/schema snapshots; drift check exits 0.

- [ ] **Step 6: Make unbound active workflows explicit and non-runnable.**

```ts
if (!row.directory && !WorkflowState.isTerminal(row.status)) {
  return { ...runRow(row), status: "waiting_approval" as const }
}
```

The Store and scheduler must surface `workflow_location_required` through the designed recovery/configuration path and must not call `process.cwd()`.

- [ ] **Step 7: Run GREEN and regressions.**

Run from `packages/core`:

```powershell
bun test test/workflow-placement.test.ts test/workflow-projector.test.ts test/workflow-store.test.ts test/database-migration.test.ts
bun typecheck
bun run migration -- --check
```

Run from `packages/schema`:

```powershell
bun typecheck
```

- [ ] **Step 8: Commit.**

```powershell
git add packages/schema/src/workflow.ts packages/schema/src/workflow-event.ts packages/core/src/workflow.ts packages/core/src/workflow packages/core/src/database packages/core/schema.json packages/core/test
git commit -m "feat(workflow): persist production placement"
```

---

### Task 23.2: Preallocate the Visual-Build Graph and Persist Branch Skips

**Files:**

- Create: `packages/core/src/workflow/graph.ts`
- Modify: `packages/schema/src/workflow-event.ts`
- Modify: `packages/core/src/workflow/state.ts`
- Modify: `packages/core/src/workflow/projector.ts`
- Modify: `packages/core/src/workflow/stage-machine.ts`
- Modify: `packages/core/src/workflow/executor.ts`
- Modify: `packages/core/src/workflow/execution/local.ts`
- Modify test: `packages/core/test/workflow-stage-machine.test.ts`
- Modify test: `packages/core/test/workflow-projector.test.ts`
- Modify test: `packages/core/test/workflow-execution.test.ts`
- Create test: `packages/core/test/workflow-graph.test.ts`

**Interfaces:**

- Consumes: `Workflow.RoleStageInput`, `WorkflowRole.Outcome`, EventV2 related batches.
- Produces: `WorkflowGraph.expandVisualBuild`, `WorkflowGraph.unreachableAfter`, durable `workflow.stage.skipped`.

- [ ] **Step 1: Write failing graph and replay tests for 0, 1, and 2 revisions.**

```ts
expect(expand(0).map(({ type }) => type)).toEqual([
  "design",
  "decompose",
  "implement",
  "test",
  "visual_review",
  "deliver",
])
expect(expand(2).map(({ type }) => type)).toEqual([
  "design",
  "decompose",
  "implement",
  "test",
  "visual_review",
  "repair",
  "test",
  "visual_review",
  "repair",
  "test",
  "visual_review",
  "deliver",
])
```

Also prove a pass at revision 0 returns every future repair/test/review stage ID, a revise returns no skipped active branch, and replay ignores skipped stages without requiring outcome artifacts.

- [ ] **Step 2: Run RED.**

Run from `packages/core`:

```powershell
bun test test/workflow-graph.test.ts test/workflow-stage-machine.test.ts test/workflow-projector.test.ts test/workflow-execution.test.ts
```

Expected: missing graph module and `workflow.stage.skipped` event/projection failures.

- [ ] **Step 3: Implement deterministic stage expansion.**

```ts
export function expandVisualBuild(input: ExpandInput): readonly Workflow.RoleStageInput[] {
  const revisions = Array.from({ length: input.maxRevisions }, (_, index) => index + 1)
  return assignOrdinals([
    role("design", 0),
    role("decompose", 0),
    role("implement", 0),
    role("test", 0),
    role("visual_review", 0),
    ...revisions.flatMap((revision) => [
      role("repair", revision),
      role("test", revision),
      role("visual_review", revision),
    ]),
    role("deliver", input.maxRevisions),
  ])
}
```

Every stage gets a deterministic idempotency key containing workflow purpose, role, and revision. The graph is frozen before `workflow.created` is published.

- [ ] **Step 4: Add and project `Stage.Skipped`.**

```ts
export const Skipped = Event.define({
  type: "workflow.stage.skipped",
  durable,
  schema: { ...base, stageID: Workflow.StageID, sourceStageID: Workflow.StageID, outcomeSha256: Sha256 },
})
```

The projector accepts only `pending -> skipped`, sets completion timestamps, and rejects leased/running/terminal targets.

- [ ] **Step 5: Make branch skips atomic with the winning stage settlement.**

When `test` or `visual_review` passes, compute unreachable IDs from the validated, hash-bound outcome and append all `Stage.Skipped` events to the same `EventV2.publish(..., { related })` batch as stage success, artifacts, Workflow terminal event, and Response terminal event. A crash cannot expose a future repair branch between pass and skip.

- [ ] **Step 6: Harden replay authority.**

```ts
for (const stage of orderedStages) {
  if (stage.status === "skipped") continue
  // decode the exact outcome artifact owned by stage before advancing
}
```

Reject forged skip sets, active-chain skips, outcome hash mismatches, and undeclared revision transitions.

- [ ] **Step 7: Run GREEN and full Workflow state regressions.**

```powershell
bun test test/workflow-graph.test.ts test/workflow-stage-machine.test.ts test/workflow-state.test.ts test/workflow-projector.test.ts test/workflow-store.test.ts test/workflow-execution.test.ts
bun typecheck
```

- [ ] **Step 8: Commit.**

```powershell
git add packages/schema/src/workflow-event.ts packages/core/src/workflow packages/core/test/workflow-graph.test.ts packages/core/test/workflow-stage-machine.test.ts packages/core/test/workflow-state.test.ts packages/core/test/workflow-projector.test.ts packages/core/test/workflow-store.test.ts packages/core/test/workflow-execution.test.ts
git commit -m "feat(workflow): persist bounded visual graph"
```

---

### Task 23.3: Add Strict Business Artifact Contracts

**Files:**

- Create: `packages/schema/src/workflow-decomposition-artifact.ts`
- Create: `packages/schema/src/workflow-implementation-artifact.ts`
- Create: `packages/schema/src/workflow-test-artifact.ts`
- Create: `packages/schema/src/workflow-delivery-artifact.ts`
- Create: `packages/core/src/workflow/artifacts/decomposition.ts`
- Create: `packages/core/src/workflow/artifacts/implementation.ts`
- Create: `packages/core/src/workflow/artifacts/test.ts`
- Create: `packages/core/src/workflow/artifacts/delivery.ts`
- Create: `packages/core/test/workflow-business-artifacts.test.ts`
- Create test: `packages/schema/test/workflow-business-artifacts.test.ts`

**Interfaces:**

- Consumes: existing design and visual-review artifact safety patterns, `Workflow.ArtifactCommit`, `Location.Ref` workspace ownership.
- Produces: strict codecs and `commit/decode` helpers for `workflow.decomposition.plan`, `workflow.implementation-manifest`, `workflow.test.result`, and `workflow.delivery`.

- [ ] **Step 1: Write RED tests for valid round trips and hostile inputs.**

Cover traversal (`../`), absolute paths, Windows device names, case aliases, wrong workflow owner, wrong revision, tampered hash, empty acceptance criteria, prose-only manifests, oversized logs, stale preview identity, and delivery references that do not match the latest manifest/test/review.

```ts
expect(() => WorkflowImplementationArtifact.decode(commit, workflowID, location)).toThrow()
expect(valid.changes[0]).toEqual({ path: "src/app.ts", beforeSha256, afterSha256 })
```

- [ ] **Step 2: Run RED.**

Run from `packages/core`:

```powershell
bun test test/workflow-business-artifacts.test.ts
```

Expected: modules and artifact kinds are absent.

- [ ] **Step 3: Define the strict schemas.**

```ts
export const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowID: Workflow.ID,
  revision: NonNegativeInt,
  snapshotRef: Schema.NonEmptyString,
  workspaceSha256: Sha256,
  changes: Schema.NonEmptyArray(
    Schema.Struct({
      path: RelativePath,
      beforeSha256: Sha256.pipe(optional),
      afterSha256: Sha256,
    }),
  ),
})
```

The test artifact records argv arrays, workspace-relative cwd, exit code, bounded log artifact reference/hash, and preview identity. The delivery artifact references exact manifest/test/review hashes plus a bounded summary.

- [ ] **Step 4: Implement owner-bound commit/decode helpers.**

Follow `WorkflowDesignArtifact` and `WorkflowVisualReviewArtifact`: canonical JSON encoding, SHA-256 over the exact bytes, safe artifact URI, strict MIME, declared byte size, secret guard, owner/revision verification, and no unknown fields.

- [ ] **Step 5: Add cross-artifact chain validation.**

```ts
export function validateDelivery(input: {
  readonly delivery: Delivery
  readonly manifest: Implementation.Manifest
  readonly test: Test.Result
  readonly review: VisualReview.Result
}): void
```

Require the same workflow/revision and exact referenced hashes; functional and visual verdicts must both pass.

- [ ] **Step 6: Run GREEN and package checks.**

Run from `packages/schema`:

```powershell
bun test test/workflow-business-artifacts.test.ts
bun typecheck
```

Run from `packages/core`:

```powershell
bun test test/workflow-business-artifacts.test.ts test/workflow-design-loop.test.ts
bun typecheck
```

- [ ] **Step 7: Scan artifact fixtures for secret-like content and path leaks.**

```powershell
rg -n --hidden -g '!node_modules/**' -g '!*.png' '(sk-[A-Za-z0-9_-]{16,}|authorization\s*:|api[_-]?key\s*[=:])' packages/schema/test packages/core/test
```

Expected: no credential-bearing fixture.

- [ ] **Step 8: Commit.**

```powershell
git add packages/schema packages/core/src/workflow/artifacts packages/core/test/workflow-business-artifacts.test.ts packages/core/test/workflow-design-loop.test.ts
git commit -m "feat(workflow): validate production handoff artifacts"
```

---

### Task 23.4: Execute Model Tools Through the Persisted Location and Real Session

**Files:**

- Create: `packages/core/src/workflow/permissions.ts`
- Create: `packages/core/src/workflow/role-agents.ts`
- Modify: `packages/core/src/workflow/execution/model.ts`
- Modify: `packages/core/src/workflow/execution/local.ts`
- Modify: `packages/core/src/workflow/executor.ts`
- Create: `packages/core/test/workflow-location-tools.test.ts`
- Modify test: `packages/core/test/workflow-execution.test.ts`
- Modify test: `packages/core/test/workflow-model-state-machine.test.ts`

**Interfaces:**

- Consumes: persisted `Workflow.Info.location/sessionID/agent`, `LocationServiceMap.Service.get`, `ToolRegistry.Service.materialize`.
- Produces: `WorkflowPermissions.forRole(role): PermissionV2.Ruleset`, immutable hidden role-agent profiles, and one ToolRegistry materialization per provider turn.

- [ ] **Step 1: Write failing real-Location tool tests.**

Create a temporary workspace and real hidden Session. Assert design/decompose/visual-review expose no mutation tools; implement/repair expose scoped read/search/edit/write/apply-patch/bash; test exposes read/search/bash but not edit/write/apply-patch; deliver exposes only its finalization allowance. Invoke one real edit in the admitted workspace and prove an outside path is denied.

```ts
expect(names(await materialize("design"))).not.toContain("edit")
expect(names(await materialize("implement"))).toEqual(expect.arrayContaining(["read", "edit", "apply_patch", "bash"]))
```

- [ ] **Step 2: Run RED.**

```powershell
bun test test/workflow-location-tools.test.ts test/workflow-execution.test.ts test/workflow-model-state-machine.test.ts
```

Expected: executor still uses process-global `ApplicationTools` and a synthetic Session ID.

- [ ] **Step 3: Add the explicit role policy.**

```ts
const denyAll: PermissionV2.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export function forRole(role: WorkflowRole.Role): PermissionV2.Ruleset {
  return [...denyAll, ...allowedActions(role).map((action) => ({ action, resource: "*", effect: "allow" as const }))]
}
```

Order rules so the final matching rule enables only declared actions. Keep catalog filtering and leaf authorization separate and test both.

Install non-user-selectable role agents with those exact rules in every Location and expose `WorkflowRoleAgents.agentForRole(role)`. The workflow's persisted agent remains its admission/profile identity; each tool settlement supplies the stricter role-agent ID so the leaf `PermissionV2` check cannot inherit a broader user-configured build agent.

- [ ] **Step 4: Resolve the Location layer and snapshot the ToolRegistry.**

```ts
const locationLayer = LocationServiceMap.Service.get(input.workflow.location)
const materialization =
  yield *
  ToolRegistry.Service.use((registry) => registry.materialize(WorkflowPermissions.forRole(input.route.role))).pipe(
    Effect.provide(locationLayer),
    Effect.scoped,
  )
```

Capture one materialization for a provider turn. Replace direct `Tool.settle` with `materialization.settle` using the persisted Session ID, `WorkflowRoleAgents.agentForRole(input.route.role)`, deterministic assistant message ID, and call ID.

- [ ] **Step 5: Remove synthetic/global execution paths.**

Delete production dependencies on `ApplicationTools.Service`, direct `Tool.settle`, and `workflowSessionID`. Missing placement/session returns the typed recoverable failure `workflow_location_required` or `workflow_session_required` before credentials or providers are touched.

- [ ] **Step 6: Preserve pending-intent/result crash semantics.**

Keep the existing checkpoint before settlement and checkpoint after result. Prove a pending call without explicit recovery becomes `tool_execution_ambiguous`; a settled result resumes without invoking the tool again.

- [ ] **Step 7: Run GREEN and regressions.**

```powershell
bun test test/workflow-location-tools.test.ts test/workflow-execution.test.ts test/workflow-model-state-machine.test.ts test/session-runner-tool-registry.test.ts test/tool-read.test.ts test/tool-edit.test.ts test/tool-bash.test.ts
bun typecheck
```

- [ ] **Step 8: Commit.**

```powershell
git add packages/core/src/workflow/permissions.ts packages/core/src/workflow/role-agents.ts packages/core/src/workflow/execution packages/core/src/workflow/executor.ts packages/core/test/workflow-location-tools.test.ts packages/core/test/workflow-execution.test.ts packages/core/test/workflow-model-state-machine.test.ts
git commit -m "feat(workflow): bind role tools to location"
```

---

### Task 23.5: Define the Safe Workflow Visual Host Contract and Frozen Preview Plan

**Files:**

- Create: `packages/schema/src/workflow-visual-build.ts`
- Create: `packages/core/src/workflow/preview-plan.ts`
- Create: `packages/core/src/workflow/visual-host.ts`
- Create: `packages/core/test/workflow-preview-plan.test.ts`
- Create: `packages/core/test/workflow-visual-host.test.ts`

**Interfaces:**

- Consumes: decoded reference app, `Location.Ref`, strict viewports, configured host roots.
- Produces: public `VisualBuildCreateInput`, internal frozen `PreviewPlan`, `WorkflowVisualHost.Service`, fake Layer, typed `Failure` and `PreviewConfigurationRequired`.

- [ ] **Step 1: Write failing contract/security tests.**

Cover static entrypoint plans, recognized Vite/Next scripts, explicit user configuration, unknown project approval, frozen hashes, env allowlists, path traversal, Windows device names, aliases, remote/file/userinfo URLs, outside-root cleanup, per-image cap, and aggregate cap.

```ts
expect(() => PreviewPlan.freeze({ command: modelOutput.command })).toThrow("model-authored")
expect(validateHandle("file:///D:/workspace/index.html")).toBe(false)
```

- [ ] **Step 2: Run RED.**

```powershell
bun test test/workflow-preview-plan.test.ts test/workflow-visual-host.test.ts
```

Expected: contract and service modules are absent.

- [ ] **Step 3: Define the public admission payload without placement authority.**

```ts
export const CreateInput = Schema.Struct({
  prompt: Schema.NonEmptyString,
  budget: Workflow.Budget,
  visual: VisualLimits,
  preview: TrustedPreviewInput.pipe(optional),
  delivery: Schema.Literals(["foreground", "background"]),
})
```

The schema has no `directory`, `workspaceID`, URL, provider, or model fields.

- [ ] **Step 4: Implement preview-plan freezing.**

```ts
export interface PreviewPlan {
  readonly kind: "static" | "script"
  readonly entrypoint?: string
  readonly argv?: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly allowedOrigins: readonly string[]
  readonly configSha256: string
}
```

Resolve cwd beneath Location, use argv arrays rather than shell strings, include relevant package/config hashes, and return `preview_configuration_required` instead of guessing unknown projects.

- [ ] **Step 5: Define `WorkflowVisualHost` as a scoped Effect service.**

`PreparedPreview` contains an opaque host ID, loopback capability URL, origin, revision, config hash, and lifecycle scope. It never exposes a general URL execution method. `CapturedImage` contains bytes, exact viewport, SHA-256, and evidence byte count.

- [ ] **Step 6: Add deterministic fake and containment helpers.**

The fake drives Core role and crash tests without Playwright. Containment resolves canonical absolute paths, compares case-insensitively on Windows, and refuses any target outside configured host roots.

- [ ] **Step 7: Run GREEN and checks.**

Run from `packages/schema`:

```powershell
bun typecheck
```

Run from `packages/core`:

```powershell
bun test test/workflow-preview-plan.test.ts test/workflow-visual-host.test.ts test/workflow-design-loop.test.ts
bun typecheck
```

- [ ] **Step 8: Commit.**

```powershell
git add packages/schema/src/workflow-visual-build.ts packages/core/src/workflow/preview-plan.ts packages/core/src/workflow/visual-host.ts packages/core/test/workflow-preview-plan.test.ts packages/core/test/workflow-visual-host.test.ts packages/core/test/workflow-design-loop.test.ts
git commit -m "feat(workflow): define secure visual host"
```

---

### Task 23.6: Implement the Loopback Preview and Managed Playwright Runtime

**Files:**

- Modify: `package.json`
- Modify: `packages/server/package.json`
- Modify generated lock: `bun.lock`
- Create: `packages/server/src/workflow/visual-host.ts`
- Create: `packages/server/src/workflow/playwright.ts`
- Modify: `packages/server/src/routes.ts`
- Create: `packages/server/test/workflow-visual-host.test.ts`
- Create: `packages/server/test/fixtures/workflow-visual/reference/index.html`
- Create: `packages/server/test/fixtures/workflow-visual/implementation/index.html`

**Interfaces:**

- Consumes: `WorkflowVisualHost.Service`, frozen `PreviewPlan`, `PLAYWRIGHT_BROWSERS_PATH`, configured host roots.
- Produces: `WorkflowVisualHostServer.layer` injected in `createRoutes/createEmbeddedRoutes`; managed preview/process/browser lifecycle.

- [ ] **Step 1: Write failing runtime tests against offline fixtures.**

Tests must prove reference source materialization, a random loopback port/capability, exact viewport PNG, ready-selector and fonts wait, external request abortion, download rejection, empty permissions, no service-worker persistence, process teardown, and cleanup limited to the host temp root.

```ts
expect(new URL(preview.url).hostname).toBe("127.0.0.1")
expect(captured.width).toBe(1440)
expect(externalRequests).toEqual([])
```

- [ ] **Step 2: Run RED.**

Run from `packages/server`:

```powershell
bun test test/workflow-visual-host.test.ts
```

Expected: runtime layer and production Playwright dependency do not exist.

- [ ] **Step 3: Give the Server runtime explicit Playwright ownership.**

Add `playwright: 1.59.1` to the root catalog and `"playwright": "catalog:"` to `packages/server` dependencies; run `bun install` from the repository root only for dependency resolution, not tests.

- [ ] **Step 4: Implement reference and implementation preview lifecycles.**

Decode/revalidate the reference app, write declared files only into a fresh capability directory, and serve on `127.0.0.1`. For script plans spawn the frozen argv/cwd/env, bound stdout/stderr, retain the process-tree handle, wait for the loopback origin, and register a scope finalizer for success/failure/cancellation/lease loss.

- [ ] **Step 5: Implement locked-down Chromium capture.**

```ts
const context = await browser.newContext({
  viewport,
  colorScheme: "light",
  reducedMotion: "reduce",
  acceptDownloads: false,
  serviceWorkers: "block",
})
await context.route("**/*", (route) => (allowed(route.request().url()) ? route.continue() : route.abort()))
```

Use a fresh context per capture; grant no permissions; wait for selector, `document.fonts.ready`, and two stable animation frames; capture PNG; validate dimensions/CRC; enforce 8 MiB and 128 MiB limits.

- [ ] **Step 6: Implement scoped cleanup and startup recovery.**

Kill only tracked process trees. Remove only a resolved descendant of the configured host root after evidence is durable. Startup recovery removes expired capability directories only when no active durable lease owns them.

- [ ] **Step 7: Inject the production layer and run GREEN.**

```ts
const serviceLayer = AppNodeBuilder.build(applicationServices, [
  [WorkflowVisualHost.node, WorkflowVisualHostServer.node],
  [WorkflowExecution.node, WorkflowExecutionLocal.node],
])
```

Run from `packages/server`:

```powershell
bun test test/workflow-visual-host.test.ts
bun typecheck
```

Run from `packages/core`:

```powershell
bun test test/workflow-visual-host.test.ts
bun typecheck
```

- [ ] **Step 8: Commit.**

```powershell
git add package.json packages/server/package.json bun.lock packages/server/src/workflow packages/server/src/routes.ts packages/server/test/workflow-visual-host.test.ts packages/server/test/fixtures/workflow-visual
git commit -m "feat(server): host isolated visual previews"
```

---

### Task 23.7: Orchestrate Strict Role Outputs, Workspace Snapshots, and Kimi Media Review

**Files:**

- Create: `packages/core/src/workflow/execution/contract.ts`
- Create: `packages/core/src/workflow/execution/role.ts`
- Modify: `packages/core/src/workflow/execution/model.ts`
- Modify: `packages/core/src/workflow/executor.ts`
- Modify: `packages/core/src/workflow/execution/local.ts`
- Modify: `packages/core/src/workflow/render.ts`
- Modify test: `packages/core/test/workflow-design-loop.test.ts`
- Modify test: `packages/core/test/workflow-model-state-machine.test.ts`
- Create test: `packages/core/test/workflow-role-execution.test.ts`

**Interfaces:**

- Consumes: strict artifact codecs, Location tools, `WorkflowVisualHost`, existing `WorkflowVisualReviewArtifact.reviewMessage`, snapshot service.
- Produces: `WorkflowRoleExecution.Service`; role-specific strict response schemas/messages; hash-bound required artifact set per successful stage.

- [ ] **Step 1: Write failing role-contract tests.**

Prove design produces spec/reference app, decompose produces plan/checklist, implement/repair produce snapshot-backed manifests, test produces functional result/preview identity, visual review receives paired `media` content and produces strict review, and deliver refuses stale/failing evidence. Prove generic textual prompts never include screenshot base64.

```ts
const media = reviewMessage.content.filter((part) => part.type === "media")
expect(media).toHaveLength(viewports.length * 2)
expect(stagePrompt).not.toContain("iVBOR")
```

- [ ] **Step 2: Run RED.**

```powershell
bun test test/workflow-role-execution.test.ts test/workflow-design-loop.test.ts test/workflow-model-state-machine.test.ts
```

Expected: production executor still asks every role only for `WorkflowRole.Outcome` and never calls the visual host.

- [ ] **Step 3: Define strict role execution contracts.**

```ts
export interface Contract<A> {
  readonly system: string
  readonly messages: readonly Message[]
  readonly output: Schema.Schema<A>
  readonly tools: PermissionV2.Ruleset
}
```

Create one contract builder per role. Its output envelope includes `outcome` and the role's structured payload; implementation/test manifests are host/tool-derived rather than trusted from prose.

- [ ] **Step 4: Add snapshot and manifest boundaries.**

Before the first mutation, capture a Location-scoped snapshot and persist its reference in the stage checkpoint. After implement/repair, compare the admitted workspace against that snapshot and commit the strict change manifest. Cancellation/final failure exposes the existing rollback path without deleting the workspace.

- [ ] **Step 5: Connect visual preparation and canonical paired media.**

Materialize the durable reference app once; prepare the frozen implementation preview per revision; capture every declared viewport; commit screenshot artifacts; call `WorkflowVisualReviewArtifact.reviewMessage(spec, images)` for Kimi K3. Decode the returned strict review and bind its SHA-256 to the role outcome used by the graph.

- [ ] **Step 6: Require business artifacts before a stage can succeed.**

```ts
const required = WorkflowRoleExecution.requiredKinds(role)
if (required.some((kind) => !result.artifacts.some((artifact) => artifact.kind === kind))) {
  return yield * invalidOutcome(`Missing required ${role} artifact`)
}
```

Atomic settlement remains in `WorkflowExecutionLocal`: artifacts, outcome, branch skips, final Workflow event, and linked Response terminal event commit as one related batch.

- [ ] **Step 7: Keep `WorkflowRender` as a deterministic harness only.**

Remove permissive production URL assumptions from shared validation, retain its focused unit-test utility, and ensure no production module imports it as the runtime host.

- [ ] **Step 8: Run GREEN and commit.**

```powershell
bun test test/workflow-role-execution.test.ts test/workflow-design-loop.test.ts test/workflow-model-state-machine.test.ts test/workflow-execution.test.ts test/workflow-business-artifacts.test.ts
bun typecheck
git add packages/core/src/workflow packages/core/test/workflow-role-execution.test.ts packages/core/test/workflow-design-loop.test.ts packages/core/test/workflow-model-state-machine.test.ts packages/core/test/workflow-execution.test.ts packages/core/test/workflow-business-artifacts.test.ts
git commit -m "feat(workflow): execute production visual roles"
```

---

### Task 23.8: Atomically Admit the Hidden Session, Workflow, and Stored Response

**Files:**

- Create: `packages/core/src/session/admission.ts`
- Create: `packages/core/src/responses/admission.ts`
- Create: `packages/core/src/workflow/admission.ts`
- Modify: `packages/core/src/session.ts`
- Modify: `packages/core/src/responses.ts`
- Modify: `packages/core/src/workflow.ts`
- Modify: `packages/core/src/workflow/execution/local.ts`
- Create: `packages/core/test/workflow-admission.test.ts`
- Modify test: `packages/core/test/session-create.test.ts`
- Modify test: `packages/core/test/responses-projector.test.ts`

**Interfaces:**

- Consumes: Location, graph expansion, Session/Workflow/Response event builders and projectors.
- Produces: `WorkflowAdmission.admitVisualBuild(input, location)` returning exactly one reconciled Workflow/Response pair.

- [ ] **Step 1: Write failing atomicity and idempotency tests.**

Inject failure independently into Session, Workflow, and Response projectors and assert no row/event from the three aggregates survives. Submit the same request hash twice and assert identical Session/Workflow/Response IDs, one graph, and no provider wake duplication. Submit the same idempotency key with a different Location/prompt/limits and assert conflict.

```ts
expect(await rows(db, SessionTable, WorkflowRunTable, ResponseTable)).toEqual([0, 0, 0])
expect(retried).toEqual(first)
```

- [ ] **Step 2: Run RED.**

```powershell
bun test test/workflow-admission.test.ts test/session-create.test.ts test/responses-projector.test.ts
```

Expected: existing services publish three independent transactions and can orphan resources.

- [ ] **Step 3: Extract reusable event builders without duplicating projectors.**

`SessionAdmission.prepare`, `ResponsesAdmission.prepare`, and the Workflow builder return canonical `{ definition, data }` entries plus projected DTOs. Existing `SessionV2.create` and `ResponsesV2.create` call the same builders so there is one schema/normalization path.

- [ ] **Step 4: Publish the full admission as one EventV2 batch.**

```ts
yield *
  events.publish(WorkflowEvent.Created, workflowCreated, {
    location,
    related: [sessionCreated, responseCreated, ...stages.map(stageQueued)],
  })
```

Use deterministic IDs derived at admission, a canonical request hash, and `store: true`. Only after the batch commits may `WorkflowExecution.wake` run.

- [ ] **Step 5: Reconcile exact retries and reject conflicting retries.**

On a projection race, load the request-hash winner and compare prompt, Location, budget, visual limits, preview-plan hash, graph, Response model binding, Session, and delivery mode. Return the winner only for an exact match.

- [ ] **Step 6: Enforce hidden Session Location and durable Response rules.**

The hidden Session uses the exact `Location.Ref`, selected workflow agent/profile, and is not returned as a public user Session. Visual builds always create one stored Response; a non-stored or cross-workflow binding fails before event publication.

- [ ] **Step 7: Run GREEN and regressions.**

```powershell
bun test test/workflow-admission.test.ts test/session-create.test.ts test/responses-projector.test.ts test/workflow-service.test.ts test/workflow-projector.test.ts test/workflow-execution.test.ts
bun typecheck
```

- [ ] **Step 8: Commit.**

```powershell
git add packages/core/src/session packages/core/src/session.ts packages/core/src/responses packages/core/src/responses.ts packages/core/src/workflow packages/core/src/workflow.ts packages/core/test/workflow-admission.test.ts packages/core/test/session-create.test.ts packages/core/test/responses-projector.test.ts packages/core/test/workflow-service.test.ts packages/core/test/workflow-projector.test.ts packages/core/test/workflow-execution.test.ts
git commit -m "feat(workflow): atomically admit visual builds"
```

---

### Task 23.9: Expose Visual-Build Admission Through Protocol, Server, and Generated Clients

**Files:**

- Modify: `packages/protocol/src/groups/workflow.ts`
- Modify: `packages/server/src/handlers/workflow.ts`
- Modify: `packages/server/src/routes.ts`
- Modify test: `packages/protocol/test/workflow.test.ts`
- Create test: `packages/sdk-next/test/workflow-visual-build.test.ts`
- Modify generated: `packages/client/src/generated/types.ts`
- Modify generated: `packages/client/src/generated/client.ts`
- Modify generated: `packages/client/src/generated-effect/client.ts`
- Modify generated: `packages/client/src/generated/index.ts`
- Modify generated: `packages/client/src/generated-effect/index.ts`

**Interfaces:**

- Consumes: `WorkflowVisualBuild.CreateInput`, `WorkflowAdmission.Service`, Location middleware.
- Produces: `POST /api/workflow/visual-build`, Promise Client and Effect Client operations returning Workflow + Response.

- [ ] **Step 1: Write failing Protocol and embedded SDK tests.**

Assert the operation ID is `workflow.visualBuildCreate`, request schema rejects directory/workspace/URL/model fields, handler derives two different test Locations correctly, background returns admitted resources, foreground follows terminal state, and exact idempotent retries return the same pair.

- [ ] **Step 2: Run RED.**

Run from `packages/protocol`:

```powershell
bun test test/workflow.test.ts
```

Run from `packages/sdk-next`:

```powershell
bun test test/workflow-visual-build.test.ts
```

Expected: endpoint/client method absent.

- [ ] **Step 3: Add the HttpApi endpoint.**

```ts
HttpApiEndpoint.post("workflow.visualBuildCreate", "/api/workflow/visual-build", {
  payload: WorkflowVisualBuild.CreateInput,
  success: Schema.Struct({ data: WorkflowVisualBuild.Admission }),
  error: [InvalidRequestError, WorkflowConflictError],
})
```

- [ ] **Step 4: Derive Location in the handler.**

Yield `Location.Service`, pass its canonical `directory/workspaceID` to `WorkflowAdmission`, map typed errors, and never accept placement from the payload. HTTP code never calls a provider directly.

- [ ] **Step 5: Regenerate clients twice and prove deterministic output.**

Run from `packages/client`:

```powershell
bun run generate
$diffPath = 'D:\OpenCode-Local\tmp\task23-client-first.diff'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $diffPath) | Out-Null
git diff -- src/generated src/generated-effect | Out-File -Encoding utf8 $diffPath
bun run generate
bun run check:generated
bun test
bun typecheck
Remove-Item -LiteralPath $diffPath -Force
```

Delete the temporary diff after comparing it only for deterministic generation; do not commit it.

- [ ] **Step 6: Run API/SDK GREEN and typechecks.**

```powershell
Set-Location ..\protocol
bun test test/workflow.test.ts
bun typecheck
Set-Location ..\sdk-next
bun test test/workflow-visual-build.test.ts test/responses-embedded.test.ts
bun typecheck
Set-Location ..\server
bun typecheck
```

- [ ] **Step 7: Verify OpenAPI and authorization coverage.**

Run from `packages/opencode`:

```powershell
bun test test/server/httpapi-public-openapi.test.ts test/server/httpapi-authorization.test.ts test/server/httpapi-sdk.test.ts
```

- [ ] **Step 8: Commit.**

```powershell
git add packages/protocol packages/server packages/client/src/generated packages/client/src/generated-effect packages/sdk-next/test/workflow-visual-build.test.ts packages/opencode/test/server
git commit -m "feat(server): expose visual build admission"
```

---

### Task 23.10: Add `opencode workflow run`

**Files:**

- Create: `packages/opencode/src/cli/cmd/workflow.ts`
- Modify: `packages/opencode/src/index.ts`
- Create: `packages/opencode/test/cli/workflow.test.ts`
- Modify: `packages/opencode/test/cli/help/help-snapshots.test.ts`
- Modify: `packages/opencode/test/cli/help/__snapshots__/help-snapshots.test.ts.snap`

**Interfaces:**

- Consumes: generated `workflow.visualBuildCreate`, workflow SSE/history/artifact/get, Response get.
- Produces: `opencode workflow run <prompt>` with current-directory Location, event progress, cancellation, terminal Response and artifact summary.

- [ ] **Step 1: Write failing CLI process tests.**

Test `workflow --help`, missing prompt, default current directory, background admission, event ordering, visible role/revision/test/visual/budget states, Ctrl-C durable cancellation, successful terminal summary, and non-zero exits for failed/cancelled workflows.

```ts
expect(result.stdout).toContain("Kimi design r0")
expect(result.stdout).toContain("DeepSeek repair r1")
expect(result.exitCode).toBe(0)
```

- [ ] **Step 2: Run RED.**

Run from `packages/opencode`:

```powershell
bun test test/cli/workflow.test.ts test/cli/help/help-snapshots.test.ts
```

Expected: command is not registered.

- [ ] **Step 3: Implement a dedicated yargs command.**

```ts
export const WorkflowCommand = effectCmd({
  command: "workflow <command>",
  builder: (yargs) => yargs.command(WorkflowRunCommand).demandCommand(),
  handler: async () => {},
})
```

`WorkflowRunCommand` calls admission once, follows durable SSE with exclusive cursors/reconnect, renders compact stage state, and fetches final Response/artifacts after a terminal Workflow event. Do not reuse the interactive Session `run.ts` loop.

- [ ] **Step 4: Preserve Location and cancellation semantics.**

Use the existing SDK directory/header mechanism to bind `process.cwd()`. On Ctrl-C call durable Workflow cancel, return promptly, and let asynchronous host teardown fence late results.

- [ ] **Step 5: Add JSON output for automation.**

`--format json` prints one final object with `workflow`, `response`, and artifact summaries while progress goes to stderr or is suppressed. Human output never prints artifact base64 or secrets.

- [ ] **Step 6: Update help snapshots and run GREEN.**

```powershell
bun test test/cli/workflow.test.ts test/cli/help/help-snapshots.test.ts
bun typecheck
```

- [ ] **Step 7: Run existing CLI regression smoke.**

```powershell
bun test test/cli/run/run-process.test.ts test/cli/serve/serve-process.test.ts test/cli/smokes/read-only.test.ts
```

- [ ] **Step 8: Commit.**

```powershell
git add packages/opencode/src/cli/cmd/workflow.ts packages/opencode/src/index.ts packages/opencode/test/cli/workflow.test.ts packages/opencode/test/cli/help
git commit -m "feat(opencode): run production workflows"
```

---

### Task 23.11: Prove Full Offline Repair, Crash Recovery, Replay, Cancellation, and Security

**Files:**

- Create: `packages/sdk-next/test/workflow-production-e2e.test.ts`
- Create: `packages/sdk-next/test/workflow-production-crash-worker.ts`
- Create: `packages/sdk-next/test/fixtures/workflow-production/recording.json`
- Modify: `packages/core/test/workflow-crash-worker.ts`
- Modify: `packages/core/test/workflow-crash.test.ts`
- Modify: `packages/core/test/workflow-recovery.test.ts`
- Modify: `packages/core/test/workflow-cancel.test.ts`
- Create: `packages/server/test/workflow-visual-security.test.ts`

**Interfaces:**

- Consumes: full visual-build API, deterministic provider fixtures, fake/real local host layers, EventV2 replay.
- Produces: acceptance evidence for the complete Task23 scenario and each required crash boundary.

- [ ] **Step 1: Write the complete recorded scenario and assert RED.**

The fixture executes exactly:

```text
Kimi design
→ Kimi decompose
→ DeepSeek Pro implement
→ DeepSeek Flash failed functional test
→ DeepSeek Pro repair
→ DeepSeek Flash passing functional test
→ Kimi failed visual review
→ DeepSeek Pro repair
→ DeepSeek Flash passing functional test
→ Kimi passing visual review
→ DeepSeek Pro delivery
```

Assert the fixed route matrix, revision sequence, required artifacts, skipped unused branches, final stored Response, and zero network access.

- [ ] **Step 2: Add process crash cases before production changes.**

Kill workers after admission, provider output, pending tool intent, settled tool result, preview startup, PNG capture, and before the atomic terminal commit. Each restart must either continue exactly once or enter `waiting_approval / tool_execution_ambiguous`; no tool, build, capture, artifact, or terminal Response may duplicate.

- [ ] **Step 3: Run the new tests and observe RED.**

Run from `packages/sdk-next`:

```powershell
bun test test/workflow-production-e2e.test.ts
```

Run from `packages/core`:

```powershell
bun test test/workflow-crash.test.ts test/workflow-recovery.test.ts test/workflow-cancel.test.ts
```

- [ ] **Step 4: Close only failures exposed by the acceptance tests.**

Keep fixes in the owning module. Preserve pending-intent ambiguity; fence late provider/host results by lease/attempt; ensure preview processes and browser contexts close on cancellation and lease loss; ensure complete EventV2 batches replay atomically.

- [ ] **Step 5: Add adversarial host and secret scans.**

Test remote/file URLs, traversal/device/case aliases, external browser requests, downloads, permissions, storage/service workers, oversized PNGs, aggregate evidence overflow, command mutation after admission, and cleanup targets pointing at the workspace. Scan events, Responses, artifacts, bounded logs, and fixtures for credentials.

- [ ] **Step 6: Run GREEN across the acceptance matrix.**

```powershell
Set-Location D:\OpenCode-Audit\packages\sdk-next
bun test test/workflow-production-e2e.test.ts test/workflow-visual-build.test.ts test/responses-conformance.test.ts
bun typecheck
Set-Location ..\core
bun test test/workflow-crash.test.ts test/workflow-recovery.test.ts test/workflow-cancel.test.ts test/workflow-execution.test.ts
bun typecheck
Set-Location ..\server
bun test test/workflow-visual-host.test.ts test/workflow-visual-security.test.ts
bun typecheck
```

- [ ] **Step 7: Verify no paid endpoint was contacted.**

Fixtures bind only loopback transports. Search test output and fixtures for `api.deepseek.com` or `api.moonshot.cn`; references may exist as expected request metadata, but network interception must show zero outbound connections.

- [ ] **Step 8: Commit.**

```powershell
git add packages/sdk-next/test/workflow-production-e2e.test.ts packages/sdk-next/test/workflow-production-crash-worker.ts packages/sdk-next/test/fixtures/workflow-production packages/core/test/workflow-crash-worker.ts packages/core/test/workflow-crash.test.ts packages/core/test/workflow-recovery.test.ts packages/core/test/workflow-cancel.test.ts packages/server/test/workflow-visual-security.test.ts packages/core/src packages/server/src
git commit -m "test(workflow): prove production visual recovery"
```

---

### Task 23.12: Run Release Gates, Push, Build, and Atomically Update the D-Drive Deployment

**Files:**

- Create: `scripts/deploy-local.ps1`
- Create: `scripts/test-local-deploy.ps1`
- Modify deployed: `D:\OpenCode-Local\bin\opencode.cmd`
- Replace deployed: `D:\OpenCode-Local\bin\opencode-local.exe`
- Create/replace deployed: `D:\OpenCode-Local\bin\opencode-local.bak.exe`
- Modify deployed: `D:\OpenCode-Local\BUILD-INFO.txt`
- Install runtime: `D:\OpenCode-Local\runtime\playwright`

**Interfaces:**

- Consumes: verified `dev`, Windows x64 single-file build, D-scoped launcher roots.
- Produces: reproducible deployment scripts, pushed `fork/dev`, updated launcher/binary, managed Chromium, rollback SHA.

- [ ] **Step 1: Write failing deployment-script tests before the scripts.**

`test-local-deploy.ps1` creates a task-specific temporary deployment root on D and verifies same-volume staging, hash/version checks, launcher env roots, backup retention, refusal of a C-drive host root, refusal of a target outside the deployment root, and rollback restoration.

- [ ] **Step 2: Run RED.**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\OpenCode-Audit\scripts\test-local-deploy.ps1
```

Expected: deployment script is absent.

- [ ] **Step 3: Implement safe, parameterized deployment tooling.**

```powershell
param(
  [Parameter(Mandatory=$true)][string]$SourceRoot,
  [Parameter(Mandatory=$true)][string]$DeploymentRoot,
  [Parameter(Mandatory=$true)][string]$Version
)
```

Resolve both roots; require the explicit source and deployment paths; stage `.new.exe` on D; verify version/hash; stop only a process whose executable path exactly equals the deployed target; use `[IO.File]::Replace` when the target exists; retain `.bak.exe` and SHA; never enumerate or remove the workspace.

- [ ] **Step 4: Run every offline release gate.**

Run affected package suites and typechecks from `packages/schema`, `packages/llm`, `packages/core`, `packages/protocol`, `packages/server`, `packages/client`, `packages/sdk-next`, and `packages/opencode`. Then run:

```powershell
Set-Location D:\OpenCode-Audit\packages\core
bun run migration -- --check
Set-Location ..\client
bun run generate
bun run check:generated
Set-Location D:\OpenCode-Audit
bunx prettier --check docs packages scripts
git diff --check
git status --short
```

Run the credential scan excluding ignored `.env.local`, build outputs, `.git`, and `node_modules`; no key or authorization header may appear in tracked files.

- [ ] **Step 5: Request final code review and fix all findings.**

Review against the frozen Task23 spec and this plan. Re-run the focused suite for every fix, then re-run the complete offline gate. Do not claim completion while any unexplained failure remains.

- [ ] **Step 6: Commit deployment tooling and push `dev`.**

```powershell
git add scripts/deploy-local.ps1 scripts/test-local-deploy.ps1 docs/superpowers
git commit -m "chore(opencode): automate local visual deployment"
git push fork dev:dev
```

Record the pushed commit range and GitHub URLs. Confirm `git status --short --branch` reports local `dev` aligned with `fork/dev`.

- [ ] **Step 7: Build and install Chromium on D.**

```powershell
$env:OPENCODE_VERSION = "0.0.0-dev-$(Get-Date -Format yyyyMMddHHmm)"
Set-Location D:\OpenCode-Audit\packages\opencode
bun run script/build.ts --single --skip-install
$env:PLAYWRIGHT_BROWSERS_PATH = 'D:\OpenCode-Local\runtime\playwright'
bunx playwright@1.59.1 install chromium
```

Update the launcher with:

```text
OPENCODE_WORKFLOW_HOST_DATA=D:\OpenCode-Local\data\workflow-host
OPENCODE_WORKFLOW_HOST_RUNTIME=D:\OpenCode-Local\runtime\playwright
OPENCODE_WORKFLOW_HOST_CACHE=D:\OpenCode-Local\cache\playwright
OPENCODE_WORKFLOW_HOST_TEMP=D:\OpenCode-Local\tmp\workflow-host
PLAYWRIGHT_BROWSERS_PATH=D:\OpenCode-Local\runtime\playwright
```

- [ ] **Step 8: Stage, atomically deploy, smoke, and retain rollback.**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\OpenCode-Audit\scripts\deploy-local.ps1 `
  -SourceRoot D:\OpenCode-Audit `
  -DeploymentRoot D:\OpenCode-Local `
  -Version $env:OPENCODE_VERSION
& D:\OpenCode-Local\bin\opencode.cmd --version
& D:\OpenCode-Local\bin\opencode.cmd workflow --help
```

Run the offline recorded visual-build smoke through the launcher, verify database/host/cache/temp/browser writes occur only under `D:\OpenCode-Local`, verify the previous executable and SHA remain recoverable, and remove only Task23-created staging files after validation.

---

## Final Definition of Done

- One CLI/API call admits the exact Location-bound Workflow + hidden Session + stored Response without orphan resources.
- The full recorded functional-repair and visual-repair scenario succeeds using only the fixed Kimi K3 / DeepSeek V4 Pro / DeepSeek V4 Flash route matrix.
- Coding and testing tools execute only through the persisted Location ToolRegistry and real Session permissions.
- Kimi receives strict design output and canonical paired PNG media; DeepSeek textual stages never receive embedded screenshot base64.
- Pass branches durably skip all unreachable preallocated stages in the same atomic settlement batch.
- Crash, cancellation, approval, replay, and ambiguous side-effect tests meet the frozen failure policy.
- The real browser host is loopback-only, outbound-deny by default, bounded, scoped, and unable to clean the user workspace.
- All standard validation is offline and zero-spend.
- `dev` is pushed to `fork/dev` with no credentials or `.env` files.
- The rebuilt launcher works from `D:\OpenCode-Local`, all Task23-owned roots are D-scoped, and the previous binary remains a verified rollback point.
- Task24 remains separate benchmarking work and is not included in Task23 completion.
