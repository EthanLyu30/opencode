# OpenCode Workflow Effect Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure whether the modified OpenCode workflow—Kimi K3 design/decomposition/review plus DeepSeek V4 Pro implementation/repair/delivery and V4 Flash testing—improves qualified web-development success over direct single-model OpenCode use, while preserving non-visual coding quality and keeping every paid request inside an explicit provider-native budget.

**Architecture:** Task24 is a black-box benchmark product around frozen OpenCode binaries. A D-drive-only runner seals source revisions, tasks, arm definitions, prompts, budgets, and hashes into an immutable campaign; creates a fresh isolated workspace and data root for every run; routes every provider request through a loopback credential/metering broker; invokes the modified workflow or direct OpenCode CLI; evaluates outputs with deterministic functional, browser, visual, policy, quality, accessibility, and responsive checks; then computes task-clustered uncertainty and renders JSON, CSV, HTML, and PDF reports. The product workflow receives a narrow trusted loopback transport profile so it can be measured without changing public APIs or production defaults.

**Tech Stack:** TypeScript, Bun 1.3.14, Effect 4, Effect Schema, SQLite, Drizzle ORM, PowerShell, Node.js, Playwright 1.59.1, Sharp 0.33.5, Axe Core 4.11.4, SSIM/pixel comparison, HTML/CSS report rendering, and the existing OpenCode Workflow/Responses/Location infrastructure.

**Spec:** `docs/superpowers/specs/2026-09-12-opencode-workflow-effect-benchmark-design.md`

## Global Constraints

- Work directly on `dev`, preserve Tasks 2–23, and make one conventional commit per implementation task. Push each verified checkpoint to `fork/dev`.
- Treat the five arms as frozen treatments: A = modified full workflow, B = modified direct DeepSeek V4 Pro, C = modified direct Kimi K3, D = upstream direct DeepSeek V4 Pro, E = upstream direct Kimi K3.
- The workflow route matrix is fixed: Kimi `kimi-k3` for `design`, `decompose`, and `visual_review`; DeepSeek `deepseek-v4-pro` Responses for `implement`, `repair`, and `deliver`; DeepSeek `deepseek-v4-flash` Responses for `test`.
- Never add Kimi 2.6/2.7, model fallback, protocol fallback, or automatic substitution. A route or protocol mismatch invalidates the run.
- Arms B–E use one model for the whole task. They do not call the workflow router or inherit hidden workflow artifacts.
- The 12 primary web tasks use A/B/C twice. D/E run once and receive a second pass only when that upstream arm's first-pass qualified-success rate is within 5 percentage points of the best fork direct control.
- The four non-visual guardrail tasks use A/B/C once. They never expand into the upstream contextual arms.
- No model is used as a judge. All scored evidence comes from deterministic tests, browser measurements, reference images, static analysis, artifact validation, or adjudicated infrastructure records.
- Standard development tests, recorded fixtures, Task24A, and report tests spend zero provider credits. Task24B requires explicit Kimi CNY and DeepSeek USD ceilings. Task24C requires a second, new approval with new ceilings.
- The metering broker rejects a request before forwarding unless its worst-case reservation fits the remaining provider-native ceiling. A missing or malformed terminal usage record is charged at the reservation, never at zero.
- Never read, print, copy, log, commit, or embed provider keys. The broker alone reads the existing local environment file at process start; child OpenCode processes receive only short-lived loopback grants.
- Request bodies, prompts, model output, tool arguments, source files, hidden gold data, and API response bodies are body-free in operational logs. The durable ledger stores hashes, byte counts, model/protocol, usage, price revision, money, status, and timing only.
- All Task24 datasets, caches, browsers, binaries, checkouts, workspaces, raw runs, reports, and temporary files live under `D:\OpenCode-Benchmark\Task24`. Do not create task-owned caches or configuration under C:.
- Hidden reference images and acceptance tests never enter an arm workspace or prompt. Each run gets only the declared task input and its own fresh workspace.
- Every run uses a fresh isolated OpenCode data/config/cache root. No arm sees another arm's sessions, summaries, provider cache state, build output, or workspace.
- Provider-side cache hits cannot always be disabled. Record cached and uncached input tokens separately, balance/randomize arm order, and report actual billed cost beside cache-normalized token consumption; cache never changes task-quality scoring.
- Freeze both binaries by SHA-256 before a campaign. The modified binary comes from the verified local deployment; the upstream binary is built from the latest official OpenCode release resolved and locked at execution time.
- A run is resumed only by the benchmark scheduler. Never resume by manually reissuing a paid request outside the ledger.
- Run focused tests and package typechecks from their package directories. Do not run the repository-wide root test command.
- Generate clients or migrations only through repository scripts. Do not hand-edit generated clients, migration registries, or database schema snapshots.
- Cleanup may remove only resolved descendants of `D:\OpenCode-Benchmark\Task24\tmp`, per-run workspaces, and runner-created source/build directories recorded in the campaign database. Preserve final reports, ledgers, locks, evidence, user inputs, the deployed product, and uncertain files.

---

## Fixed Measurement Contract

### Primary outcome

A run is a **qualified success** only when all of the following are true:

1. The submitted application builds from the documented clean command.
2. Every mandatory functional test passes.
3. The visual composite is at least 75/100 and no required viewport is below 65/100.
4. Every mandatory requirement and required artifact is present.
5. No security, scope, leakage, tampering, or evaluator-integrity violation occurred.
6. No human repaired the output or supplied help after the run began.
7. The run stayed inside its fixed token, tool, wall-clock, retry, revision, and provider-money ceilings.

The diagnostic score is 100 points: functional 45, visual 30, requirements/compliance 10, code quality 10, and accessibility/responsive behavior 5. The visual subscore is SSIM 35%, pixel/color 20%, DOM geometry 25%, typography/style 10%, and responsive/interaction 10%.

### Decision rule

- Primary contrasts are A–B and A–C on qualified-success rate.
- Compute 10,000 task-cluster bootstrap resamples, keeping repeat runs of the same task in the same resampled cluster.
- Claim workflow effectiveness only when the estimated gain is at least 10 percentage points, the 95% confidence interval lower bound is greater than zero, no primary task family regresses, all guardrails hold, and combined provider cost per qualified success is no more than 2× the best direct primary arm.
- D/E are context only. They must not be pooled into the causal A–B/A–C estimate.
- The decision contrast is A against the better observed fork direct control, `max(B, C)`; report A–B and A–C separately as well. The workflow must gain at least 10 percentage points over that better control and the paired clustered interval for the gating contrast must have a lower bound above zero.
- Treatment functional success must not trail the best fork direct control by more than 5 percentage points. Security/evaluator-isolation incidents must be zero, and same-class arms must receive equal aggregate input-token, output-token, tool-call, wall-time, and retry ceilings.
- Compare workflow cost per qualified success to the better qualified-success fork direct control using the sealed benchmark-start exchange-rate snapshot. Raw ledgers and hard caps remain in Kimi CNY and DeepSeek USD; the exchange rate is presentation/decision analysis only.
- Report `promising but inconclusive` when the point gain passes 10 points but the interval crosses zero, and `quality gain at disproportionate cost` when only the 2× cost rule fails. Do not convert either case into a win.

### D-drive layout

```text
D:\OpenCode-Benchmark\Task24\
├── assets\                 # immutable public assets and hidden gold bundles
├── cache\                  # Bun/npm/source caches owned by Task24
├── toolchain\              # frozen binaries, Node helper, Chromium, upstream checkout
├── workspaces\             # one fresh directory per run
├── runs\                   # campaign DB, append-only ledgers, evidence, stdout/stderr
├── reports\                # final JSON, CSV, HTML, PDF
└── tmp\                    # verified disposable descendants only
```

