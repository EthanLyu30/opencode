# Task 23.6B3 report — durable, idempotent screenshot evidence staging

Date: 2026-08-25
Base: `faafaec85fc37cf1f9874001e7f8ac0b1474dc08`
Branch: `dev`

## Scope

This report records the implementation and genuine RED/GREEN evidence for stable logical screenshot evidence identity, durable ACL-owned SQLite staging, exact commit/release/recovery semantics, and deterministic Core fake parity. It does not add Task23.7 role orchestration and does not invoke real Docker, Chromium, Windows ACL mutation/probing, providers, network, deployment, or C-drive caches.

## Design and root-cause analysis

The joint preflight found six additional load-bearing boundaries beyond the initial counter-to-item migration:

- an implementation screenshot cannot be keyed only by frozen preview configuration; the host-minted preview identity also carries the implementation snapshot/manifest SHA-256, while reference identity carries the exact validated reference-app hash;
- neither implementation SHA nor ready selector is accepted by `PrepareImplementationInput` or `CaptureInput`; production preparation obtains both through a trusted `resolveImplementationContract` seam, and fails typed-unavailable before capability creation when that authority is absent;
- artifact commitment binds the complete durable `Workflow.Artifact` identity (artifact/workflow/stage/kind/URI/MIME/SHA-256/size/canonical `timeCreated` epoch), PNG SHA-256, evidence ID, and canonical receipt SHA-256—not only the artifact hash;
- screenshot payloads embed the exact evidence receipt so a post-EventV2 crash can reconcile backwards from the durable artifact;
- browser work requires a durable `capturing` intent plus exact owner nonce before invocation; a foreign/orphan intent is ambiguous rather than recaptured, and only its exact owner can clear a known failed/cancelled attempt;
- durable failed/cancelled authority creates an `abandoned` tombstone which clears bytes without decrementing historical accounting or permitting recapture.

The ACL/SQLite preflight also confirmed that ACL descriptor probing is a high-level operation fence, not an individual-SQL fence. Each public ledger operation/transaction receives at most a before/after ACL probe; every internal SQL boundary retains cheap canonical root, main-database identity, owned-file, and injected-boundary checks. The main database device/inode/birth identity is captured after open and compared thereafter so a same-path safe regular-file replacement cannot split the verified pathname from the live SQLite handle.

The identity API was further narrowed after static review. A caller never supplies an evidence ID beside coordinates: `evidenceCoordinates(CaptureInput)` returns only exact logical coordinates, and the one canonical encoder derives the opaque ID. Receipts alone carry both ID and coordinates, allowing durable rows/artifacts to prove the mapping without creating an ID↔key loop or permitting naked-ID recovery authority. The canonical schemas, screenshot-kind literals, and encoder live in the artifact-codec-independent `visual-evidence.ts` module; a static import regression proves that dependency direction.

Task23.6B3 deliberately does **not** claim that `WorkflowVisualHostServer` can independently reconstruct the future Task23.7 implementation manifest/design contract. The Core service no longer accepts naked caller identity fields, the Server exposes the trusted resolver seam, and the default production composition has no resolver and therefore fails closed for implementation preparation. Task23.7 must install a resolver that reloads and validates the strict durable design plus implementation/snapshot authority (owner, revision, Location/workspace, and source facts) before returning this contract. Reference preparation remains independently validated and hashed in the host now.

## TDD record

### Core logical identity/fake parity RED

From `packages/core`, using pinned Bun 1.3.14 and D-scoped temp/cache roots:

```text
bun test test/workflow-visual-host.test.ts
9 pass, 5 fail, 57 expect() calls
```

The failures were the intended missing behavior: the service exposed none of `lookupEvidence`, `commitEvidence`, `releaseEvidence`, or `reconcileEvidence`; `makeFakeEvidenceStore`/`evidenceKey` did not exist; therefore restored same-key evidence, host-ID-independent identity, exact commit/release tombstones, and recovery classification could not be exercised. Existing URL, preview-plan, cap, cleanup, and handle-recovery tests remained green.

### Core logical identity/fake parity GREEN

After implementing the strict key, receipt, complete artifact binding, abandoned tombstone, reconciliation categories, and reusable fake evidence store:

```text
bun test test/workflow-visual-host.test.ts
15 pass, 0 fail, 92 expect() calls
```

This proves a restored same-key fake call under a different host ID returns the original validated PNG with one capture and one historical charge; stage/kind/revision/viewport/config/source/selector changes do not alias; commit/release are exact and idempotent; released/abandoned keys cannot recapture; and recovery leaves unmatched staging ambiguous.

### Independent-review RED/GREEN

