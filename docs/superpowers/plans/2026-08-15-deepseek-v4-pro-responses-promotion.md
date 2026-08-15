# DeepSeek V4 Pro Native Responses Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan one task at a time, and use superpowers:test-driven-development for every behavior change. Keep the review gate before the final commit.

**Goal:** Promote `deepseek-v4-pro` to the existing native DeepSeek Responses path and route implement/repair/deliver stages to Pro while retaining Flash for test stages and Kimi K3 for design/decompose/visual review.

**Architecture:** Reuse the existing provider-specific `/responses` protocol, SSE parser, workflow lifecycle, tool continuation, persistence, and gateway. Change only the canonical capability profile and deterministic routing policy, then prove that the Pro model identifier flows unchanged through provider and embedded gateway boundaries. Keep explicit Chat available as a legacy escape hatch and never introduce Pro-to-Flash fallback.

**Tech Stack:** TypeScript, Bun, Effect 4, Effect Schema, existing `@opencode-ai/llm` DeepSeek provider, Workflow V2 routing, Protocol/Server Responses gateway, SDK embedded tests.

## Global Constraints

- Work directly on `dev` as previously requested; do not create a feature branch or worktree.
- Use recorded/deterministic transports only. Do not send a paid DeepSeek request and do not read API keys into test output.
- Preserve `deepseek-v4-flash` native Responses behavior and Kimi K3-only routing.
- `DeepSeek.chat("deepseek-v4-pro")` remains explicit; automatic and default Pro selection must use native Responses.
- Keep the public Responses API's explicit Flash/Pro model selection separate from workflow stage route overrides: automatic `deliver` remains Pro, while a bound direct Response executes its validated requested model exactly.
- No model fallback, protocol fallback, new provider schema, database migration, or public Responses lifecycle semantic is authorized.
- The deferred Location/browser/preview visual host is outside Task22.

---

### Task 1: Promote the Canonical Pro Capability and Provider Route

**Files:**

- Modify: `packages/llm/test/capabilities.test.ts`
- Modify: `packages/llm/test/provider/deepseek-responses.test.ts`
- Modify: `packages/llm/src/capabilities.ts`

**Step 1: Write failing capability tests**

- Change the Pro expectation to protocol `openai-responses`, supported capabilities `chat`, `responses`, `structured_output`, and `required_tool_choice`, and an empty planned set.
- Assert `DeepSeek.model("deepseek-v4-pro")` and `DeepSeek.responses("deepseek-v4-pro")` both choose the native Responses route.
- Retain an assertion that `DeepSeek.chat("deepseek-v4-pro")` is explicitly available and separate.

**Step 2: Run the RED test**

Run from `packages/llm`:

```powershell
bun test test/capabilities.test.ts
```

Expected: the old planned Chat-only profile rejects native Responses.

**Step 3: Add a failing native-wire Pro test**

- Parameterize the deterministic DeepSeek Responses request test across Flash and Pro, or add a focused Pro case.
- Assert the request URL is `/responses`, `body.model` is exactly `deepseek-v4-pro`, structured-output/tool fields retain their existing lowering, the terminal SSE event is decoded, and usage remains exact.

**Step 4: Implement the smallest capability change**

- Change only the Pro capability definition in `packages/llm/src/capabilities.ts`.
- Reuse the existing native Responses provider route without copying schemas, request projection, or parsers.

**Step 5: Run focused and regression gates**

Run from `packages/llm`:

```powershell
bun test test/capabilities.test.ts test/provider/deepseek-responses.test.ts test/provider/openai-responses.test.ts test/provider/kimi-k3.test.ts
bun typecheck
```

Expected: all pass; Flash and Kimi contracts are unchanged.

---

### Task 2: Promote Implement/Repair/Deliver to Pro with Exact Routing

**Files:**

- Modify: `packages/core/test/workflow-routing.test.ts`
- Modify: `packages/core/test/workflow-model-state-machine.test.ts` only if its explicit expected model matrix requires promotion
- Modify: `packages/core/src/workflow/routing.ts`

**Step 1: Write failing table-driven routing tests**

- Expect `implement` and `repair` to select Pro/Responses/max.
- Expect `deliver` to select Pro/Responses/high.
- Keep `test` on Flash/Responses/high.
- Keep all Kimi roles on `kimi-k3` with their existing effort levels.
- Assert exact restatement is accepted, Pro-to-Flash on a Pro role is rejected, Flash-to-Pro on test is rejected, and Responses-to-Chat is rejected.

**Step 2: Run the RED test**