### Stage gates

| Gate | Scope | Paid calls | Required evidence before advancing |
| --- | --- | --- | --- |
| Task24A | Harness, broker fakes, evaluator, scheduler, reports, full offline E2E | Zero | Focused tests, package typecheck, recovery replay, redaction scan, deterministic report hashes |
| Task24B | Three-task pilot across A–E | Explicit capped budget | Per-request ledger reconciliation, protocol trace, evaluator sanity, no hidden leakage, pilot report |
| Task24C | Full sealed campaign | New explicit capped budget | User approval after reviewing Task24B and a fresh preflight cost envelope |
| Task24D | Analysis, report, independent audit, cleanup | Zero unless rerun separately approved | Reproducible statistics, evidence index, JSON/CSV/HTML/PDF outputs, retained rollback material |

---

## File and Interface Map

| Area | Responsibility | Primary files |
| --- | --- | --- |
| Package | CLI, schemas, canonicalization, D-root enforcement | `packages/benchmark/{package.json,tsconfig.json,src/cli.ts,src/schema.ts,src/root.ts}` |
| Campaign | Immutable preregistration, source/model/binary locks, hashes | `packages/benchmark/src/campaign/{canonical.ts,seal.ts,verify.ts}` |
| Workflow transport | Trusted persisted loopback endpoint profile | `packages/core/src/workflow/{benchmark-transport.ts,admission.ts,routing.ts,execution/model.ts}`, Server composition/tests |
| Corpus | Public-source locks, hidden task bundles, clean workspace materialization | `packages/benchmark/src/corpus/{source-lock.ts,manifest.ts,materialize.ts,validate.ts}` |
| Broker | Credential isolation, protocol enforcement, hard caps, usage ledger | `packages/benchmark/src/broker/{server.ts,grant.ts,policy.ts,pricing.ts,ledger.ts,redaction.ts}` |
| Arms | Modified workflow/direct and upstream direct black-box adapters | `packages/benchmark/src/arms/{types.ts,workflow.ts,direct.ts,upstream.ts,config.ts,process.ts}` |
| Scheduler | Durable queue, leases, resume, cancellation, deterministic order | `packages/benchmark/src/run/{sql.ts,store.ts,scheduler.ts,state.ts,budget.ts}` |
| Browser | Authenticated Node/Playwright capture and DOM/a11y extraction | `packages/benchmark/src/evaluator/{browser-runtime.ts,browser-node-helper.ts}` |
| Evaluation | Functional, visual, policy, static, requirements, score | `packages/benchmark/src/evaluator/{functional.ts,visual.ts,policy.ts,quality.ts,score.ts}` |
| Statistics | Qualified-success contrasts, clustered bootstrap, guardrails | `packages/benchmark/src/statistics/{aggregate.ts,bootstrap.ts,decision.ts}` |
| Reports | Sanitized JSON, CSV, HTML, PDF, evidence index | `packages/benchmark/src/report/{model.ts,json.ts,csv.ts,html.ts,pdf.ts}` |
| Automation | Setup, browser runtime build, command wrapper | `scripts/{setup-task24-sources.ps1,build-task24-browser-runtime.ps1,task24.ps1}` |
| Tracked config | Campaign template, task schemas, authoring rules | `benchmarks/task24/{campaign.template.json,schemas,README.md,.gitignore}` |

The central interfaces are fixed before implementation:

```ts
export type ArmID = "A" | "B" | "C" | "D" | "E"
export type ProviderID = "kimi" | "deepseek"
export type Protocol = "chat_completions" | "responses"

export interface SealedCampaign {
  readonly id: string
  readonly schemaVersion: 1
  readonly createdAt: string
  readonly preregistration: Preregistration
  readonly binaries: Readonly<Record<"modified" | "upstream", BinaryLock>>
  readonly sources: readonly SourceLock[]
  readonly tasks: readonly SealedTask[]
  readonly arms: readonly ArmDefinition[]
  readonly pricing: Readonly<Record<ProviderID, PriceRevision>>
  readonly exchangeRate: ExchangeRateLock
  readonly toolchain: ToolchainLock
  readonly evaluator: EvaluatorLock
  readonly sha256: string
}

export interface BenchmarkTransportProfile {
  readonly campaignID: string
  readonly grant: string
  readonly kimiBaseURL: string
  readonly deepseekBaseURL: string
  readonly expiresAt: number
}

export interface Reservation {
  readonly requestID: string
  readonly runID: string
  readonly provider: ProviderID
  readonly model: "kimi-k3" | "deepseek-v4-pro" | "deepseek-v4-flash"
  readonly protocol: Protocol
  readonly maximumChargeMicros: bigint
}

export interface EvaluationResult {
  readonly qualifiedSuccess: boolean
  readonly disqualifications: readonly string[]
  readonly functional: number
  readonly visual: number
  readonly requirements: number
  readonly quality: number
  readonly accessibilityResponsive: number
  readonly total: number
  readonly evidenceHashes: readonly string[]
}
```

---

### Task 24.1: Create the Private Benchmark Package and Immutable Campaign Seal

**Files:**

- Modify: `package.json`
- Create: `packages/benchmark/package.json`
- Create: `packages/benchmark/tsconfig.json`
- Create: `packages/benchmark/src/{cli.ts,schema.ts,root.ts,hash.ts}`
- Create: `packages/benchmark/src/campaign/{canonical.ts,seal.ts,verify.ts}`
- Create: `packages/benchmark/test/{root.test.ts,seal.test.ts}`
- Create: `benchmarks/task24/{README.md,campaign.template.json,.gitignore}`
- Create: `benchmarks/task24/schemas/{campaign.schema.json,task.schema.json}`

**Produces:** a private workspace package, strict D-root policy, canonical JSON, and an immutable campaign manifest whose hash binds every later run.

- [x] **Step 1: Write RED tests for root confinement and seal immutability.**

```ts
test("rejects every Task24 root outside the configured D directory", () => {
  expect(() => Task24Root.make("C:\\temp\\task24")).toThrow("TASK24_ROOT_OUTSIDE_D")
})

test("detects any post-seal mutation", async () => {
  const sealed = await sealCampaign(fixtureCampaign)
  expect(await verifyCampaign({ ...sealed, arms: [...sealed.arms].reverse() })).toMatchObject({ ok: false })
})
```

- [x] **Step 2: Run the focused tests and observe RED.**

Run from `packages/benchmark` with the bundled Bun:

```powershell
$Bun = 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe'
& $Bun test test/root.test.ts test/seal.test.ts
```

Expected: missing package/modules or assertion failures.

- [x] **Step 3: Add strict Effect Schemas and canonical serialization.**

Implement schema version 1 for campaign, arm, task, binary lock, source lock, provider price revision, exchange-rate lock, toolchain lock, evaluator lock, run envelope, score, and report. Canonical JSON recursively sorts object keys, preserves array order, rejects non-finite numbers, encodes bigint money as decimal strings, and normalizes line endings before hashing.

Add exact direct dependencies for Playwright 1.59.1, Sharp 0.33.5, and Axe Core 4.11.4 to `packages/benchmark`; use the repository's Effect/TypeScript catalog versions. Keep the package `private: true` and expose only the `task24` CLI plus test/typecheck scripts.

- [x] **Step 4: Enforce the exact root and create only declared child directories.**

