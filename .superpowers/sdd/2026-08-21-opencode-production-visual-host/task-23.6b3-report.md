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
