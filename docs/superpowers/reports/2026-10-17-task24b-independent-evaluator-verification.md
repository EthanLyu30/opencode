# Task24B B-Prep1 independent evaluator — verification record

Date: 2026-10-17. Implementation baseline: `19ae30d1469caa3f140b381c2caac232f7898a57`, directly on `dev`.

## Status and limits

The framework and Task 5 private authoring now have zero-provider-cost acceptance. The user explicitly chose completion of the original scope, not a partial framework handoff. Final Task 6 validation/push is recorded below. This is **not** acceptance of real Linux execution, real-corpus visual calibration, a paid pilot, or evidence of model-quality improvement.

All 16 fixed tasks now have authored private input/expected-value cases and byte-addressed, reconstructible calibration candidates, not just copied legacy tests or a list of required controls. There are **65 functional cases, 104 control candidates, 72 explicit keyboard/page-health assertions, and 16 real controller-readable private canaries**. Four guardrails load as strict v2 bundles. Twelve visual tasks retain an explicitly different authored-v2 format until real engine/reference/dependency identities are available. All 16 remain execution-blocked; no expected control label is presented as an observed real-corpus result.

`corpusEngineReady=false`. No active seal, current pointer or deployment was changed. No provider, `/models`, Docker, dependency installation or real corpus execution was used. Real Key files were not read.

## Implemented framework

- Strict v2 public profile/private oracle/identity and bundle validation; v1 modules unchanged.
- Bounded single-link candidate archive, independent work copy, source/config drift checks.
- Public-input probe protocol and controller-side value comparison; fixture assurance cannot become Linux assurance. No default candidate execution host.
- Fixed three-viewport visual measurement reuse; 75/65 thresholds and all original weights preserved. Guardrails have null visual/total fields. Candidate failure, blocked environment and harness errors are separate.
- Immutable evaluated-result publication, repeated byte/evidence/identity verification, no generation-side result channel.
- Exact 12-primary/4-guardrail catalogue and six public fixture families, new-directory-only corpus preparation.

## Verification before final review

Commands ran only from `D:\OpenCode-Audit\packages\benchmark`, with pinned Bun 1.3.14, `--no-env-file`, D-owned temporary/cache/config roots and provider environment variables removed.

- Task 1: 28 pass, 0 fail, typecheck exit 0.
- Task 2: 13 pass, 1 existing skip, 0 fail, typecheck exit 0.
- Task 3: 33 pass, 1 existing skip, 0 fail, typecheck exit 0.
- Task 4: 68 pass, 1 existing skip, 0 fail, typecheck exit 0.
- Task 5: 100 pass, 1 existing skip, 0 fail, typecheck exit 0; preparation command returned all 16 entries.
- Full package: `bun --no-env-file test --timeout 30000 --only-failures` → 262 pass, 10 existing skips, 0 fail, 992 assertions, 70 files. `bun --no-env-file run typecheck` → exit 0.
- Fresh whole-range review and any resulting corrections are recorded below once actually performed.

All 10 full-package skips predate this work: five browser release capture/interaction tests, one browser PDF test, one exact-binary security test, one exact offline recovery-matrix test and two Docker vector-isolation tests. Their opt-in gates were left disabled under the user's current constraints. No skip, old assertion or timeout was added/changed by this work.

## Real corpus preparation

Source: `D:\OpenCode-Benchmark\Task24\assets\tasks` (read-only).

Final material: `D:\OpenCode-Benchmark\Task24\assets\evaluation-v2` (private material deliberately outside Git). It contains per-task `private/authoring/oracle-authored.json`, real content-addressed control bytes/manifests and source-reference candidates. All 16 original authoring input files are retained in `_private-authoring-inputs` with unchanged hashes. No actual hidden answer, patch or expected PNG is committed to Git.

Source bundle aggregate SHA-256: `d210fefe6be13c3f5cd3ccde53a8846b77491118826d4fb93dbf11fc3d6add8b`.

| Tasks                                                  | Count | Remaining acceptance prerequisites                                                                                                                              |
| ------------------------------------------------------ | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| private analytics / checkout / inventory / travel      |     4 | Linux execution, same-engine three-viewport reference/interaction captures and browser/font lock; authored cases and controls are complete |
| d2c g29 / g38 / g41 / g63                              |     4 | Same, plus actual DOM/image/link/page-health capability; v2 supplies the cached shared source image equally to all arms |
| Chart.js 10157 / 10301                                 |     2 | Same, plus resolved dependency image, fresh locked build and actual canvas/event execution |
| react-pdf 1363                                         |     1 | Same, plus renderer build, real PDF generation and fixed PDF raster execution; no CSS simulation |
| marked 1535                                            |     1 | Same, plus fresh candidate `lib/marked.js` build and actual DOM/probe execution |
| normalization / orders / registry / session guardrails |     4 | Linux host attestation and real-corpus calibration; strict data bundles already load, with no visual score |

