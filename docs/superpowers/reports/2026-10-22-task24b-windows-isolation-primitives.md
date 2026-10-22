# Task24B — Windows isolation primitives, not full runtime readiness

Date: 2026-10-22. Branch: `dev`. No paid model API calls; no deployment replacement.

## Verified scope

- A real LPAC worker can write its admitted workspace, read admitted read-only assets, and cannot read ungranted canaries, write read-only assets, or contact an unadmitted loopback service. Cancellation, timeout, output bounds, and descendant termination are exercised.
- A private copy of frozen Chromium 147.0.7727.15 runs with Chromium's own sandbox enabled. The trusted, pinned helper is not an AppContainer broker and never executes project Node code. Actual observed renderers have restricted primary tokens and low integrity (4096); they are not reported as AppContainers.
- Browser smoke performs a real button click and PNG capture. Non-preview loopback and file canaries are denied; the network canary receives zero requests. Six exclusively owned security registrations are unregistered and their default application-data paths remain absent.
- Persistent WFP DENY filters are separate from dynamic, narrowly scoped PERMIT filters. Actual private-executable policy testing proves that killing the supervisor removes the dynamic permit while the persistent deny remains effective. A fresh canary client is blocked, with zero server hits.
- Generic network-policy recovery requires the exact original supervisor instance dead and a still-named, held job with zero active processes. An absent job is not accepted as an empty-job proof. Retirement checks exact object keys, identity bytes, action, conditions and ownership within an explicit transaction, and verifies absence after commit.
- BFE chooses an available sublayer weight and may add `INDEXED`. Validation accepts only those documented runtime differences; disabled filters and other unexpected flags remain rejected.
- Journal admission is bounded before hashing; blocked stdin flushes can be interrupted; final process waits and cleanup walks are bounded. Cleanup retains and reports roots with unexpected links or uncertain termination.

## Durable real evidence

Final fixed-source verification: benchmark full suite **513 passed, 10 skipped, 0 failed**, 2,740 assertions, 523 tests across 124 files (373.27 seconds). The three new real Windows opt-ins were enabled. Separate focused checks passed 31 pure/control-plane tests (208 assertions), four normal Windows admission/live tests (44 assertions), and the crash/recovery test (12 assertions). Package typecheck and Prettier check passed. Existing skipped tests were not enabled or weakened to manufacture a full-readiness result. Exact skipped names and all results are in `benchmark-final-suite.log` in the evidence directory.

`D:\OpenCode-Benchmark\Task24\reports\windows-native-20261022-29c4-final` contains actual generated browser observations, policy crash/recovery observations, source identities and the two earlier exact-policy retirement records. The final browser observation contains two restricted low-integrity renderers, zero network-canary hits and a 9,624-byte PNG hash.

The crash test is deliberately **network-policy-only**, using a private Bun executable and the same production application-ID policy path. It does not claim integrated browser/AppContainer/DACL crash recovery or production-arm readiness.

Two earlier invocations failed in `PolicyCreate` after rule commit but before job/process creation. Their exact journal hashes, identities, supervisor instances and six filter/sublayer keys were independently checked before a one-off, two-selector retirement. This positive prelaunch evidence is not a new generic absent-job recovery path; the temporary helper is outside the repository.

## Protection and cleanup

The existing deployment, old Docker disks and old C-drive Docker directories were not changed. `.wslconfig` remains SHA256 `6a6432a0a5a905c76a7a4ae381deb63eec6c700f34741ab238ab71aa383d92e9`. Old disk lengths and modification times remain unchanged; their contents were not read.

Removal of these verified disposable test copies was denied by tool policy. No alternate deletion method was attempted. Their persistent rules have been retired; the copies remain on D:

- `D:\OpenCode-Benchmark\Task24\tmp\bprep2-7c4f20261021\windows-browser-live-TLfC9z` — 523,029,618 bytes.
- `D:\OpenCode-Benchmark\Task24\tmp\bprep2-7c4f20261021\isolation-live-tsaUtR\control\native-isolation-ZeZBqu` — 98,482,576 bytes.
- `D:\OpenCode-Benchmark\Task24\tmp\bprep2-7c4f20261021\windows-policy-live-wrm9o7` — 98,482,997 bytes. Its policies were retired; only the fixture's later cleanup rejected PowerShell module-loading progress. The progress-only issue was subsequently fixed without ignoring real stderr or changing exit checks.

The previously denied `browser-metadata-compile-subtask` directory and its small, exact-target cleanup helper remain; no retry was made. Other previously reported denied/uncertain scratch roots remain outside this cleanup claim.

Six exhausted, individually verified temporary debugging/evidence-collection source scripts were removed. The new full-suite/publication directory `D:\OpenCode-Benchmark\Task24\tmp\bprep1-20261022-windows-final-29c4` is retained while publication uses its no-dotenv wrappers; it contains a disposable Bun copy and D-only test state. Remaining directory-level cleanup is not worked around after policy rejection.