The final independent/main review found five load-bearing gaps and each received a new RED before implementation:

- `visual-evidence.ts` imported the screenshot artifact codec, creating a future codec-validation cycle;
- implementation hash/selector were still naked `PrepareImplementationInput` fields;
- artifact binding omitted `timeCreated`; and
- `operate()` preserved an earlier validation error over a fatal post-operation database identity failure, so the ledger could remain open after path/handle authority diverged; and
- the screenshot codec accepted `evidenceReceipt` as unchecked `Schema.Unknown`, allowing a malformed receipt to become an otherwise self-consistent artifact before the later binding boundary rejected it.

The Core review RED was `12 pass, 5 fail, 77 expect() calls`. It directly exposed the artifact reverse import, missing trusted resolver/fail-close behavior, legacy caller identity acceptance, and missing timestamp binding. The ledger review RED was `8 pass, 3 fail, 54 expect() calls`; the deliberate failures also left handles for cleanup, confirming that the fatal collision was not latched closed.

The receipt-codec RED was `17 pass, 1 fail, 101 expect() calls`: `commitScreenshot` returned a durable artifact containing an extra-key receipt instead of rejecting it. The corrected codec calls the cycle-free validator at capture, commit, and decode; returns the normalized frozen receipt; and additionally binds workflow/kind/viewport/revision, PNG SHA/size, and parsed IHDR dimensions. Legacy screenshot artifacts with no receipt remain decodable.

The corrected focused results are:

```text
Core visual host:      18 pass, 0 fail, 102 expect() calls
Server evidence ledger: 10 pass, 0 fail, 61 expect() calls
Server visual host:     36 pass, 0 fail, 133 expect() calls
```

The independent re-review returned **CLEAN** after rerunning the Core and Server focused suites, both package typechecks, and `git diff --check`; it found no remaining Critical or Important issue.

The collision regression first raises a normal reservation validation error inside the operation, then adds a second database owner during the post-operation root-policy fence. The fatal ownership result overrides the business error and closes the service; the next call returns `Evidence ledger is closed`.

### Server durable intent/SQLite RED

The first corrected Server run reached the intended new test module after fixing its package import. It failed because the production key still expected a caller selector and because the ledger had none of `beginCapture`, `completeCapture`, exact `get`, complete artifact `commit/release`, or durable abandonment. That established the selector-minting and item-state prerequisites before the Server production implementation. The test module also exposes the existing per-SQL ACL probe amplification and missing same-path main-database identity fence.

### Server durable staging GREEN

After implementing the additive STRICT item schema and state machine:

```text
bun test test/workflow-evidence-ledger.test.ts
10 pass, 0 fail, 61 expect() calls
```

The matrix proves: durable owner-fenced `capturing` intent before browser work; exact-owner clear; restart-safe validated BLOB lookup; atomic capturing→staged plus aggregate quota; quota rollback without charge; complete Artifact/PNG/receipt commit binding; exact/idempotent release and abandonment; historical accounting tombstones; corrupt coordinate/receipt/state/PNG/oversized-BLOB fail-close; exact recovery categories which preserve unknown staging and foreign capturing; two ACL descriptor probes per high-level put/get/commit/release/reconcile operation; and same-path main database replacement detection.

### Server VisualHost integration RED/GREEN

The first integrated focused run exposed one genuine inherited B2 regression: a database handle acquired inside the `open` boundary was lost when the post-check injected a new hardlink owner, leaving the Windows file busy. The acquire path now records ownership before the post-check and closes that exact handle on rejection. Its focused regression turned GREEN.

The production host now mints reference/implementation source and ready-selector identities into `PreparedPreview`, keys single-flight by the derived evidence ID, inserts a nonce-owned intent before browser invocation, restores staged/committed bytes without a browser, and returns typed ambiguity for a foreign capturing owner. A cancelled follower only leaves its wait; it neither cancels the leader nor clears the leader's nonce. The exact leader clears only its own pre-byte intent on an explicit failure/cancellation. Completed staging is never reversed by cleanup.

The combined required Server matrix, including the new staging suite, passed:

```text
bun test test/workflow-evidence-ledger.test.ts test/workflow-visual-host.test.ts \
  test/workflow-host-root-policy.test.ts test/workflow-runtime-composition.test.ts \
  test/workflow-docker-process-ownership.test.ts test/workflow-command-sandbox.test.ts
181 pass, 0 fail, 630 expect() calls
```

It includes one logical key shared by concurrent callers and restored under a new random host ID: one browser call, zero restart browser calls, one persisted row, and one quota charge. A separately seeded foreign intent returns `evidence_capture_ambiguous` with zero browser contexts.

## Verification

