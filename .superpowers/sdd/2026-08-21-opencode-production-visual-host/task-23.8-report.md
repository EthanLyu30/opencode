# Task 23.8 implementation report

## Result

Task 23.8 is implemented on local `dev` from base `9664184bb5f1af8bdad4d9ecc95b1ffffb5aea7e`.

Implementation commits:

- `a59982774ea0951b171d4bb246da2f3cc9fdfad2` (`feat(workflow): atomically admit visual builds`)
- `fb7e5b589` (`fix(workflow): tighten admission quality gates`)

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
- Changed-TypeScript oxlint: **0 errors**; 37 warnings remain in pre-existing portions of touched legacy/projector/test files after Task23.8-owned warnings were removed (down from 52 on the first exact changed-file pass).
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

## Independent review fix round 1

The two Critical and first three Important review findings are closed by implementation commit `03b55d9d6` (`fix(workflow): close hidden admission boundaries`). Ruling 8 adjudicates the reviewer's immediate-push/single-commit request as incompatible with the user's final-push instruction and the SDD audit split, so this round remains local and unsquashed.

### Closed findings

- Public event visibility now classifies the complete related EventV2 batch. Primary and related live notifications, including replay notifications, carry the same complete ownership context. A hidden Session suppresses every Session, Workflow, Stage, and Response member, including the stored admission receipt, Location, and deterministic identifiers.
- The opencode EventV2 bridge uses the shared ownership classifier before both legacy GlobalBus and sync emission. `/sync/history` obtains the complete durable batch even when the caller's fence leaves only part of it as a response candidate; missing/empty fences no longer bypass filtering. Missing, incomplete, or contradictory workflow/response ownership fails closed.
- Session deletion events carry immutable visibility. Public and legacy-public deletion tombstones remain deliverable after the Session projector removes the row, while workflow-hidden tombstones remain suppressed, in accordance with ruling 7.
- Public `MoveSession` now resolves the known Session through `SessionStore.getPublic` before destination resolution or Git capture/apply/discard. A known workflow Session returns the same public not-found error as an absent ID.
- `SessionAdmission.prepare` derives its slug deterministically from the deterministic Session ID. Identical prepare inputs now produce byte-identical creation entries across retry and rollback.
- A receipt over the 256 KiB durable bound now returns the declared `WorkflowAdmission.InvalidAdmission` typed error with a fixed message no longer than 128 characters. The exact-limit case is admitted; the over-limit case echoes no prompt/secret content and leaves all Session, Workflow, Stage, Response, event, and sequence counts unchanged.

### TDD evidence

Meaningful RED was observed before the production fixes:

- Related `workflow.created` and `response.created` events from a hidden Session batch were visible; incomplete ownership was allowed; public deletion was suppressed after row removal.
- The legacy opencode bridge emitted the hidden Response receipt, and unfiltered sync history returned the hidden batch when the fence map was empty.
- A known hidden Session reached the public move path, identical Session prepare calls produced different slugs/event bytes, and an oversized admission receipt failed outside the declared WorkflowAdmission error channel.

The final fresh package-directory gates used pinned Bun `D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe` and task-owned `D:\OpenCode-Task23.8-Fix1` temp/cache roots:

- Core Task23.8 plus EventV2/MoveSession matrix: **166 pass, 0 fail, 484 assertions**.
- Server visibility/sandbox matrix: **87 pass, 0 fail, 297 assertions**.
- Legacy opencode list/live/history matrix with the package-declared 30-second timeout: **26 pass, 0 fail, 65 assertions**.
- Migration and generic Response regressions: **31 pass, 0 fail, 119 assertions**.
- Schema, Core, Protocol, Server, and Client typechecks: **exit 0**.
- Generated migration consistency: incremental check reported no schema changes; full schema regeneration comparison succeeded.
- Exact changed-file Prettier check and `git diff --check`: **exit 0**.
- Changed-TypeScript oxlint: **0 errors**; 51 warnings are confined to pre-existing portions of five touched legacy/EventV2 files. Newly added files and Task23.8 fix lines are warning-free.

The first combined legacy opencode test invocation used Bun's 5-second default and timed out in the existing slow `session-list` fixture. The same exact test file passed **12/12** with the package-declared 30-second timeout, and the final combined matrix passed **26/26**. This was a harness-timeout diagnosis, not a behavior regression.

`packages/opencode` typecheck continues to report exactly the two adjudicated pre-existing errors: the `InvalidReplayBatchError` HTTP union at `handlers/sync.ts:70` and its cascading route-layer error at `server.ts:276`. No Task23.8 visibility compile error remains.

No migration change was required in this fix round. The exact task-owned non-reparse root `D:\OpenCode-Task23.8-Fix1` was verified and moved to the Windows Recycle Bin after final verification. No Task23.9 endpoint, Task23.10 CLI, provider/network/browser/Docker/ACL action, deployment, push, or `env.local` access was added or performed.
