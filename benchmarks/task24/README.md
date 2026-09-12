# Task24 benchmark configuration

This directory contains only versioned schemas, an intentionally unsealed campaign template, and authoring guidance. Live datasets, hidden gold, browser/toolchain files, provider approvals, request ledgers, workspaces, and reports belong under `D:\OpenCode-Benchmark\Task24` and must not be copied into this directory.

The fixed comparison is:

- A: modified OpenCode production workflow;
- B: modified OpenCode with direct DeepSeek V4 Pro Responses;
- C: modified OpenCode with direct Kimi K3 Chat Completions;
- D: frozen official upstream OpenCode with direct DeepSeek V4 Pro Responses;
- E: frozen official upstream OpenCode with direct Kimi K3 Chat Completions.

`campaign.template.json` is not sealable as checked in: source, binary, task, price, exchange-rate, and toolchain locks must be replaced with observed immutable values under the D-drive run root. The runtime Effect Schema is authoritative; the JSON schemas support editors and offline inspection.

Never add API keys, bearer grants, authorization headers, raw provider payloads, hidden tests, reference gold, or campaign databases here.

The route/model matrix is deliberately fixed before any scored call. Workflow arm A uses Kimi `kimi-k3` Chat Completions for design, decomposition, and visual review; DeepSeek `deepseek-v4-pro` Responses for implementation, repair, and delivery; and `deepseek-v4-flash` Responses for tests. Direct arms B–E use the same Kimi K3 and DeepSeek V4 Pro identities and protocols, so the workflow is the measured variable.

## Source setup

Task24 source setup is intentionally two-phase. First, author `D:\OpenCode-Benchmark\Task24\runs\dataset-sources.candidate.json` with exactly two immutable dataset records: `design2code-hard` and `swebench-multimodal-js`. Each record must contain an exact commit, deterministic subset selector, selected item IDs, every public asset hash and size, normalization version, and license. Moving branches and `latest` are rejected.

Each candidate record uses `kind: "dataset"`, `repositoryUrl`, a 40- or 64-character lowercase commit in `revision`, `subset`, a nonempty `itemIDs` array, an `assets` array of `{ path, sha256, size }`, `normalizationVersion`, and `license`. The candidate itself stays under `runs` and is never committed.

Then run `scripts\setup-task24-sources.ps1` with the D-drive Bun executable. The script redirects its temporary and Bun cache paths to Task24, resolves the latest stable official OpenCode release to an immutable commit, verifies the downloaded archive, checks the MIT license, and atomically publishes `toolchain\upstream-src` plus `toolchain\source-lock.json`. It will not replace a different valid lock.

The Task24.10 corpus candidate is fixed to these source identities:

- Design2Code-HARD revision `3945da581392920893492517153101690c138a6a`, items `g29`, `g38`, `g41`, and `g63`, under ODC-By-1.0;
- SWE-bench Multimodal revision `4e6662d51c48e475f7f346e4fa09a6f8b31fcaa5`, items `chartjs__Chart.js-10157`, `chartjs__Chart.js-10301`, `diegomura__react-pdf-1363`, and `markedjs__marked-1535`;
- official OpenCode release `v1.18.30`, commit `3104c1428ec91f809e5ab86631300de41eb6952e`, archive SHA-256 `4b5f2e5edfc796082a353fd09c1b1dec3e7a108a4b080fe3a86b12d9fa59fae6`.

The four SWE-bench tasks are preflighted offline in their official evaluator images by immutable digest. A focused compatibility adapter is permitted only inside the disposable preflight container when a mutable browser package has outgrown an older upstream test harness; it may narrow discovery to the issue-owned test/fixture while leaving the repository patch, evaluator assertion, image digest, `--network none`, CPU/memory limits, and baseline-fails/gold-passes requirement unchanged. The adapter itself is evaluator metadata, never part of an arm workspace.

Task bundles live outside Git and have this exact shape:

```text
bundle\
  task.json
  LICENSES.json
  starter\
  assets\        # optional public inputs
  gold\          # hidden evaluator-only material
```

Materialization copies only `starter` and public `assets` into a fresh `workspaces\<campaign>\<run>\repo`. Hidden `gold` never enters the child workspace. Every run also receives separate `data`, `config`, `cache`, `temp`, and `output` directories on D:.

## Candidate validation

The local authoring output contains exactly 12 primary tasks and four non-visual guardrails. Private and Design2Code tasks include fixed mobile, tablet, and desktop references; private and guardrail tasks include deterministic hidden tests; SWE-bench tasks preserve accepted patches, evaluator scripts, issue assets, base commits, and official image digests. `validateTaskBundle` rejects undeclared bytes, hash/size drift, reparse escapes, and common hidden-gold prompt leakage.

Task24.10 writes only non-final artifacts under `D:\OpenCode-Benchmark\Task24\runs`: `sources.lock.json`, `corpus-validation.json`, `fairness-fingerprint.json`, `preregistration.candidate.json`, and `preregistration.candidate.validation.json`. Validate them without sealing or provider access with:

```powershell
& 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe' run --cwd 'D:\OpenCode-Audit\packages\benchmark' task24 -- campaign validate --root 'D:\OpenCode-Benchmark\Task24'
```

The candidate uses concurrency 1 and five separate immutable price revisions: Kimi K3 standard CNY, DeepSeek V4 Pro peak/off-peak USD, and DeepSeek Flash peak/off-peak USD. Each request is bound to provider, model, rate class, source URL, capture time, and exact integer micro-units per million tokens. Cross-currency reporting uses a dated exchange-rate lock; approval and enforcement remain provider-native and never borrow headroom across currencies.

Do not seal Task24.10. Task24.11 must first build and hash the exact modified and official-upstream executables, exercise all five arms with fake providers, rerun recovery/security/report reproducibility checks, and replace both candidate binary placeholders. Live Kimi or DeepSeek calls require a later explicit, provider-specific spending approval.
