# OpenCode Coding Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user selected implementation in the current session; use one fresh read-only review at the end, not an implementer/reviewer per task.

**Goal:** Add a real Location-bound `coding-build` workflow without requiring a page, preview or screenshot, preserving the existing visual workflow and reliable execution algorithms.

**Architecture:** Add separate coding request, role, artifact, graph and evidence contracts. A closed internal build-profile dispatcher lets coding roles reuse the existing provider-turn/tool/checkpoint engine and fenced scheduler without reinterpreting historical visual contracts. Trusted frozen Bun checks and independent code-review receipts gate delivery; the ordinary authenticated REST/CLI surfaces admit the new type.

**Tech Stack:** Existing Bun 1.3.14, TypeScript, Effect 4, Effect Schema, Responses/Workflow persistence, Location services and command sandbox; no new provider, dependency, database migration or background-queue implementation.

**Spec:** `docs/superpowers/specs/2026-10-16-opencode-coding-workflow-design.md` — written-spec approval received 2026-10-16. This implementation plan awaits review.

## Global Constraints

- Work directly in `D:\OpenCode-Audit` on `dev`. Preserve user changes and Tasks2–9; commit and push each verified checkpoint to `fork/dev`, never force-push or create an unnecessary worktree.
- Do not change lease, retry, budget, event-storage or cancellation algorithms. New profile dispatch and settlement validation must still pass through those mechanisms.
- Keep the old `WorkflowRole.Role`, seven-role selection snapshots, visual artifact schemas and their fingerprints unchanged. New coding formats must have distinct domain-qualified identifiers and cannot add required fields to old data.
- Only `coding-build` selects the new profile. Existing visual and generic legacy executions retain their current paths. A client cannot install a profile or submit frozen admission/host-plan authority.
- Kimi handles design/decompose/code review; DeepSeek Pro implementation/repair/delivery and Flash test. Use existing confirmed family selections and reviewed wire adapters, no Kimi2.x, no model/protocol fallback or silent activation. Each admitted task keeps its frozen choices.
- All tests use recorded/fake providers and isolated D-drive state. Never read real `.env.local`, request real `/models`, or send a paid provider request. Child Bun invocations must also disable dotenv loading.
- All task-created caches, output, checkouts and intermediates stay on D. Preserve every previously policy-blocked cleanup target and all uncertain/user-owned files.
- `coding-build` never creates a preview/browser/screenshot. Visual primary benchmark tasks still use `visual-build` and the original 75/65 visual thresholds.
- Use Schema → Core/Protocol → Server dependency direction; Client never imports Core/Server at runtime. Regenerate clients with `bun run generate` from `packages/client`, never edit generated output.
- Build only with the approved safe new `--outdir`, never default build into old `dist`. Exact-binary validation uses the new isolated output; do not replace the current deployment or historical seal in this plan.

## Review Focus

1. A coding `code_review` must not invalidate old seven-role snapshots or change visual contract fingerprints. Task2 pins both persisted formats and exact visual fingerprints.
2. Normal generic create and injected serialized fields must not obtain coding tools or manufacture settled evidence. Tasks3–5 reject missing/forged coding admission and enforce the final settlement gate.
3. A model `pass`, stale snapshot, empty test suite or configuration drift must not mask failed checks. Tasks1/3/4 bind actual check execution, source identity and configuration identity.
4. Restart/cancellation between a tool side effect and settlement must not automatically redispatch an unknown operation. Task6 exercises the unchanged conservative recovery path and zero replay of settled turns.
5. A passing code review cannot advance over a failed test, exhausted revision budget or unresolved blocker. Tasks3/6 exercise branch combinations and ensure no delivery artifact is committed.

## File and Interface Map

