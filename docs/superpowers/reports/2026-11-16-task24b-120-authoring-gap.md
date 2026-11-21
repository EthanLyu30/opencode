# Task24B 120 calibration — production authoring gap

Date: 2026-11-16
Base: `7a97299c7` (fork/dev)
Status at writing: B-Prep2 **not complete**; real Linux calibration was **0/120**; readiness is **false**; no receipt exists.

> **Update 2026-11-21:** a calibration-only campaign has since evaluated all 120 required rows on Linux: 120/120 real, 120/120 matched, 120/120 stable, `corpusEngineReady: true` (see `2026-11-21-task24b-linux-120-calibration.md`). That campaign used an explicitly issued `calibration-only` authority with `readinessEligible: false`; it does **not** close the production authoring gap described below. The `prepare` → `finalizeHostManifest` producer chain is still missing, and no production `accept`/`calibrate` path or readiness receipt exists.

## What is already fixed

`packages/benchmark/src/sandbox/dependencies.ts` now keeps every already-frozen static artifact from a prepared manifest while replacing pending declarations with verified binary, browser and image identities:

- `composeAcceptArtifacts` (line 421) rejects duplicate ids, supplied pending entries, replacement of a frozen prepared artifact, and any pending entry left in the accept manifest.
- `finalizeHostManifest` (line 439) requires the process-local `issuedImages` proof, a `phase: "prepare"` input and a matching `manifestSha256`; it no longer drops `controller-inventory`, `runtime-config` and expectation artifacts.
- `packages/benchmark/test/linux-host/accept-manifest.test.ts` covers preservation, residual pending, duplicate supplied and frozen-replacement cases (4 tests).

This closes one correctness hole. It does **not** create the missing producer chain below.

## The actual reachability gap

The CLI modes are `inspect | plan-preparation | prepare | accept | calibrate | verify` (`packages/benchmark/src/sandbox/command.ts:20`). Each mode consumes files that no production code authors:

| Consumed input | Consumer | Current producer |
| --- | --- | --- |
| `phase: "prepare"` HostManifest | `prepare` at `command.ts:113-143` | none; only `test/linux-host/fixture.ts` builds one by hand |
| `controller-inventory` worker artifact | `verifyControllerIdentity` at `controller-identity.ts:15-63` | none |
| `runtime-config` JSON | `openLinuxRuntime` at `runtime.ts:242-245` | none |
| `benchmark-models` JSON | `runtime.ts:277` | none |
| `host-isolation`, `controller-bun`, `public-mcp`, `production-engine` files | `runtime.ts:249-298`, `loadHostIsolationAdapter` | built by tests or ad-hoc scripts, not bound by any production author |
| `browser` + `fonts` + `browser-helper` identities | `runtime.ts:279-292`, `fonts.ts` | no prepare-to-accept path |
| `dependencies` JSON with 16 linux-attested tasks | `runtime.ts:300-313` | `prepareLinuxArtifacts` returns `ResolvedImages`; CLI writes it, then exits |
| accepted `linux-acceptance-input.json` | `runtime.calibrate` at `runtime.ts:791` | written only by a successful `runtime.accept()` |

`finalizeHostManifest` is therefore a terminal composer, not an authoring pipeline. Even if `prepare` called it, no code constructs the prepare manifest or the runtime config it must freeze.

## Why hand-authoring is not a workaround

- `finalizeHostManifest` checks `issuedImages.has(input.images)`; the WeakSet lives only in the `prepareLinuxArtifacts` process (`dependencies.ts:93,379`). A later process cannot reconstruct it from JSON.
- `openLinuxRuntime` rejects a dependencies file unless it has exactly 16 distinct tasks, all `linux-attested`, and every task image appears as an `image` artifact in the accept manifest (`runtime.ts:300-313`).
- `decodeHostManifest` requires complete source, test and policy fingerprints, and the controller inventory recomputes every file identity and each role fingerprint (`controller-identity.ts:42-62`).
- Therefore an accept manifest and a runtime config must be generated from the same observed files and images, in the same trusted process, then sealed.

## Proposed minimal production chain

These are the smallest additions that make the existing acceptance code reachable without weakening any check.

1. **Controller inventory author** — `authorControllerInventory(root)` walks exactly `src`, `script`, `test/linux-host`, `package.json` and `../../bun.lock`, classifies `test/` as `test`, `sandbox/` as `policy`, everything else as `source`, and emits `{schemaVersion: 2, root, files}`. It also returns the three canonical role hashes used for `sourceSha256`, `testSha256` and `policySha256`.
2. **Prepare manifest author** — `authorPrepareManifest({request, inventory, controllerInventory, artifacts, pending})` reuses `decodeHostManifest` and `requestOf`; `artifacts` are concrete files/JSON already observed on disk; `pending` entries are image recipes from the preparation plan. It refuses to emit when any concrete artifact is stale or any pending recipe is absent.
3. **Prepare-mode seal** — after `prepareLinuxArtifacts` succeeds, the same process builds the binary and browser artifacts from the build records and browser release, calls `finalizeHostManifest`, re-reads the accept manifest, and publishes it immutably. This preserves the in-process `issuedImages` proof.
4. **Runtime config author** — `authorRuntimeConfig` must bind the 16 catalog tasks to the five arm cases, profiles, corpus plans and references. This is the largest piece and needs the actual per-arm launch data; do not synthesize it from test fixtures.
5. **Tests** — RED/GREEN at module level plus a full `prepare`-to-`accept` fixture path that uses only synthetic files and no Docker. Real 120 still requires the host conditions below. (2026-11-21: real 120 has been run under calibration-only; this does not remove the need for the production fixture path.)

## Host blockers (unchanged)

- `docker info` fails: `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified`.
- `wsl --status` and `wsl -l -v` return `Wsl/E_ACCESS_DENIED` inside this sandbox.
- The benchmark roots must live under `D:\OpenCode-Benchmark\Task24\(tmp|workspaces|reports|toolchain)` (`contracts.ts:186`), but D writes are denied in the current DSH sandbox.

No readiness receipt, no `corpus_engine_ready`, no Task 8 real matrix and no publication exists. Preserve all prior uncertain fixtures; do not retry or delete them.
