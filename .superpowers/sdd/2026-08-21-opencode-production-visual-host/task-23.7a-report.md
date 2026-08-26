# Task 23.7A report — strict role contracts and atomic business-evidence authority

## Status

Implemented and locally verified on the existing `dev` checkout.

- Base SHA: `6c509f7e4d50253b7a0b29577fde03a156b216b1`
- Original implementation SHA: `04eb580ec`
- Original report/ledger completion SHA: `2904d19a1`
- No branch/worktree, push, deployment, provider call, network test, Docker, Chromium, ACL mutation, `.env.local` read, or C-drive Task23 cache was used.
- Review status: implementer self-review clean. The task explicitly prohibited spawning an independent reviewer.

## RED evidence

All commands ran from `D:\OpenCode-Audit\packages\core` with pinned Bun
`D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe` before production edits.

### RED 1 — contracts and fixed routing

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' test test/workflow-role-execution.test.ts test/workflow-design-loop.test.ts test/workflow-model-state-machine.test.ts test/workflow-routing.test.ts
```

Observed terminal result:

```text
error: Cannot find module '@opencode-ai/core/workflow/execution/contract'
(fail) WorkflowRouting > does not let a linked Response switch visual delivery to Flash
48 pass
2 fail
1 error
```

This proved that there was no role-contract/evidence authority module and that a linked deliver Response could still switch from the fixed Pro route to Flash.

### RED 2 — continuation durability and Local authority

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' test test/workflow-role-execution.test.ts test/workflow-location-tools.test.ts test/workflow-execution.test.ts test/workflow-routing.test.ts
```

Observed terminal result:

```text
error: Cannot find module '@opencode-ai/core/workflow/execution/contract'
(fail) Workflow Location tools > fails closed on a nonempty legacy continuation without a contract fingerprint
(fail) Workflow Location tools > recovers a provider request intent without reissuing the provider call
(fail) Workflow Location tools > resumes a durable provider result without a duplicate provider call and rejects drift
(fail) WorkflowRouting > does not let a linked Response switch visual delivery to Flash
63 pass
5 fail
1 error
```

The remaining failing assertion was the new versioned pending-intent/result durability fixture: the old v1 continuation neither carried the required contract/context/route fingerprints nor represented a durable provider turn. The provider-intent fixture observed a reissue, while the result fixture observed no durable normalized provider result to resume.

## Implementation decisions

### Exact role contracts

`execution/contract.ts` defines seven distinct, versioned exact envelopes, systems, message templates, output identifiers, and fingerprints. The fingerprint binds role/revision, fixed route/protocol/reasoning, prompt version, full typed messages, permission rules, exact sorted input artifact identities, and context.

The model controls only semantic output:

- design: strict spec and complete reference source text;
- decompose: semantic checklist/tasks;
- implement/repair/test: bounded summary plus admitted ToolRegistry calls;
- visual review: verdict/score/findings proposal only;
- deliver: bounded summary only.

Excess properties and host-authority fields fail decoding. Generic provider values are recursively rejected if they contain `dataBase64`, `data:image/`, PNG base64 signatures, or binary outside an explicit typed `media` message.

### Provider intent/result continuation

Continuation v2 binds contract, context, route, protocol, reasoning, tool-catalog fingerprint, and provider request fingerprint. Every turn now persists:

```text
provider request intent -> provider call -> bounded normalized provider result -> tool/final settlement
```

An intent without a result returns `provider_execution_ambiguous` and never reissues the provider. A durable result resumes without another call. Pending tool intent remains `tool_execution_ambiguous`. Nonempty v1 continuations fail `model_continuation_mismatch`; an empty v1 checkpoint remains a compatible no-op starting point.

### Business-evidence authority

`execution/role.ts` provides a narrow resolver service, complete deterministic fake, and fail-closed production layer. It accepts only persisted workflow/stage/revision/Location, decoded prior artifacts, strict semantic output, settled tool evidence, and admission inputs. It does not accept model/caller artifact identities, hashes, snapshots, selectors, URLs, preview identities, or evidence IDs.