## Still not completed

This change provides tested Windows primitives, not a completed `HostIsolationAdapter` factory. Remaining work includes sealed runtime/session integration and LPAC-compatible public-tool IPC; the truthful protocol-v2 browser release and semantic interactions; and the full corpus/dependency/reference preparation plus production-binary capability matrix and real calibration. No full engine readiness receipt or 120-run calibration completion is claimed.

## Primary references

- [Microsoft: installing a WFP provider — BFE-assigned sublayer weight](https://github.com/MicrosoftDocs/win32/blob/docs/desktop-src/FWP/installing-a-provider.md)
- [Microsoft: FWPM_FILTER0 flags and filter weights](https://learn.microsoft.com/en-us/windows/win32/api/fwpmtypes/ns-fwpmtypes-fwpm_filter0)
- [Microsoft: job object lifetime](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Chromium frozen sandbox implementation](https://github.com/chromium/chromium/blob/147.0.7727.15/sandbox/win/src/app_container_base.cc)

## Production MCP wiring increment — 2026-10-22

The runtime now supplies its verified session, frozen manifest, exact adapter artifact identity and revalidation guard to the adapter factory. Fixture context is not an engine receipt; the real-runner gate still precedes module import. Module-cache identity is bound to the artifact.

Public tooling now also supports one authenticated IPv4-loopback port, with a fixed private route, strict UTF-8/single-frame parsing, five enumerated operations, 12 MiB request/reply bounds, 16 concurrent requests, and Origin rejection. The named-pipe API remains compatible. Shutdown revokes authority, stops admission gracefully and drains within at most five seconds; an unsettled operation produces sticky cleanup uncertainty and prevents workspace retirement. A deferred-operation regression exposed a Bun crash with forced HTTP shutdown; the graceful, bounded path passes that regression.

The frozen standalone MCP executable disables dotenv, bunfig, package and tsconfig autoload. The real LPAC test uses the production MCP entry and `makePublicToolHost`, not a synthetic successful write. It replaces an existing source file using CAS and atomic rename, reads it back, then rejects writes after the readonly transition. A hostile, owned bunfig preload is not executed. A separate real LPAC probe is denied direct overwrite, create, unlink and rename; a controller directory-rename attempt is also rejected.

This uses an optional **mediated** workspace: the child receives only ReadAndExecute. All leaves are sealed during initial ACL inheritance; afterward only mediated leaf pins are retired. Directory handles retain no DELETE sharing, while READ/WRITE sharing permits trusted child-entry updates. Immutable assets and ordinary writable roots retain their previous behavior. Merely adding delete sharing to an open leaf was insufficient on the real Windows host; bounded Win32 probes isolated both the open-target and directory-sharing restrictions.

Implementation rulings: continue the already approved plan without new design documents; use private HTTP framing for Bun's half-close incompatibility; use standalone packaging rather than expanding ancestor access; and mediate writes without broadening the child's ACL. Incorrect choices require internal transport/packaging revision or blocking the optional mode, never promotion to full readiness. One fresh read-only review found the real-write integration gap; the strengthened live test failed before the fix and passed afterward. Deferred minor coverage: hostile direct oversized/chunked requests and a seventeenth concurrent request. The inherited 30-second client versus 300-second backend deadline remains a usability limitation, not a claimed completed acceptance case.

Evidence and final publication logs are retained in `D:\OpenCode-Benchmark\Task24\reports\production-mcp-20261022-8c61`. The current task's compiler-error scratch copy is retained as uncertain; no generic absent-job cleanup proof was invented. Old policy-denied scratch roots were not retried.

Final fixed-source package verification: **523 passed, 10 skipped, 0 failed**, 2,821 assertions, 533 tests across 128 files, 379.28 seconds. All three real Windows opt-ins, including the added real MCP test under the worker opt-in, were enabled. Package typecheck, formatting and whitespace checks passed. Skipped cases do not count as accepted real-engine or corpus work.

Still incomplete: the full `HostIsolationAdapter`, protocol-2 browser production wiring, Arm A's newly authorized finite WSL2 production-host bridge, the complete official-CLI five-tool/binary matrix, and all 16 tasks/120 real calibration evaluations. This increment does **not** complete Tasks 6–10 or publish a full readiness receipt. Paid scoring and deployment replacement remain unperformed. The original untracked follow-up report, `.wslconfig` hash and old disk metadata remain unchanged.

References: [Bun ancestor-discovery issue](https://github.com/oven-sh/bun/issues/28220), [Bun executable configuration autoload](https://bun.sh/docs/bundler/executables#automatic-config-loading), [Microsoft file-rename semantics](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/4217551b-d2c0-42cb-9dc1-69a716cf6d0c).