`Task24Root.make()` resolves the configured path, verifies the drive root is `D:\`, verifies the last path components equal `OpenCode-Benchmark\Task24`, and returns typed child paths. It must not accept symlinks/reparse points that resolve outside the root.

- [x] **Step 5: Implement `task24 campaign seal` and `campaign verify`.**

Sealing must fail unless every source, task bundle, model/protocol/effort, binary, provider price revision, dated cited exchange-rate snapshot, toolchain/evaluator version, timeout, tool ceiling, token ceiling, retry ceiling, repetition rule, seed, and arm order is concrete. Write the immutable seal to `runs\<campaign-id>\campaign.sealed.json`; later commands accept only a valid seal hash.

- [x] **Step 6: Keep local benchmark data out of Git.**

The tracked `.gitignore` ignores local lock material, datasets, gold bundles, raw runs, reports, and keys while retaining only templates, schemas, and authoring instructions.

- [x] **Step 7: Verify package boundaries.**

```powershell
& $Bun test test/root.test.ts test/seal.test.ts
& $Bun run typecheck
```

Expected: tests and typecheck exit 0.

- [x] **Step 8: Commit and push.**

```powershell
git add package.json packages/benchmark benchmarks/task24
git commit -m "feat(benchmark): seal task24 campaigns"
git push fork dev
```

---

### Task 24.2: Add a Trusted, Persisted Workflow Measurement Transport

**Files:**

- Create: `packages/core/src/workflow/benchmark-transport.ts`
- Modify: `packages/core/src/workflow/{admission.ts,routing.ts,execution/model.ts,execution/provider-request.ts}`
- Modify: `packages/server/src/workflow/production-host-runtime.ts`
- Modify the Workflow handler/composition file that constructs admission dependencies
- Create: `packages/core/test/workflow-benchmark-transport.test.ts`
- Modify: `packages/core/test/workflow-admission.test.ts`
- Modify: `packages/core/test/workflow-recovery.test.ts`
- Create: `packages/server/test/workflow-benchmark-transport.test.ts`

**Consumes:** the existing immutable Workflow/Responses route and provider-request fingerprints.

**Produces:** an opt-in server-side loopback endpoint/grant binding that survives crash recovery without exposing endpoint selection in public visual-build requests or changing the normal production visual-build path.

- [x] **Step 1: Write RED security and recovery tests.**

Cover all of these cases:

- public HTTP request fields that resemble `baseURL`, `endpoint`, `grant`, or `benchmarkTransport` are rejected by strict decoding;
- the feature is unavailable unless `OPENCODE_BENCHMARK_TRANSPORT_FILE` points inside the isolated run data root;
- non-loopback URLs, URL userinfo, query credentials, expired grants, wrong campaign IDs, and symlink escapes are rejected;
- admitted Kimi stages use the Kimi loopback base URL and DeepSeek stages use the DeepSeek loopback base URL;
- provider-request fingerprints include the bound transport identity without including the grant value;
- a process crash followed by recovery resolves the same persisted endpoint and never falls back to the public provider URL.

- [x] **Step 2: Run focused Core and Server tests and observe RED.**

```powershell
Push-Location 'D:\OpenCode-Audit\packages\core'
& $Bun test test/workflow-benchmark-transport.test.ts test/workflow-admission.test.ts test/workflow-recovery.test.ts
Pop-Location
Push-Location 'D:\OpenCode-Audit\packages\server'
& $Bun test test/workflow-benchmark-transport.test.ts
Pop-Location
```

- [x] **Step 3: Define the trusted transport contract.**

Read a runner-created JSON file only at server composition time. Validate an exact `127.0.0.1` origin, two provider-specific base paths, campaign/run identity, expiry, and a nonempty short-lived grant. Expose the validated profile through an injected Core service. Do not add it to Protocol schemas or generated clients.

- [x] **Step 4: Bind the profile at admission.**

Persist a nonsecret transport reference containing campaign ID, broker origin, provider paths, expiry, and grant fingerprint. Store the actual grant only in the isolated benchmark credential store. Exact-create reconciliation must reject a changed transport binding.

- [x] **Step 5: Configure the native routes without protocol translation.**

Kimi remains Chat Completions and only its base URL/auth change. DeepSeek V4 Pro/Flash remain native Responses routes and only their base URL/auth change. Do not translate Kimi events into Responses or DeepSeek Responses into Chat inside the benchmark transport.

- [x] **Step 6: Make recovery transport-stable.**

Reconstruct the configured model before creating/checking `ProviderRequest` fingerprints. An expired or missing grant after restart yields a typed recoverable benchmark-auth error; it must never switch to direct provider credentials.

- [x] **Step 7: Verify production-default identity.**

Add a snapshot/fingerprint test proving route selection is byte-for-byte unchanged when the environment variable is absent. Run Core/Server focused suites and package typechecks.

- [x] **Step 8: Commit and push.**

```powershell
git add packages/core packages/server
git commit -m "feat(workflow): add trusted benchmark transport"
git push fork dev
```

---

### Task 24.3: Lock Upstream Sources and Materialize Isolated Task Workspaces

**Files:**

- Create: `packages/benchmark/src/corpus/{source-lock.ts,manifest.ts,materialize.ts,validate.ts,archive.ts}`
- Create: `packages/benchmark/test/corpus/{source-lock.test.ts,materialize.test.ts,validate.test.ts}`
- Create: `scripts/setup-task24-sources.ps1`
- Modify: `benchmarks/task24/README.md`

**Produces:** reproducible source locks and clean per-run workspaces without allowing a task process to see hidden gold or another arm.

- [x] **Step 1: Write RED tests for immutable source identity and path isolation.**

Test SHA-256 mismatch, mutable branch URL rejection, archive traversal, NTFS reparse-point escape, hidden-file leakage, dirty reused workspace rejection, and run-to-run byte inequality caused by undeclared files.

- [x] **Step 2: Implement official-upstream resolution.**

At setup time, query the official OpenCode release source, resolve the latest stable tag, resolve it to a commit, download/checkout exactly that commit under `toolchain\upstream-src`, and record repository URL, tag, commit, archive hash, lock timestamp, and license. A campaign never uses a moving `main`, `dev`, or `latest` reference after sealing.

- [x] **Step 3: Implement benchmark-dataset source locking.**

Resolve exact licensed revisions for Design2Code-Hard and the JS/visual subset of SWE-bench Multimodal. Record dataset repository/revision, subset selector, item IDs, asset hashes, normalization version, and license. Cache downloaded data only under `assets\public` and `cache\sources`.

- [x] **Step 4: Implement safe bundle validation.**

Every task bundle has `task.json`, `starter\`, optional public `assets\`, hidden `gold\`, and `LICENSES.json`. Validate that declared workspace files cannot escape `starter`, that gold files are outside materialized workspaces, and that the prompt cannot contain gold hashes, reference image bytes, expected DOM snapshots, or evaluator commands.

- [x] **Step 5: Materialize a fresh run.**

Copy or extract only `starter` and public assets into `workspaces\<campaign>\<run-id>\repo`, set read/write permissions for that run, and emit a pre-run tree hash. Create separate D-only `data`, `config`, `cache`, `temp`, and `output` directories for the child process.

- [x] **Step 6: Add setup automation.**

`setup-task24-sources.ps1` accepts the Task24 root and bundled Bun path, refuses C-owned output, downloads into a staging child of `tmp`, verifies hashes, then atomically publishes to the recorded destination. It preserves the prior valid source lock on failure.

- [x] **Step 7: Verify offline after the one-time source fetch.**

Run corpus tests, disconnect the test HTTP fixture, rematerialize all fixture bundles, and verify identical tree hashes.

- [x] **Step 8: Commit and push.**

```powershell
git add packages/benchmark scripts/setup-task24-sources.ps1 benchmarks/task24/README.md
git commit -m "feat(benchmark): lock and isolate task24 sources"
git push fork dev
```

---

### Task 24.4: Build the Loopback Credential and Hard-Budget Broker

**Files:**

- Create: `packages/benchmark/src/broker/{server.ts,grant.ts,policy.ts,pricing.ts,reservation.ts,ledger.ts,redaction.ts,stream.ts}`
- Create: `packages/benchmark/test/broker/{server.test.ts,grant.test.ts,reservation.test.ts,ledger.test.ts,redaction.test.ts,stream.test.ts}`
- Create redacted fixtures: `packages/benchmark/test/fixtures/provider/{kimi-chat.sse,deepseek-responses.sse,failed.sse,incomplete.sse}`

**Produces:** an authenticated local proxy that enforces exact model/protocol routes, reserves worst-case spend before dispatch, streams provider events unchanged, and reconciles actual usage without leaking content.

- [x] **Step 1: Write RED tests for authorization, routing, and pre-dispatch rejection.**

Assert that only `POST /v1/kimi/chat/completions` and `POST /v1/deepseek/responses` exist; the Kimi route accepts only `kimi-k3`; the DeepSeek route accepts only `deepseek-v4-pro` or `deepseek-v4-flash`; wrong paths/models/protocols return a typed local error before any upstream fetch.

- [x] **Step 2: Write RED accounting tests.**

Cover cached/uncached input, output/reasoning tokens, both provider currencies, price-revision binding, parallel reservations, cancellation, upstream 4xx/5xx, malformed SSE, missing usage, duplicate terminal events, broker restart, and exact exhaustion at the ceiling.

- [x] **Step 3: Implement short-lived grants.**

Generate a random per-run bearer grant. Store only its hash, campaign ID, run ID, allowed provider/model/protocol set, expiry, and maximum calls. Compare hashes in constant time. Revoke it when the run becomes terminal.

- [x] **Step 4: Implement provider-native reservations.**

Require explicit maximum output tokens on every request. Bound input tokens conservatively from UTF-8 body bytes plus fixed overhead, apply the sealed price revision, and atomically reserve micros in CNY for Kimi or USD for DeepSeek. Reject with `BUDGET_RESERVATION_EXCEEDED` before opening an upstream connection.

- [x] **Step 5: Stream without transformation.**

Forward headers from an allowlist, inject the real provider key only upstream, and pipe response bytes unchanged to the child. Parse a side branch of the byte stream for terminal usage and protocol conformance. Never buffer a complete response solely for logging.

- [x] **Step 6: Settle the append-only ledger.**

On a valid terminal usage record, settle actual charge and release the unused reservation. On missing/invalid usage, charge the full reservation. Ledger records include request/run IDs, UTC times, provider/model/protocol, route, request/response byte counts, input/cache/output/reasoning tokens when known, reservation/settlement money, HTTP/result class, stream terminal type, price hash, and request/response SHA-256—not bodies.

- [x] **Step 7: Add redaction and leakage tests.**

Seed fixtures with canary strings shaped like API keys, prompts, source code, tool arguments, and response text. Recursively scan logs, SQLite text columns, JSON errors, stdout/stderr, and report models; all canaries must be absent.

- [x] **Step 8: Verify and commit.**

```powershell
Push-Location 'D:\OpenCode-Audit\packages\benchmark'
& $Bun test test/broker
& $Bun run typecheck
Pop-Location
git add packages/benchmark
git commit -m "feat(benchmark): enforce provider spend broker"
git push fork dev
```

---

### Task 24.5: Implement Five Black-Box Arm Adapters

**Files:**

- Create: `packages/benchmark/src/arms/{types.ts,process.ts,environment.ts,config.ts,workflow.ts,direct.ts,upstream.ts,protocol-proof.ts}`
- Create: `packages/benchmark/test/arms/{process.test.ts,config.test.ts,workflow.test.ts,direct.test.ts,upstream.test.ts,protocol-proof.test.ts}`
- Modify: `packages/benchmark/src/schema.ts`

**Produces:** uniform start/cancel/collect behavior for A–E while preserving the intended treatment differences.

- [x] **Step 1: Write RED command/environment snapshot tests.**

Each snapshot must bind binary hash, working directory, isolated D-only roots, task prompt hash, model, effort/variant, protocol, permissions, aggregate input/output-token, tool/step, retry, and wall-time ceilings, broker grant, and expected output locations. Assert that no real provider key is present.

- [x] **Step 2: Implement the common process supervisor.**

Start child processes without a shell, capture bounded stdout/stderr to run-owned files, record PID/start time/executable hash, enforce wall time, cancel the full process tree, and classify exit, signal, timeout, lease loss, and user cancellation distinctly.

- [x] **Step 3: Implement arm A.**

Invoke the modified deployment as:

```powershell
opencode workflow run <task-prompt> --format json
```

Pass the prompt as one shell-free argv value and persist only its hash in process metadata. Supply the trusted benchmark transport file and isolated OpenCode roots. The CLI must enter the same deployed production visual-build admission and role prompts used outside benchmarking; the adapter must not inject stage prompts, artifacts, or extra decomposition. Follow its Workflow SSE/JSON identifiers until terminal, export the final delivery artifact, and record stage/model/protocol evidence. Fail if the observed stage route differs from the sealed Kimi/DeepSeek matrix.

- [x] **Step 4: Implement arms B and C.**

Generate an isolated `opencode.json` containing only the loopback provider definitions and model metadata required for that arm. DeepSeek uses bundled `@ai-sdk/openai` and must hit `/responses`; Kimi uses `@ai-sdk/openai-compatible` and must hit `/chat/completions`. Invoke:

```powershell
opencode run --dir <repo> --model task24-deepseek/deepseek-v4-pro --variant max --format json --auto <prompt>
opencode run --dir <repo> --model task24-kimi/kimi-k3 --variant max --format json --auto <prompt>
```

Use identical task input/reference media, allowed dependency set, permission policy, aggregate input/output-token envelope, wall time, retries, and maximum tool-step policy. If a provider cannot honor the sealed variant, fail preflight rather than substituting another setting. Do not provide direct arms with workflow stage prompts, Kimi review, design artifacts, or workflow-generated decomposition.

Materialize public reference media at identical relative workspace paths and name those paths in the shared task prompt. Use the same declared attachment mechanism where the product supports one; do not OCR, caption, resize, or otherwise derive extra arm-specific reference content. A model's inability to consume an identically exposed medium is an observed capability difference, not a reason to enrich only that arm.

- [x] **Step 5: Implement arms D and E.**

Use the frozen upstream binary and the same isolated configs, workspace materialization, broker, task prompt, and direct-run envelope as B/C. Never patch or import benchmark code into the upstream checkout. Only its executable path/hash and version differ.

- [x] **Step 6: Prove the wire protocol before a paid campaign.**

Against a local fake broker, assert exact request paths, models, auth grant, stream semantics, required maximum-output field, and terminal usage parsing. DeepSeek on any arm must reach `/v1/deepseek/responses`; Kimi must reach `/v1/kimi/chat/completions`.

- [x] **Step 7: Verify and commit.**

Run all arm tests, package typecheck, and a fake five-arm smoke. Commit:

```powershell
git add packages/benchmark
git commit -m "feat(benchmark): add task24 comparison arms"
git push fork dev
```

---

### Task 24.6: Add the Durable Scheduler, Leases, Cancellation, and Resume

**Files:**

- Create: `packages/benchmark/src/run/{schema.ts,sql.ts,store.ts,state.ts,scheduler.ts,lease.ts,budget.ts,order.ts}`
- Create generated benchmark migration files through the package migration script
- Create: `packages/benchmark/test/run/{store.test.ts,state.test.ts,scheduler.test.ts,recovery.test.ts,budget.test.ts}`

**Produces:** exactly-once run admission, at-most-one active attempt, crash-safe state, deterministic arm ordering, and budget-aware dispatch.

- [x] **Step 1: Write RED state-machine tests.**

Use the fixed lifecycle:

```text
planned -> materializing -> ready -> reserved -> running -> evaluating -> completed
                                  \-> rejected_budget
