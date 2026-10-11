# Workflow Model Catalogue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the preserved native execution method. Implement task-by-task with checkbox tracking, TDD and scoped commits. Do not start implementation until the user reviews this written plan.

**Goal:** Automatically discover Kimi/DeepSeek model choices, require explicit replacement activation, retire superseded choices only for new tasks, and preserve exact admitted/replayed routes without recompiling every model identifier.

**Architecture:** A trusted metadata service publishes content-addressed catalogue and role-policy snapshots through one atomic head pointer. Profile-driven adapters accept only validated model/contract bindings; production admission freezes the selected binding into a versioned receipt and restores it on every continuation. CLI/API share catalogue reads and explicit compare-and-swap activation; no discovery, activation or offline test performs model generation.

**Tech Stack:** Existing TypeScript, Bun 1.3.14, Effect 4, Effect Schema, EventV2, native filesystem atomic rename/Flock, existing HTTP client and generated Protocol/Client machinery. No new runtime dependency or SQL migration is required by this plan.

**Spec:** `docs/superpowers/specs/2026-10-11-opencode-workflow-model-catalog-design.md`

## Global Constraints

- Work directly on `dev` in `D:\OpenCode-Audit`; preserve unrelated edits, use conventional scoped commits and push each verified checkpoint to `fork/dev`. Do not create another worktree or force-push.
- Automatic discovery and choice publication; explicit activation of a replacement. No automatic activation or paid compatibility probe.
- Kimi flagship K3 or a validated same-family successor supplies design/decomposition/visual review; DeepSeek Pro supplies implementation/repair/delivery, Flash supplies testing. No Kimi 2.6/2.7, cross-family substitution, protocol fallback or silent effort downgrade.
- Metadata requests: configured first-party HTTPS origins only, no redirects, 10-second deadline, 2 MiB reply ceiling, 256-model ceiling. Credentialed discovery uses `api.deepseek.com` or the verified Kimi API origin; documentation origins are separately allowlisted and never receive API authorization headers. First-party metadata/contract evidence is required; unknown capability/lineage remains unverified.
- Refresh at startup when the last successful snapshot is older than 60 minutes; check hourly while the service runs; allow manual refresh. OpenCode being closed means no discovery is running. Do not create a desktop automation.
- Two complete successful missing observations at least 60 minutes apart are required to mark a model unavailable. Refresh failure is not a missing observation or deprecation.
- Catalogue/policy history: `D:\OpenCode-Local\data\workflow-model-catalog`. Cache/temp use the existing D-drive roots; reusable code receives roots through runtime composition.
- Never read, print, copy or commit real keys or `.env.local` during development. Runtime discovery alone obtains redacted credentials; children, model tools, catalogues, events and public views never receive them.
- Keep exact model, catalogue/policy hash, adapter revision and price identity fixed for admitted work. Existing tasks, receipts, Responses and seals are not relabeled. Rolling aliases are not a guarantee of immutable weights.
- Preserve Task2–9 lease, retry, cancellation, event-store and replay algorithms. New model-configuration gates are additive business behavior; do not classify unavailable models as ambiguous tool side effects.
- Old benchmark arm/model/protocol/price allowlists remain exact. This plan does not broaden or rerun the existing seal and does not implement the nonvisual entry, library evaluator or paid run loop.
- Tests and typechecks run from affected package directories. Generate clients only with `bun run generate` from `packages/client`; never hand-edit generated files.
- Use injected clocks/readiness signals, not arbitrary sleeps, in concurrency/crash tests. Redirect all test-owned temp/cache/config/data roots to D.
- Preserve final documentation, evidence, deployment and rollback. Remove only verified owned intermediates after verification. Previously policy-blocked cleanup targets must not be retried or bypassed.

## Review Focus

1. Discovery replies reordered, duplicated, partially omitted or containing misleading `created` values must not change lineage/default selection; MC1/MC2 tests bind this.
2. Credential/origin changes and two concurrent refresh/activation processes must not leak an account's availability or partially publish a policy; MC2/MC3 use trusted scope identity and a single CAS head.
3. A confirmation rendered from an old head must fail as a typed conflict, not activate a newly priced/differently profiled candidate; MC3/MC6 cover this.
4. An idempotent admission retry after activation must return its original route snapshot, including V1 legacy receipts, rather than conflict against today's defaults; MC5 covers this.
5. Cancellation/lease loss while a pinned model becomes unavailable must fence configuration gating and never replay a settled model/tool turn; MC5/MC7 cover real processes.

## File and Interface Map

