# Task 23.8 implementation report

## Result

Task 23.8 is implemented on local `dev` from base `9664184bb5f1af8bdad4d9ecc95b1ffffb5aea7e`.

Implementation commit: `a59982774ea0951b171d4bb246da2f3cc9fdfad2` (`feat(workflow): atomically admit visual builds`)

The implementation adds `WorkflowAdmission.admitVisualBuild(input, location, idempotencyKey?)`. A winning admission commits one `Workflow.Created` primary event plus related hidden `Session.Created`, stored `Response.Created`, and initial `Stage.Queued` events in one EventV2 transaction. Project creation is projected from the related Session event in the same transaction. No Session, Project, Workflow, Response, Stage, event, or sequence row is written before that batch.

## Admission and idempotency authority

- The strict `WorkflowVisualBuild.CreateInput` remains separate from the optional standard idempotency header value. Payload idempotency fields are rejected by the strict schema.
- Supplied keys must be 1–256 characters, NFC-normalized, and free of control characters. When absent, the key is derived from the complete canonical request plus trusted `Location.Ref`.
- A versioned claim digest is the unique stored Response `requestHash`; deterministic Session, Workflow, Response, and Stage IDs derive from that claim.
- A strict versioned Response context receipt (maximum 256 KiB) binds the canonical request, Location, frozen preview and production-host plan hashes, expanded graph, exact Task23.7 route matrix, selected agent, hidden visibility, Response model/store/background/delivery attributes, and every deterministic ID.
- Retry/race reconciliation reloads the request-hash winner, receipt, Workflow/stages, and workflow-only Session and returns it only when the immutable authority matches structurally. Changed prompt, Location, budget, visual limits, delivery, graph, route, model binding, or hidden Session authority conflicts.
- The creating winner calls `WorkflowExecution.wake` only after EventV2 publish returns. Exact retries do not wake. A post-commit wake crash leaves the durable queued graph intact, and the existing periodic execution poll recovers it.

## Hidden Session boundary and migration

- Session visibility is durable and versioned as `public | workflow`; generic/legacy creation explicitly remains public.
- Generated migration `20260829061350_session_visibility` adds a non-null `visibility` column with default `public`, preserving existing rows.
- Core public Session get/list/message/context/history/events/shell/skill/active/resume/interrupt and mutation entry paths treat workflow Sessions as absent. Workflow internals use the narrow `SessionStore.getWorkflow` authority.
- Current Server location middleware, handlers, and global SSE filter workflow Sessions. Both durable and non-durable Session-associated events are filtered.
- The legacy opencode Session get/list/global-list/children/update/delete/share handler boundary and GlobalBus/sync event bridge also hide workflow Sessions, including when the ID is known.
- `Workflow.Info.sessionID` remains the internal relationship and does not grant public Session access.

## TDD and verification evidence

Meaningful RED was observed before production changes:

- Initial admission test failed because `@opencode-ai/core/responses/admission` did not exist.
- Hidden Session shell/skill returned operation-unavailable instead of not-found.
- Global event filtering helper was absent.
- An internally inconsistent visual admission receipt was accepted.
- Legacy public get/list/children returned workflow Sessions.
- Legacy GlobalBus emitted hidden Session events.
- Non-durable Session-associated global events were initially treated as public.

Final fresh gates, using pinned Bun `D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe` from package directories with task-owned D-drive temp/cache roots:

- Core mandatory Task23.8 matrix (`workflow-admission`, `session-create`, `responses-projector`, `workflow-service`, `workflow-projector`, `workflow-execution`): **99 pass, 0 fail, 313 assertions**.
- Server visibility/sandbox matrix (`session-handler`, `workflow-command-sandbox`): **84 pass, 0 fail, 292 assertions**.
- Legacy opencode visibility/event matrix (`session-list`, `session`): **20 pass, 0 fail, 57 assertions**.
- Migration and generic Response regressions (`database-migration`, `responses-store`): **31 pass, 0 fail, 119 assertions**.
- Schema, Core, Protocol, Server, and Client package typechecks: **exit 0**.
- Generated migration consistency: incremental check reported no schema changes; full regeneration succeeded.
- `git diff --check`: clean before the implementation commit.

One broader Core run executed concurrently with other packages observed the pre-existing timing-sensitive workflow-deadline assertion at zero remaining milliseconds. The exact test passed immediately in isolation, and the complete Core Task23.8 matrix then passed 97/97 and finally 99/99 in fresh sequential runs.

`packages/opencode` typecheck still reports two pre-existing errors in untouched files: `handlers/sync.ts` exposes `InvalidReplayBatchError` outside the HTTP error union, followed by the cascading `server.ts` route-layer requirement error. The Task23.8 visibility compile fallout was fixed; these unrelated baseline errors were not broadened into this task. The changed opencode behavior is covered by the 20/20 runtime regression matrix.

## Reversible implementation rulings

1. The Location-selected public base agent from `AgentV2.select` is persisted as the hidden Session/workflow profile. Task23.7 role agents remain the per-stage execution authority. If product policy later requires a dedicated admission profile selector, the receipt/profile field can change without changing the public request.
2. When the optional workflow budget `maxAttempts` is absent, visual graph expansion uses `1`, matching the graph authority's minimum-attempt semantics. A later schema-level default can replace this without changing stored explicit graphs.

## Scope and safety

- No Task23.9 REST/SSE admission endpoint and no Task23.10 CLI command was added.
- No provider, browser, network, Docker, ACL, deployment, or `env.local` operation ran; no provider credits were spent.
- The user-required no-subagent constraint prevented the normally mandatory reviewer-subagent pass. A full self-review was performed against the brief, controller rulings, and review constraints instead.
- The exact task-owned non-reparse temp/cache root `D:\OpenCode-Task23.8` was verified and moved to the Windows Recycle Bin after final verification. No repository or user input was removed.
- No push or deployment was performed.