| Responsibility                         | Files                                                                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coding wire/artifact contracts         | `packages/schema/src/workflow-coding-build.ts`, `workflow-coding-artifact.ts`                                                                                                            |
| Frozen nonvisual checks                | `packages/core/src/workflow/coding/host-plan.ts`, `packages/server/src/workflow/coding-checks.ts`                                                                                        |
| Coding route, snapshot and permissions | `packages/core/src/workflow/coding/{model-selection,routing,role-agents,permissions}.ts`                                                                                                 |
| Business contract and graph            | `packages/core/src/workflow/coding/{contract,graph,stage-machine,evidence,artifacts}.ts`                                                                                                 |
| Closed shared-engine adapters          | `packages/core/src/workflow/execution/{build-routing,build-contract,build-role-agents,build-evidence}.ts`                                                                                |
| Coding admission                       | `packages/core/src/workflow/coding/admission.ts`                                                                                                                                         |
| Existing integration boundaries        | Core `workflow/{executor,tool-lineage,command-sandbox,model-availability}.ts`, `execution/{model,provider-request,local}.ts`, reserved-agent installation and Server service composition |
| Public surfaces                        | Protocol `groups/workflow.ts`, Server `handlers/workflow.ts`, CLI `cli/cmd/workflow.ts`, generated Client/SDK surfaces                                                                   |
| Offline acceptance                     | New focused Core/Server/CLI tests; coding scenario in the existing narrowly gated private exact-executable fixture                                                                       |

The dispatcher has a closed `Kind = "visual-build" | "coding-build"` and role union of the unchanged visual role plus `WorkflowCodingBuild.Role`. Coding modules never call visual graph replay, visual receipt validators or visual host-plan decoding. Shared adapters route by persisted workflow type; their legacy branch delegates to existing functions with the exact original inputs and output bytes.

## Task 1: Coding Contracts and Frozen Check Plan

**Files:** Create the two Schema files, Core `coding/host-plan.ts`, `packages/schema/test/workflow-coding-build.test.ts`, and `packages/core/test/workflow-coding-host-plan.test.ts`.

**Interfaces:**

- `WorkflowCodingBuild.Role`: `design/decompose/implement/test/code_review/repair/deliver`; separate from the old role schema.
- `WorkflowCodingBuild.Limits`: `maxRevisions` integer 0–10, plus positive `maxTokens/maxTurns/maxToolCalls`. CLI defaults are exactly `{maxRevisions:1,maxTokens:12000,maxTurns:12,maxToolCalls:24}`; these remain sublimits inside the overall budget, never an additional allowance.
- `WorkflowCodingBuild.Checks`: `{ cwd, test, build?, typecheck? }`; `cwd` is `"."` or a validated Location-relative directory; `test` is `"bun-test" | "bun-run-test"`, optional build/typecheck values are exactly `"bun-run-build"`/`"bun-run-typecheck"`.
- `WorkflowCodingBuild.CreateInput`: `{ prompt, budget, coding, checks, delivery }`, exact unknown-field rejection. `Admission`: `{ workflow, response }` using existing canonical resources.
- `WorkflowCodingArtifact.Plan`, `.Review`, `.Delivery`: exact serializable schemas with workflow/revision identity; Plan has objective/constraints/interfaces/files/risks/acceptance/check-plan reference; Review has implementation/test fingerprints, verdict and findings (`id`, Location-relative path, severity, blocking, summary); Delivery has implementation/test/code-review fingerprints and bounded summary, no visual-review field.
- `CodingHostPlan.freeze({ authority:"admission", location, checks }): Plan`, `.decode(input, location): Plan`, `.verifyCurrentConfiguration(plan): void`. Plan kind is `workflow.coding-host-plan.v1`, includes Location hash, typed command argv, canonical cwd and configuration hashes, never preview authority.

- [x] **Step 1:** Write RED tests for valid no-page inputs; max revisions 0 and 10 versus -1/11; exact optional-key encoding; unknown/provider/internal fields; no visual fields in coding delivery. Freeze a real D fixture with `package.json`/Bun configuration; reject missing selected scripts, escape paths/reparse points, forged plan hashes, and post-freeze script/config mutations. The test names identify these breaks explicitly.
- [x] **Step 2:** From Schema/Core package directories run the two new files; expect failures for absent contracts/functions, not test-fixture or import errors left unresolved.
- [x] **Step 3:** Implement the schemas and plan freeze/verification. Translate only the four approved command kinds to literal argv; freeze existing relevant local package/config files and preserve absence as part of configuration identity. No shell strings or arbitrary executables.
- [x] **Step 4:** Rerun both files and package typechecks; expect all pass. Add current-contract/identifier tests through the existing Schema test convention.
- [x] **Step 5:** Commit `feat(workflow): define coding contracts and check plans` after verification.