| Unit               | Files                                                                                                                                                                      | Responsibility                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Wire schemas       | `packages/schema/src/workflow-model-catalog.ts`                                                                                                                            | Sanitized catalogue/policy/view/activation/route-snapshot DTOs; no credentials or executable commands   |
| Pure rules         | `packages/core/src/workflow/model-catalog/policy.ts`                                                                                                                       | Lineage, observation merge, eligibility, explicit replacement and retirement                            |
| Contract bindings  | `packages/llm/src/model-contract.ts`, `packages/llm/src/capabilities.ts`, `packages/llm/src/providers/{kimi,deepseek}.ts`                                                  | Fixed adapter contracts, validated dynamic model IDs, immutable per-model bindings                      |
| Sources/transport  | `packages/core/src/workflow/model-catalog/discovery.ts`, `sources.ts`                                                                                                      | First-party schema decoding and capability/lineage/pricing evidence; redacted credentialed GET boundary |
| Storage/service    | `packages/core/src/workflow/model-catalog/{store,service}.ts`                                                                                                              | Hash-addressed immutable files, CAS head, refresh scope/timer and activation                            |
| Route ownership    | Existing `workflow/{admission,routing,executor}.ts`, `workflow/execution/{contract,role-binding}.ts`, new `workflow/model-selection.ts`, existing `responses/admission.ts` | Versioned admission snapshot and exact continuation/settlement validation                               |
| Configuration gate | New `workflow/model-availability.ts`; existing `workflow/execution/local.ts`, `workflow.ts`, `packages/schema/src/workflow-event.ts`                                       | Model-unavailable approval without changing retry/lease algorithms                                      |
| User surface       | New `packages/protocol/src/groups/workflow-model.ts`, `packages/server/src/handlers/workflow-model.ts`, `packages/opencode/src/cli/cmd/workflow-models.ts`                 | Shared sanitized list/refresh/confirmation APIs and CLI                                                 |
| Composition/deploy | Existing `packages/server/src/{routes,handlers}.ts`, `packages/protocol/src/api.ts`, `scripts/{deploy-local,test-local-deploy}.ps1`                                        | Runtime roots, services, authenticated API and launcher                                                 |

All newly exported types below are owned by MC1. New service/runtime methods are explicitly defined in their owning task. Do not add a mutable process-global capability registry.

## Shared Contracts (MC1 owns these)

Use namespace `WorkflowModelCatalog` from Schema. Exact schemas reject undeclared persistence/API fields and pass the existing secret guard.

- `ProviderID`: `"kimi" | "deepseek"`; `Family`: `"kimi-flagship" | "deepseek-pro" | "deepseek-flash" | "unknown"`.
- `AdapterProfile`: `{ id: "kimi-chat-k3-v1" | "deepseek-responses-v4-v1", providerID, protocol: WorkflowRole.Protocol, capabilities: string[], effortLevels: string[], wireContractSha256: Sha256 }`; MC1 owns normalized immutable descriptors and `adapterProfile(id: string): AdapterProfile | undefined`. These descriptors describe the existing tested wire contracts, never assert that an unknown model supports them. MC2 consumes them; MC4 binds them into provider instances.
- `SourceEvidence`: `{ url: string, sha256: Sha256, observedAt: number, contractRevision: string }`; validate first-party origin and hashes, not arbitrary URLs.
- `ModelEntry`: `{ providerID, modelID: string, displayName: string, family, predecessor: string | null, advertisedRevision: string | null, contextWindow: number | null, maxOutputTokens: number | null, capabilities: string[], effortLevels: string[], protocol: WorkflowRole.Protocol | null, adapterProfileID: string | null, adapterProfileSha256: Sha256 | null, priceSha256: Sha256 | null, evidence: SourceEvidence[], availability, compatibility, lifecycle, missingObservation: { firstAt: number, lastAt: number, count: number } | null }` with the spec's exact status literals. Provider metadata alone cannot self-certify a binding.
- `Catalogue`: `{ schemaVersion: 1, scopeSha256: Sha256, observedAt: number, models: ModelEntry[], sha256: Sha256 }`, canonical-sorted by exact provider/ID before hashing.
- `Policy`: `{ schemaVersion: 1, scopeSha256: Sha256, choices: Record<Family excluding "unknown", { providerID, modelID: string }>, sha256: Sha256 }`; three complete choices, no implicit cross-family replacement.
- `Head`: `{ schemaVersion: 1, scopeSha256: Sha256, generation: number, catalogueSha256: Sha256, policySha256: Sha256, sha256: Sha256 }`.
- `View`: `{ head: Head | null, catalogue: Catalogue | null, policy: Policy | null, stale: boolean, refreshStatus: "idle" | "refreshing" | "failed", failureCode: string | null }`; no raw HTTP/body/auth fields.
- `ActivationInput`: `{ expectedHeadSha256: Sha256, replacements: Array<{ family: Family excluding "unknown", providerID, modelID: string }> }`; 1–3 unique families, explicit POST/CLI confirmation, no profile/capability/price/endpoint supplied by caller.
- `RefreshInput`: exact `{ force: boolean }`, owned by MC1 and consumed by MC6.
- `RouteSelection`: `{ providerID, modelID: string, protocol: WorkflowRole.Protocol, reasoningEffort: WorkflowRole.ReasoningEffort, requiredCapabilities: string[], adapterProfileID: string, adapterProfileSha256: Sha256, priceSha256: Sha256, advertisedRevision: string | null }`.
- `AdmissionSnapshot`: `{ schemaVersion: 1, catalogueSha256: Sha256, policySha256: Sha256, scopeSha256: Sha256, routes: Record<WorkflowRole.Role, RouteSelection>, sha256: Sha256 }`.
- `CatalogError`: typed codes `invalid_metadata`, `discovery_failed`, `unverified_contract`, `selection_required`, `selection_conflict`, `model_unavailable`, `scope_mismatch`, `snapshot_corrupt`, `approval_mismatch`; messages are static/body-free.

