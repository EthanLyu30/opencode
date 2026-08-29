# Task 23.7B implementation report

Date: 2026-08-29

Branch: `dev` (direct checkout, as authorized)

Base: `45f8b2dc64021c6262ee6de12fa146b5bfe59fea`

Implementation: `b77075194cc64c672ae373a73ecc66e7b626d7ea`

Network/provider/browser/Docker/ACL use during verification: none; deterministic fakes only.

## Outcome

Task 23.7B is implemented. The production visual-build evidence loop now:

1. prepares trusted host facts before a provider turn and settles semantic output afterward;
2. persists an exact reserved `workflow.production-host-plan.v1`;
3. captures a mandatory baseline Snapshot, derives canonical bounded entries and manifest-v2 add/modify/delete changes;
4. runs only the admission-frozen direct Bun test argv and owns exact stage/revision test logs/results;
5. resolves implementation preview authority from durable Workflow/Stage/Location/design/baseline/manifest/current-workspace state in a separate Server module;
6. supplies Kimi with exact typed paired media in declared viewport order;
7. reuses revision-zero reference Artifacts as exact read-only dependencies without re-owning, re-emitting, or recapturing them;
8. checks delivery freshness immediately before settlement;
9. publishes EventV2 before screenshot evidence commit/release, then reloads exact projected Artifacts and reconciles durable evidence on startup.

No Task 23.8–23.12 API, SDK, CLI, deployment, or live-provider behavior was added.

## Authority chain

```text
persisted Workflow/Stage/Location + strict reserved host plan
→ durable design/reference app
→ mandatory Location-scoped baseline Snapshot + validated bounded tree
→ implement/repair Location tools
→ current Snapshot entries
→ host-derived manifest v2 + full workspace SHA-256
→ Server reload of exact workflow/stage/revision/location/design/baseline/manifest/current tree
→ host-minted implementation source/selector contract
→ frozen reference/implementation preview preparation
→ ledger-staged receipt-bound PNGs
→ exact [reference(viewport), implementation(viewport)] typed-media request
→ host-injected review/test/delivery business artifacts and dependency authority
→ one EventV2 Stage/artifact/skip/Workflow/Response batch
→ exact projected Artifact reload
→ idempotent commitEvidence → releaseEvidence
→ bounded startup reconciliation from succeeded receipt-bound Artifacts
```

Model/caller data cannot supply Snapshot IDs, tree hashes, manifest changes, test argv/log/result facts, preview URLs, source/selector identity, screenshot IDs/receipts, Artifact ID/time, dependency ownership, or delivery freshness.

## TDD evidence

All commands used pinned Bun `D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe`, with that directory prepended to `PATH` and task temp/cache under `D:\OpenCode-Task23.7b`. Tests and typechecks ran from the owning package directory.

### RED

| Boundary                            | Command / observed failure                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Snapshot entries + manifest v2      | Core: `bun test test/snapshot.test.ts test/workflow-business-artifacts.test.ts` → **9 pass, 2 fail, 41 expects**; `Snapshot.entries` absent and manifest still v1.             |
| Reserved production host plan       | Core: `bun test test/workflow-business-artifacts.test.ts test/workflow-production-host-plan.test.ts` → **6 pass, 2 fail, 1 error**; derive/host-plan module absent.            |
| Production evidence owner           | Core: `bun test test/workflow-production-evidence.test.ts` → module-not-found (**0 pass, 1 fail, 1 error**).                                                                   |
| Later-revision dependency grant     | Same focused file after foundation → **2 pass, 1 fail**; `second.dependencies` was absent.                                                                                     |
| Exact test-log owner                | Core: `bun test test/workflow-business-artifacts.test.ts` → **7 pass, 1 fail**; `commitExact` absent.                                                                          |
| Server trusted resolver/composition | Server: `bun test test/workflow-production-evidence.test.ts` → module-not-found (**0 pass, 1 fail, 1 error**).                                                                 |
| Frozen direct test runner           | Server focused `workflow-command-sandbox.test.ts -t ...` → **0 pass, 1 fail**; `runFrozenTest` missing.                                                                        |
| Event/evidence settlement           | Core: `bun test test/workflow-evidence-settlement.test.ts` → **0 pass, 1 fail**; settlement/reconciliation helper absent.                                                      |
| Reloaded dependency identity        | Core: `bun test test/workflow-production-evidence.test.ts -t "grants a later revision"` → exact value clone rejected as referentially unequal.                                 |
| Delivery freshness                  | Added a production resolver case that changes the current entry set immediately before deliver settlement; it fails typed `workspace_stale` and produces no delivery artifact. |

