# Task24B B-Prep1 independent evaluator — verification record

Date: 2026-10-17. Implementation baseline: `19ae30d1469caa3f140b381c2caac232f7898a57`, directly on `dev`.

## Status and limits

The new evaluator framework has zero-provider-cost regression coverage. This is **not** a completed acceptance of the 16 real tasks, Linux isolation, a paid pilot, or evidence of model-quality improvement.

The corpus preparation software materialized all 16 fixed tasks into a new owned D-drive directory and reverified every source bundle. All 16 remain blocked: independent data-only oracle cases and actual calibration candidates still need authoring. The copied legacy test scripts and calibration requirement lists are preparation material, not completed independent oracles or executed controls. This outstanding B-Prep1 work must not silently be counted as B-Prep2 completion.

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

All 10 full-package skips predate this work and depend on separately enabled browser/binary release integration. They are not new permissive Docker skips; no old assertion or timeout was changed.

## Real corpus preparation

Source: `D:\OpenCode-Benchmark\Task24\assets\tasks` (read-only).

New material: `D:\OpenCode-Benchmark\Task24\tmp\bprep1-20261017-19ae30d14\corpus-v2` (private material deliberately outside Git).

Source bundle aggregate SHA-256: `d210fefe6be13c3f5cd3ccde53a8846b77491118826d4fb93dbf11fc3d6add8b`.

| Tasks                                                  | Count | Remaining acceptance prerequisites                                                                                                                              |
| ------------------------------------------------------ | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| private analytics / checkout / inventory / travel      |     4 | Independent oracle cases and real calibration candidates; Linux execution; engine-bound three-viewport references, browser/font identity and interaction oracle |
| d2c g29 / g38 / g41 / g63                              |     4 | Same, plus DOM/image/local-link/page-health probes                                                                                                              |
| Chart.js 10157 / 10301                                 |     2 | Same, plus resolved dependency image, fresh locked build and deterministic canvas/event probes                                                                  |
| react-pdf 1363                                         |     1 | Same, plus renderer build, real PDF generation and fixed PDF raster capability                                                                                  |
| marked 1535                                            |     1 | Same, plus fresh candidate `lib/marked.js` and DOM probe                                                                                                        |
| normalization / orders / registry / session guardrails |     4 | Independent oracle cases, real calibration candidates and Linux host attestation; no visual score required                                                      |

Prepared profiles are named `preparation-profile.json`, not `profile.json`; they cannot be loaded as a strict evaluated bundle. `oracleSha256=null` explicitly denotes missing authoring, never a zero placeholder. No source patch is used to score correctness.

## Unchanged deployment

`D:\OpenCode-Local\bin\opencode-local.exe` SHA-256 remains `ff814205889f709c3374aaa855f3f17be1974bac9e86893e8c62d5e7de4fe9ce`.

## Review / final validation / cleanup

Pending at this checkpoint; this section must be updated with actual results before final handoff. Only this plan's owned intermediates may be cleaned. The new private corpus material is an intended deliverable and is retained.
