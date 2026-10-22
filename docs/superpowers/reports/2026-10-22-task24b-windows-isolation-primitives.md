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