running -> canceling -> canceled
running/evaluating -> interrupted -> resumable | failed
```

Reject backward transitions, duplicate active attempts, seal-hash changes, reused workspaces, and completion without evaluation evidence.

- [x] **Step 2: Define SQLite tables.**

Persist campaigns, tasks, arms, runs, attempts, leases, state events, reservations, request ledgers, process records, evidence, evaluations, adjudications, and report builds. Use unique constraints for `(campaign_id, task_id, arm_id, repetition)` and monotonically increasing per-run event sequence.

- [x] **Step 3: Implement deterministic balanced ordering.**

Derive order from the sealed seed using a balanced Latin-square schedule across tasks and repetitions. Store the full order before the first run so a crash cannot reshuffle later arms.

- [x] **Step 4: Implement leases and recovery.**

Lease acquisition and renewal are atomic. On restart, inspect expired leases, process liveness, broker ledger state, product Workflow status, workspace hash, and evaluation state. Resume observation/evaluation when safe; never duplicate a provider call whose disposition is unknown. Unknown paid calls require adjudication and retain their reservation charge.

- [x] **Step 5: Implement cancellation and concurrency.**

Start with concurrency 1 for pilot and make higher concurrency an explicit sealed setting. Cancellation revokes the grant, terminates the process tree, waits for broker settlement, records the final state, and leaves evidence intact.

- [x] **Step 6: Add campaign/run status commands.**

Implement `task24 status`, `task24 run --stage offline|pilot|campaign`, `task24 resume`, and `task24 cancel`. `run --stage pilot|campaign` refuses to start without a separate signed local approval envelope containing provider-native ceilings and matching campaign/stage hashes.

- [x] **Step 7: Verify fault injection.**

Kill the scheduler at every state boundary in table-driven tests, restart, and assert no double dispatch, no lost settlement, stable order, and a terminal or explicitly adjudication-required state.

- [x] **Step 8: Commit and push.**

```powershell
git add packages/benchmark
git commit -m "feat(benchmark): persist task24 run scheduling"
git push fork dev
```

---

### Task 24.7: Build the Authenticated Node/Playwright Evaluation Runtime

**Files:**

- Create: `packages/benchmark/src/evaluator/{browser-protocol.ts,browser-runtime.ts,browser-node-helper.ts,capture.ts}`
- Create: `packages/benchmark/test/evaluator/{browser-runtime.test.ts,capture.test.ts}`
- Create: `scripts/build-task24-browser-runtime.ps1`
- Modify: `packages/benchmark/package.json`

**Produces:** a D-hosted, integrity-checked Node helper for screenshots, DOM geometry, computed styles, interactions, and Axe output, avoiding the known Windows Bun/Chromium deadlock path.

- [x] **Step 1: Write RED protocol and security tests.**

Test random bearer authentication, request IDs, bounded JSON lines, loopback-only URLs, allowed run/preview IDs, viewport allowlist, output-root confinement, timeout, navigation escape, popup/download denial, oversized screenshot rejection, process crash, and malformed helper response.

- [x] **Step 2: Define the browser request contract.**

Requests include run ID, preview capability URL, viewport ID/dimensions/device scale, deterministic wait condition, interaction script ID from the sealed evaluator bundle, and output relative path. Every primary task declares exactly three fixed responsive viewports. Requests never include arbitrary JavaScript from task output.

- [x] **Step 3: Implement the Node helper.**

Launch the pinned Chromium in a fresh per-run user-data directory under D, disable external network except the preview origin, set deterministic locale/timezone/color scheme/reduced-motion/font inputs, execute only evaluator-owned interaction modules, capture PNG, DOM boxes, computed style allowlist, console/page errors, accessibility tree summary, and Axe results.

- [x] **Step 4: Build and authenticate the runtime.**

Follow the proven Task23 pattern: use Bun to bundle for Node, copy the exact Node executable/helper/dependencies to `toolchain\browser\<build-hash>`, hash every file into a manifest, and refuse startup if any hash differs. Store the helper grant only in the parent/child environment.

- [x] **Step 5: Add lifecycle recovery.**

The parent restarts a crashed helper once for an unstarted capture, never repeats an interaction after evidence publication, and records a typed infrastructure failure if capture disposition is uncertain.

- [x] **Step 6: Verify fixture capture determinism.**

Capture the same local fixture three times at every required viewport. Pixel hashes and DOM/style JSON must match after known PNG metadata normalization.

- [x] **Step 7: Commit and push.**

```powershell
git add packages/benchmark scripts/build-task24-browser-runtime.ps1
git commit -m "feat(benchmark): add deterministic browser evaluator"
git push fork dev
```

---

### Task 24.8: Implement Deterministic Functional, Visual, Policy, and Quality Scoring

**Files:**

- Create: `packages/benchmark/src/evaluator/{functional.ts,requirements.ts,visual.ts,geometry.ts,style.ts,interaction.ts,accessibility.ts,quality.ts,policy.ts,score.ts,evidence.ts}`
- Create: `packages/benchmark/test/evaluator/{functional.test.ts,visual.test.ts,requirements.test.ts,quality.test.ts,policy.test.ts,score.test.ts}`
- Create fixture applications and expected score files under `packages/benchmark/test/fixtures/evaluator`

**Produces:** reproducible 100-point diagnostics and strict qualified-success/disqualification outcomes.

- [ ] **Step 1: Write RED golden-score tests.**

Create controlled fixtures for exact match, spacing drift, wrong palette, typography drift, missing mobile behavior, broken interaction, functional failure, accessibility failure, prompt leakage, evaluator tampering, and build-script substitution. Store expected component scores and disqualifications.

- [ ] **Step 2: Implement functional evaluation.**

Run only evaluator-owned commands in a constrained child process with a fixed environment and timeout. Parse machine-readable results, bind them to test hashes, and map mandatory/optional assertions to the 45-point functional score. Task-authored tests cannot replace evaluator tests.

- [ ] **Step 3: Implement the visual composite.**

Normalize images, calculate SSIM and pixel/color distance over declared masks, compare DOM geometry with tolerance bands, compare typography/computed-style fields, and score sealed responsive/interaction checkpoints. Aggregate exactly 35/20/25/10/10 within the visual subscore, then map to 30 diagnostic points. Report official Design2Code metrics for applicable tasks. A missing visual component is a harness failure; weights are never redistributed.

- [ ] **Step 4: Implement requirements, quality, and accessibility.**

Requirements come from evaluator-owned machine-readable assertions. Quality uses fixed linters/typecheck plus bounded structural checks; it does not reward code volume. Accessibility/responsive combines Axe critical/serious violations, keyboard/focus checks, overflow/clipping, and declared responsive states.

- [ ] **Step 5: Implement policy disqualification.**

Detect writes outside workspace, hidden-gold access attempts, external network, benchmark/evaluator process access, test deletion/modification, reference embedding, credential probing, output manipulation, human edits after start, or budget/time/tool ceiling violation. Security, hidden-test mutation, evaluator access, or fabricated evidence sets the diagnostic score to zero and makes `qualifiedSuccess=false`; other ceiling/requirement failures make the run unqualified under the sealed scoring rule.

- [ ] **Step 6: Produce the blinded qualitative-audit package.**

For every primary run whose automatic visual composite is 70–79 inclusive, export anonymized, randomly ordered reference/candidate pairs plus reason-neutral task labels. Remove arm/model/runtime identity. Human preference is qualitative audit evidence only and cannot alter automatic scores or qualified-success state.

- [ ] **Step 7: Bind evidence.**

Every score component cites one or more content-addressed evidence files. The evaluation JSON includes evaluator/version hashes, task/gold hashes, binary/arm/run identity, timestamps, and reason codes. Re-evaluation over the same workspace/evidence must produce byte-identical canonical JSON.

- [ ] **Step 8: Verify and commit.**

Run evaluator tests, typecheck, and a mutation test that changes one fixture dimension/function/policy event at a time and observes the expected score change.

```powershell
git add packages/benchmark
git commit -m "feat(benchmark): score task24 outcomes"
git push fork dev
```

---

### Task 24.9: Add Clustered Statistics and Reproducible Reports

**Files:**

- Create: `packages/benchmark/src/statistics/{aggregate.ts,bootstrap.ts,decision.ts,cost.ts}`
- Create: `packages/benchmark/src/report/{model.ts,json.ts,csv.ts,html.ts,pdf.ts,evidence-index.ts}`
- Create: `packages/benchmark/test/statistics/{bootstrap.test.ts,decision.test.ts,cost.test.ts}`
- Create: `packages/benchmark/test/report/{json.test.ts,csv.test.ts,html.test.ts,pdf.test.ts}`
- Create report fixtures under `packages/benchmark/test/fixtures/report`

**Produces:** exact A–B/A–C inference, guardrail decisions, cost effectiveness, and sanitized human/machine-readable reports.

- [ ] **Step 1: Write RED statistical fixtures.**

Include clear win, clear loss, interval crossing zero, gain below 10 points, one-family regression, functional regression beyond 5 points, security incident, unequal budget, cost ratio above 2×, all-failure, missing run, D/E one-pass, and D/E second-pass-trigger cases.

- [ ] **Step 2: Implement deterministic clustered bootstrap.**

Use a documented PRNG and the sealed seed. Resample task IDs 10,000 times, carrying all repeats/arms for each selected task. Compute percentile 95% intervals for A–B, A–C, and the preregistered A–`max(B,C)` gating contrast, plus diagnostic/cost secondary metrics. Verify results against hand-calculated small samples and stored golden vectors.

- [ ] **Step 3: Implement the preregistered decision engine.**

The result is one of `demonstrated`, `not demonstrated`, `promising but inconclusive`, `quality gain at disproportionate cost`, or `incomplete`, accompanied by each satisfied/failed rule and no editorial override. Enforce the 10-point/interval/family/functional/security/equal-budget/2×-cost rules exactly. Missing/invalidated runs produce an incomplete campaign, not an imputed success or failure, unless the sealed failure policy explicitly classifies that terminal condition.

- [ ] **Step 4: Implement report models and exports.**

Lead with qualified-success rates, A–B/A–C and gating effects with intervals, decision, family checks, guardrails, total provider-native spend, and cost per qualified success. Then show diagnostic subscores, first-pass functional/visual success, repair loops, changed files, time/tokens/tool calls/retries/recovery, actual billed cost, cache-normalized token consumption, quality/cost and quality/time Pareto frontiers, D/E context, exclusions, harness failures, failure taxonomy, and an evidence index.

- [ ] **Step 5: Render HTML and PDF without a model.**

Render a self-contained HTML report, then print it to PDF through the authenticated browser helper. Include campaign/source/binary/model/protocol/price/exchange-rate/evaluator hashes and limitations covering sample size, public-data contamination, cache effects, provider variability, and Windows-only execution. Exclude keys, grants, prompts, full model output, and request/response bodies; include only explicitly sanitized patch excerpts and anonymized screenshots required for representative case studies.

- [ ] **Step 6: Verify report determinism and accessibility.**

Regenerate JSON/CSV/HTML twice and compare hashes. Normalize PDF creation metadata before comparing its content hash. Validate tables, chart text alternatives, contrast, pagination, Chinese/Latin font embedding, and no clipped columns.

- [ ] **Step 7: Commit and push.**

```powershell
git add packages/benchmark
git commit -m "feat(benchmark): report task24 effects"
git push fork dev
```

---

### Task 24.10: Author and Validate the 16-Task Corpus

**Files:**

- Modify: `benchmarks/task24/campaign.template.json`
- Modify: `benchmarks/task24/README.md`
- Create local-only bundles under `D:\OpenCode-Benchmark\Task24\assets\tasks`
- Create local-only `D:\OpenCode-Benchmark\Task24\runs\preregistration.json`
- Create local-only `D:\OpenCode-Benchmark\Task24\runs\sources.lock.json`

**Produces:** 12 primary web tasks plus four non-visual guardrails, with hidden evaluator assets and a complete candidate preregistration ready for the final post-verification seal.

- [ ] **Step 1: Import four Design2Code-Hard tasks.**

Select four licensed tasks with distinct layout families and responsive references. Normalize assets without changing pixels, preserve upstream IDs/licenses, and create functional/interaction assertions only from observable task requirements.

- [ ] **Step 2: Import four SWE-bench Multimodal JS visual tasks.**

Select four JavaScript/TypeScript web issues whose accepted outcome is observable through tests and visual evidence. Pin repository base commits and issue assets, exclude tasks that require inaccessible services or subjective manual judgment, and preserve upstream provenance.

- [ ] **Step 3: Author four private real-web tasks.**

Use these fixed families:

1. analytics dashboard with KPI cards, filters, charts, empty/loading/error states, and responsive references;
2. travel search/results page with controlled form state, filtering/sorting, interaction checkpoints, and desktop/mobile references;
3. inventory admin feature added to an existing app, including batch edit, validation, persistence boundary, and responsive behavior;
4. checkout visual/functional repair in an existing app, including state recovery, keyboard path, error handling, and reference fidelity.

Write independent hidden functional tests, reference images for every required viewport, DOM/style expectations, accessibility checks, build commands, mandatory requirements, and score masks. Place hidden files only in each bundle's `gold` directory.

- [ ] **Step 4: Author four non-visual guardrails.**

Cover repository debugging, API/data transformation, stateful backend behavior, and multi-file refactoring. Give them deterministic tests and no visual points; map their outcome to the fixed guardrail comparison so workflow overhead cannot hide coding regressions.

- [ ] **Step 5: Validate task leakage and difficulty.**

Run static canary scans between prompts/starter trees and gold bundles. Verify clean builds, evaluator-owned tests, reference capture, offline dependency availability, expected time limits, and no evaluator reliance on machine-specific absolute paths.

- [ ] **Step 6: Freeze the full toolchain and fairness fingerprint.**

Record the candidate modified/upstream source revisions, Bun/package-manager versions, Docker engine and image digest, Chromium revision, browser helper hash, operating-system build, fonts and their hashes, locale, timezone, viewports, allowed dependency mirrors, evaluator commands, and external-network policy. Fail validation when a required component is floating or resolves outside its approved D-drive root.

- [ ] **Step 7: Freeze model/protocol/effort and run order.**

The seal records exact `kimi-k3`, `deepseek-v4-pro`, and `deepseek-v4-flash` IDs; Kimi Chat and DeepSeek Responses protocols; the fixed workflow role matrix; direct-arm variants; arm repetition policy; balanced order seed; evaluator weights; thresholds; and decision rules.

- [ ] **Step 8: Validate the candidate preregistration without sealing it.**

Run:

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' --cwd 'D:\OpenCode-Audit\packages\benchmark' run task24 campaign validate --root 'D:\OpenCode-Benchmark\Task24'
```