The exact log-link test now explicitly rejects missing, duplicate, wrong-hash, wrong-URI, and wrong-size log Artifacts. The paired-media test settles a later revision and proves the durable reference Artifact identity is preserved while only current implementation screenshots and the review are emitted.

### Systematic-debugging incident

A combined Core run first completed Snapshot/business cases, then failed while loading `execution/role.ts` with:

```text
ReferenceError: WorkflowRole is not defined
at packages/core/src/workflow/execution/role.ts:75
```

Bun subsequently terminated with a segmentation fault. The smallest role/model/production-evidence load reproduced the missing runtime import. The single fix was to import `WorkflowRole` as a runtime schema dependency. Re-running the same focused load passed **21/21** and the segfault did not recur; the later broad Core batches also passed. No crash workaround was added.

A later Server typecheck failure was independently minimized to a test fixture whose `goals` array widened from a nonempty tuple. A const-narrowed fixture fixed that single static issue; the same Server typecheck then passed.

## Final GREEN verification

### Core

- From `packages/core`:
  - `bun test test/snapshot.test.ts test/workflow-business-artifacts.test.ts test/workflow-production-host-plan.test.ts test/workflow-production-evidence.test.ts test/workflow-evidence-settlement.test.ts test/workflow-visual-host.test.ts`
  - Result: **40 pass, 0 fail, 197 expect calls**, 6 files, 50.08 s.
- From `packages/core`:
  - `bun test test/workflow-role-execution.test.ts test/workflow-design-loop.test.ts test/workflow-routing.test.ts test/workflow-model-state-machine.test.ts test/workflow-location-tools.test.ts test/workflow-execution.test.ts`
  - Result: **102 pass, 0 fail, 545 expect calls**, 6 files, 5.88 s.
- `bun run typecheck` from `packages/core` → `$ tsgo --noEmit`, exit 0.

### Schema

- `bun run typecheck` from `packages/schema` → `$ tsgo --noEmit`, exit 0.

### Server

- From `packages/server`:
  - `bun test test/workflow-production-evidence.test.ts test/workflow-runtime-composition.test.ts test/workflow-command-sandbox.test.ts test/workflow-visual-host.test.ts`
  - Result: **137 pass, 0 fail, 470 expect calls**, 4 files, 7.83 s.
- `bun run typecheck` from `packages/server` → `$ tsgo --noEmit`, exit 0.

### Quality

- Exact changed-file `prettier --check` → **All matched files use Prettier code style**, exit 0.
- Exact changed-file `oxlint` → **0 errors, 7 warnings**, exit 0.
  - The first pass had 28 warnings. Twenty-one Task23.7B/relevant warnings were removed.
  - The remaining seven are pre-existing `consistent-return` warnings in unchanged legacy portions of `packages/core/src/git.ts` (6) and `packages/core/src/snapshot.ts` (1); `git show 45f8b2dc6:<path>` confirms the same return forms at the base. No unrelated legacy refactor was made.
- `git diff --check` and staged diff check → exit 0.

## Crash/recovery matrix

