# OpenCode Production Visual Workflow Host Design

**Date:** 2026-08-21
**Status:** Approved in chat; written specification pending user review
**Task:** Task23
**Depends on:** Tasks 2–22, especially the durable Workflow/Responses runtime, Task19 visual artifacts, Task20 conformance runtime, and Task22 model routing

## Purpose

Task23 turns the deployed engineering preview into a usable local production workflow for:

1. Kimi K3 design and decomposition;
2. DeepSeek V4 Pro implementation and repair;
3. DeepSeek V4 Flash testing;
4. Kimi K3 paired-image visual review;
5. DeepSeek V4 Pro final delivery.

The implementation preserves the existing durable Workflow, Responses, EventV2, routing, retry, cancellation, checkpoint, and replay foundations. It adds the missing production host boundary: durable workspace placement, real Location-scoped tools, trusted preview preparation, isolated browser capture, a bounded visual-repair graph, and a one-command product entry point.

## Goals

- Execute every workflow stage in the exact local workspace admitted by the server.
- Give coding roles real Location-scoped read, edit, patch, shell, and test tools without exposing them to design/review roles.
- Materialize Kimi's validated reference application in a trusted host directory.
- Build or serve the implementation from a trusted, admission-time-frozen preview plan.
- Capture deterministic paired reference/implementation PNG evidence for every configured viewport.
- Persist strict design, implementation, test, visual-review, and delivery artifacts.
- Survive process crashes between stages without repeating settled model turns or settled tool results.
- Keep Task23-owned data, browser binaries, caches, and temporary files on `D:\OpenCode-Local` in the local deployment.
- Expose the complete flow through a generated API/SDK surface and `opencode workflow run`.
- Rebuild, atomically update, verify, and retain a rollback point for the local D-drive deployment.

## Non-goals

- Replacing the Workflow runtime with SessionRunner.
- Replacing the existing `/v1/responses` interface.
- Adding a fallback model or downgrading any role from Kimi K3, DeepSeek V4 Pro, or DeepSeek V4 Flash.
- Rebuilding the full interactive TUI around workflows. Task23 provides a CLI command and API/SDK surface.
- Claiming VM, container, or kernel-level isolation for project build scripts.
- Running paid provider smoke tests without a separate, explicit token ceiling approval.
- Task24 benchmarking against upstream OpenCode or public evaluation suites.

## Chosen architecture

Task23 uses a **Location-bound independent production host**. It does not wire `WorkflowRender` directly to process-global tools, and it does not collapse Workflow execution into SessionRunner.

The workflow owns immutable placement. The server derives placement from the resolved request Location, persists it once, and restores Location services for every background attempt. A workflow also owns a dedicated hidden Session used for permissions, tool output ownership, and approval lineage.

```text
Visual-build admission
  ├─ durable Workflow + bounded stage graph
  ├─ durable Location.Ref + hidden Session
  └─ durable linked Response
          │
          ▼
WorkflowExecutionLocal
  ├─ LocationServiceMap.get(workflow.location)
  ├─ ToolRegistry.materialize(workflow permission profile)
  ├─ WorkflowVisualHost preview/capture operations
  └─ existing model routing, checkpoints, related EventV2 settlement
```

## Durable placement and execution identity

### Placement

`Workflow.Info`, `WorkflowEvent.Created`, the workflow projection, and workflow SQL gain an immutable placement containing:

- an absolute directory;
- an optional workspace ID.

The public `VisualBuildCreateInput` and generic workflow request schemas do not accept a directory or workspace ID. The Location-aware server handler obtains the resolved request Location and constructs an internal `Workflow.AdmissionInput` containing the immutable placement and hidden Session ID. Core creation accepts only that internal admission type. Responses inherit placement through their workflow relationship; placement is not duplicated on every Response or child event.

Existing legacy terminal workflows may remain unbound. A nonterminal legacy workflow without placement must not silently adopt `process.cwd()`; it enters an explicit recovery/configuration state.

### Hidden Session

Visual-build admission creates or binds a dedicated hidden Session with the same Location. The workflow persists the Session ID and selected workflow agent/profile. This replaces the current synthetic workflow Session ID and gives permission checks, tool outputs, and approval events a real owner.

The admission transaction must not leave an orphan workflow, Session, or Response. Creation either commits the complete relationship or commits none of it.

### Tool materialization

Each execution attempt obtains the persisted Location through `LocationServiceMap`, then snapshots `ToolRegistry.materialize(...)` for the provider turn. The production model executor stops building definitions directly from `ApplicationTools` and stops calling `Tool.settle` directly.

