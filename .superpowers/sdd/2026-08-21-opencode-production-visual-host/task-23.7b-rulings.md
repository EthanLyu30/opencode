# Task23.7B controller rulings after the post-A interface preflight

These rulings refine the 23.7B brief without weakening reviewed 23.7A authority.

1. **Role evidence has a pre-provider preparation phase and a post-provider settlement phase.**
   - Extend the reviewed role service with a narrow trusted `prepare` operation. It receives only the persisted Workflow/Stage/Location/full prior Artifacts, admission-frozen inputs, and durable preparation checkpoint facts.
   - For `visual_review`, `prepare` resolves/reuses staged reference and implementation screenshots, constructs `WorkflowVisualReviewArtifact.reviewMessage(...)`, and returns those exact typed-media messages plus a bounded authority descriptor. The contract is built with those messages before provider intent is persisted and before Kimi is called.
   - For roles that need no host prework, preparation is pure/default. Post-provider `settle` remains the only place semantic output becomes business artifacts/outcome binding.
   - Checkpoints persist only bounded preparation identity/receipt hashes and coordinates, never PNG/base64 bytes. Restart reconstructs media from the durable evidence ledger; staged onward means zero recapture.
   - Cost if wrong: preparation may become a separate injected service, but media capture may never happen after Kimi has already answered.

2. **Admission-frozen host plans live under a strict reserved Workflow input envelope.**
   - Define a versioned exact `workflow.production-host-plan.v1` codec in the owning Core module and store it under one reserved key in persisted `Workflow.Info.input`; do not add public placement/model/URL/command fields and do not rely on untyped caller objects.
   - It binds canonical Location, the complete frozen `PreviewPlan`, its configuration digest, and a functional-test plan containing host-selected exact argv/cwd/policy/config hashes.
   - Task23.7B defines/fakes/verifies this authority. Task23.8's admission builder freezes and persists it atomically. A visual workflow missing it fails `preview_configuration_required`/approval before provider or host side effects.

3. **The functional plan is host-selected, bounded, and model-immutable.**
   - If admission finds a supported, safe, frozen package test script, use exact `bun run test` with its package/config identity. Otherwise the host default is exact `bun test` in the admitted scope. No shell string, model command, ambient package-manager fallback, or post-admission script/config change is accepted.
   - Preview/build execution uses the separately frozen PreviewPlan. Unknown/unsafe runtime configuration fails to approval rather than guessing.
   - The test role can request/observe only the frozen operation; settled command facts—not model prose—derive argv/cwd/exit/log/result. Implement/repair keep their reviewed sandbox tool flow.
   - Cost if wrong: additional trusted test-plan choices may later be added to the public product schema, but existing plans remain versioned and immutable.

4. **Production resolution is a new owning module, not more code in `role.ts`.**
   - Create a focused production evidence/preparation module and keep the reviewed role facade, binding validator, fake, and test-log codec separated.
   - Wire the production role layer and the B3 implementation-contract resolver through one composition factory used by normal and embedded Server/OpenCode graphs. No callback supplied by an HTTP handler or test fixture becomes production authority.

5. **Snapshot/tree and implementation manifest authority are versioned and exact.**
   - Extend Snapshot with a bounded Location-scoped canonical entry API that hashes file contents with SHA-256, preserves type/absence semantics, sorts ordinally, and rejects Windows topology/collision/unsafe/oversized trees without unbounded reads.
   - Add a new manifest codec version: added has only after hash; modified has distinct before+after; deleted has only before; unchanged/empty entries reject. `workspaceSha256` hashes the complete current entry set.
   - Legacy manifest decode remains available only for legacy history; new visual execution requires the exact version.

6. **Durable test logs are owning business artifacts.**
   - Promote/use the reviewed bounded `workflow.test.log` artifact codec with exact workflow/stage/revision URI/hash/size/bytes identity. Every test-result log reference resolves one-to-one to a complete durable log Artifact; duplicate/missing/cross-owner facts reject.

7. **Paired screenshots are exact ordered authority, not a set.**
   - Load the declared design viewport list. Require precisely `[reference(v), implementation(v)]` for every viewport in declared order, strict B3 receipts for all new visual screenshots, and no extras/duplicates.
   - Later revisions reuse the exact durable reference evidence. Released/ambiguous/foreign keys never silently recapture.

8. **EventV2 succeeds before evidence commitment, and reconciliation is durable.**
   - Local validates receipt-bearing screenshot commits, publishes the one complete EventV2 batch, reloads exact projected Artifacts including ID/time, then idempotently commit/releases evidence.
   - A post-batch evidence error never reverses or reruns the stage/provider/browser. A startup/scheduler reconciliation hook finishes exact staged/committed evidence from durable Artifacts; unmatched evidence remains retained/ambiguous.

9. **Delivery freshness is checked immediately before settlement.**
   - Recompute current workspace entries/digest and require exact equality with the unique latest same-revision manifest plus passing functional test and passing ordered visual review. Any concurrent edit fails closed before the delivery artifact/Response can commit.

10. **Cross-revision reference reuse is a read-only dependency grant, not current-stage ownership.**
    - The original reference screenshot keeps its exact durable Artifact owner, stage, revision, viewport, configuration, receipt, and creation identity. A later `visual_review` stage may consume it only when the frozen host plan and same-Workflow design/reference authority select that exact identity.
    - The later stage must bind the reused Artifact as an explicit dependency in its preparation/outcome authority, but must not clone, re-own, re-emit, or recapture it. Newly captured implementation screenshots and the review artifact remain owned by the current stage under the Task 23.7A settlement rules.
    - Missing, released-without-durable-bytes, ambiguous, foreign, or identity-drifted reference evidence fails closed to approval.
    - Cost if wrong: the role contract will need a first-class persisted dependency-edge schema rather than this bounded same-Workflow reuse grant; silently weakening current-stage output ownership is not allowed.

11. **A filesystem materialization is a cache, not the immutable evidence boundary.**
    - The host must read every expected Snapshot entry into a bounded, content-addressed immutable byte representation and verify every entry plus the aggregate workspace identity before handing any content to a consumer.
    - Static preview serves the frozen byte map directly. Functional tests and script previews import the exact host-generated archive/bytes into their owned container before execution; they never bind-mount or reopen a same-user-writable host tree after verification.
    - A pre-use or post-use filesystem rehash alone is insufficient because an edit-and-restore race can evade it. No accepted test log or PNG may depend on bytes reopened from a mutable path after the immutable representation was sealed.
    - Cost if wrong: the host will need an OS/process isolation identity unavailable to the current same-user runtime; until then, mutable filesystem paths must remain non-authoritative.

12. **Materialization cache roots and cleanup use the existing trusted-host policy and exact leases.**
    - Every configured/cache root is canonicalized and admitted by `HostRootPolicy`; reparse/junction/symlink/hardlink drift fails closed before create/read/delete. The test path cannot bypass a visual-host root rejection.
    - Acquire/release records bind the exact root/tree/workflow/stage/revision/Location/Snapshot/manifest/workspace identity. Normal completion releases after durable evidence exists; startup/scheduler recovery performs bounded fair GC.
    - Cleanup enumerates the exact admitted entry/directory set and removes it leaf-first under repeated root/identity fences; no unconstrained recursive deletion follows a caller-controlled or reparseable path.
    - Cost if wrong: bounded stale cache entries remain retained for manual recovery rather than risking deletion outside the trusted D-drive subtree.