Visual preparation profiles remain named `preparation-profile.json`, not `profile.json`; they cannot be loaded as strict evaluated bundles. Their `oracleFormat:authored-v2` hash binds the real authored private file, not a fabricated engine-bound oracle. Guardrails use `oracleFormat:strict-v2` and verified `profile.json`/`oracle.json`. No source patch is used to score correctness: a text-only patch applicator is used only to construct private calibration controls. Relocated hunks must match one complete exact context; no fuzzy or reverse-patch scoring exists.

Read-only verification command: `bun --no-env-file run ./script/prepare-independent-corpus.ts --verify-root D:\OpenCode-Benchmark\Task24\assets\evaluation-v2`. Observed: 16 tasks, 65 cases, 104 controls, 72 interaction assertions, 4 strict bundles; `engineVerified=false`, `corpusEngineReady=false`.

Authoring aggregate SHA-256: `9a2154567568201a8e83e4d1ee2626d2b86763899a8b00ec9eb03504f8d774de`.

Legacy mandatory requirements and selectors are inherited as individually hash-named mandatory assertions, with a hash-bound `source-requirements.json` preserving their meaning. Missing trusted observations cannot count as passing. Calibration candidates preserve protected public package/probe/build/preview bytes; visual and responsive negative controls change allowed candidate source, not evaluator infrastructure.

Actual zero-cost calibration execution was limited to newly authored, known synthetic fixture code: materialized correct/alternate-correct/seed/functional-bad variants produced controller verdicts **true / true / false / false**. Real corpus code, network-violation controls and actual renderer/library builds were not executed on Windows. Their complete byte/expectation authoring is not an assertion that their future real-engine calibration already passed.

## Unchanged deployment

`D:\OpenCode-Local\bin\opencode-local.exe` SHA-256 remains `ff814205889f709c3374aaa855f3f17be1974bac9e86893e8c62d5e7de4fe9ce`.

## Review / final validation / cleanup

One fresh read-only whole-range review covered `19ae30d1469caa3f140b381c2caac232f7898a57..13e6a381ed55bc52777fe0009407465ebdbb68e2`. It found no Critical issue, six Important issues and one Minor. There is no second review.

Five framework defects were reproduced RED and corrected GREEN in one fix pass:

1. Require loader-issued bundle identity before using its profile/oracle; substituted objects cannot retain old hashes.
2. Match oracle requirement IDs, mandatory flags, weights and quality/policy coverage; require identity-bound controller evidence, not just arbitrary intact evidence bytes.
3. Retain bounded per-case result handles/fixture references for stateful APIs. The actual worker was exercised only against a newly authored, known synthetic factory module, never real corpus candidates. Returned snapshots stay defensive copies.
4. Validate copied source and encoded archive separately; a valid seven-MiB source file with an archive larger than eight MiB now succeeds.
5. Allow same-byte reference exports only for actual image files matched to a private hash-bound source manifest's public-assets records. Relabeling a repaired source file fails.

After fixes: full package **267 pass, 10 existing skips, 0 fail, 1,006 assertions, 70 files**; package typecheck exit 0.

The sixth Important finding reopened Task 5. The user rejected partial scope. Its correction now authors and verifies actual per-task cases, controls and interaction expectations as described above. Additional RED→GREEN tests cover strict guardrail publication, incomplete interaction coverage, control-expectation substitution, content mutation and an actual synthetic worker/calibration loop. Real-engine calibration remains unrun under the existing Docker prohibition, not silently accepted.

Deferred Minor: the first visual negative-test loop repeats an identical invalid input rather than mutating each named field. Later tests cover some actual paths; the loop is not counted as independent coverage of those four cases.

Review boundaries: no actual Linux/PDF/relay/provider/deployment assurance is claimed. Ordinary content hashes do not authenticate a manifest against an attacker who can replace the trusted manifest and all files; that requires an external trust anchor. Private legacy material semantics remain unverified.

