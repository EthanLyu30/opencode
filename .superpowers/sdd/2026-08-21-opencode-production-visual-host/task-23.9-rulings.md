# Task23.9 controller rulings after Protocol/server/client preflight

These rulings refine Task23.9. They assume Task23.8's reviewed `WorkflowAdmission` contract and do not permit HTTP code to recreate admission or call providers.

1. **Expose idempotency only through an optional standard header.**
   - Add an exact optional `Idempotency-Key` endpoint header schema with conservative length/character bounds; generated Promise and Effect clients expose it as a header input.
   - The strict JSON payload remains `WorkflowVisualBuild.CreateInput` and rejects idempotency, placement, model/provider, URL, and model-authored command fields.
   - If the header is absent, the handler derives the deterministic admission key from the complete decoded request plus canonical Location according to Task23.8's ruling. It never generates a random retry identity in the handler.

2. **Location is middleware-derived and endpoint-scoped where the framework permits.**
   - The handler must obtain `Location.Service` and pass only its canonical `Location.Ref` to Core admission.
   - Prefer middleware on the new endpoint rather than silently changing the context/behavior of every existing Workflow route. If Effect's group construction requires group middleware, prove all existing Workflow handlers and OpenAPI behavior remain unchanged.
   - Two-location tests must use trusted headers/query middleware inputs, never JSON placement fields.

3. **Background and foreground share one admission.**
   - Background returns the newly admitted stored Response/Workflow pair immediately.
   - Foreground admits exactly once, then follows that same durable Response to terminal state and returns the same Admission shape with the refreshed terminal Response. It must not proxy `/v1/responses`, allocate a second Response, issue a second wake, or couple HTTP disconnect to durable cancellation.
   - SSE remains a separate reconnectable observation surface for Task23.10; do not implement foreground by consuming and discarding the public SSE protocol.

4. **Both standalone Server and real OpenCode embedded composition must resolve the production graph.**
   - Add the reviewed `WorkflowAdmission` service to the standalone route graph while preserving the single normal/embedded `workflowReplacements` boundary for `WorkflowVisualHostServer` and command sandbox.
   - The `packages/opencode` HttpApi composition must also provide Workflow, Responses, Execution, Admission, and the same production replacements. OpenAPI presence without a resolvable runtime handler is a failure.
   - Add composition tests for both paths; no handler-level fallback layer is allowed.

5. **Generated clients are codegen-only artifacts.**
   - Change Protocol first, run generation from `packages/client`, compare first/second outputs for exact determinism, run `check:generated`, tests, and typecheck, then remove only the verified Task23 temporary diff under `D:\OpenCode-Local\tmp`.
   - Never hand-edit `src/generated` or `src/generated-effect`.

6. **Authorization and public API behavior are explicit gates.**
   - The operation ID is exactly `workflow.visualBuildCreate`; path is exactly `/api/workflow/visual-build`.
   - Prove OpenAPI exposure, the existing v2 authentication policy/401 body, strict payload/header decode, and generated Promise/Effect client operation names.

## Mandatory Task23.8 breaker carry-over

The fifth Task23.8 fix round exhausted its review budget with four real, load-bearing findings. Task23.9 must close these before its new admission endpoint or generated clients can be considered green. They are compatibility repairs to the admission substrate, not permission to redesign Tasks2–22.

7. **Filter the legacy instance event stream through complete public authority.**
   - `GET /event` must never expose hidden Session, Workflow, Response, receipt/context, or Stage members merely because their Location matches the subscriber.
   - Reuse the same authoritative complete-batch visibility decision that protects GlobalBus and sync history; do not add a payload-only or directory-only approximation.
   - Add a real-route regression that subscribes to `/event`, admits a hidden visual build, proves the complete hidden batch is absent, and proves ordinary public events still arrive in order.

8. **Make terminal deletion crash-safe and terminal for every Session event kind.**
   - The production delete path must leave either the intact pre-delete state or a fully compacted state that retains only the exact v3 deletion event, EventSequence, and durable tombstone while removing complete related sensitive batches. A crash, interruption, or retry between publish and compaction must not strand the uncompactable half-state.
   - An atomic transition is preferred. A durable recovery design is acceptable only if the recovery authority is persisted before the gap, is idempotent, does not require the deleted live row, and is exercised at the relevant crash boundary.
   - Once a tombstone exists, reject `session.created`, `session.updated`, all legacy/current deletion duplicates that are not exact persisted replay, and every other future Session event before sequence advancement.

9. **Canonicalize EventV2 once before every consumer.**
   - Schema decode/encode must produce the single canonical envelope used for projector input, EventTable bytes, public classification, postcommit notification, GlobalBus, and SSE.
   - A caller-provided v3 deletion object with extra nested or top-level fields must either fail strict validation or have those fields absent from every durable and live surface; no code may persist canonical data but notify with the original object.
   - Cover commit, rollback, replay, and live notification without weakening exact event ID/version/tombstone authority.

10. **Update all minimal-v3 Session deletion consumers and generated types.**
    - The four production TUI listeners must use v3 `sessionID` and explicitly preserve legacy v1/v2 handling where those versions remain supported; normal deletion must not throw and must clear navigation, list, and local/sync indexes.
    - Regenerate any public SDK/client type that still requires `properties.info` from its authoritative source. Generated artifacts remain codegen-only: do not hand-edit them, and prove deterministic regeneration or explicitly isolate an unrelated pre-existing generator baseline without hiding the v3 type correction.