| Boundary                                              | Behavior                                                                                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline captured before durable decompose settlement | No mutating role has run; a retry may recapture and must validate the bounded tree.                                                                                                                  |
| Baseline plan durable                                 | Implement/repair decode and reuse the exact persisted Snapshot ID; caller IDs are rejected.                                                                                                          |
| Preview prepared before capture                       | Scoped capability is recreated from the frozen plan; no URL/source/selector caller authority exists.                                                                                                 |
| Capturing intent before PNG                           | B3 ledger retains the intent as ambiguous unless the exact owner completes it; no silent recapture.                                                                                                  |
| PNG before staged transaction                         | Capture returns only after exact bytes/receipt are durably staged.                                                                                                                                   |
| Staged before Artifact EventV2 batch                  | Re-preparation uses the exact logical key and staged bytes; zero browser recaptures from staged onward.                                                                                              |
| EventV2 committed before evidence commit              | Local reloads the exact complete Artifact (including ID/time) before commit/release. A commit failure leaves the already-succeeded stage unchanged.                                                  |
| Evidence committed before release                     | Startup reconciliation supplies the exact Artifact/receipt binding with `release: true`; operations are idempotent.                                                                                  |
| Foreign/orphan/unmatched evidence                     | Retained ambiguous; no broadened cleanup or recapture authority.                                                                                                                                     |
| Later revision reference reuse                        | Requires exact same-Workflow design/reference selection, original Artifact identity, receipt, exact committed/released ledger binding, and durable embedded bytes; it is bound only as a dependency. |

## Compatibility

- Manifest v1 and test-result/log v1 remain decodable for legacy history.
- New production visual execution requires manifest v2 and stage-owned result/log v2.
- Legacy/non-visual role resolution retains the deterministic/default preparation behavior.
- The generic command sandbox interface keeps `run`; the trusted direct runner is a narrow optional host capability and production fails closed when absent.
- Implement/repair retain reviewed Bash tooling. Test/deliver provider catalogs are read-only; test execution occurs only through the frozen host operation.
- Task23.7A request/contract/context/tool/media binding remains intact and now also binds preparation identity and exact reference dependency digests.

## Files

The implementation commit changes 32 files. Principal owning boundaries:

- Core Snapshot/Git: `packages/core/src/git.ts`, `packages/core/src/snapshot.ts`
- Schema/codecs: `packages/schema/src/workflow-implementation-artifact.ts`, `packages/schema/src/workflow-test-artifact.ts`, Core implementation/test/test-log artifact modules
- Host plan: `packages/core/src/workflow/production-host-plan.ts`
- Production resolver: `packages/core/src/workflow/execution/production-evidence.ts`
- Role preparation/binding: `execution/role.ts`, `role-binding.ts`, `model.ts`, `executor.ts`
- Event/evidence order: `packages/core/src/workflow/execution/local.ts`
- Server resolver/composition: `packages/server/src/workflow/production-evidence.ts`, `packages/server/src/routes.ts`
- Frozen runner: Core/Server `workflow/command-sandbox.ts`
- Focused Core/Server tests named `workflow-production-*` and `workflow-evidence-settlement.test.ts`, plus updated regression suites

## Self-review

- Confirmed no production `WorkflowRender` import, public admission/HTTP field, model-authored URL/command/hash/receipt authority, or Task23.8+ implementation.
- Confirmed normal and embedded route graphs share the same production visual-host and role-evidence nodes.
- Confirmed reference reuse compares canonical full Artifact identity rather than JavaScript object reference and does not emit the old reference Artifact from the current stage.
- Confirmed preparation checkpoints contain only evidence coordinates/IDs/receipt hashes and opaque digests, never PNG/base64.
- Confirmed EventV2 precedes every production evidence commit/release and post-event failure cannot roll back the succeeded stage.
- Confirmed no live provider, network, browser, Docker, ACL, deployment, push, or `.env.local` access occurred.

## Remaining concerns

- Startup reconciliation intentionally bounds one scan to 1,000 workflows. A future high-volume operational task should add durable pagination/periodic continuation rather than widening this Task23.7B unit.
- Frozen functional tests run in the reviewed read-only test sandbox. Projects whose tests require declared writable outputs need a future versioned host-policy extension; they currently fail closed.
- Real Docker/Chromium/ACL and paid-provider acceptance remain explicitly deferred to Tasks 23.11/23.12 and require their own authorization.
- Seven pre-existing lint warnings remain as documented above; Task23.7B introduces no lint warning or error.