All commands used pinned `D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe` with D-scoped temp/cache environment. No real Docker, Chromium, Windows ACL probe/mutation, provider, network, deployment, or C-drive cache was used.

```text
Core focused matrix:   38 pass, 0 fail, 254 expect() calls
Server focused matrix: 181 pass, 0 fail, 630 expect() calls
Core typecheck:        PASS
Server typecheck:      PASS
Changed-file oxlint:   0 warnings, 0 errors
Prettier/write:        PASS
git diff --check:      PASS
```

## Task23.6 joint fix round 1

Base: `cc7ceae36f9f02bdeae4ad7637262eefe147cd64` on the existing `dev` checkout. All runs used pinned Bun 1.3.14 with `TEMP`, `TMP`, and Bun cache on D:. No provider, network, real Docker/Chromium, ACL mutation/probe, deployment, or `.env.local` access occurred.

### RED evidence and rulings

- Critical 1 command admission: the missing engine, protected Location, and post-create engine replacement cases first produced `61 pass, 3 fail, 227 expect`; the shared VisualHost admission case produced `0 pass, 1 fail`; the preview protected-root overlap case likewise failed before the shared policy was installed.
- Critical 2 hardlinks: command, preview mount, and static-fetch pairs each first produced `0 pass, 2 fail`. The old paths accepted a multiply-linked leaf or returned external bytes after replacement.
- Important 3 acquisition: the five create/inspect failure modes plus late visibility first produced `0 pass, 6 fail`; no deterministic-name cleanup occurred before the condition deadline.
- Important 4 recovery: stopped and still-present regressions first produced `1 pass, 2 fail`; recovery poisoned a stopped container with kill failure and did not prove post-rm absence.
- Important 5: the review's recorded `SELECT *` implementation was confirmed in source before replacement. Focused query-boundary coverage now proves an oversized length fails with zero `select-blob` boundaries and reconcile performs zero BLOB reads. The first two-test run exposed a test-owned open-handle cleanup defect (`1 pass, 2 fail`), corrected without changing the production ruling.
- Important 6 aggregate: missing/lowered reopen and mutation-time corruption first produced `0 pass, 3 fail`; missing aggregate was treated as zero.
- Minor parity: conflicting duplicate `release` authority first failed because Server sequentially accepted false then true and changed state.

### GREEN implementation

- One protected-root contract now covers command and preview composition. It canonicalizes host roots, rejects case-insensitive ancestor/descendant overlap, pins an ordinary single-link D-drive `docker.exe`, and performs a cheap dev/ino/birthtime/link-count identity fence immediately before every engine invocation.
- Recursive command/preview admission and point-of-read static serving reject hardlinks and replacement. Static bytes are read through a verified file handle and rechecked before response.
- Command acquisition uses one absolute caller deadline and signal from create onward. Any uncertain create/ID/inspect outcome launches bounded deterministic-name discovery, authenticates the complete exact labels, and only then removes the returned opaque ID. Late cleanup never extends the caller boundary.
- Recovery retains `Running`, skips kill for stopped owners, removes exact owners, and performs a second exact-label listing before declaring absence.
- Evidence reads select scalar metadata plus `length(png_blob)` first. Only `get`/binding paths read one validated BLOB inside the same transaction; reconcile reads metadata only. Aggregate is checked against durable item-history SUM on open and every quota mutation; higher legacy counters remain valid while lower/missing counters fail closed.
- Server duplicate authority normalization matches Core fake behavior.
- Timing diagnosis found delayed rejected `completion` derivatives and stream drains that Bun reported against later parallel tests. Rejections are now observed immediately without changing promise semantics; detached cleanup is also terminally caught. No timeout was increased.

### Verification

```text
Focused EvidenceLedger: 16 pass, 0 fail, 75 expect
Six-file Server matrix, repeated default-parallel runs: 208 pass, 0 fail, 702 expect (three consecutive runs)
Final post-format six-file run: 208 pass, 0 fail, 702 expect
Server typecheck (`bun run typecheck`): PASS
Changed-file oxlint (9 files): 0 warnings, 0 errors
Prettier/write (9 files): PASS
git diff --check: PASS (only Git LF→CRLF notices)
```

The repository-wide `bun run lint` was also attempted. It completed in 98 seconds with the pre-existing repository baseline of `4925 warnings and 1 error` across 3213 files; changed-file oxlint is clean. This wave does not modify unrelated baseline findings.

## Task23.6 joint fix round 2

All four independent-review findings were confirmed against `d111972bd`; none was weakened or dismissed.

### RED and root cause