Role permissions are explicit:

| Role            | Workspace mutation tools                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `design`        | none                                                                                             |
| `decompose`     | none                                                                                             |
| `implement`     | scoped read/search/edit/write/apply-patch/bash                                                   |
| `test`          | scoped read/search/bash; mutation denied unless a test tool requires a declared output directory |
| `visual_review` | none                                                                                             |
| `repair`        | scoped read/search/edit/write/apply-patch/bash                                                   |
| `deliver`       | scoped read/search/bash; mutation limited to explicitly required finalization                    |

The permission profile remains auditable and can request approval. It does not silently inherit unrestricted host authority.

Background visual-build workflows require durable stored Responses. A non-stored Response remains supported by the generic Responses runtime but is not eligible as the durable product workflow's delivery Response.

## Bounded stage graph

Visual-build admission expands `maxRevisions` into a deterministic, bounded graph before execution:

```text
design r0
  → decompose r0
  → implement r0
  → test r0
      ├─ revise → repair r1 → test r1 → visual_review r1 ─┐
      └─ pass   → visual_review r0                        │
                       ├─ pass → skip unused branches → deliver
                       └─ revise ──────────────────────────┘
```

Additional repair/test/visual-review triplets are predeclared up to the configured revision ceiling. The graph is not extended ad hoc after a crash.

A new durable `workflow.stage.skipped` event marks every branch made unreachable by a validated pass outcome. Replay ignores skipped role stages when reconstructing the role state machine but retains their audit trail.

The only branch authority is a schema-validated, hash-bound stage artifact. Natural-language output, a preview URL, or an in-memory callback cannot advance the graph.

## Role responsibilities and durable artifacts

Every stage commits the standard role outcome plus its required business artifacts. The final stage event, artifacts, linked Response settlement, and Workflow terminal event remain one EventV2 related batch whenever the stage ends the workflow.

### Design — Kimi K3

The design result uses strict structured output and produces:

- `workflow.design.spec`;
- `workflow.design.reference-app` with self-contained browser-runnable HTML/CSS/JavaScript sources;
- `workflow.role.outcome`.

The existing Task19 source topology, hashing, UTF-8, secret, URI, and workflow-owner checks remain mandatory. The reference application may not return a preview URL or build command.

### Decompose — Kimi K3

The decomposition result produces a strict implementation plan and acceptance checklist artifact plus the role outcome. It consumes the design artifacts but has no workspace mutation tools.

### Implement and repair — DeepSeek V4 Pro

These roles receive the decoded design specification, applicable review findings, acceptance checklist, and Location-scoped tools. They produce:

- an implementation manifest with revision, changed paths, before/after hashes, and snapshot reference;
- bounded tool-continuation artifacts/checkpoints;
- the role outcome.

Task23 introduces a strict implementation-manifest codec. Later stages never infer changed files from prose.

Before the first mutation, the host captures a recoverable workspace snapshot through the existing Location-scoped snapshot service. Successful delivery keeps the changes. Cancellation, final failure, or explicit rejection offers or applies the defined rollback path without deleting the user workspace.

### Test — DeepSeek V4 Flash

The test stage executes the frozen test/build plan through Location-scoped tools and produces a structured test artifact containing commands, exit results, bounded logs, and the prepared implementation preview identity. A functional failure routes to repair. An unsafe or missing host configuration routes to approval rather than guessing a command.

### Visual review — Kimi K3

The host captures one reference and one implementation PNG for every declared viewport. Kimi receives the existing canonical paired-media `reviewMessage`, not base64 data copied into a generic textual stage prompt.

The stage commits:

- reference and implementation screenshot artifacts;
- the strict visual-review artifact with score and findings;
- the pass/revise role outcome.

A passing review skips unused future revision branches. A failing review routes its structured findings to the next repair stage. The max-revision or budget boundary routes to approval.

### Deliver — DeepSeek V4 Pro

Delivery requires the latest functional test to pass, the latest visual review to pass, and the current implementation manifest to match the workspace. It produces the final summary, test evidence, visual evidence references, change manifest, role outcome, and linked Response completion.

## Tool checkpoint and crash semantics

The existing pending-intent/result continuation protocol remains authoritative:

1. persist the tool-call intent before a local side effect;
2. execute the Location-scoped tool;
3. persist the result before the next provider turn.

If a process dies after a side effect but before its result is durable, recovery enters `waiting_approval` with an ambiguous-tool failure. It does not automatically execute the call again. Completed turns and tool results resume without repetition.