`scopeSha256` binds the configured first-party provider origins and trusted credential/integration reference plus configuration revision, never the plaintext key or a key-derived digest. Credential replacement/origin change invalidates the discovery scope. An unconfigured scope returns a configuration diagnostic without a GET; no existing credential file is read by tests.

Use these future test helpers in `packages/core/test/fixtures/workflow-model-catalog.ts` (created in MC1): `fixtureCatalogue(overrides?: Partial<Catalogue>): Catalogue`, `fixturePolicy(catalogue: Catalogue): Policy`, `fixtureDiscovery(providerID: ProviderID, entries: readonly ModelEntry[]): unknown`. They contain invented successor identifiers and fake prices only, not claims about available real models. Cover all seven roles and all three families.

The test excerpts below pin names/assertions rather than repeat package fixture wiring. In service/storage excerpts, `catalogue`, `policy`, `store`, `service`, and `location` are the real MC1/MC2 objects initialized by the test's package fixture under an injected D temp root, with readiness signals and scoped disposal. Do not replace their behavior with mocks.

---

### Task MC1: Define Validated Catalogue and Pure Eligibility Rules

**Files:** Create the Schema DTO file, `model-catalog/policy.ts`, `packages/core/test/workflow-model-catalog-policy.test.ts`, and the fixture file above. Existing `workflow-role.ts` roles/effort literals remain unchanged.

**Interfaces:** Produce `normalizeCatalogue(input: unknown, scopeSha256: string): Catalogue`, `mergeObservation(previous: Catalogue | null, observed: Catalogue, now: number): Catalogue`, `eligible(entry: ModelEntry, role: WorkflowRole.Role): boolean`, and `replacePolicy(input: { catalogue: Catalogue, policy: Policy, replacements: ActivationInput["replacements"] }): { catalogue: Catalogue, policy: Policy }`. Schema DTOs and canonical hashes are the only persisted outputs.

- [x] **Step 1: Write failing pure-policy tests.** Assert a fixture same-family Kimi successor is visible/eligible for all three Kimi roles only with a trusted Chat profile and vision; Kimi 2.x is excluded even if a reply claims flagship lineage. A Flash successor cannot retire Pro; unknown/specialized lineage is unverified; unsupported high/max effort and missing required capabilities fail. Reordered replies and `created` values do not change choices/hashes. For omission: one observation at `t=0`, a second at `t=3_599_999` do not mark missing; a complete successful observation at `t=3_600_000` does. Duplicate IDs/conflicting profiles and unknown persisted fields are rejected.

```ts
test("rejects Kimi 2.x despite claimed flagship lineage", () => {
  const current = fixtureCatalogue().models.find((entry) => entry.providerID === "kimi")!
  expect(eligible({ ...current, modelID: "kimi-k2.7", family: "kimi-flagship" }, "visual_review")).toBe(false)
})
```

- [x] **Step 2: Run RED.** From `packages/core`: `bun test test/workflow-model-catalog-policy.test.ts`; verify failures concern missing APIs/incorrect assertions, not fixture setup.
- [x] **Step 3: Implement the DTOs, profile descriptors and pure functions with exact spec constants.** Use hash/secret-guard conventions, reject backwards observation time, never parse generation/order from arbitrary model IDs. The Kimi 2.x deny policy wins over alleged lineage. A replacement requires verified lineage and cannot replace a newer selection with its predecessor. Descriptor definitions belong to Schema so both Core source verification and the later LLM binding use one dependency-safe authority.
- [x] **Step 4: Run GREEN/typechecks.** The new policy test passes; `bun typecheck` in Schema and Core passes.
- [x] **Step 5: Commit/push.** Stage only MC1 files; `feat(workflow): define model catalogue eligibility` and push `fork/dev`.

### Task MC2: Implement First-Party Discovery and Crash-Safe Snapshot Storage

**Files:** Create `model-catalog/{sources,discovery,credential-scope,store,service}.ts`, `packages/core/test/workflow-model-catalog-{discovery,store}.test.ts`, and `workflow-model-catalog-store-worker.ts` (a retained crash-test fixture). `credential-scope.ts` reads existing `credential/sql.ts` metadata through the injected Database service; environment-file references use the existing launcher's `OPENCODE_ENV_FILE` path and filesystem metadata through injected runtime configuration. No public Credential DTO, credential-body copy or SQL migration is needed.