The host mints a versioned outcome binding and receipt covering semantic outcome, contract fingerprint, exact context digest, canonical required-business-artifact-set digest, and outcome hash. Validation checks exact role/revision, workflow/stage owner, Location, codec, canonical URI/MIME/hash/size, cardinality, test-log references, paired screenshot set, delivery chain, verdict agreement, and binding/receipt digests. Test logs use the schema's existing 1 MiB bound.

### Atomic Local gate and compatibility

Local mints complete `Workflow.Artifact` identities, then revalidates the settlement before the one `Stage.Succeeded` related batch. Failure uses `invalid_role_evidence` through the existing atomic failure path and emits no artifact creation, branch skip, Workflow success, or Response completion.

Legacy non-visual workflows retain plain outcome replay. New `visual-build` settlement requires the versioned binding and receipt. Stage-machine replay understands both formats. The production evidence resolver intentionally remains unavailable/fail-closed until Task 23.7B.

The fixed route matrix remains:

- `design`, `decompose`, `visual_review`: Kimi `kimi-k3`, Chat;
- `implement`, `repair`, `deliver`: DeepSeek `deepseek-v4-pro`, Responses;
- `test`: DeepSeek `deepseek-v4-flash`, Responses.

A linked Response must exactly match its fixed route; deliver cannot switch to Flash.

## GREEN evidence

Final mandatory matrix, from `packages/core`:

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' test test/workflow-role-execution.test.ts test/workflow-design-loop.test.ts test/workflow-model-state-machine.test.ts test/workflow-location-tools.test.ts test/workflow-execution.test.ts test/workflow-business-artifacts.test.ts test/workflow-routing.test.ts
```

```text
102 pass
0 fail
495 expect() calls
Ran 102 tests across 7 files. [9.81s]
```

Final typecheck, from `packages/core`:

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' run typecheck
```

```text
$ tsgo --noEmit
exit 0
```

Changed-file formatting/lint, from the repository checkout:

```powershell
& '.\node_modules\.bin\prettier.exe' --write <11 changed TypeScript files>
& '.\node_modules\.bin\oxlint.exe' <11 changed TypeScript files>
```

```text
Found 0 warnings and 0 errors.
Finished in 2.8s on 11 files with 130 rules using 16 threads.
```

`git diff --check` and the staged equivalent both exited 0. The final mandatory suite was rerun after formatting.

## Required behavior coverage

- Seven distinct exact role envelopes/systems/messages/fingerprints and excess rejection.
- Host-authority field rejection for implement, repair, test, visual review, and deliver.
- Typed media and generic text/continuation screenshot-data rejection.
- Provider intent ambiguity with zero reissue; durable provider result and tool result resume with zero duplicate execution.
- Contract/context/route/catalog drift fail-close and legacy nonempty continuation fail-close.
- Missing, duplicate, wrong-URI/context, binding, receipt, and artifact-set tamper rejection.
- Wrong semantic verdict versus durable test result rejection.
- Exact test-log and visual screenshot extension-point required kinds.
- Local zero-partial-publication assertions on visual settlement failure.
- Legacy plain outcome compatibility and strict new visual binding admission.
- No production import of `WorkflowRender`.

## Files changed

- `packages/core/src/workflow/execution/contract.ts` (new)
- `packages/core/src/workflow/execution/role.ts` (new)
- `packages/core/src/workflow/execution/model.ts`
- `packages/core/src/workflow/executor.ts`
- `packages/core/src/workflow/execution/local.ts`
- `packages/core/src/workflow/routing.ts`
- `packages/core/src/workflow/stage-machine.ts`
- `packages/core/test/workflow-role-execution.test.ts` (new)
- `packages/core/test/workflow-location-tools.test.ts`
- `packages/core/test/workflow-execution.test.ts`
- `packages/core/test/workflow-routing.test.ts`

## Concerns and deferred work

- No architectural conflict was found. Task 23.7B must install the production evidence resolver and owns real Snapshot/filesystem manifesting, functional command/log derivation, preview/capture/media settlement, delivery freshness, and post-EventV2 evidence reconciliation.
- Original implementation concern (resolved by the independent-review fix below): `execution/role.ts` was 729 lines and needed focused extraction before Task 23.7B.
- No real provider, Docker, Chromium, ACL, network, deployment, or production-environment claim was made.

## Independent review fix round 1 — 2026-08-26

### Status and commit identity