Task1 evidence (2026-10-16): initial missing-module RED; Schema21pass/1fail exposed missing filtered-schema AST identifiers, corrected to22pass33assert; host6pass31assert. Complete Schema59pass176assert/10files and Core1733pass7skip0fail5481assert/184files (338.61s); both package typechecks exit0. Raw fixture comparisons use the existing `unknown` boundary convention for branded decoded types; initial fixture matcher typing errors were corrected without weakening runtime assertions. Pinned Bun JUnit reporter independently produced22 tests/33 assertions/0 failures/0 skipped. No real provider request or credential read occurred.

Task1 policy clarification: normalize supported `bun-run-test` scripts to direct `bun --no-env-file test <validated args>`; reject shell syntax, pre/post hooks and unsupported flags rather than silently omit them. Every check Bun argv disables dotenv; selected build/typecheck scripts remain frozen and Task4 must protect their child Bun invocations. Cost if wrong: complex existing scripts require a reviewed adapter. The Task3 check-service interface belongs in Core `coding/checks.ts`, with a fail-closed default, before Task4 provides its real Server layer; this preserves dependency direction. Cost if wrong: adjust the service boundary, never enable a host fallback.

## Task 2: Pinned Coding Routes and Shared Provider-Engine Boundary

**Files:** Create Core coding `model-selection.ts`, `routing.ts`, `permissions.ts`, `role-agents.ts`; execution `build-routing.ts`, `build-contract.ts`, `build-role-agents.ts`; coding `contract.ts`; tests `workflow-coding-model-selection.test.ts`, `workflow-coding-contract.test.ts`. Modify shared engine consumers listed below, not the old visual schemas.

**Interfaces:**

- `CodingModelSelection.freeze(selection: WorkflowModelCatalog.AdmissionSnapshot, location: Location.Ref): FrozenSelection`, `.fromWorkflow(workflow): FrozenSelection`, `.validate(input): FrozenSelection`; kind/key `workflow.coding-model-selection.v1`. The input is the existing confirmed three-family selection captured at admission. Preserve source snapshot identity; copy existing role routes into the coding format and derive `code_review` from the confirmed Kimi `design` route (same max effort and text capabilities), never from `visual_review`. Validate the new role's capabilities and hash the new coding contract separately. This does not widen existing family activation eligibility.
- `CodingRouting.resolve({ role, budget, selection, benchmarkTransport? }): Route`; Route has existing route facts (`providerID/modelID/protocol/reasoningEffort/requiredCapabilities/budget/model`) and coding role. Kimi efforts max/high/max, Pro max/max/high, Flash high as in the spec; review has no vision requirement.
- `CodingContract.build(input): Contract`, `.decode(contract,input): RoleResult`, `.decodeJson(contract,text): RoleResult`, `.verifyAuthority(input): void`; strict kind `workflow.coding-role-contract.v1`, with route, permissions, dependencies, prompt/schema and context fingerprints. Only typed outcome/payload drives transitions; summaries cannot replace authority.
- `BuildRouting.Route` and `BuildContract.Contract/RoleResult/Authority` are closed visual-or-coding unions. `BuildRouting.resolve(input)` and `BuildContract.build/decode/decodeJson/verifyAuthority` preserve legacy delegation. `BuildRoleAgents.agentForRole(workflow,role)`/`.reassert(workflow,role)` dispatch to the appropriate protected profiles.
- Coding profiles use reserved IDs `workflow-coding-role-<role>`. Design/decompose/review/test/deliver are read-only; implement/repair use the same bounded edit policy as their existing counterparts. Configuration cannot widen or remove these profiles.

- [x] **Step 1:** Write RED tests for all seven role routes, rejected Kimi2/protocol overrides/unverified adapters, pinned model identity across active-family changes, coding review without vision, reserved-agent tampering and mismatched workflow/profile authority. Retain literal old visual snapshot/contract fingerprint fixtures and show they still decode unchanged.
- [x] **Step 2:** Run new files plus existing role-contract, routing, model-selection and role-agent tests; expect the new tests to fail for missing coding behavior.
- [x] **Step 3:** Implement coding modules and closed adapters. Update `execution/model.ts`, `execution/provider-request.ts`, `tool-lineage.ts` and `model-availability.ts` only where role/contract selection enters the existing loop. Pass new typed unions through provider-call fingerprinting, tool policy, credential resolution and availability checks. Keep one explicit LLM stream per turn and all existing continuation accounting/unknown-turn rules. Do not clone a second provider loop or add a caller-supplied adapter.
- [x] **Step 4:** Run new and affected old files and Core/LLM typechecks; expect zero failures. Show old visual authority bytes unchanged, coding and visual context never interchangeable, and `code_review` cannot request Bash/edit.
- [x] **Step 5:** Commit `feat(workflow): pin coding role execution profiles` after verification. The public admission remains absent until Task5.