**Interfaces:** `CredentialScope.resolve(providerID: ProviderID): Effect<{ referenceID: string, revision: string, origin: string }, CatalogError>` reads metadata-only credential/integration identity and its update revision through the trusted runtime. Database credentials use their ID and existing `time_updated`; environment-file credentials use an opaque runtime reference and reload/file-metadata revision, not key hashing or file-body logging. Environment-only credentials without a stable revision require fresh discovery before activation/admission, not reuse of another account's cached availability. `Discovery.refresh(providerID: ProviderID, scopeSha256: string): Effect< Catalogue, CatalogError >` obtains credentials through the injected existing credential/HTTP services, not a key argument. `Sources.verify(entry: ModelEntry, evidence: readonly SourceEvidence[]): ModelEntry` uses MC1's `adapterProfile` and first-party normalized evidence; profiles/lineage/prices from bare model-list fields remain unverified. `Store.open(root: string, scopeSha256: string)` returns `read(): Promise<View>`, `publish(input: { expectedHeadSha256: string | null, catalogue: Catalogue, policy: Policy }): Promise<Head>`. `Service.view(): Effect<View, CatalogError>` and `Service.refresh(force?: boolean): Effect<View, CatalogError>` share this store and injected clock.

- [ ] **Step 1: Write failing transport/storage tests.** Use a local deterministic transport behind an injected trusted test origin (production rejects that origin). Assert GET-only, no completion/Responses POST, redirects denied, 10-second deadline, 2 MiB/256-entry limits, typed 401/429/5xx/invalid/truncated JSON, and zero fake-key canary leaks. Failed refresh preserves the prior head; credential/origin revision changes produce a different scope and do not reuse account availability. Real sibling processes synchronize with readiness markers, race two CAS publications, and kill the writer before/after head rename; restart observes the old or complete new pair, never a partial pair.

```ts
test("CAS rejects a second initial publication without changing the head", async () => {
  const head = await store.publish({ expectedHeadSha256: null, catalogue, policy })
  await expect(store.publish({ expectedHeadSha256: null, catalogue, policy })).rejects.toMatchObject({
    code: "selection_conflict",
  })
  expect((await store.read()).head).toEqual(head)
})
```

- [ ] **Step 2: Run RED.** Core `bun test test/workflow-model-catalog-discovery.test.ts test/workflow-model-catalog-store.test.ts` must fail on the intended behavior.
- [ ] **Step 3: Implement discovery/source verification/store/service.** Reuse `Flock` under the configured D state root; bound lock waits and honor cancellation. Write immutable `catalogues/<sha>.json` and `policies/<sha>.json`, then atomically replace `head.json` under the lock after CAS and rehash. Reject root/child links, reparse points and path escapes. Keep failed refresh status outside immutable content hashes. Timer uses a scoped hourly schedule; disposal cancels requests and releases resources. No external metadata fetch occurs in deterministic/benchmark composition.
- [ ] **Step 4: Verify the Kimi source before enabling its production discovery parser.** Inspect current first-party documentation/OpenAPI without credentials; record endpoint/schema/hash in a reviewed source contract. If authoritative fields cannot be verified, retain candidates as unverified and return a Kimi discovery-contract diagnostic. Do not invent response fields, use a third-party catalogue, perform a credentialed GET, or silently advertise Kimi discovery as live-verified. This limitation is explicit in the handoff and is not a license to relax activation.
- [ ] **Step 5: Run GREEN/typecheck.** Both integration suites pass with real filesystem/process CAS tests and no paid requests; Core `bun typecheck` passes.
- [ ] **Step 6: Commit/push.** `feat(workflow): persist and refresh trusted model catalogues`.

### Task MC3: Add Explicit Atomic Activation and Retirement

**Files:** Extend `model-catalog/service.ts`; create `packages/core/test/workflow-model-catalog-activation.test.ts`. Reuse MC1/MC2 policy/store rather than duplicate lifecycle state.

**Interfaces:** Add `Service.activate(input: ActivationInput): Effect<View, CatalogError>` and `Service.snapshot(): Effect<AdmissionSnapshot, CatalogError>`. Activation reloads the exact head under CAS and uses MC1 replacement rules; snapshot expands the three selected families into the seven fixed roles with their exact effort/capability requirements. Bootstrap may preserve the known legacy selections as explicit policy history, but cannot fabricate current availability/prices or activate a newly discovered ID.

- [ ] **Step 1: Write failing activation tests.** Assert discovery alone leaves policy unchanged; explicit replacement publishes catalogue+policy together, hides the predecessor from normal new-task choices and preserves its immutable history. Stale confirmation yields `selection_conflict`. Mixed invalid replacements make no change. The same candidate with changed profile/price requires a fresh confirmation. Unknown price cannot create an eligible metered route; no activation invents a spend approval. Independent family replacement leaves the other two selections fixed. Reverse-generation rollback, Kimi 2.x and unverified lineage are rejected.

```ts
test("discovery publishes candidates without activating them", async () => {
  const before = await Effect.runPromise(service.view())
  await Effect.runPromise(service.refresh(true))
  expect((await Effect.runPromise(service.view())).policy?.sha256).toBe(before.policy?.sha256)
})
```

- [ ] **Step 2: Run RED.** Core `bun test test/workflow-model-catalog-activation.test.ts`.
- [ ] **Step 3: Implement both service methods.** Inputs contain identifiers/families only; trusted catalogue owns evidence and price/profile bindings. Return a body-free diff to the user surface, not key/provider payloads. No provider generation or mutable global registry is involved.
- [ ] **Step 4: Run GREEN/typecheck.** Activation suite and MC1/MC2 suites pass; Core `bun typecheck` passes.
- [ ] **Step 5: Commit/push.** `feat(workflow): confirm model replacements atomically`.