---

## Independent review result (fix round 1 input; verbatim)

> ## Summary
>
> Task 23.7B is not ready to gate. The patch establishes most intended structures, but two critical integrity gaps let implementation evidence diverge from the workspace identity it claims. Recovery, failure mapping, and delivery-chain validation also have important defects.
>
> ## Spec verdict: ❌
>
> - Mandatory baseline Snapshot: ❌ Capture occurs during decompose settlement and later stages reuse the persisted ID, but oversized untracked files are silently omitted rather than failing closed.
> - Exact tree/manifest v2: ❌ The v2 codec and add/modify/delete derivation are strict, sorted, and legacy-v1 compatible. However, the underlying capture is not an exact scoped tree.
> - Durable functional evidence: ❌ Stage/revision-owned log/result v2 codecs and one-to-one validation are good, but the frozen test runs against the mutable live workspace after its digest was checked.
> - Reserved host plan/frozen command: ✅ Strict reserved envelope, exact direct Bun argv, configuration verification, and no model shell authority are present.
> - Production resolver/composition: ❌ Durable owner/revision/location/design/baseline/manifest checks and shared normal/embedded composition exist, but the resolver’s verified workspace is not frozen for preview consumption.
> - Ordered reference/implementation evidence: ❌ Declared viewport pairing and read-only reference dependencies are implemented correctly, but implementation screenshots can be captured from content different from their claimed manifest identity, and current screenshot receipts are not fully prevalidated before EventV2.
> - Kimi paired media/no base64 text: ✅ `reviewMessage(spec, images)` is used directly with ordered typed media; prior generic scanning remains in force. Live provider-adapter behavior was intentionally not exercised.
> - Delivery freshness/chain: ❌ Persistent ordinary edits are caught, but skipped oversized files evade freshness and delivery does not revalidate the required test-log/screenshot chain.
> - EventV2/evidence ordering: Partial. The code publishes EventV2 before `commitEvidence`/`releaseEvidence`, but receipt mismatch can still be discovered only after the irreversible batch.
> - Recovery/reconciliation: ❌ Ledger idempotency is used, but startup reconciliation is a one-shot, unpaged scan and cannot guarantee recovery.
> - Compatibility/scope: ✅ Legacy manifest/test codecs remain decodable, production requires exact versions, no production `WorkflowRender` import was found, and no Task23.8+ public surface was added.
>
> Cannot independently verify the reported test/typecheck outputs because the review instructions prohibited rerunning them; they are treated as report evidence. Real provider, browser, Docker, ACL, and network behavior also remains intentionally unverified.
>
> ## Findings
>
> ### Critical
>
> 1. **Oversized untracked files disappear from trusted Snapshot and freshness authority.**
>    [snapshot.ts](D:/OpenCode-Audit/packages/core/src/snapshot.ts:147) captures with a 2 MiB untracked-file ceiling. [git.ts](D:/OpenCode-Audit/packages/core/src/git.ts:474) classifies larger untracked files as `skipped`, removes them from the snapshot index, and [git.ts](D:/OpenCode-Audit/packages/core/src/git.ts:550) discards the returned `skipped` set when writing the tree. `Snapshot.entries` therefore succeeds on a tree that silently excludes those files. A 3 MiB untracked application asset can be changed after review and remain absent from the manifest and every delivery freshness digest, allowing completion against a stale live workspace. This directly violates mandatory fail-closed oversized-tree and full scoped-workspace authority.
> 2. **Preview and functional evidence are stamped with a manifest identity but consume the mutable live workspace.**
>    [production-evidence.ts](D:/OpenCode-Audit/packages/server/src/workflow/production-evidence.ts:100) hashes a current Snapshot and returns the manifest hash, after which [visual-host.ts](D:/OpenCode-Audit/packages/server/src/workflow/visual-host.ts:337) starts static/script preview directly from `plan.locationRoot` while labeling the preview with that earlier manifest identity. Browser capture occurs later. Likewise, [production-evidence.ts](D:/OpenCode-Audit/packages/core/src/workflow/execution/production-evidence.ts:71) checks the workspace before running the frozen test against the live bind mount. A user edit between verification and browser/test consumption can affect screenshots or tests; restoring the file before delivery makes the final freshness check pass. Evidence then claims a source revision it never evaluated. The preview/test input must be an immutable Snapshot materialization or equivalently fenced exact content.
>
> ### Important
>
> 1. **Typed host failures are erased and do not reach the required approval path.**
>    [executor.ts](D:/OpenCode-Audit/packages/core/src/workflow/executor.ts:155) and [executor.ts](D:/OpenCode-Audit/packages/core/src/workflow/executor.ts:216) convert every `EvidenceFailure` to `invalidOutcome`; [executor.ts](D:/OpenCode-Audit/packages/core/src/workflow/executor.ts:389) hardcodes category `schema` and code `invalid_role_outcome`. Missing host plans, unavailable baseline Snapshots, stale workspaces, and ambiguous visual authority therefore lose codes such as `preview_configuration_required`, `snapshot_required`, and `workspace_stale`, and become immediate final failures rather than typed approval/ambiguity outcomes.
> 2. **Durable reconciliation is incomplete above 1,000 workflows and is never retried by the scheduler.**
>    [local.ts](D:/OpenCode-Audit/packages/core/src/workflow/execution/local.ts:1083) requests only `list({ limit: 1_000 })` with no cursor or continuation. [store.ts](D:/OpenCode-Audit/packages/core/src/workflow/store.ts:182) always returns the oldest rows, while [local.ts](D:/OpenCode-Audit/packages/core/src/workflow/execution/local.ts:994) invokes reconciliation only once at startup; the scheduler loop omits it. A post-EventV2 staged record belonging to workflow 1001+ is never committed/released. A transient reconciliation failure at startup is likewise retained indefinitely until another process restart.
> 3. **Delivery trusts pass artifacts without revalidating their mandatory durable dependencies.**
>    [production-evidence.ts](D:/OpenCode-Audit/packages/core/src/workflow/execution/production-evidence.ts:395) decodes only manifest, test result, and review, then validates their digests and current workspace. It never proves that every test log still resolves exactly once, or that every review screenshot/dependency and bound outcome still exists. The final gate in [role-binding.ts](D:/OpenCode-Audit/packages/core/src/workflow/execution/role-binding.ts:301) similarly uses only the three top-level commits. Removing a referenced test-log or screenshot Artifact leaves delivery able to complete despite a broken exact evidence chain.
> 4. **Current-stage screenshot receipt ownership is not validated before EventV2.**
>    [visual-review.ts](D:/OpenCode-Audit/packages/core/src/workflow/artifacts/visual-review.ts:201) validates receipt/image facts but not the expected current stage. [role-binding.ts](D:/OpenCode-Audit/packages/core/src/workflow/execution/role-binding.ts:262) validates screenshot pairing and Artifact ownership without requiring each new receipt’s `coordinates.stageID` to equal the current stage or re-deriving its frozen config/source/selector coordinates. A host bug returning a consistent receipt for another stage can pass the pre-batch gate; EventV2 succeeds, then [local.ts](D:/OpenCode-Audit/packages/core/src/workflow/execution/local.ts:1073) discovers the receipt/Artifact conflict only during post-batch evidence binding, leaving a succeeded stage that reconciliation cannot repair.
>
> ### Minor
>
> - The mandatory RED evidence is incomplete. The focused production-evidence suite contains four scenarios and no successful baseline-reuse case, typed executor error-mapping case, live-workspace race case, or missing delivery-dependency case. The settlement test seeds `order = ["eventv2"]` manually rather than exercising actual EventV2 publication, so it does not itself prove the full crash/order matrix.
>
> ## Task-quality verdict: Not approved
>
> Strengths include the strict manifest-v2 topology, exact log-v2 URI/hash/bytes ownership, deterministic direct test argv, canonical paired-media ordering, preserved cross-revision Artifact identity, shared production composition, legacy decoding, and explicit EventV2-before-evidence code order.
>
> ## Final gate verdict
>
> **REJECT — ❌ spec noncompliant, with 2 Critical and 4 Important findings.**

