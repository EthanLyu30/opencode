# Task 23.9 implementation report

## Result

Task 23.9 is implemented locally in two scoped implementation commits:

- `7cf08cd1e517fa65f8232362f91c432f34ae81de` (`fix(events): preserve public session authority`)
- `1af75425494f9ff4865528337041fe10f4e5a813` (`feat(server): expose visual build admission`)

`POST /api/workflow/visual-build` is now an exact Protocol operation named `workflow.visualBuildCreate`. It accepts strict `WorkflowVisualBuild.CreateInput`, accepts the bounded optional `Idempotency-Key` only as a header, derives canonical Location in the handler, and returns the admitted Workflow and Response. The Promise and Effect clients expose the generated operation. HTTP code does not choose providers or accept caller placement, provider/model, URL, command, workspace, directory, or idempotency fields in JSON.

This report records implementation and self-verification evidence only. It does not claim that a separate independent review is clean or complete.

## Task 23.8 load-bearing closures

All four findings transferred by the Task 23.8 breaker were closed before exposing admission:

- Legacy instance `/event`, the Server event surface, GlobalBus, replay, and sync history now use complete-batch public authority. The real legacy POST admission regression proves a hidden Workflow Session batch does not disclose the prompt sentinel, receipt, Workflow/Session/Response IDs, or reorder surrounding ordinary public Session events.
- Session deletion is transactionally terminal. Compaction, exact tombstone/sequence authority, rollback, replay, post-delete rejection, and live notification are exercised without a best-effort postcommit gap.
- EventV2 projects, stores, classifies, and notifies from one schema-decoded canonical envelope. Extra caller data cannot survive only in the live path.
- TUI deletion consumers prefer the minimal v3 `sessionID` and retain a narrow malformed/legacy `info.id` fallback. The authoritative generated SDK v2 deletion type is minimal v3 rather than requiring `properties.info`.

Meaningful focused RED/GREEN evidence included:

- Complete public EventV2/legacy visibility: **60 pass, 1 fail** before the repair; **62 pass, 0 fail, 138 assertions** after it.
- Terminal deletion boundary: **17 pass, 2 fail** before the repair; **19 pass, 0 fail, 81 assertions** after it.
- Canonical live payload: **61 pass, 1 fail** before the repair; **62 pass, 0 fail, 138 assertions** after it.
- The new legacy `/event` admission case passed **1/1, 10 assertions**; the final event HttpApi file passed **4/4, 21 assertions**.
- Minimal v3 TUI consumers passed **2/2, 4 assertions**; generated SDK v2 authority passed **2/2, 5 assertions**.

## Admission, composition, and authorization

Protocol RED first failed because `makeWorkflowGroup` and the endpoint were absent. GREEN exposes the exact route, operation ID, header bounds, and strict body rejection: **10 pass, 0 fail, 17 assertions**.

The real generated-client HTTP test covers Promise and Effect calls, background queued admission, same-key/same-Location exact Workflow/Response identity with one wake, distinct Locations, foreground returning the same terminal Response, and strict body/header `400` behavior. Its final SDK-next matrix passed **5/5, 37 assertions** together with the existing embedded Responses contract.

Standalone and embedded Server route graphs both provide Workflow, Responses, Execution, Admission, and production replacements. A recovery-layer acquisition failure exposed a real composition defect: `Effect.tryPromise` converted an invalid Docker configuration into `Fail(undefined)`, preventing embedded app acquisition. The repair maps only Docker configuration validation failure to the existing unhealthy/not-ready recovery service; `recoverExpired` remains outside that fallback and its errors are not swallowed. The final composition matrix passed **17/17, 40 assertions**.

The OpenCode route graph additionally provides both production Session execution nodes. The handler no longer constructs a canonical Location reference with an explicit `workspaceID: undefined`, which had produced a `500`. The exact OpenAPI/auth/generated SDK gate passed **47/47, 259 assertions** and proves endpoint exposure, existing v2 Basic Auth and bodyful `401`, operation naming, and unchanged existing routes. OpenCode typecheck is fully green; no adjudicated baseline error remains in the current tree.

During final recovery, two SDK tests timed out at the unchanged 5-second boundary. Systematic isolation found mutable global auth configuration and unrelated cold Git fixture acquisition, not a product gateway failure. Basic Auth now uses a fresh ConfigProvider/layer and a generated global health call; the general instance-read and event fixtures use `git: false`, while the separate project Git initialization test retains real Git coverage. Basic Auth passed alone **1/1, 2 assertions**, instance read passed alone **1/1**, and their combination passed **2/2, 2 assertions**. No timeout was raised and no product behavior was relaxed.