- Review-fix implementation commit: `9750a6ce2` (`fix(workflow): harden role settlement authority`).
- This section and the progress-ledger correction are a separate documentation commit, so the code SHA above remains stable and is not described as the final visible `dev` SHA.
- All eight reviewer findings were verified as technically correct before editing. No new architectural conflict or `NEEDS_CONTEXT` condition was found.

### Focused RED evidence

All RED commands ran from `D:\OpenCode-Audit\packages\core` with pinned Bun before the corresponding production fixes.

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' test test/workflow-role-execution.test.ts
```

```text
(fail) Workflow role contracts > keeps media typed and rejects screenshot data in generic provider text
Received function did not throw
(fail) Workflow role contracts > binds the canonical response schema and sorts without locale authority
TypeError: undefined is not an object (evaluating 'built.authority.responseSchemaSha256')
10 pass
2 fail
```

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' test test/workflow-role-execution.test.ts test/workflow-location-tools.test.ts
```

```text
(fail) Workflow Location tools > resumes a durable provider result without a duplicate provider call and rejects drift
(fail) Workflow role contracts > keeps media typed and rejects screenshot data in generic provider text
(fail) Workflow role contracts > binds the canonical response schema and sorts without locale authority
(fail) Workflow role business-evidence authority > lets strict non-visual roles complete without evidence authority but never lets visual roles bypass it
(fail) Workflow role business-evidence authority > passes complete persisted authority to the resolver and validates prior identity before resolution
22 pass
5 fail
```

The generation-option case resumed a successful durable result after the workflow token budget changed, proving that the old request fingerprint did not bind the actual generation limit. The legacy case failed with `role_evidence_unavailable`, proving that strict non-visual execution incorrectly invoked the production resolver. The resolver capture contained only `{ id, type }` workflow facts and omitted budget/usage/provider usage and full artifact identity.

After adding the mutually consistent forged-authority fixture, its independent RED was:

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' test test/workflow-role-execution.test.ts
```

```text
(fail) Workflow role business-evidence authority > mints and validates a context/contract/artifact-set-bound role settlement
Expected substring: "contract authority"
Received message: "Unexpected key ... at [\"authority\"]"
13 pass
1 fail
```

This proved that the old receipt had no independently verifiable authority descriptor; it rejected only the unknown field, not a recomputed host-authority mismatch.

### Fix decisions and compatibility behavior

- Non-visual workflows still undergo strict contract/semantic decoding, but the executor bypasses business-evidence resolution and mints the compatible plain semantic outcome. A `visual-build` still requires a bound settlement, fail-closed evidence resolver, and host-measured provider usage.
- Resolver input now carries the complete persisted `Workflow.Info`, complete `Workflow.Stage`, complete prior `Workflow.Artifact` identities, admission inputs, workflow budget/usage, execution usage, and provider usage. Full identity, owner/time, URI/hash/size and codec validation occurs before identity is projected into decoded values. The deterministic fake derives visual limits/usage from these host facts.
- `contractFingerprint` now hashes a bounded authority descriptor containing the canonical actual response-schema digest, fixed route, prompt/system, typed-message digest/media identities, permissions, input artifacts and context. Local reconstructs the fixed contract from persisted host facts, recomputes the fingerprint, and rejects even mutually consistent forged binding/receipt pairs.
- Each provider turn now constructs one immutable canonical request snapshot containing the public model/route, system, messages, tools, response schema, generation options, catalog, sequence and contract fingerprint. The same snapshot fields are dispatched. Recovery rematerializes tools and recomputes the fingerprint before either resuming a result or returning intent-only ambiguity; schema and generation-option drift fail closed with zero provider reissue.
- Validated `Message` scanning is separate from generic provider/checkpoint scanning. Only a schema-valid media content part may contain `Uint8Array`; generic values reject every binary, media-shaped bypass, case-insensitive `dataBase64`, data URL and PNG signature. Legitimate typed media remains accepted.
- Durable artifact ordering uses ordinal code-unit comparison and no longer consults `localeCompare`.
- Legacy plain outcome replay remains compatible. New visual admission still requires the versioned binding/receipt. A trusted-message/media verification extension is explicit and fail-closed until Task 23.7B supplies persisted screenshot evidence.
- The 799-line review-time `role.ts` was reduced to 220 lines. Binding/context validation is owned by `execution/role-binding.ts`, the deterministic fake by `execution/role-fake.ts`, and the bounded log codec by `artifacts/test-log.ts`.

### Final GREEN and quality evidence

Mandatory Core matrix, run from `D:\OpenCode-Audit\packages\core` after formatting:

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' test test/workflow-role-execution.test.ts test/workflow-design-loop.test.ts test/workflow-model-state-machine.test.ts test/workflow-location-tools.test.ts test/workflow-execution.test.ts test/workflow-business-artifacts.test.ts test/workflow-routing.test.ts
```