Write `preregistration.candidate.json` and its validation report. Do not create the final campaign seal until Task24A code review, commit, deployment, and offline acceptance have fixed the final modified binary hash.

- [ ] **Step 9: Commit only templates/documentation.**

Do not add local task gold, source locks, preregistration files, or sealed campaigns to Git.

```powershell
git add benchmarks/task24
git commit -m "docs(benchmark): define task24 corpus"
git push fork dev
```

---

### Task 24.11: Complete Task24A Offline End-to-End Verification, Deployment, and Seal

**Files:**

- Create: `packages/benchmark/test/e2e/offline-campaign.test.ts`
- Create: `packages/benchmark/test/e2e/recovery-matrix.test.ts`
- Create: `packages/benchmark/test/e2e/leakage.test.ts`
- Create: `scripts/task24.ps1`
- Modify: `packages/benchmark/package.json`
- Update: `docs/superpowers/plans/2026-09-12-opencode-workflow-effect-benchmark.md` checkboxes/evidence during execution

**Produces:** a zero-credit proof that all five arms, broker, scheduler, evaluation, statistics, reports, and recovery work together, plus a newly deployed and hashed modified binary and a final campaign seal created before any live provider call.

- [ ] **Step 1: Add a deterministic fake-provider scenario.**

The fake Kimi and DeepSeek endpoints emit recorded Chat/Responses SSE, tool calls, terminal usage, incomplete/failed events, and controlled code edits. The fake scenario must exercise all workflow roles and both direct protocols.

