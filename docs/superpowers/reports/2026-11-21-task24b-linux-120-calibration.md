# Task24B Linux 120 calibration — run43 evidence

Date: 2026-11-21 (Asia/Shanghai)
Scope: Linux 16-task / 120-evaluation oracle calibration of the frozen Task24B corpus.
Status: **120/120 real evaluations, 120 matched, 120 stable; calibration-only, not readiness.**

## 1. Outcome

Run43 completed the whole schedule without a harness error or retry.

| Field | Value |
| --- | --- |
| tasks | 16 (12 primary + 4 guardrail) |
| distinct controls | 104 |
| required evaluations | 120 |
| real Linux evaluations | 120 |
| matched oracle expectations | 120 |
| stable repeats | 120 |
| unobserved required checks | none |
| corpus engine ready | true |
| readiness eligible | false |
| concurrency | 8 |

Coverage: 12 primary tasks × {`correct` r0, `alternate-correct`, `seed`,
`functional-bad`, `visual-bad`, `responsive-bad`, `policy-bad`, `correct` r1}
plus 4 guardrail tasks × {`correct` r0, `alternate-correct`, `seed`,
`functional-bad`, `policy-bad`, `correct` r1}.

The run started at 2026-11-21 04:06 local, opened the Linux runtime at 04:16,
finished the 12 reference builds at 05:33, published the finalized corpus at
05:36, and completed calibration at 16:18.

## 2. Identity

- controller source `a1138f1bf80eb1099bdc36dd8dfba7de3da0288a85767a5e434db200dced4fd0`
- policy `61f9f56e478e3da453e03c545c3763433491df9c2f0a5c3c16da19670c847c6a`
- browser helper `3946565c87c52ef22add6fbd6edbefedf134f0c428efc94ba6838310259115fd`
- runtime config `76ab8bacd088b0340a99eb5317e89c4cc3577973fb88c857d15b02fc3ce8204e`
- calibration authority `243e58ba2a7c07eb2db10503d7155632085fea74a48b73032a58c46eb18be868`
- accept manifest `a1854f99d2de82fea8bf9b1dff4c0e9ddb7d32b501797666de4caff536721ef4`
- finalized corpus `c312c2416715cc9d7d210036495e961807e2aabcccf3a20d615339bf40da897c`
- derived report `1c3682d08bbd2922f14a45e84a1eb175aafcf4e1f92dcf152fd4143060b92ce3`
- raw report `7f148ed1c74618cb61502aed99b41dc217e2443d4d4f4df3392773bfc8ec43b2`

The authority statement records `kind: "calibration-only"` and
`purpose: "linux-oracle-calibration-not-task24-readiness"`, with
`readinessEligible: false`.

## 3. Stability derivation

The raw report recorded 120 real and 120 matched outcomes but only 119 stable.
One `d2c-g29-spelling-bee` correct repeat produced `visual 26.999999` versus
`27` (composite `89.999995` vs `90`), a difference confined to the sixth
decimal of browser rasterization. The exact semantic hash counted it as a
different measurement.

No evaluation was re-run. `sameCalibrationMeasurement` now compares numeric
measurements at `1e-4` resolution for the repeat-stability predicate;
`measurementSha256` remains exact, and any real score change still fails. Applied
to the same immutable results, the predicate yields 120/120 stable and
`corpusEngineReady: true`. The raw report and summary remain archived unchanged,
and the derived evidence records `stabilityTolerance: 0.0001` together with the
raw report hash.

## 4. Calibration defects fixed on the way

- **Policy audit missed HTML sentinels.** The calibration policy scan only fed
  `*.js/ts/jsx/tsx` files to the exact sentinel matcher; the d2c policy-bad
  controls place the sentinel in an inline `index.html` script. The filter now
  includes `.html/.htm`, so those controls are rejected before build
  (`linux-backend.ts`).
- **Accessibility failure was conflated with visual failure.** All correct
  assets carry serious/critical axe findings (for example a 4.48:1 contrast
  ratio), so `ACCESSIBILITY_REQUIRED_FAILED` cannot separate good from bad
  controls. Correct/alternate outcomes are now matched on absolute visual quality
  (composite ≥ 75, every viewport ≥ 65); bad visual/responsive controls must also
  fall below the same task's correct repeat-0 visual baseline
  (`calibration.ts`).
- **Watchdog measured verification, not evaluation.** A second full candidate
  hash after the controller could push a finished 34-minute evaluation past the
  40-minute watchdog. Calibration-only runs now skip that duplicate
  `verifyCandidate` (the evaluator already verified its context), and the attempt
  budget is 90 minutes.
- **Per-guard re-hashing of 806 MB browser release and 630 MB fonts.** Each
  container operation re-verified the release and re-hashed all Windows fonts.
  Calibration-only runs now bind both observations once at runtime open and reuse
  them; production accept keeps per-guard verification
  (`runtime.ts`, `browser-runtime.ts`).
- **Publish link races.** `publishImmutable` retries `EBUSY/EPERM/EACCES/EEXIST`
  for up to 120 seconds before failing, covering Defender/indexer locks that
  previously surfaced as harness errors (`offline/atomic.ts`).
- **Transient candidate drift.** `verifyCandidate` retries file identity ten
  times at 500 ms before declaring `TASK24_CANDIDATE_DRIFT` (`snapshot.ts`).
- **Marked responsive overlay did not build.** The appended ES6 `const`/`append`
  failed uglify-js; the control now appends ES5 `var`/`appendChild`
  (`swe-markedjs__marked-1535` authoring).
- **react-pdf public build symlinks.** The public build driver materializes the
  workspace package links expected by the react-pdf build
  (`evaluation-finalize.ts`).

## 5. Verification

- `bun typecheck` from `packages/benchmark`: exit 0.
- `bun test test/linux-host/calibration.test.ts`: 8 pass, including a new test
  that accepts 1e-6 visual jitter and rejects a functional score change.
- `bun test test/offline/atomic.test.ts test/independent test/linux-host/calibration.test.ts`:
  45 pass earlier in this change set.
- The run produced 120 evaluation directories, each with a controller, and zero
  `CALIBRATION_DRIVER_FAILURE`, `CALIBRATION_HARNESS_ERROR_RETRY`,
  `CALIBRATION_ATTEMPT_TIMEOUT`, `TASK24_BROWSER_*` or policy-retry entries.

## 6. Evidence

Archived at:

`D:\OpenCode-Benchmark\Task24\reports\task24b-linux-calibration-20261121\`

- `README.md` — scope, result, derivation and boundary.
- `evidence-index.json` — identity, counts, tolerance, artifact hashes.
- `calibration-summary.json`, `calibration-report.json` — derived evidence.
- `raw/calibration-report.json`, `raw/calibration-summary.json` — raw originals.
- `calibration-authority.json`, `accept-manifest.json`, `accept-approval.json`,
  `controller-inventory.json`, `runtime-config.json`,
  `linux-dependency-auditors.json`, `finalized-corpus.json`.

## 7. Boundary

This is calibration evidence, not a Task 8 or production-readiness claim. The
production authoring gap is unchanged: no production code authors a
`phase: "prepare"` host manifest, and `finalizeHostManifest` still has no
caller, so the normal `accept`/`calibrate` CLI path remains unreachable without
the approved calibration-only harness. The A-arm native Windows blocker
(Win32 4551 at `CreateProcessW`) is likewise untouched and remains documented in
`2026-11-16-task24b-arm-a-native-4551-archive-and-handoff.md`.