```text
106 pass
0 fail
521 expect() calls
Ran 106 tests across 7 files. [10.59s]
```

Typecheck, run from `D:\OpenCode-Audit\packages\core`:

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' typecheck
```

```text
$ tsgo --noEmit
exit 0
```

Formatting and changed-file lint, run from `D:\OpenCode-Audit` with the exact literal file list:

```powershell
& '.\node_modules\.bin\prettier.exe' --write 'packages/core/src/workflow/artifacts/test-log.ts' 'packages/core/src/workflow/execution/contract.ts' 'packages/core/src/workflow/execution/model.ts' 'packages/core/src/workflow/execution/role-binding.ts' 'packages/core/src/workflow/execution/role-fake.ts' 'packages/core/src/workflow/execution/role.ts' 'packages/core/src/workflow/executor.ts' 'packages/core/test/workflow-execution.test.ts' 'packages/core/test/workflow-location-tools.test.ts' 'packages/core/test/workflow-role-execution.test.ts'
& '.\node_modules\.bin\oxlint.exe' 'packages/core/src/workflow/artifacts/test-log.ts' 'packages/core/src/workflow/execution/contract.ts' 'packages/core/src/workflow/execution/model.ts' 'packages/core/src/workflow/execution/role-binding.ts' 'packages/core/src/workflow/execution/role-fake.ts' 'packages/core/src/workflow/execution/role.ts' 'packages/core/src/workflow/executor.ts' 'packages/core/test/workflow-execution.test.ts' 'packages/core/test/workflow-location-tools.test.ts' 'packages/core/test/workflow-role-execution.test.ts'
```

```text
packages/core/src/workflow/artifacts/test-log.ts 54ms (unchanged)
packages/core/src/workflow/execution/contract.ts 54ms (unchanged)
packages/core/src/workflow/execution/model.ts 96ms (unchanged)
packages/core/src/workflow/execution/role-binding.ts 28ms (unchanged)
packages/core/src/workflow/execution/role-fake.ts 12ms (unchanged)
packages/core/src/workflow/execution/role.ts 9ms (unchanged)
packages/core/src/workflow/executor.ts 19ms (unchanged)
packages/core/test/workflow-execution.test.ts 78ms (unchanged)
packages/core/test/workflow-location-tools.test.ts 71ms (unchanged)
packages/core/test/workflow-role-execution.test.ts 32ms (unchanged)
Found 0 warnings and 0 errors.
Finished in 2.9s on 10 files with 130 rules using 16 threads.
```

`git diff --check` and `git diff --cached --check` exited 0; Git emitted only the repository's CRLF conversion warnings. No temporary/cache artifacts were created.

### Review-fix files changed

- `packages/core/src/workflow/artifacts/test-log.ts`
- `packages/core/src/workflow/execution/contract.ts`
- `packages/core/src/workflow/execution/model.ts`
- `packages/core/src/workflow/execution/role-binding.ts`
- `packages/core/src/workflow/execution/role-fake.ts`
- `packages/core/src/workflow/execution/role.ts`
- `packages/core/src/workflow/executor.ts`
- `packages/core/test/workflow-execution.test.ts`
- `packages/core/test/workflow-location-tools.test.ts`
- `packages/core/test/workflow-role-execution.test.ts`

### Remaining concern

No A-scope correctness concern remains. Task 23.7B must provide the trusted message/screenshot extension and production resolver; A continues to perform no real Snapshot/filesystem/preview/capture/evidence settlement/delivery-freshness work.

## Independent review fix round 2 — 2026-08-26

### Status and commit identity

- Review-fix implementation commit: `5117562b2` (`fix(workflow): bind exact provider requests`).
- This section and the progress-ledger entry are a separate documentation commit; the code SHA above identifies the reviewed implementation exactly.
- Both scoped reviewer findings were verified against the production paths before editing. No architectural conflict or `NEEDS_CONTEXT` condition was found.

### Focused RED evidence

The first RED command ran from `D:\OpenCode-Audit\packages\core` with pinned Bun, after adding the provider-observed-request and string-media-shape regressions and before production changes:

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' test test/workflow-role-execution.test.ts test/workflow-location-tools.test.ts
```