- [ ] **Step 2: Run a full fake five-arm campaign.**

Materialize independent workspaces, dispatch A–E, collect artifacts, serve previews, capture viewports, evaluate, bootstrap, and render all four formats. Assert exact run counts, protocol paths, ledger totals, workspace isolation, and report values.

- [ ] **Step 3: Run the crash/recovery matrix.**

Inject process death during materialization, after reservation, mid-stream, after terminal usage, during workflow recovery, during capture, during evaluation publication, and during report write. Each restart must converge without a duplicate paid-equivalent dispatch or conflicting result.

- [ ] **Step 4: Run security and redaction acceptance.**

Attempt remote endpoint injection, public transport override, workspace traversal, symlink/reparse escape, hidden-gold access, external network, evaluator mutation, grant replay, log injection, oversized output, and fake usage. Assert typed rejection/disqualification and scan all durable text for canaries.

- [ ] **Step 5: Add the D-only wrapper.**

`scripts/task24.ps1` sets task-specific `TEMP`, `TMP`, Bun cache, config, data, Playwright browser, and npm cache directories under the Task24 root; validates the Bun/Node/binary hashes; then invokes the package CLI without printing secrets.

- [ ] **Step 6: Run the pre-commit Task24A gate.**

```powershell
Push-Location 'D:\OpenCode-Audit\packages\benchmark'
& $Bun test
& $Bun run typecheck
Pop-Location
& 'D:\OpenCode-Audit\scripts\task24.ps1' preflight --offline
& 'D:\OpenCode-Audit\scripts\task24.ps1' run --stage offline
& 'D:\OpenCode-Audit\scripts\task24.ps1' report --stage offline
```