The existing generic foreground embedded fixture was also stale for the fail-closed, no-Location workflow. It now observes the publicly admitted queued Response, cancels it through the public API, joins the request, and proves the returned object is that exact cancelled Response. Background generated/pro requests remain queued; the fixture does not add a fake production Location, directly mutate storage, call a provider, create a second Response, or create a second wake.

## Generated clients and controller ruling

The client and legacy SDK were regenerated only through their official package commands; generated files were not hand-edited.

- `packages/client` generation was run twice and compared as Git-native LF bytes. Both authoritative diffs were **59,546 bytes**, SHA-256 `78069C4EA96F757DE5FC4B445A3C401BCB3C281A7A477CF6F63306082B1CB5F4`. A post-commit `bun run check:generated` passed with no diff.
- `packages/sdk/js` official build was run twice and compared as Git-native LF bytes. Both authoritative diffs were **394,991 bytes**, SHA-256 `F286FB5FF61732ED0696CBA6A99E0E9BCC2327B379764D53CC722C73CCB587B9`. A post-commit official build completed with no substantive or status diff.

The controller ruled that Task 23.8 explicitly handed its cumulative legacy SDK generated baseline to Task 23.9. Therefore the deterministic official output is retained in full even though it is large; the generator was not changed to shrink the diff and output was not hand-selected. Only `packages/sdk/js/src/v2/gen/sdk.gen.ts` and `types.gen.ts` contained substantive SDK changes. The other 32 SDK status entries and two OpenCode middleware entries were CRLF working-tree noise: every canonical `git hash-object --path` matched the index blob, and refreshing those exact paths produced zero staged diff.

Official codegen initially rejected `DesignArtifact.SourcePath` as `Unportable` because it used a custom `Schema.makeFilter`. Equivalent portable `Schema.isPattern` constraints now preserve the safe normalized relative POSIX subset, Windows device-name rejection, single-line environment values, and NUL-free argv. The focused schema safety suite passed **9/9, 46 assertions**.

## Fresh verification

All commands used pinned Bun `D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe` from the relevant package directory with `TEMP`, `TMP`, and Bun cache below `D:\OpenCode-Task23.9`:

- Core EventV2/deletion/runner matrix: **86 pass, 0 fail, 229 assertions**.
- Protocol workflow matrix: **10 pass, 0 fail, 17 assertions**.
- Schema portability/safety matrix: **9 pass, 0 fail, 46 assertions**.
- TUI minimal deletion matrix: **2 pass, 0 fail, 4 assertions**.
- Server runtime/composition matrix: **17 pass, 0 fail, 40 assertions**.
- SDK-next visual-build/embedded matrix: **5 pass, 0 fail, 37 assertions**.
- Client full package tests: **22 pass, 0 fail, 117 assertions**.
- Legacy SDK generated authority: **2 pass, 0 fail, 5 assertions**.
- OpenCode OpenAPI/auth/generated SDK matrix: **47 pass, 0 fail, 259 assertions**.
- OpenCode legacy event HttpApi: **4 pass, 0 fail, 21 assertions**.
- Core, Protocol, Schema, TUI, Server, Client, SDK-next, legacy SDK, and OpenCode typechecks: **exit 0**.
- Exact 41-file Prettier check and `git diff --check`: **exit 0**.
- Oxlint covered 36 authored files after excluding five official generated outputs. Its 85 whole-file warnings are inherited; **0 diagnostics intersect changed lines**.

The final diff/security audit found no changed `.env`/credential filename and no API-key, private-key, or token literal signature. The only non-local URL literal host was the synthetic `opencode.local` base URL intercepted by injected test transports. No provider, external network, browser, Docker, paid, deployment, push, ACL, or secret-reading action was performed.

The exact task-owned `D:\OpenCode-Task23.9` directory was verified as a non-reparse directory containing only `bun-cache`, `diffs`, `temp`, and `tmp`, then moved to the Windows Recycle Bin. Repository inputs and user-owned files were preserved.

## Independent review fix round 1/5