## Review fix round 1 — resolution

All two Critical and four Important findings were reproduced and accepted; no review pushback was necessary.

| Finding                              | Targeted RED                                                                                                                                                           | GREEN implementation and focused evidence                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 skipped/oversized untracked input | A scoped untracked file above 2 MiB returned a Snapshot tree instead of failing closed.                                                                                | `Git.tree.capture` now propagates any refresh `skipped` set as a capture failure. The regression passes, and the final Snapshot matrix includes both the oversize rejection and content-digest/materialization cases.                                                                                                                                                                                                                        |
| C2 verify/use race                   | The functional-test race reached `invalid_role_evidence`; the Server resolver returned no materialization; preview/test could observe edited-then-restored live bytes. | Added a strict v1 `WorkflowWorkspaceMaterialization.Lease`, exact Snapshot materialization, deterministic owner/tree/lease identity, whole-tree rehashing, D-drive containment, and mutation/absence/extra/link rejection. Both frozen tests and static/script preview use the same host-materialized root. Focused test, resolver, command-final-gate, and preview race cases all pass and prove only materialized bytes are consumed.      |
| I1 typed failure mapping             | `preview_configuration_required`/`workspace_stale`/ambiguous host facts became `schema/invalid_role_outcome`.                                                          | Executor now preserves exact evidence codes and explicit categories; required/unavailable/stale/ambiguous facts enter the ambiguity/approval path. Focused matrix: **1 pass, 8 assertions**.                                                                                                                                                                                                                                                 |
| I2 durable reconciliation            | A 1,001-workflow case reconciled only 100 in the test page; a transient startup failure was never retried.                                                             | Added deterministic `(timeCreated, workflowID)` cursor pagination, a 1..1,000 page size, a 10,000-page hard bound/nonadvancing-cursor fail-close, and the same reconciliation iteration at startup and every scheduler tick. Focused file: **4 pass, 9 assertions**.                                                                                                                                                                         |
| I3 delivery chain                    | Removing a referenced log/screenshot/outcome still allowed the top-level delivery facts to validate.                                                                   | Delivery now exact-resolves every v2 manifest/test result/log, ordered reference+implementation screenshot, cross-revision dependency, visual review, and host-bound outcome artifact-set digest; missing/duplicate/foreign/drifted facts reject. Focused chain case: **1 pass, 7 assertions**.                                                                                                                                              |
| I4 pre-Event receipt authority       | A self-consistent current screenshot receipt naming a foreign stage was accepted before EventV2.                                                                       | Both production settlement and Local's business-artifact gate now rederive current receipt stage/revision/config/source/selector/manifest authority; reference receipts retain original owner identity. The foreign-stage regression passes. A real Local worker test verifies EventV2 projection inside `commitEvidence`, simulates a post-projection commit crash, and observes periodic durable reconciliation: **1 pass, 8 assertions**. |