### Task MC4: Bind Dynamic Model IDs to Tested Provider Contracts

**Files:** Create `packages/llm/src/model-contract.ts` and `packages/llm/test/provider/model-contract.test.ts`; modify `capabilities.ts`, `providers/{kimi,deepseek}.ts`, `index.ts` and existing capability/Kimi/DeepSeek tests.

**Interfaces:** `ModelContract.bind(input: { providerID: ProviderID, modelID: string, profileID: string, profileSha256: string, capabilities: readonly string[], effortLevels: readonly string[], sourceSha256: string }): Binding` produces a validated immutable binding for a compiled, tested wire profile. `Binding` is a readonly factory-owned object containing those exact fields, privately branded to reject plain-object injection. Initially supported profile IDs are `kimi-chat-k3-v1` and `deepseek-responses-v4-v1`; use MC1 descriptors, with `profileSha256` equal to the normalized descriptor's `wireContractSha256`, not a second independent registry. `Kimi.configure` and `DeepSeek.configure` gain optional private runtime `modelContract: Binding`; existing no-binding calls retain exact legacy behavior. Capability lookup accepts that per-instance binding without registering it globally.

- [ ] **Step 1: Write failing wire-level tests.** Use invented successor IDs bound by trusted fixture contracts. Assert exact model ID reaches Chat or Responses unchanged; high/max, strict output, required tools, reasoning replay, paired images for Kimi, terminal incomplete/failed and usage semantics remain correct. Binding one instance never enables another. Wrong provider/profile/hash, forged capability, unsupported protocol/effort and unbound future IDs fail. Existing legacy fixtures preserve their request bodies and hashes.

```ts
test("a future model works only in its verified per-instance binding", () => {
  const profile = WorkflowModelCatalog.adapterProfile("deepseek-responses-v4-v1")!
  const binding = ModelContract.bind({
    providerID: "deepseek",
    modelID: "deepseek-pro-successor-fixture",
    profileID: profile.id,
    profileSha256: profile.wireContractSha256,
    capabilities: profile.capabilities,
    effortLevels: profile.effortLevels,
    sourceSha256: "a".repeat(64),
  })
  expect(String(DeepSeek.configure({ modelContract: binding }).responses(binding.modelID).id)).toBe(binding.modelID)
  expect(() => DeepSeek.configure().responses("deepseek-pro-successor-fixture")).toThrow()
})
```

The unbound fail-closed assertion accompanies the new binding-positive wire assertion; RED must come from missing binding behavior, not from changing the legacy guard. Full request/SSE fixtures separately exercise the wire-level properties listed above.

- [ ] **Step 2: Run RED.** From LLM: `bun test test/provider/model-contract.test.ts test/capabilities.test.ts test/provider/kimi-k3.test.ts test/provider/deepseek-responses.test.ts`.
- [ ] **Step 3: Implement binding-driven construction/validation.** Preserve existing body projectors/SSE parsers and protocol paths. Resolve a contract once per immutable model instance; never use a changing catalogue inside the parser. Current profiles keep their historical semantics. A genuinely different API needs a new profile/adapter release; metadata cannot install it or relax validation. Strip private binding options before constructing wire request bodies.
- [ ] **Step 4: Run GREEN/typecheck.** All four suites and LLM `bun typecheck` pass. Compare exact baseline request fixtures; generic unrelated providers remain unchanged.
- [ ] **Step 5: Commit/push.** `feat(llm): bind model identifiers to verified adapter profiles`.

### Task MC5: Freeze Admission/Response Routes and Gate Unavailable Recovery

**Files:** Create Core `workflow/{model-selection,model-availability}.ts` and `test/workflow-model-selection.test.ts`; modify `workflow/{admission,routing,executor,projector}.ts`, `workflow/execution/{contract,role-binding,local}.ts`, `responses/admission.ts`, `workflow.ts`, Schema `workflow-event.ts`; extend existing admission/recovery/role-security tests.

**Interfaces:** MC5 owns `FrozenSelection = { readonly schemaVersion: 1, readonly locationSha256: string, readonly snapshot: AdmissionSnapshot, readonly sha256: string }`, `ModelSelection.freeze(snapshot: AdmissionSnapshot, location: Location.Ref): FrozenSelection`, and `ModelSelection.fromWorkflow(workflow: Workflow.Info): FrozenSelection`. The latter verifies the owner, canonical hash and reserved internal input key `workflow.model-selection.v1`. `WorkflowRouting.resolve` accepts optional `selection: FrozenSelection`, widens the validated output `modelID` to string, and binds MC4 contracts. No selection means the exact legacy route table, never today's catalogue. `ModelAvailability.check(selection: FrozenSelection): Effect<void, CatalogError>` checks current availability without replacing the pinned model. Add admission receipt V2 with selection; retain the exact V1 codec and kind `workflow.visual-build.admission-receipt.v1` for old records. New V2 uses `workflow.visual-build.admission-receipt.v2`.