Task2 evidence (2026-10-16): final focused coding/legacy/security suite95pass496assert/7files; full Core1748pass7skip0fail5568assert/186files (200.08s); full Schema59pass176assert and Schema/Core/LLM typechecks exit0. RED cases reproduced a public internal-agent bypass, legacy role decoding in the actual provider engine, unstable authority after an approved budget increase, nonliteral provider output roles, and duplicate finding IDs before correction. Legacy snapshot/contract literal hashes remain unchanged. Coding review uses the confirmed Kimi text/design route without vision; coding agents are hidden/reserved and immutable. The shared provider loop remains single, and generic coding execution is explicitly closed pending trusted coding receipts/settlement in Tasks3–4. No actual provider or credential was used.

## Task 3: Coding Graph, Artifact Lineage and Settlement

**Files:** Create Core coding `graph.ts`, `stage-machine.ts`, `artifacts.ts`, `evidence.ts`; execution `build-evidence.ts`; tests `workflow-coding-graph.test.ts`, `workflow-coding-evidence.test.ts`. Modify `workflow/executor.ts` and the final profile-specific validation portion of `execution/local.ts`.

**Interfaces:**

- `CodingGraph.expand({maxRevisions,maxAttempts,responseID}): readonly Workflow.StageInput[]` emits design0, decompose0, implement0, test0, code_review0, then repair/test/code_review for each declared revision, finally deliver. There are6/9/36 declared stages for0/1/10 revisions. Keys use `coding-build/<role>/r<N>`. Coding admission freezes per-stage maxAttempts3; it does not interpret the aggregate workflow attempt ceiling as a per-stage retry count.
- `CodingStageMachine.replay({stages,artifacts,beforeOrdinal?}): State` and `.unreachableAfter({stages,stageID,outcome}): readonly Workflow.StageID[]` handle only coding outcomes. Failed test skips that revision's code review and proceeds to a declared repair; passing review skips all unused later repairs/tests/reviews. Exhaustion cannot reach a successful delivery.
- `CodingEvidence.prepare(input): Effect<Preparation,EvidenceFailure>` and `.resolve(input): Effect<ResolverOutput,EvidenceFailure>` use the existing preparation/resolver structural boundary, with coding contracts. Only the host commits trusted check evidence.
- `CodingEvidence.validateSettlement(input): void` binds admission, current lease attempt, semantic contract, Location, revision, dependencies and artifact set. `BuildEvidence` dispatches prepare/resolve/settlement by workflow kind; the old visual validators remain intact.

- [x] **Step 1:** Write RED tests for no-repair success, real-test failure then repair, review-driven repair, zero/max revision exhaustion, conflicting duplicate outcomes, dependency cycles/unknown task IDs, cross-Location/revision artifacts, forged test outcomes, unresolved blocking findings and delivery without final passing checks. Use literal expected role sequences and independent artifact hashes.
- [x] **Step 2:** Run both new files; expect missing coding replay/evidence failures.
- [x] **Step 3:** Implement typed coding artifact construction and graph replay, not an editable graph service. Route coding settlement through the same Local fenced event publication path. Require actual check artifacts and the final passing review; model-only usage/results or reserved artifact injection fail closed. Do not change scheduler, retry, cancellation or budget logic.
- [x] **Step 4:** Run new files plus existing graph, stage-machine, role-binding, settlement and recovery tests; expect all pass. Explicitly exercise generic create with coding stage names but no trusted coding receipt: no model/tool dispatch or delivery.
- [x] **Step 5:** Commit `feat(workflow): enforce coding graph and evidence lineage` after verification.

Task3 evidence (2026-10-16): final focused coding/legacy graph, business-artifact, provider-contract, Local settlement and recovery suite117pass0fail495assert/13files; Core typecheck exit0. New graph7pass21assert, evidence10pass40assert and independent Local final-gate1pass4assert are included. RED reproduced absent modules, generic coding admission acceptance, missing coding authority, cyclic decomposition escaping as a defect, and absent semantic design handoff before correction. The complete in-memory exact-Snapshot/check authority chain validates early revision0 delivery in a max-revision1 graph; this is not claimed as real sandbox execution. Real check host/durable admission and public entry remain Tasks4–5, guarded by default-deny services. Local event publication and projection now dispatch the separate coding outcome format; scheduler, fencing, retries, cancellation and budgets remain unchanged.