### Systematic debugging during fix round 1

1. The actual EventV2 integration test first failed with `Service not found: @opencode/v2/WorkflowStore`. The smallest test proved the custom host replacement was a dependency-bearing raw Layer. Replacing only that fixture with a `makeGlobalNode` declaring `WorkflowStore.node` fixed the service graph; the same test then reached its final assertion. A second test-only failure (`UnsafePersistenceError: Only plain JSON objects can be persisted`, path `$.timeCreated`) was caused by passing a full Artifact to an ArtifactCommit decoder; direct exact Artifact/receipt assertions fixed that fixture. The focused integration then passed **1/1, 8 assertions**.
2. The first Server mandatory run passed **138/139** and failed only actual normal/embedded graph acquisition with `TypeError: Missing required OPENCODE_WORKFLOW_HOST_TEMP`. The root cause was eager materialization-root evaluation while acquiring `productionRoleLayer`. Root resolution was delayed to the first materialization call, preserving fail-closed production behavior while retaining environment-free graph construction. The exact reproduction passed **1/1, 6 assertions**; the complete Server matrix then passed **139/139**.

## Review fix round 1 — final GREEN

All commands used pinned Bun `D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe`, with package-directory working directories and task temp/cache beneath `D:\OpenCode-Task23.7b-review`.