Expected: zero outbound provider requests, all tests/typecheck exit 0, the recovery matrix passes, and deterministic offline JSON/CSV/HTML/PDF reports are written under `D:\OpenCode-Benchmark\Task24\reports\offline`.

- [ ] **Step 7: Request code review and verify repository state.**

Use `superpowers:requesting-code-review`, address concrete findings, rerun focused checks, then use `superpowers:verification-before-completion`. Confirm no key-shaped strings or Task24 local data are tracked.

- [ ] **Step 8: Commit and push the reviewed Task24A implementation.**

```powershell
git add packages/benchmark scripts/task24.ps1 docs/superpowers/plans/2026-09-12-opencode-workflow-effect-benchmark.md
git commit -m "test(benchmark): verify task24 offline"
git push fork dev
```

- [ ] **Step 9: Build, atomically deploy, and freeze the two measured binaries.**

Build the modified executable from the clean pushed `dev` commit with the pinned Bun, run `scripts/test-local-deploy.ps1`, then atomically update `D:\OpenCode-Local` through the existing deployment script while retaining the prior binary/hash as rollback:

```powershell
$env:OPENCODE_VERSION = "0.0.0-dev-$(Get-Date -Format yyyyMMddHHmm)"
Push-Location 'D:\OpenCode-Audit\packages\opencode'
& $Bun run script/build.ts --single --skip-install
Pop-Location
powershell -NoProfile -ExecutionPolicy Bypass -File 'D:\OpenCode-Audit\scripts\test-local-deploy.ps1'
powershell -NoProfile -ExecutionPolicy Bypass -File 'D:\OpenCode-Audit\scripts\deploy-local.ps1' `
  -SourceRoot 'D:\OpenCode-Audit' `
  -DeploymentRoot 'D:\OpenCode-Local' `
  -Version $env:OPENCODE_VERSION