Only this plan's owned intermediate copies and workspace may be cleaned after final verification. Final private material stays under `assets/evaluation-v2`; no prior plan's artifacts, old sources, deployment or historical evidence may be removed. Final cleanup/push outcome is recorded after it occurs.

Cleanup was attempted only after verifying the exact owned paths and absence of links. The environment rejected the deletion command before execution. No deletion or workaround followed. Remaining artifacts:

- `D:\OpenCode-Benchmark\Task24\tmp\bprep1-20261017-19ae30d14`: `corpus-v2`, `corpus-authored-v2-1` through `corpus-authored-v2-5`, plus task-local caches/temp/owner marker.
- `D:\OpenCode-Audit\.superpowers\sdd\2026-10-17-task24b-independent-evaluator`: this plan's verification logs, helpers and ledger, retained under the same no-bypass boundary.

These are intermediate artifacts, not additional requested deliverables. Their cleanup remains outstanding solely because of the deletion policy. The final private material is separate and verified. Remote push/ref verification is reported in the handoff, not inferred from the local commit.

## Final zero-cost acceptance

- Explicit 11 independent test entries: **34 pass, 0 fail, 226 assertions**.
- Full benchmark package: **272 pass, 10 unchanged skips, 0 fail, 1,037 assertions, 70 files**.
- Package `bun --no-env-file run typecheck`: exit 0.
- Read-only real material verification: **16 / 65 / 104 / 72 / 4** tasks / functional cases / controls / interaction assertions / strict guardrail bundles; engine readiness remains false.
- Protected-control regressions first failed and then passed; unchanged absent protected paths are permitted. Source requirements inheritance also has an exact coverage regression.
- Final source bundle aggregate and deployed executable SHA-256 match the values above.
- Task 5 closing verification: 108 pass, 1 existing skip, 0 fail across 23 files; typecheck exit 0. Task 6 closing verification: 114 pass, 1 existing skip, 0 fail across 25 files, followed by the full package and 16-task material verification above; typecheck exit 0.
- Authoring implementation commit: `f6c22c968`; prior framework security correction: `c2cdad9c9`. Scope check: 35 changed paths from baseline, no unexpected v1/production changes. The final docs-only closure commit and remote ref are verified at handoff.

## Rulings retained from the execution ledger

In chronological order, including the cost if a ruling is wrong:

1. Normalize task headings to the extractor's `Task 1` grammar; cost: documentation labels only, no runtime change.
2. Use the real `evaluator/mutation.test.ts` and `run/plan.test.ts` paths rather than the brief's nonexistent alternatives; cost: command-path correction, assertions unchanged.
3. Declare three private DOM references alongside three PNGs; cost: new v2 authors must supply all six, with no v1 effect.
4. Keep actual Linux isolation/dependencies/PDF/relay/attestation in B-Prep2; cost: no integration readiness claim in B-Prep1.
5. Keep provider matrices, execution ledger loop, seals and deployment outside this stage; cost: no model-effectiveness conclusion yet.
6. Treat hashes as integrity checks, not signatures against replacement of both trusted manifest and all files; cost: a malicious storage/controller owner requires a later external trust anchor.
7. Treat raw legacy private semantics as unverified until independent authoring/calibration; cost: those obligations cannot silently be relabeled as Linux-only work. Authoring is now supplied; real-engine calibration remains pending.
8. Add a hash-bound source manifest for public reference exemptions; cost: v2 authors must supply provenance, v1 remains unchanged.
9. Add bounded result handles, fixtures and `$ref` inputs for stateful API probes; cost: B-Prep2 must implement these explicit fields, not silently use a stateless fallback.
10. Keep generic authoring/control modules separate and take private inputs through explicit `--authoring-root`; cost: private authoring inputs must be retained or explicitly regenerated, never auto-discovered.
11. Distinguish authored-v2 materials from strict engine-bound bundles; cost: B-Prep2 must finalize real engine identities; authoring hashes are not strict evaluation identities.
12. Supply cached Design2Code `rick.jpg` equally to all groups as a source image; cost: a new public fixture revision and seal, never merged into v1 results.
13. Permit private controls to repeat exact public seed bytes only with the source-manifest proof; cost: trust stays on the sealed manifest, never a purpose label.
14. Inherit original mandatory text/selectors as bound mandatory assertions; cost: B-Prep2 must obtain trusted observations for every inherited assertion and cannot infer passing from a label.

Deferred minor: the initial visual reason loop is redundant rather than four distinct negative cases; no additional coverage is claimed for it.