## Task 4: Real Coding Check Host and Durable Admission

**Files:** Create Core `coding/admission.ts`, Server `workflow/coding-checks.ts`; tests Core `workflow-coding-admission.test.ts` and Server `workflow-coding-checks.test.ts`. Modify Server composition, Core/Server command-sandbox profile selection and existing reserved-agent registration.

**Interfaces:**

- `CodingAdmission.Service.admit(input: WorkflowCodingBuild.CreateInput, location: Location.Ref, idempotencyKey?: string): Effect<WorkflowCodingBuild.Admission, AdmissionError>` freezes Tasks1–3 contracts and atomically admits existing Workflow/Session/Response resources before advisory wake.
- `CodingChecks.Service.run({workflow,stage,revision,sealedSnapshot,plan}): Effect<CheckRecord,CheckFailure>` uses trusted literal argv via the existing command sandbox. CheckRecord records every selected check's exit/timeout/applicability, observed test count, source snapshot/hash, configuration hash, bounded log hash and host ownership; no model-supplied command or exit status.
- Reuse `WorkflowWorkspaceMaterialization.Sealed` and its exact Snapshot archive for operation lifetime. A coding snapshot does not require design reference files. Resolve command policy from the workflow's own trusted host plan rather than decoding a visual preview plan.

- [x] **Step 1:** Write RED tests for foreground/background admission, exact idempotent retry versus changed kind/checks, no provider before commit, real no-page fixture commands, nonzero/timeout/no-tests outcomes, missing optional checks as explicit not-applicable, config changes, readonly review/test tools, traversal, and unavailable sandbox with no host-shell fallback.
- [x] **Step 2:** Run new Core/Server files; expect missing coding service/host capability, not real Docker/network installation or real credentials.
- [x] **Step 3:** Implement admission and Server check adapter using existing durable identity and sandbox/ownership services. Keep `WorkflowCommandSandbox.Request.role` restricted to the existing executable roles; the new read-only review role never needs a shell role. Use the pinned Bun JUnit reporter (`--reporter=junit --reporter-outfile=<owned sandbox path>`) for mandatory test evidence, and require a well-formed report with observed tests greater than0, no failed/error cases and exit0. `bun-run-test` must resolve to a frozen compatible Bun test invocation; reject an incompatible selected script during plan freezing rather than parse arbitrary console summaries. The owned reporter path/flags are part of the frozen invocation policy, not model input. Missing/empty reports and zero tests fail even with exit0. Runtime ownership/readiness gates apply unchanged to new tasks.
- [x] **Step 4:** Run new files and old production host-plan, command-sandbox, workspace-materialization, admission and model-catalog regressions; expect all pass. Verify actual temporary source is edited/tested, records bind the tested revision and no browser/preview service is invoked.
- [x] **Step 5:** Commit `feat(workflow): admit coding builds with real check evidence` after verification.

Task4 evidence (2026-10-16): Core focused260pass0fail1210assert/20files; Server focused126pass0fail454assert/6files; full Server459pass0fail1738assert/20files (211.21s); both typechecks exit0. New actual Bun launcher/check tests7pass42assert cover failing implementation, edited passing implementation, empty tests, timeout, malformed/contradictory JUnit, child Bun no-dotenv, and exact cached record reuse. Sandbox Docker ownership is tested with a fake engine; full real-workspace/provider/crash acceptance remains Task6. Core provider-engine tests preserve coding check records in fenced continuations and replay settled turns with provider-call count1; genuine stored coding admission/delivery context is consumed without forwarding receipts to the model. Reserved coding Bash was tested RED against an intercepted ordinary-host path before correction; ordinary host calls remain0. Old/new checkpoint1/2 command/recovery tests pass without changing lease/retry algorithms. Historical transport identity decodes after expiry while live dispatch still rejects expired grants. Task-specific state/cache/temp and launcher-child home/cache paths are D-scoped. No actual credential/provider/model-discovery request or deployment replacement occurred.

## Task 5: Authenticated REST, Generated Clients and CLI

**Files:** Modify Protocol `groups/workflow.ts`, Server `handlers/workflow.ts`, CLI `cli/cmd/workflow.ts`; create Server `workflow-coding-api.test.ts`, Client `workflow-coding.test.ts`, CLI `test/cli/workflow-coding.test.ts`. Generate Client output using the existing script and update SDK composition if its public facade requires it.