```

Build the locked official upstream source without patches into `D:\OpenCode-Benchmark\Task24\toolchain\upstream`; hash both executables and record version/source commit/build inputs. Smoke the deployed modified launcher with benchmark transport absent to prove ordinary production behavior remains unchanged.

- [ ] **Step 10: Rerun offline acceptance against the exact frozen binaries.**

Run the fake five-arm campaign through the deployed modified binary and frozen upstream binary. Re-run seal candidate validation, ledger reconciliation, redaction scan, evaluator reproducibility, and report reproducibility. If this uncovers a defect, fix it in a new reviewed commit, push, rebuild/redeploy, and repeat before sealing.

- [ ] **Step 11: Create the final immutable seal and stop at the paid gate.**

```powershell
& 'D:\OpenCode-Audit\scripts\task24.ps1' campaign seal
& 'D:\OpenCode-Audit\scripts\task24.ps1' campaign verify
git status --short --branch
```

Verify `dev` matches `fork/dev` and the repository is clean. Report the exact Task24A evidence, final campaign hash, sealed three-task pilot selection, modified/upstream binary hashes, and maximum Kimi CNY/DeepSeek USD envelope. Do not start Task24B in the same authorization.

---

### Task 24.12: Run Task24B Three-Task Paid Pilot

**Prerequisite:** the user explicitly approves separate maximum amounts in Kimi CNY and DeepSeek USD after reviewing Task24A. Approval is scoped only to the sealed Task24B pilot.

**Local outputs:** `D:\OpenCode-Benchmark\Task24\runs\<campaign>\pilot`, `D:\OpenCode-Benchmark\Task24\reports\pilot`.

- [ ] **Step 1: Generate a body-free preflight envelope.**

Show the three sealed task IDs/families—one private, one Design2Code-Hard, and one SWE-bench Multimodal task—A–E run count, per-arm/model request ceilings, worst-case tokens, Kimi CNY reservation, DeepSeek USD reservation, wall time, binary hashes, source lock hash, and campaign seal hash.

- [ ] **Step 2: Bind the explicit approval.**

Create a local approval envelope whose stage/campaign/seal/provider/currency/ceiling values exactly match the user's authorization. Never infer a cross-currency conversion or borrow unused Kimi budget for DeepSeek.

- [ ] **Step 3: Run live protocol preflight with the smallest sealed requests.**

Make one minimal metered request per required route—Kimi K3 Chat, DeepSeek V4 Pro Responses, and DeepSeek V4 Flash Responses—through the broker. Verify model identity, endpoint, streaming terminal event, usage, price accounting, and remaining ceiling. These calls count against Task24B.

- [ ] **Step 4: Execute three tasks across A–E.**

Use one task from each of three distinct primary families, balanced arm order, fresh workspaces, concurrency 1, and sealed limits. Stop automatically on any provider ceiling, repeated infrastructure fault, protocol drift, credential failure, or evaluator-integrity failure.

- [ ] **Step 5: Reconcile before evaluation/reporting.**

Confirm every forwarded request has exactly one terminal ledger settlement, total charge does not exceed either approved ceiling, no unknown request remains, and no key/grant/body appears in durable outputs.

- [ ] **Step 6: Evaluate and render the pilot report.**

Generate all score components and JSON/CSV/HTML/PDF, but label inferential results as pilot-only and underpowered. Inspect screenshots and functional evidence for evaluator defects without altering run outputs.

- [ ] **Step 7: Decide readiness.**

Classify the pilot as `ready`, `harness_revision_required`, or `provider_blocked`. Any harness change invalidates the current campaign seal and requires rerunning Task24A before a new pilot/campaign.

- [ ] **Step 8: Push only sanitized code/documentation changes.**

Raw pilot outputs, prompts, ledgers, and hidden evidence remain under D and out of Git. If no code changed, record the pilot report path and hashes without manufacturing a commit.

---

### Task 24.13: Run Task24C Full Scored Campaign

**Prerequisite:** Task24B is `ready`, and the user separately approves new maximum Kimi CNY and DeepSeek USD amounts for the sealed full campaign.

- [ ] **Step 1: Reverify the frozen environment.**

Verify campaign seal; modified/upstream binary hashes; source/task/gold/evaluator/price locks; broker/runtime manifests; available disk; isolated roots; provider route health; and absence of incomplete pilot processes. Any mismatch stops before spend.

- [ ] **Step 2: Derive and bind the new approval envelope.**

For each provider, calculate pilot P95 usage for the relevant route/model, multiply by the planned activated cells/requests, then add exactly 20% reserve. Present the resulting Kimi CNY and DeepSeek USD maxima to the user and bind only the explicitly approved values and authorization reference. Pilot spend is not silently rolled into or deducted from the new campaign unless the approval explicitly states that accounting rule.

- [ ] **Step 3: Admit the complete run matrix before dispatch.**

Create all A/B/C primary repetitions, A/B/C guardrails, and first-pass D/E runs in deterministic balanced order. Keep conditional D/E second passes in a sealed dormant state.

- [ ] **Step 4: Execute with continuous hard-budget enforcement.**

Use fresh workspaces and isolated OpenCode roots. Persist after each state transition and ledger settlement. Stop on ceiling exhaustion, integrity violation, protocol/model drift, source/binary drift, or a campaign-level infrastructure failure threshold.

- [ ] **Step 5: Apply the D/E second-pass rule mechanically.**

After all required first passes are terminal and valid, calculate the preregistered 5-percentage-point trigger. Activate or skip D/E second passes without viewing diagnostic subscores or choosing favorable tasks.

- [ ] **Step 6: Close and reconcile the campaign.**

Require terminal state for every activated run, adjudicate infrastructure-only unknowns using predefined reason codes, settle every reservation, revoke all grants, stop helpers/previews, and freeze the campaign database/evidence index hashes.

- [ ] **Step 7: Run a no-write evidence audit.**

Verify arm isolation, no human edits, no hidden leakage, body-free logs, valid references, score reproducibility, and approved spend. Do not alter workspaces or results during this audit.

- [ ] **Step 8: Stop before interpretation if incomplete.**

If the campaign is incomplete or invalid, report exact reason codes and remaining approved headroom. Any rerun requires separate explicit authorization; it is not implied by Task24C approval.

---

### Task 24.14: Complete Task24D Analysis, Report, Review, and Cleanup

**Local outputs:**

- `D:\OpenCode-Benchmark\Task24\reports\final\summary.json`
- `D:\OpenCode-Benchmark\Task24\reports\final\cells.csv`
- `D:\OpenCode-Benchmark\Task24\reports\final\leaderboard.html`
- `D:\OpenCode-Benchmark\Task24\reports\final\report.pdf`
- `D:\OpenCode-Benchmark\Task24\reports\final\evidence-index.json`
- sanitized per-cell JSON, patches, screenshots, and evaluator logs referenced by the evidence index

- [ ] **Step 1: Freeze the analysis input.**

Copy no bodies. Hash the read-only campaign database, canonical evaluation records, ledger summary, binary/source/task/evaluator locks, and adjudication log into the final analysis manifest.

- [ ] **Step 2: Compute primary and secondary results.**

Calculate A/B/C qualified-success rates, A–B and A–C gains with 10,000 task-cluster bootstrap intervals, family checks, guardrails, provider-native spend, cost per qualified success, and the exact preregistered decision. Report diagnostic score, time, tokens, tool calls, retries, revision loops, and failure categories as secondary.

- [ ] **Step 3: Add upstream context without contaminating causality.**

Present D/E beside B/C with binary version/hash and one/two-pass status. Explain that these estimate release-context differences and are not part of the primary workflow-effect claim.

- [ ] **Step 4: Render and visually verify all deliverables.**

Generate JSON/CSV/HTML/PDF from one report model. Render every PDF page to images for QA, inspect pagination/tables/charts/fonts, fix report code if needed, regenerate all formats, and delete the render previews after verification. Include anonymized visual comparisons and representative sanitized successful/failed patch excerpts without exposing prompts, hidden gold, credentials, or provider bodies.

- [ ] **Step 5: Conduct the blinded qualitative audit and independent evidence review.**

Present the randomized anonymized pairs for every 70–79 automatic-visual case to human reviewers and retain their qualitative notes separately; those preferences never modify automatic scores or qualification. Use `superpowers:requesting-code-review` for the implementation and a separate read-only audit of decision-rule application, ledger reconciliation, task inclusion, disqualifications, and report/body redaction. Resolve discrepancies from underlying records, never by editing aggregate outputs directly.

- [ ] **Step 6: Clean only verified Task24 intermediates.**

Remove resolved runner-owned children of `tmp`, expired per-run config/grant files, disposable browser profiles, staged archives, and failed report render previews. Keep source/binary locks, campaign DB, append-only ledgers, evaluated workspaces required for audit, evidence, manifests, and final reports.

- [ ] **Step 7: Final verification.**

```powershell
& 'D:\OpenCode-Audit\scripts\task24.ps1' campaign verify
& 'D:\OpenCode-Audit\scripts\task24.ps1' ledger reconcile
& 'D:\OpenCode-Audit\scripts\task24.ps1' evaluate --verify-only
& 'D:\OpenCode-Audit\scripts\task24.ps1' report --verify-only
git status --short --branch
```

Expected: seal/ledger/evaluation/report verification succeeds, no provider call occurs, Git is clean except deliberate sanitized report-documentation changes, and every final file hash matches the evidence index.

- [ ] **Step 8: Commit any final sanitized documentation, push, and hand off.**

```powershell
git add docs benchmarks/task24
git commit -m "docs(benchmark): publish task24 findings"
git push fork dev
```

Do not commit raw task outputs, API ledgers with sensitive metadata, hidden gold, provider usage bodies, or local campaign databases. Report the final decision, uncertainty, guardrails, provider-native spend, limitations, rollback/deployment state, GitHub commit, and clickable D-drive deliverables.

---

## Execution Checkpoints

1. **Implementation checkpoint:** Tasks 24.1–24.11 complete; Task24A passes with zero paid calls; all commits pushed.
2. **Pilot authorization checkpoint:** user reviews the sealed pilot envelope and explicitly approves separate Kimi CNY and DeepSeek USD ceilings.
3. **Campaign authorization checkpoint:** user reviews Task24B and explicitly approves new separate ceilings for Task24C.
4. **Final evidence checkpoint:** Task24D reproduces the decision from frozen inputs and produces verified JSON/CSV/HTML/PDF without additional provider calls.

The implementation session must stop at each authorization checkpoint. “按计划执行” authorizes the zero-credit implementation/Task24A work, but does not by itself authorize Task24B or Task24C spend.
