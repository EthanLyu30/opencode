# Task 23.7A report — strict role contracts and atomic business-evidence authority

## Status

Implemented and locally verified on the existing `dev` checkout.

- Base SHA: `6c509f7e4d50253b7a0b29577fde03a156b216b1`
- Implementation SHA before report/ledger amendment: `04eb580ec`
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
- `execution/role.ts` is 729 lines because A requires the complete resolver contract, all contextual validators, the bounded test-log extension point, and a deterministic fake for all seven roles in the planned module. Task 23.7B should keep its production resolver in its owning module rather than expanding this authority file further.
- No real provider, Docker, Chromium, ACL, network, deployment, or production-environment claim was made.