- Acquisition ownership inspection had no caller `AbortSignal`, and its detached discovery launch had no terminal catch. The regression asserts the first acquisition inspect carries the Effect caller signal; the old invocation had `signal === undefined`. The fix also installs a terminal rejection observer on every detached cleanup launch.
- Recovery's running→stopped race was reproduced with kill exit 1, rm exit 0, and a final exact-label listing proving absence. RED was `0 pass, 1 fail`: `Workflow Docker recovery cleanup failed`. Kill outcome was incorrectly made permanently authoritative before final absence.
- Reconcile's active-only no-BLOB test was insufficient: committed/release and abandoned authorities called `requireItem()` and selected PNG bytes. The combined active/capturing/staged→released/staged→abandoned reconciliation boundary now asserts zero `select-blob` operations before any later explicit `get`.
- Static serving used unbounded `handle.readFile()`. Exact 32 MiB, 32 MiB+1, and append-after-open cases define the host-only boundary; the former implementation had no size fence and could allocate the whole workspace-controlled file.

### GREEN

- The acquisition create and exact ownership inspect now share one caller signal and remaining absolute deadline. Detached deterministic-name cleanup is always rejection-observed and retains its prior exact-label authority.
- Recovery treats kill errors/nonzero as a benign race only when rm succeeds and the final exact-label listing proves absence. rm failure, malformed/ambiguous ownership, and still-present owners remain fatal.
- Reconcile uses metadata-only require/mutate/return paths for commit, release, and abandon. Only explicit `get` and normal public byte-bearing bindings select one validated BLOB.
- Static response bodies have a non-public 32 MiB constant. The verified handle size is checked before allocation; reads are capped to the admitted size; handle/path identity and size are rechecked after reading. Oversize and growth return 413 without returning bytes; hardlink/replacement checks remain intact.

### Verification

```text
Three directly changed suites: 133 pass, 0 fail, 497 expect
Six-file default-parallel matrix: 211 pass, 0 fail, 719 expect (clean repeated runs)
Server typecheck: PASS
```

One deliberately overlapping verification launch (a three-run PowerShell loop was still active when another matrix was started) produced cross-process fixture interference and was discarded; after confirming no Bun process remained, the same default-parallel command returned 211/211 clean. No timeout was increased.

Round-2 exact quality commands/results:

```text
cd D:\OpenCode-Audit\packages\server
D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe run typecheck
$ tsgo --noEmit  # exit 0

cd D:\OpenCode-Audit
D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe x oxlint \
  packages/server/src/workflow/{command-sandbox,evidence-ledger,visual-host}.ts \
  packages/server/test/workflow-{command-sandbox,evidence-ledger,visual-host}.test.ts
Found 0 warnings and 0 errors.

D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe x prettier --write <the same six changed TS files> task-23.6b3-report.md
all files formatted/unchanged; exit 0

git diff --check
exit 0; only Git LF->CRLF notices
```

## Task23.6 joint fix round 3

The remaining pathname-size interval was reproduced deterministically with a host-only `onStaticFileRead` hook positioned after the post-read handle `stat` and before pathname `lstat`.

RED:

```text
bun test test/workflow-visual-host.test.ts --test-name-pattern "bounds static responses"
Expected status 413; received { status: 200, bytes: 16 }
0 pass, 1 fail, 12 expect
```

The handle retained its admitted 16-byte size while the same pathname/inode grew to 17 bytes. Identity/link checks therefore passed and old bytes escaped with 200.

GREEN requires admitted, post-read handle, and post-read pathname sizes to be mutually equal and independently within the fixed 32 MiB cap. Any growth returns 413 without body bytes; exact 32 MiB, pre-read growth, hardlink, and replacement protection remain intact.

```text
bun test test/workflow-visual-host.test.ts --test-name-pattern "bounds static responses"
1 pass, 0 fail, 12 expect

bun test test/workflow-command-sandbox.test.ts test/workflow-evidence-ledger.test.ts test/workflow-visual-host.test.ts
133 pass, 0 fail, 500 expect

bun test test/workflow-evidence-ledger.test.ts test/workflow-visual-host.test.ts \
  test/workflow-host-root-policy.test.ts test/workflow-runtime-composition.test.ts \
  test/workflow-docker-process-ownership.test.ts test/workflow-command-sandbox.test.ts
run 1: 211 pass, 0 fail, 722 expect
run 2: 211 pass, 0 fail, 722 expect

bun run typecheck
$ tsgo --noEmit  # exit 0

bun x oxlint <round-2/round-3 six changed TS files>
0 errors (final rerun after the one reported optional-parameter warning was corrected)

bun x prettier --check <round-2/round-3 six changed TS files and report>
All matched files use Prettier code style!

git diff --check
exit 0; only Git LF->CRLF notices
```