Implementation commit: `a05d29ab8` (`fix(workflow): close production evidence review gaps`), 24 code/test files, 2,011 insertions and 81 deletions. This report and the progress ledger are committed separately.

- Core matrix 1: `bun test test/snapshot.test.ts test/workflow-business-artifacts.test.ts test/workflow-production-host-plan.test.ts test/workflow-production-evidence.test.ts test/workflow-evidence-settlement.test.ts test/workflow-visual-host.test.ts` → **46 pass, 0 fail, 213 assertions**, 6 files, 66.42 s.
- Core matrix 2: `bun test test/workflow-role-execution.test.ts test/workflow-design-loop.test.ts test/workflow-routing.test.ts test/workflow-model-state-machine.test.ts test/workflow-location-tools.test.ts test/workflow-execution.test.ts` → **104 pass, 0 fail, 561 assertions**, 6 files, 5.90 s.
- Server matrix: `bun test test/workflow-production-evidence.test.ts test/workflow-runtime-composition.test.ts test/workflow-command-sandbox.test.ts test/workflow-visual-host.test.ts` → **139 pass, 0 fail, 475 assertions**, 4 files, 7.83 s.
- `bun run typecheck` from each of `packages/schema`, `packages/core`, and `packages/server` → `$ tsgo --noEmit`, exit 0 for all three.
- Exact changed-file Prettier check → all matched files formatted, exit 0.
- Exact changed-file oxlint with the repository config → **0 errors, 7 warnings** in Core and **0 errors, 0 warnings** in Server. All Task23.7B-fix warnings were removed. The remaining seven are the same base `consistent-return` forms in legacy portions of `packages/core/src/git.ts` (6) and `packages/core/src/snapshot.ts` restore (1), confirmed at `45f8b2dc6`; they were not refactored.
- `git diff --check` → exit 0.

## Review fix round 1 — self-review and remaining concerns

- Confirmed the two consumers (functional test and visual preview) receive the same exact Snapshot-tree contract, never the mutable live Location after hashing; final launch/capture gates rehash the materialized root.
- Confirmed current screenshot receipt authority is checked before the irreversible EventV2 batch, and actual post-batch failure leaves durable stage/Artifact state recoverable without provider/browser rerun.
- Confirmed bounded pagination is linear per scan with a deterministic cursor and hard upper bound; transient per-workflow failures are retained and retried periodically.
- Confirmed delivery rejects missing, duplicate, foreign, and drifted evidence dependencies and validates the bound outcome set.
- Confirmed Task23.7A request immutability, normal/embedded composition parity, and legacy codecs remain intact; no Task23.8+ public surface was added.
- No live provider, browser, network, Docker, ACL, deployment, push, or `.env.local` access occurred.
- Materialized owner/tree/lease directories are deliberately retained when there is no proven exact post-projection cleanup authority. A bounded exact-owner garbage-collection pass for old successful test-only leases remains an operational follow-up; current behavior prefers a D-drive retention leak over unsafe early deletion or deleting bytes needed by evidence recovery.
- Cleanup verified `D:\OpenCode-Task23.7b-review` and `D:\OpenCode-Task23.7b` as the exact task-owned temporary directories, but the execution safety policy rejected both recursive `Remove-Item` calls. They remain as removable test temp/cache artifacts; no repository file is contained there.