```text
(fail) Workflow Location tools > resumes a durable provider result without a duplicate provider call and rejects drift
Expected: true
Received: false
at expect(Object.isFrozen(observed)).toBe(true)
(fail) Workflow role contracts > keeps media typed and rejects screenshot data in generic provider text
Received function did not throw
26 pass
2 fail
154 expect() calls
Ran 28 tests across 2 files. [3.71s]
```

This directly proved that the provider-observed `LLMRequest` was mutable and that a string-backed media-shaped object escaped the generic scanner. The accompanying source trace showed the cause: the durable fingerprint was minted from pre-normalization input and dispatch separately invoked `LLM.request`; the test's subsequent actual-request fingerprint assertion could not exist against that old API.

A self-review RED added collision/separator variants before their production hardening:

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' test test/workflow-role-execution.test.ts
```

```text
(fail) Workflow role contracts > keeps media typed and rejects screenshot data in generic provider text
Received function did not throw
14 pass
1 fail
66 expect() calls
Ran 15 tests across 1 file. [954.00ms]
```

### Fix decisions and compatibility behavior

- `execution/provider-request.ts` now owns one canonical request builder. It invokes `LLM.request` exactly once, freezes the normalized request and its ordered system/message/tool arrays, fingerprints that same object, and dispatches that same object without reconstruction. Recovery invokes the identical builder with the public fixed route model and does not read credentials or reissue an ambiguous provider request.
- The bounded 256 KiB authority descriptor binds every normalized request field, full response JSON schema, ordered messages and tools, generation/provider/HTTP/cache/metadata options, fixed workflow route facts, non-secret model/endpoint/default/compatibility facts, contract fingerprint, catalog fingerprint, and sequence. Credential material is represented only as host authority; typed media payloads are represented by kind, SHA-256, and byte size rather than raw bytes or base64.
- The provider-observed integration fixture recomputes the durable fingerprint from the exact request received by `LLMClient.generate`. Schema, generation, tool-order, and message drift each produce a different fingerprint. Existing recovery cases prove contract/schema, context/message, generation, and tool-catalog drift fail closed with no additional provider call.
- Generic scanning now rejects case-insensitive media/image type tags, duplicate case-variant tags, image/media URL/URI/data/byte fields, MIME/media-type plus payload combinations, image/audio/video content-type payloads, and separator/case variants of `dataBase64`. These rules apply recursively to provider results, continuations, and tool values. Schema-validated top-level `Message` media remains accepted and is the only binary exception.
- Existing continuation versions and legacy non-visual outcome replay behavior are unchanged. Newly admitted visual settlement retains the strict binding/receipt authority from fix round 1.

### Final GREEN and quality evidence

Focused Core tests, run from `D:\OpenCode-Audit\packages\core` after formatting:

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' test test/workflow-role-execution.test.ts test/workflow-location-tools.test.ts
```

```text
28 pass
0 fail
182 expect() calls
Ran 28 tests across 2 files. [4.95s]
```

Mandatory Core matrix, run from `D:\OpenCode-Audit\packages\core`:

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' test test/workflow-role-execution.test.ts test/workflow-design-loop.test.ts test/workflow-model-state-machine.test.ts test/workflow-location-tools.test.ts test/workflow-execution.test.ts test/workflow-business-artifacts.test.ts test/workflow-routing.test.ts
```

```text
106 pass
0 fail
538 expect() calls
Ran 106 tests across 7 files. [10.94s]
```

Core typecheck, run from `D:\OpenCode-Audit\packages\core`:

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' typecheck
```

```text
$ tsgo --noEmit
exit 0
```

Formatting and changed-file lint, run from `D:\OpenCode-Audit` with exact literal file lists:

```powershell
& '.\node_modules\.bin\prettier.exe' --write 'packages/core/src/workflow/execution/contract.ts' 'packages/core/src/workflow/execution/model.ts' 'packages/core/src/workflow/execution/provider-request.ts' 'packages/core/test/workflow-location-tools.test.ts' 'packages/core/test/workflow-role-execution.test.ts'
& '.\node_modules\.bin\oxlint.exe' 'packages/core/src/workflow/execution/contract.ts' 'packages/core/src/workflow/execution/model.ts' 'packages/core/src/workflow/execution/provider-request.ts' 'packages/core/test/workflow-location-tools.test.ts' 'packages/core/test/workflow-role-execution.test.ts'
```

```text
packages/core/src/workflow/execution/contract.ts 121ms (unchanged)
packages/core/src/workflow/execution/model.ts 97ms (unchanged)
packages/core/src/workflow/execution/provider-request.ts 12ms (unchanged)
packages/core/test/workflow-location-tools.test.ts 100ms (unchanged)
packages/core/test/workflow-role-execution.test.ts 47ms (unchanged)
Found 0 warnings and 0 errors.
Finished in 2.7s on 5 files with 130 rules using 16 threads.
```

`git diff --check` and `git diff --cached --check` exited 0; Git emitted only the repository's CRLF conversion warnings. No temporary/cache artifacts were created.

### Review-fix files changed

- `packages/core/src/workflow/execution/contract.ts`
- `packages/core/src/workflow/execution/model.ts`
- `packages/core/src/workflow/execution/provider-request.ts` (new focused owner for canonical dispatch/fingerprinting)
- `packages/core/test/workflow-location-tools.test.ts`
- `packages/core/test/workflow-role-execution.test.ts`

### Remaining concern

No new A-scope correctness concern remains. The existing Task 23.7B boundary is unchanged: production visual evidence resolution and trusted screenshot settlement remain fail-closed and are not implemented or exercised here.

## Independent review fix round 3 — 2026-08-26

### Status and commit identity

- Review-fix implementation commit: `4bef87733` (`fix(workflow): own immutable provider requests`).
- This section and the progress-ledger entry are a separate documentation commit; the implementation SHA above is the exact code revision reviewed here.
- Both scoped findings were reproduced before production edits. No architectural conflict or `NEEDS_CONTEXT` condition was found.

### Focused RED evidence

After adding nested mutation attempts and generic separator/binary bypass cases, the corrected first behavioral RED ran from `D:\OpenCode-Audit\packages\core`:

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' test test/workflow-role-execution.test.ts test/workflow-location-tools.test.ts
```

```text
(fail) Workflow Location tools > dispatches a deeply immutable request, resumes its durable result, and rejects drift
expect(accepted).toBe(false)
Expected: false
Received: true
(fail) Workflow role contracts > keeps media typed and rejects screenshot data in generic provider text
Received function did not throw
26 pass
2 fail
167 expect() calls
Ran 28 tests across 2 files. [4.36s]
```

The mutation was accepted on a nested normalized request object, while spaced/dotted media-authority keys and non-`Uint8Array` binary views passed generic scanning. An earlier test-draft run addressed `model.defaults.providerOptions` even though the fixture owns that default at `model.route.defaults.providerOptions`; that fixture error was corrected before the behavioral RED above and was not treated as product evidence.

A second RED added an ownership assertion for schema-valid media bytes, again from the Core package:

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' test test/workflow-role-execution.test.ts
```

```text
(fail) Workflow role contracts > keeps media typed and rejects screenshot data in generic provider text
Received function did not throw
(fail) Workflow role contracts > owns immutable typed media bytes in the canonical provider request
expect(part.data).not.toBe(inputBytes)
14 pass
2 fail
74 expect() calls
Ran 16 tests across 1 file. [800.00ms]
```

After changing only the generic scanner, the scanner case passed while the media ownership test remained RED (`15 pass`, `1 fail`, `85 expect() calls`, `868.00ms`), isolating the request-ownership defect before its fix.

### Fix decisions and compatibility behavior

