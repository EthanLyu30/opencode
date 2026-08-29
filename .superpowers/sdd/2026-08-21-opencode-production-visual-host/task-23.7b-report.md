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