- [ ] **Step 1: Write failing durable tests.** Admit with policy P1, activate P2, then restart/continue/deliver under P1; assert no settled provider/tool turn repeats and Response model equals the admitted deliver route. Exact idempotency retries after activation return P1 rather than mint P2. Tampering with nested model/profile/price/owner hashes fails. Legacy V1 receipt fixtures still decode/rehash identically using fixed legacy profiles, not current defaults. The normal caller cannot forge the reserved selection input. An unavailable pinned model stops without dispatch; reinstating its availability allows explicit retry on that same model only.

```ts
test("a frozen admission keeps its exact delivery model", async () => {
  const snapshot = await Effect.runPromise(service.snapshot())
  const selection = ModelSelection.freeze(snapshot, location)
  const route = WorkflowRouting.resolve({ role: "deliver", budget: {}, selection })
  expect(route.modelID).toBe(snapshot.routes.deliver.modelID)
  expect(selection.snapshot.sha256).toBe(snapshot.sha256)
})
```

- [ ] **Step 2: Run RED.** Core `bun test test/workflow-model-selection.test.ts test/workflow-admission.test.ts test/workflow-role-session-security.test.ts test/workflow-recovery.test.ts`.
- [ ] **Step 3: Implement versioned selection and receipt validation.** New admissions read MC3 snapshot once; exact retries reconcile the existing semantic request and its stored receipt before resolving new defaults. Persist the selection with existing admission's related batch. Update all production route/authority reconstruction sites, including executor and contract verification, to the same selection. New authority/role-receipt V2 binds `modelSelectionSha256`; retain the exact V1 authority/role-receipt codecs and hashes. V1 validation remains isolated and immutable. No SQL/event-store rewrite or reinterpretation of historical fingerprints.
- [ ] **Step 4: Implement the additive configuration gate.** Before an unsettled provider dispatch, check pinned availability and publish a fenced `WorkflowEvent.Approval.Requested` with additive reason `workflow_model_required`, failure code `model_unavailable`, and no fabricated usage. Extend reason handling/projector validation only as necessary for this new business gate; keep existing event payloads valid. Do not change `WorkflowRetry.decide`, lease algorithms or ambiguous-tool semantics. Cancellation/lease loss wins; explicit existing recovery retry can resume only when the original binding is available and any metered approval still matches. Changing the model requires a new admission, not editing its checkpoint.
- [ ] **Step 5: Verify metered boundary and settlement.** Existing benchmark approvals/seals retain exact model/profile/price checks; new bindings cannot borrow old approval. Production selection cannot bypass broker policy. Extend generated event/API contracts only through repository generation when exposed. If this work needs a scheduler algorithm or migration change, stop and revise the plan before implementing it.
- [ ] **Step 6: Run GREEN/typechecks.** New and existing admission/recovery/role-security suites pass; run workflow crash/cancel/late-result suites and affected Schema/Core/Protocol typechecks. Rehash retained V1 fixtures.
- [ ] **Step 7: Commit/push.** `feat(workflow): persist selected model routes across recovery`.

### Task MC6: Expose Shared Choices/Confirmation and D-Root Runtime Composition

**Files:** New Protocol group, Server handler, CLI `workflow-models.ts` and corresponding tests; modify `protocol/api.ts`, `server/{handlers,routes}.ts`, CLI `workflow.ts`, existing `models.ts`, deployment scripts and generated Client outputs via the generator.

**Interfaces:** Authenticated endpoints: `GET /api/workflow-models` → `{ data: View }`; `POST /api/workflow-models/refresh` with `{ force: boolean }` → `{ data: View }`; `POST /api/workflow-models/activate` with `ActivationInput` → `{ data: View }`. Method IDs are `workflowModels.list`, `.refresh`, `.activate`. Public payloads never accept origin, key, profile, capabilities or price. CLI: `opencode workflow models [--refresh] [--json]`; `opencode workflow models activate <family> <modelID> [--yes]`. `--yes` is explicit user confirmation, not a runtime bypass; noninteractive activation without it fails before mutation. No model tool exposes this administration surface.

- [ ] **Step 1: Write failing CLI/API tests.** CLI/API publish identical sanitized choices; fake new candidates require compatibility then activation; declined/noninteractive confirmation and stale head do not mutate state. Display current→replacement, affected roles, price status and pinned-task warning before confirmation. CLI workflow progress displays admitted model IDs, not static K3/V4 labels. Existing generic `opencode models` consumers stay unchanged; provide the workflow catalogue view without overwriting unrelated generic provider/default selections. Request fields that attempt to inject keys/origins/contracts are rejected; unauthenticated callers cannot activate; discovery errors never return bodies.

```ts
test("the refresh API cannot inject a provider origin", () => {
  expect(() =>
    Schema.decodeUnknownSync(WorkflowModelCatalog.RefreshInput)({ force: true, origin: "https://untrusted.invalid" }),
  ).toThrow()
})
```