Run from `packages/core`:

```powershell
bun test test/workflow-routing.test.ts test/workflow-model-state-machine.test.ts
```

Expected: the current policy still selects Flash for implement/repair/deliver.

**Step 3: Implement the exact policy change**

- Expand the route model type to include `deepseek-v4-pro`.
- Change only implement/repair/deliver policies to Pro.
- Continue constructing every DeepSeek role through `DeepSeek.responses(...)`; do not add conditional fallback logic.

**Step 4: Run Workflow gates**

Run from `packages/core`:

```powershell
bun test test/workflow-routing.test.ts test/workflow-model-state-machine.test.ts test/workflow-stage-machine.test.ts
bun typecheck
```

Expected: exact matrix and negative override tests pass.

---

### Task 3: Prove the Embedded Responses Gateway Admits and Executes Pro

**Files:**

- Modify: `packages/sdk-next/test/responses-embedded.test.ts`
- Modify: `packages/sdk-next/test/responses-conformance.test.ts` only where the old planned-Pro diagnostic is asserted
- Modify: `packages/protocol/test/responses.test.ts` only where the old planned-Pro example is now stale
- Modify: `packages/core/src/workflow/execution/model.ts` only to preserve the explicit gateway model at the bound Response execution boundary

**Step 1: Replace stale unsupported-Pro assertions with failing supported-Pro behavior**

- Admit a Pro response through the embedded SDK/gateway against a deterministic DeepSeek transport.
- Assert one `/responses` request, exact wire model `deepseek-v4-pro`, exact terminal Response resource, and no Flash request.
- Run an explicit Flash request through the same production executor and assert its provider turns remain Flash while the automatic role matrix remains unchanged.
- Retain unsupported-field and unknown-model typed diagnostics.

**Step 2: Run the RED gateway tests**

Run from their packages:

```powershell
cd packages/protocol
bun test test/responses.test.ts
cd ../sdk-next
bun test test/responses-embedded.test.ts test/responses-conformance.test.ts
```

Expected: old tests still classify Pro as planned/unsupported or the gateway cannot execute it.

**Step 3: Make only fixture/expectation changes required by the promoted canonical capability**

- Do not add a Pro-specific handler, storage branch, event type, or model fallback.
- Ensure the gateway uses the same local lifecycle, workflow binding, cancellation, replay, and secret boundary as Flash.
- Derive the bound Response's provider route from its already capability-validated explicit model; keep stage `input.route` policy enforcement exact and unchanged.

**Step 4: Run focused package gates**

```powershell
cd packages/protocol
bun test test/responses.test.ts
bun typecheck
cd ../sdk-next
bun test test/responses-embedded.test.ts test/responses-conformance.test.ts
bun typecheck
```

Expected: Pro and Flash both pass their intended routes with no network access.

---

### Task 4: Update the Stage Plan, Verify, Review, Commit, and Push

**Files:**

- Modify: `docs/superpowers/plans/2026-08-09-opencode-kimi-k3-deepseek-responses-stage-b.md`
- Verify all changed production/test/documentation files

**Step 1: Update the durable plan baseline**

- Replace the obsolete Pro Chat/planned capability row with native Responses support.
- Add Task22 and the exact role table, noting that it supersedes only the Task18 DeepSeek tier choice.
- Preserve the historical Task13–21 task text and commits.

**Step 2: Run final verification from affected packages**

```powershell
cd packages/llm
bun test test/capabilities.test.ts test/provider/deepseek-responses.test.ts test/provider/openai-responses.test.ts test/provider/kimi-k3.test.ts
bun typecheck
cd ../core
bun test test/workflow-routing.test.ts test/workflow-model-state-machine.test.ts test/workflow-stage-machine.test.ts
bun typecheck
cd ../protocol
bun test test/responses.test.ts
bun typecheck
cd ../sdk-next
bun test test/responses-embedded.test.ts test/responses-conformance.test.ts
bun typecheck
```

- Run Prettier check on changed files, `git diff --check`, and a secret scan of the diff.
- Confirm `.env.local` is ignored and absent from the diff.

**Step 3: Request an independent code review**

- Resolve every Critical/Important finding with a focused RED→GREEN regression.
- Re-run affected verification after review fixes.

**Step 4: Commit and push**

```powershell
git add <Task22 files>
git commit -m "feat(deepseek): promote v4 pro responses routing"
git push fork dev
```

- Verify local `HEAD`, `refs/remotes/fork/dev`, and the GitHub commit URL agree.
- Never force-push and never push credentials or raw provider payloads.