Stage terminal events, business artifacts, Workflow terminal events, and Response terminal events use EventV2 atomic related batches and complete-batch replay metadata. No host callback is allowed to create an unjournaled lifecycle transition.

## Workflow visual host

`WorkflowVisualHost` is a narrow injected service with production and deterministic test layers. It owns:

- reference source materialization;
- implementation preview planning and process lifecycle;
- loopback preview serving;
- browser capture;
- scoped cleanup and orphan recovery.

Core retains provider-independent contracts and fake layers. The real browser/process implementation belongs in the runtime composition layer, not Schema and not the provider adapters.

### D-drive roots

The deployed launcher sets:

| Purpose                   | Path                                   |
| ------------------------- | -------------------------------------- |
| host durable/runtime data | `D:\OpenCode-Local\data\workflow-host` |
| managed Chromium          | `D:\OpenCode-Local\runtime\playwright` |
| Playwright cache          | `D:\OpenCode-Local\cache\playwright`   |
| preview temporary data    | `D:\OpenCode-Local\tmp\workflow-host`  |

The implementation uses environment/configured roots rather than hard-coding D-drive paths in reusable Core code. The deployed configuration makes all Task23-owned paths D-scoped. Operating-system DLLs, page files, or pre-existing system components are outside this guarantee.

### Reference preview

The host decodes and revalidates the committed reference app, creates a fresh capability directory, resolves every output path, verifies containment under that directory, and writes only the declared files. It serves those files from an ephemeral `127.0.0.1` port under an unguessable workflow capability path.

Models cannot supply preview URLs. Production rejects remote origins and `file:` URLs.

### Implementation preview plan

Admission normalizes and persists one trusted preview plan. The plan supports:

- static entrypoint hosting;
- recognized common project scripts such as Vite or Next preview/development scripts;
- an explicit user-owned project preview configuration.

The effective command, working directory, environment allowlist, local-origin allowlist, and relevant configuration hashes are frozen at admission. Model edits cannot change the active host command. Unknown project types enter `waiting_approval` with `preview_configuration_required`.

Running a project build executes project code. Task23 applies permissions, frozen commands, bounded output, process-tree control, and browser-network restrictions, but does not claim OS-level sandboxing.

### Browser capture

Production uses a managed Playwright Chromium installed under the D-drive runtime root. Each capture uses a fresh isolated browser context and:

- exact viewport dimensions;
- deterministic color scheme and reduced motion;
- a wait for the configured ready selector, document fonts, and page stability;
- disabled downloads, persistent credentials, service workers, and browser permissions;
- default-deny outbound requests, allowing only the current loopback preview origin and admission-frozen local origins;
- PNG output followed by existing strict PNG, dimension, hash, owner, and URI checks.

The production cap is 8 MiB per PNG and 128 MiB of screenshot evidence per workflow. Exceeding either cap becomes an explicit visual-host failure or approval state. Screenshot bytes remain self-contained in the D-drive SQLite artifact history so complete EventV2 replay remains possible.

### Lifecycle and cleanup

Preview servers, build processes, browser contexts, and capability directories are scoped resources. Success, failure, cancellation, and lease loss close the complete process tree. A temporary directory is removed only after the corresponding evidence is durable.

Cleanup resolves and verifies every target beneath the configured host root. It never recursively deletes or moves the Location workspace. Startup orphan recovery removes only expired host-owned resources with no active durable lease.

## Product surface

Task23 adds a single visual-build admission operation to Protocol, Server, generated clients, and sdk-next. Its request contains:

- the user prompt;
- workflow budget;
- visual limits;
- optional trusted preview configuration;
- foreground/background delivery choice where supported.

The server derives Location, creates the hidden Session, expands the graph, creates the stored linked Response, and wakes execution as one reconciled admission operation. Request-hash/idempotency reconciliation must return the existing workflow/response pair without duplicate stages or provider execution.

The local CLI exposes:

```text
opencode workflow run "Build and implement this web experience"
```

It defaults to the current directory, follows durable workflow events, displays role/revision/test/visual/budget state, and returns the final Response plus artifact summary. Existing OpenCode commands and direct `/v1/responses` calls remain unchanged.

## Failure policy

| Condition                            | Result                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| transient provider or host failure   | bounded retry/backoff                                                                         |
| missing/invalid credential           | recoverable configuration failure without secret exposure                                     |
| functional build/test failure        | route to repair while revisions remain                                                        |
| visual review failure                | route structured findings to repair                                                           |
| unsafe/unknown preview configuration | `waiting_approval / preview_configuration_required`                                           |
| ambiguous tool side effect           | `waiting_approval / tool_execution_ambiguous`                                                 |
| token/turn/tool/revision limit       | `waiting_approval` with the exact exhausted limit                                             |
| user cancellation                    | durable cancel admission, immediate caller return, asynchronous teardown, late-result fencing |
| final success/failure/cancel         | atomic Workflow, stage, active Response, and artifact settlement                              |