- [ ] **Step 2: Run RED.** Server `bun test test/workflow-model-catalog.test.ts`; CLI `bun test test/cli/workflow-models.test.ts test/cli/workflow.test.ts`. Both new test files are created in this task.
- [ ] **Step 3: Implement surfaces/composition.** Reuse Protocol global authorization, LayerNode service injection, existing credential lookup and generated clients. Configure `OPENCODE_WORKFLOW_MODEL_CATALOG_ROOT` through the launcher as `D:\OpenCode-Local\data\workflow-model-catalog`; reject unsafe paths through existing deployment guards. Test/benchmark layers disable external discovery and use injected catalogues. Startup migration does not grant new capabilities or send generation calls. Missing initial verified selection is an explicit selection/configuration diagnostic, not invented freshness.
- [ ] **Step 4: Generate and verify Client twice.** In `packages/client`: `bun run generate`; compare hashes across a second generation; `bun typecheck` and package tests pass. No hand edits to `src/generated`/`src/generated-effect`.
- [ ] **Step 5: Run GREEN/typechecks and launcher tests.** Affected Server/Protocol/Client/CLI suites pass, deployment tests assert D roots and no discovery/generation side effects during `--version`/`--help`.
- [ ] **Step 6: Commit/push.** `feat(workflow): expose confirmed model catalogue choices`.

### Task MC7: Offline Product Acceptance, Review, Rebuild and Handoff

**Files:** Create `packages/server/test/workflow-model-catalog-e2e.test.ts`, `packages/server/test/workflow-model-catalog-probe.ts` and its retained process-worker fixture; update this plan's evidence/checklists. Deployment uses existing scripts, no new ad hoc installer.

**Interfaces:** `runCatalogueProbe(executable: string): Promise<ProbeResult>` in the new probe fixture invokes the exact source/deployed binary and returns a schema-checked, body-free `ProbeResult = { generationCallsDuringDiscovery: number, generationCallsDuringActivation: number, settledCallsReplayed: number, originalModelID: string, recoveredModelID: string, selectedSuccessorID: string, newAdmissionModelID: string }`. A zero-credit smoke exercises MC6 list/refresh/activation against a private deterministic transport composition. The fake transport must not be a public production endpoint override; absence of its test binding restores ordinary first-party behavior.

- [ ] **Step 1: Write/run RED for the full lifecycle.** Local fake metadata/streams exercise discover→unchanged policy→confirmation→retirement→new admission, and independent already-admitted continuation→original delivery. Inject process death at immutable-file/head publication, activation/admission boundary, pending/settled provider continuation and configuration gate. Include concurrent activation, alias drift, cancellation/lease loss and redacted credentials. Assert zero generation during discovery/activation, exact routes during actual fake execution and zero duplicate settled calls.

```ts
test("exact-binary discovery and activation do not generate or replace admitted work", async () => {
  const result = await runCatalogueProbe(executable)
  expect(result.generationCallsDuringDiscovery + result.generationCallsDuringActivation).toBe(0)
  expect(result.settledCallsReplayed).toBe(0)
  expect(result.recoveredModelID).toBe(result.originalModelID)
  expect(result.newAdmissionModelID).toBe(result.selectedSuccessorID)
})
```

- [ ] **Step 2: Run GREEN and package regression gates.** Execute the new E2E and all MC1–MC6 tests, affected package typechecks, focused lint/format/diff checks and real-key-shape scans with fake canaries distinguished. Existing benchmark fixed-arm/seal tests must still reject substitutions; do not refreeze or rerun the full old campaign under changed source and claim its historical seal is current. Read-only final files/graphs remain retained.
- [ ] **Step 3: Review the native implementation before deployment.** Use the required requesting-code-review workflow for one whole-range fresh review; fix findings with covering tests and scoped commits. Reviewer limitations do not replace actual runtime gates. No per-step subagent implementation or extra worktree is requested.
- [ ] **Step 4: Commit/push clean reviewed runtime source.** Verify `dev` equals `fork/dev`, no secrets/local runtime state are staged, and record the exact source commit. Build/deploy only from that clean source; subsequent fixes repeat this step.
- [ ] **Step 5: Rebuild and update D deployment.** With pinned Bun/Node/models/build inputs and D temp/cache/config/data roots, use the existing Windows single-file build, `scripts/test-local-deploy.ps1`, and `scripts/deploy-local.ps1`. Before replacing the currently measured r4 executable, preserve a rehashed historical copy at `D:\OpenCode-Benchmark\Task24\toolchain\modified\<binary-sha256>\opencode.exe` so later rollback rotations cannot erase that campaign's binary input. Stage/verify before atomic replacement and retain the previous binary/hash as rollback. Do not claim deployed source equals a later doc-only commit. The old campaign is historical after runtime updates: a verifier targeting the new deployment must not be claimed to validate its old binary lock; a later readiness task creates a new active campaign without rewriting this one.
- [ ] **Step 6: Verify the exact deployed executable.** Through `D:\OpenCode-Local\bin\opencode.cmd`, check version/help and the private zero-credit catalogue/product scenario; verify catalogue paths, role pins, redaction, no-contract ordinary behavior and rollback identity. A credentialed `/models` smoke or billable protocol probe remains a separate opt-in gate. No paid pilot runs here.
- [ ] **Step 7: Record proof and cleanup.** Save counts, source/binary hashes, exercised profile IDs, fake/live distinction, Kimi source-verification status and any remaining limitations in tracked documentation. Remove only verified owned intermediates once final evidence is durable; report safety/policy-blocked leftovers. Reverify after cleanup, then push the documentation checkpoint.