- `execution/provider-request.ts` still normalizes exactly once with `LLM.request`. It now constructs an exclusively owned `LLMRequest` graph from that normalized result, including independent system/messages/tools/schema/options/model data. The fingerprint descriptor reads that owned graph, and the exact same top-level request is dispatched.
- Model routing is re-created with owned endpoint, auth/transport wrappers, and independently cloned route defaults so freezing the canonical request cannot freeze a provider-shared route/default object. Provider body/schema/functions are retained as runtime capabilities rather than recursively freezing provider implementation state.
- Ordinary nested request data is recursively cloned and frozen. Schema-valid media bytes are copied into a mutation-denying `Uint8Array` proxy which preserves the provider-facing typed-media contract, `instanceof Uint8Array`, iteration and `Buffer.from` behavior without exposing the owned backing buffer.
- Generic contract scanning now removes every non-alphanumeric separator before comparing keys/tags. It therefore rejects spaced, dotted, underscored, hyphenated and case-varied `dataBase64`, type/media, MIME and recognized image/media fields consistently.
- Generic values reject `ArrayBuffer`, `SharedArrayBuffer` when available, and every `ArrayBuffer.isView` value, including `DataView` and all typed-array forms. The exception remains limited to bytes inside a schema-validated `Message` media part.
- Durable recovery, legacy replay, visual binding/receipt authority, fixed routing, and the Task 23.7B fail-closed production-evidence boundary are unchanged.

### Final GREEN and quality evidence

Focused Core tests, run from `D:\OpenCode-Audit\packages\core` after final formatting:

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' test test/workflow-role-execution.test.ts test/workflow-location-tools.test.ts
```

```text
29 pass
0 fail
216 expect() calls
Ran 29 tests across 2 files. [4.55s]
```

Mandatory Core matrix, run from `D:\OpenCode-Audit\packages\core`:

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' test test/workflow-role-execution.test.ts test/workflow-design-loop.test.ts test/workflow-model-state-machine.test.ts test/workflow-location-tools.test.ts test/workflow-execution.test.ts test/workflow-business-artifacts.test.ts test/workflow-routing.test.ts
```

```text
107 pass
0 fail
572 expect() calls
Ran 107 tests across 7 files. [9.75s]
```

Core typecheck, run from `D:\OpenCode-Audit\packages\core`:

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' typecheck
```

```text
$ tsgo --noEmit
exit 0
```

Formatting and changed-file lint, run from `D:\OpenCode-Audit` with exact literal file lists:

```powershell
& '.\node_modules\.bin\prettier.exe' --write 'packages/core/src/workflow/execution/contract.ts' 'packages/core/src/workflow/execution/provider-request.ts' 'packages/core/test/workflow-location-tools.test.ts' 'packages/core/test/workflow-role-execution.test.ts'
& '.\node_modules\.bin\oxlint.exe' 'packages/core/src/workflow/execution/contract.ts' 'packages/core/src/workflow/execution/provider-request.ts' 'packages/core/test/workflow-location-tools.test.ts' 'packages/core/test/workflow-role-execution.test.ts'
```

```text
packages/core/src/workflow/execution/contract.ts 95ms (unchanged)
packages/core/src/workflow/execution/provider-request.ts 23ms (unchanged)
packages/core/test/workflow-location-tools.test.ts 98ms (unchanged)
packages/core/test/workflow-role-execution.test.ts 50ms (unchanged)
Found 0 warnings and 0 errors.
Finished in 2.2s on 4 files with 130 rules using 16 threads.
```

`git diff --check` and `git diff --cached --check` exited 0; Git emitted only the repository's CRLF conversion warnings. No temporary/cache artifacts were created.

### Review-fix files changed

- `packages/core/src/workflow/execution/contract.ts`
- `packages/core/src/workflow/execution/provider-request.ts`
- `packages/core/test/workflow-location-tools.test.ts`
- `packages/core/test/workflow-role-execution.test.ts`

### Remaining concern

No new A-scope correctness concern remains. The Task 23.7B boundary is unchanged: production visual evidence resolution and trusted screenshot settlement remain fail-closed and were not exercised here.

## Fix round 3 independent scoped re-review

The fresh reviewer examined `eb66c126d..177867bf2` and returned **CLEAN**. Both remaining Important findings were addressed: the exact normalized provider request is now deeply owned and immutable across every fingerprinted/dispatched surface, and generic evidence scanning now rejects separator variants plus every ArrayBuffer/view binary representation while retaining the typed `Message` media path. No new Critical or Important breakage was found.