**Interfaces:** `POST /api/workflow/coding-build`, operation `workflow.codingBuildCreate`, exact Task1 request/admission, Location middleware and `Idempotency-Key` headers as for visual admission. Existing workflow get/events/history/artifacts/cancel/recovery and Responses endpoints operate on the admitted resources unchanged.

CLI: `workflow run --kind coding --checks <JSON> --coding-budget <JSON>` selects coding admission. `--kind` defaults to `visual`; unknown kinds or coding with `--visual-budget` fail before admission. Omitting `--checks` supplies `{cwd:".",test:"bun-test"}`; Core still validates/freeze-checks it. New `workflowCodingRunLimits(budget?,coding?)` validates through the coding request schema, not the visual decoder. Its overall default is `{maxTokens:20000,maxTurns:20,maxToolCalls:40,maxAttempts:27,maxDurationMs:1800000}`: one-revision graph9 stages ×3 attempts. Explicit `--budget` values are never raised; a smaller budget can pause/fail through existing gates. Old visual default maxAttempts3 is unchanged. Foreground/background, format and idempotent connection retry retain current semantics. Coding JSON/text output labels engineering plan/code review truthfully; the visual command/help remain compatible apart from documented additive options.

- [x] **Step 1:** Write RED handler/client/CLI tests for successful typed admission, missing auth/Location, unsafe unknown fields, conflicting idempotency key, ordinary visual default, no preview requirement for coding, no silent task-kind selection, coding option conflicts, SSE after-sequence replay, cancellation and Responses association.
- [x] **Step 2:** Run new files plus existing workflow API/CLI tests; expect missing endpoint/options, not caller credential provisioning.
- [x] **Step 3:** Register the endpoint, install CodingAdmission in Server composition and use generated Client calls in the CLI. Reject invalid options before any write/model call. Keep public inputs free of model/base URL and test-only transport overrides.
- [x] **Step 4:** Run `bun --no-env-file run generate` in Client twice with protected child Bun/PATH; expect identical generated file hashes on the second run. Run Protocol, Server, Client, SDK Next and CLI tests/typechecks from their package directories, preserving all original test assertions/timeouts.
- [x] **Step 5:** Commit `feat(cli): expose location-bound coding workflows` after generated output and tests verify.

Task5 evidence (2026-10-16): named gate135pass585assert plus independently verified resumed visual scenario1pass38assert; six package typechecks exit0. Actual CLI route graph2pass7assert is included: a RED showed its Location map lacked the production coding sandbox; the map and global app now share the same replacement array. REST4pass29assert covers explicit header/query Location, normal auth, strict unknown-field rejection with sanitized diagnostics, idempotency, foreground terminal-Response follow, durable history/exclusive SSE and cancellation. CLI retains visual default3 aggregate attempts; coding defaults27 without raising explicit budgets. Generator ran twice with identical SHA256 across9 output files. Core DI20pass26assert proves replacement clones share an exact normalized implementation graph while differing dependencies still conflict.

SDK verification is file-isolated because its pre-existing process-global Fetch fixtures contaminate Effect Reference defaults across a raw whole-package process: six files38pass289assert; production file15pass1fail was solely the old resumed credential-count assertion. User approved fixture-only purpose-tagged accounting; happy flow independently1pass24assert (14provider+4metadata=18), resumed flow1pass38assert (6provider+4metadata=10), both outbound0. No production credential/provider code changed. Two raw full Server runs exposed Windows fixture races/timeouts (459pass4fail, then462pass1fail); every named failed case subsequently passed unchanged in isolated reruns. These raw failures are not hidden or called green; Task6 must repeat final-source full package acceptance. No paid call, real credential read, deployment replacement or historical seal modification is authorized by these tests.

## Task 6: Zero-Credit End-to-End, Review and Exact-Binary Proof

**Files:** Create `packages/server/test/workflow-coding-e2e.test.ts` and coding fixture/worker files beside the existing catalogue private acceptance fixture. Extend its gated scenario dispatcher and narrowly scoped tests, not ordinary public commands. Update this plan's evidence/checkboxes only after actual verification.