## Verification Commands and Execution Environment

Use existing `D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe`. Set process-local `TEMP`, `TMP`, XDG data/config/cache, Bun/npm caches to task-specific D children before tests/build. Use native PowerShell file operations; no recursive cleanup workaround for policy-blocked targets.

Each task lists package-local test commands. Always run `bun typecheck` in each affected package; do not run root tests or invoke `tsc` directly. Format only touched files with the installed formatter; run `git diff --check`. Each implementation commit stages its file list only, then `git push fork dev` (existing ephemeral proxy configuration may be used, never persisted or force-pushed).

Build/deploy commands remain:

```powershell
# After the source gates, review, commit and push are complete.
Push-Location 'D:\OpenCode-Audit\packages\opencode'
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' run script/build.ts --single --skip-install
Pop-Location
& 'D:\OpenCode-Audit\scripts\test-local-deploy.ps1'
& 'D:\OpenCode-Audit\scripts\deploy-local.ps1' -SourceRoot 'D:\OpenCode-Audit' -DeploymentRoot 'D:\OpenCode-Local' -Version $env:OPENCODE_VERSION
& 'D:\OpenCode-Local\bin\opencode.cmd' --version
```

Before running, set a new task-specific `OPENCODE_VERSION` and the existing verified build-input environment; do not reuse the old r4 identity. This plan does not approve a credentialed metadata call, model-generation call, price quote or paid campaign. No current model names/prices are inferred from fake successor fixtures.

## Self-Review and Handoff

- Spec coverage: catalogue/source trust and lifecycle → MC1/MC2; confirmation/retirement → MC3; adapters → MC4; immutable admissions/recovery/seals → MC5; shared CLI/API/roots → MC6; process/security/deployment/cleanup → MC7. All twelve spec acceptance cases are assigned; the other three readiness subsystems are excluded.
- Review Focus cases have explicit owning test steps. All new DTOs/services/factories are defined above before consumption. No new SQL schema, mutable global capability table, silent model fallback, paid probe or historical-receipt reinterpretation is planned.
- Execution method is native, preserved from the prior workflow. The next gate is the user's written-plan review; approval starts MC1, not the other readiness subsystems or a paid pilot.

## Execution checkpoint — MC1, 2026-10-11

The user approved the written plan. MC1 source is committed and pushed as `22fc28b70` (`feat(workflow): define model catalogue eligibility`); only its four new files changed. Existing Task2–9 execution algorithms, provider adapters, production admission and deployment remain unchanged. This is not a finished automatic-discovery feature: MC2–MC7 have not been implemented or reviewed.

- RED: missing module, then API stubs produced eight intended behavior failures; pure implementation passed twelve tests. Additional cross-provider evidence and cyclic/cross-family lineage tests failed before their fixes.
- GREEN: catalogue policy 14 pass / 0 fail / 51 assertions. Catalogue + existing routing/secret-guard regression: 64 pass / 0 fail / 169 assertions. Schema suite: 37 pass / 0 fail / 143 assertions. Schema and Core typechecks pass; the push hook completed 31/31 workspace typecheck tasks.
- Full Core baseline, started before MC1 implementation: 1,627 pass, 7 skip, 1 fail, 1 error, 5,016 assertions across 178 files (612.92 seconds). The failure is `Snapshot > isolates snapshot indexes by canonical Git worktree`, at its existing 30-second timeout; cleanup then produced an unhandled ENOENT for that test's snapshot directory. This is not reported as a green full suite.
- The unchanged Snapshot test independently reproduced the 30-second timeout. A temporary diagnostic running the same steps/assertions with a longer observation bound passed all four assertions in 33.79 seconds: setup 4.67 seconds, first capture 18.57 seconds, second capture 30.83 seconds, separate Location lookup 33.77 seconds. No production or existing test source was changed by the diagnostic.
- Before proceeding to MC2, request user direction on a narrowly scoped Windows-only deadline correction for this existing test. Do not silently widen the approved MC1 file list or weaken its assertions.
- No real credentials or `.env.local` were read; no authenticated discovery, generation or paid probe ran. Catalogue fixtures are invented offline data. All task-owned runtime/test roots were on D. Temporary diagnostic source/output are removed after this evidence is recorded; the in-flight plan ledger and full baseline log remain needed for continuation.

Public source follow-up, without credentials: Kimi's [official model-list reference](https://platform.kimi.com/docs/api/list-models) is now readable and documents `/v1/models` and model capability fields. Its [overview](https://platform.kimi.com/docs/api/overview) also lists a Responses endpoint. MC2 can use that first-party discovery-schema evidence; this does not prove account access, successor lineage, pricing or a new tested wire contract, and does not authorize changing the agreed historical Chat profile.