Budget updates and recovery resolutions use the existing durable APIs. Increasing an approved budget resumes from the durable checkpoint rather than restarting the workflow.

## Test strategy

Task23 follows test-driven development. Provider behavior is exercised with deterministic and recorded fixtures; no paid request is sent by the standard suite.

### Schema and Core

- Location/session persistence and immutable placement.
- Visual-build graph expansion for zero, one, and multiple revisions.
- `Stage.Skipped` projection, replay, and branch selection.
- Implementation-manifest validation and workspace-owner binding.
- Atomic stage/artifact/Workflow/Response settlement and rollback on projector failure.
- Budget, approval, retry, cancellation, checkpoint, and complete-batch replay.

### Location tools and host

- Real LocationServiceMap and ToolRegistry materialization against a temporary workspace.
- Role-specific mutation permissions.
- Path traversal, Windows device names, directory aliases, and containment checks.
- Static and recognized project preview planning.
- Frozen preview configuration and model-authored command/URL rejection.
- Process teardown on success, failure, cancellation, and lease loss.

### Browser and security

- Real local Chromium capture against offline fixtures.
- Exact viewports, selector/font waits, deterministic settings, and PNG validation.
- Remote URL, `file:` URL, external request, download, permission, and credential rejection.
- Per-image and per-workflow evidence caps.
- Secret scans across events, responses, artifacts, logs, process output, and generated fixtures.

### End-to-end and process recovery

One offline recorded scenario must execute:

```text
Kimi design
→ DeepSeek implementation
→ failed functional test
→ DeepSeek repair
→ Kimi failed visual review
→ DeepSeek repair
→ Kimi passing visual review
→ DeepSeek delivery
```

Process-level cases crash after admission, model output, pending tool intent, settled tool result, preview startup, PNG capture, and atomic terminal commit. Restart must either resume exactly once or enter the designed approval state.

### Build gates

- affected package tests and typechecks;
- database migration generation and drift checks;
- Protocol/Client generation twice with identical output;
- formatting, lint, `git diff --check`, and credential scans;
- Windows build and local launcher smoke tests.

A paid Kimi/DeepSeek production smoke test is a separate gate. Before sending it, the operator must see and approve the exact requests, models, maximum output tokens, and worst-case spend ceiling.

## Deployment and rollback

After the offline acceptance and final review are clean:

1. commit Task23 changes on `dev` with conventional subjects;
2. push `dev` to `fork/dev` and report the GitHub commit links;
3. build a versioned Windows x64 single-file binary;
4. install the managed Chromium under `D:\OpenCode-Local\runtime\playwright`;
5. update the launcher with D-drive host and Playwright environment roots;
6. verify the staged binary and launcher;
7. atomically replace `D:\OpenCode-Local\bin\opencode-local.exe` on the same volume;
8. retain the previous binary and SHA-256 as the rollback point;
9. verify `opencode --version`, `opencode workflow --help`, an offline visual-build scenario, and D-drive data/cache/temp placement.

The launcher remains the supported entry point. Running the binary directly is not considered a valid D-drive placement test because it bypasses the launcher's environment redirection.

## Acceptance criteria

Task23 is complete only when all of the following are true:

- A single CLI/API call admits the complete location-bound workflow and linked Response.
- The exact Task22 route matrix is observed, with no fallback or model downgrade.
- DeepSeek edits and tests only the persisted Location workspace using Location-scoped tools.
- Kimi receives strict design output and canonical paired image media for visual review.
- At least one offline scenario demonstrates both a functional repair and a visual repair before successful delivery.
- Crash, cancellation, approval, and replay tests prove the specified durable behavior.
- Host URLs are loopback capabilities, external browser requests are denied by default, and cleanup cannot target the user workspace.
- Task23-owned browser/runtime/cache/temp data in the deployed product is D-scoped.
- The updated executable starts through the launcher and the previous executable remains recoverable.
- `dev` is pushed to `fork/dev`, with no API keys, `.env` files, credentials, or raw authorization data in Git.

After Task23, Task24 remains as a separate evaluation task. It measures whether the modified workflow outperforms upstream OpenCode and direct single-model baselines; it is not a missing production-host feature.