**Interfaces:** New scenario uses the existing offline-only private authorization/lazy entry. The driver returns a body-free result containing workflow type, per-role model IDs, final status, actual-check count, browser/preview invocation count and settled-turn replay count. It accepts only exact owned fixture roots and recorded provider contracts, never a real credential or provider endpoint.

- [ ] **Step 1:** Write RED E2E for a tiny library without HTML: fake Kimi creates engineering plan/decomposition; fake DeepSeek makes a genuine failing implementation, actual Bun test fails; repair edits the file, actual tests pass; Kimi code review and DeepSeek delivery settle. Assert `type="coding-build"`, browser/preview counts0 and delivery references actual final evidence. Add wrong source/config/hash, forged admission and review/exhaustion cases.
- [ ] **Step 2:** Add crash injection after a settled turn and between side effect/settlement; assert pinned model unchanged, settled turns replay0, unknown effects require existing recovery approval. Add REST/SSE replay/cancel/recovery and old visual/old seven-role snapshot regression. Use explicit worker-death proof and deterministic barriers, not fixed sleeps.
- [ ] **Step 3:** Run complete affected package suites from Schema/Core/Protocol/Server/Client/SDK/CLI directories and package typechecks, plus the benchmark package suite (including the pilot15 regression). Long outputs go only to this plan's owned D scratch. Report every failure and skip; do not claim full Task24A from these package tests.
- [ ] **Step 4:** Request one fresh whole-range read-only review, providing this plan/spec and all rulings. Fix Critical/Important findings via RED→GREEN and rerun affected suites; record deferred minors. Commit and push verified source checkpoints; require clean `dev == fork/dev` before building.
- [ ] **Step 5:** Build that exact clean pushed source with pinned Bun/models metadata into a new safe D `--outdir`, `--single --skip-install`, no dotenv and no automatic model fetching. Never use or delete old `dist`, replace deployment, or rewrite old seal. Record source/build inputs, exe version and SHA256.
- [ ] **Step 6:** Run the same recorded coding acceptance through that exact executable using the existing private guard, isolated D roots and clear provider environment. Confirm wrong private grants are rejected and normal help/version/default visual behavior remain unchanged. Build-time constants must not replace runtime guard checks. Any source fix repeats source verification/push/build/proof.
- [ ] **Step 7:** Record completion evidence and the new isolated binary identity in tracked sanitized documentation. Remove only this plan's resolved owned intermediates after final deliverable verification; retain requested evidence/binary or report a cleanup prohibition. Commit/push final documentation and verify remote equality.

## Subsequent Work — Not Completed By This Plan

Library visual-preview/hidden-test evaluators, the brokered live execution loop and a newly sealed full Task24A are separate Task24B readiness work. Before implementing them, write/approve their focused spec and implementation plan against the coding entry's actual interfaces. Preserve task identities, common public fixtures, all five arms, hidden-gold isolation and frozen scoring; do not substitute reverse-patch matching for functional correctness or fabricate visual scores for guardrails.

The already-fixed pilot has exactly15 cells. A new Task24B seal and fresh official-price Kimi CNY/DeepSeek USD envelope require separate user approval before live preflight or paid execution. Task24C also requires its own later approval. No step of this plan authorizes paid calls or claims the workflow improves model/task quality.

## Plan Self-Review

Spec mapping: sections1–3 → Tasks1/2/3/5; section4 → Tasks1/2/4; section5 → Tasks1/3/4; section6 → Tasks2/4/5; section7 → Task6. Section8 remains the explicitly separated subsequent work, not an unchecked success claim.

Shared interfaces: host-plan schemas freeze before admission; coding route/contract/profile exist before graph/evidence execution; graph/evidence and real checks exist before public admission; generated clients precede CLI acceptance; final exact-binary proof uses the clean pushed source and existing protected build entry. The old visual format and new coding format have separate decoders and fingerprints throughout. No API caller can select a runtime profile or create host authority.

Planning decisions: preserve old visual CLI defaults but give the new coding default enough aggregate stage attempts; the existing projector charges one workflow attempt per stage lease, so copying3 would halt before a six-stage happy path. Keep per-stage retry attempts3 separate. Mandatory coding tests use verified Bun1.3.14 JUnit reporter flags and positive observed test count, not a model claim or an arbitrary script's console text. Both decisions are explicit reviewable policy, not changes to the budget/retry algorithms.

Approval gate: review this implementation plan before Task1. Preserve current-session implementation as already chosen; do not ask the user to select execution mode again.