Fix round 1 addresses both Important findings from the independent review, with 2 addressed and 0 open in this round. The implementation range is `dc1820d6b0fc02f868ea2003f680a341446cc402..6afdc9343`; this is implementation and self-verification evidence only and does not claim that an independent re-review is clean or complete.

The standalone `/api/event` handler had acquired one mutable `makeLiveBatchFilter` for its entire handler group even though the filter is explicitly single-subscriber state. Two concurrent readers could therefore corrupt each other's pending/rejected/lock state and permanently drop members of the same public batch. The deterministic RED interleaved two readers as `A0 -> B0 -> A1 -> B1` and failed after 5 seconds with 0 pass, 1 fail, and 5 assertions because one reader lost the batch. The handler now creates the filter inside each `event.subscribe` request. The same interleaving is GREEN with 1 pass, 0 fail, and 10 assertions: both readers receive the complete public batch in order, both suppress hidden data, and both continue to the marker event. Existing complete-batch fail-closed coverage remains green: the Core event matrix passed 62/62 with 138 assertions and the legacy OpenCode event HttpApi passed 4/4 with 21 assertions.

The visual-build preview environment schema previously expressed the safe name constraint as record `patternProperties`. The legacy SDK generator consequently widened every value to `unknown`, so numeric values compiled even though the endpoint rejected them. The source now expresses the same contract as `Record(String, EnvironmentValue)` plus Effect's structural `isPropertyNames(EnvironmentName)` refinement. The portability visitor accepts only that reconstructible built-in AST form: it requires the exact `isPropertyNames` metadata, the Effect structural marker, a portable property-name AST, and all existing annotations; spoofed, aborted, custom, and unknown filters still fail closed. The focused codegen RED reported `Unportable schema: workflows.workflow.visualBuildCreate.payload`; GREEN passed 63/63 with 122 assertions, including a spoofed-propertyNames rejection. Protocol runtime coverage accepts safe string values and rejects numeric, malformed-name, and newline values (11/11, 22 assertions). Exact OpenAPI coverage proves string `additionalProperties` plus constrained `propertyNames`.

The authoritative SDK TypeScript contract accepts string environment values and places `@ts-expect-error` directly on a numeric value. Before generation, typecheck failed only with `TS2578` because the directive was unused; after official generation it is consumed and the SDK typecheck is green. The official `packages/sdk/js` build was run repeatedly, including two clean deterministic rounds: each Git-native generated diff was 451 bytes with SHA-256 `A390C7ED9B595391C1ABBA22F91AF532C9EC7D739D912AC266478C22A31CB282`, and the only substantive generated change was `src/v2/gen/types.gen.ts`. A post-commit official build left the worktree clean. `packages/client` `check:generated` also passed before and after the implementation commit with no generated diff.

Fresh focused verification passed: Server concurrent SSE 1/1 (10 assertions), Core event 62/62 (138), legacy event 4/4 (21), Protocol 11/11 (22), Schema source-path/design-artifact 9/9 (46), HTTP API codegen 63/63 (122), SDK-next visual-build/embedded 5/5 (38), Client 22/22 (117), SDK-js runtime 2/2 (5), and OpenCode OpenAPI/auth/generated SDK 47/47 (260). Typechecks for Core, HTTP API codegen, Schema, Protocol, Server, Client, SDK-next, SDK-js (including the generated-type contract), and OpenCode all exited 0.

The OpenCode gate initially exposed an environmental proxy baseline rather than a product failure: the in-process server bound `0.0.0.0`, and a same-process request to that address received an empty `502` after about 3.3 seconds while `127.0.0.1` and `localhost` returned `200` in 11-16 ms. Running the unchanged gate with `NO_PROXY=0.0.0.0,127.0.0.1,localhost` produced the stable 47/47 result; no timeout, product gateway behavior, or test assertion was relaxed.

Exact-file Prettier and `git diff --check` exited 0. Oxlint reported 0 errors and 0 changed-line diagnostics; its two whole-file warnings precede the changed hunks. The final diff/security audit found 12 substantive implementation files, no sensitive filename, secret signature, or non-local URL, and no diagnostic `openapi.json` or CRLF-only noise. No provider, external network, browser, Docker, paid, deployment, push, or secret-reading action was performed. The exact task-owned `D:\OpenCode-Task23.9-Fix1` root was verified non-reparse and confined to task cache, deterministic-diff, and test-temp artifacts before being moved to the Windows Recycle Bin; repository inputs and user-owned files were preserved.
