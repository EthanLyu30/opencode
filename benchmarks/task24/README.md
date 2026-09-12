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

## Source setup

Task24 source setup is intentionally two-phase. First, author `D:\OpenCode-Benchmark\Task24\runs\dataset-sources.candidate.json` with exactly two immutable dataset records: `design2code-hard` and `swebench-multimodal-js`. Each record must contain an exact commit, deterministic subset selector, selected item IDs, every public asset hash and size, normalization version, and license. Moving branches and `latest` are rejected.

Each candidate record uses `kind: "dataset"`, `repositoryUrl`, a 40- or 64-character lowercase commit in `revision`, `subset`, a nonempty `itemIDs` array, an `assets` array of `{ path, sha256, size }`, `normalizationVersion`, and `license`. The candidate itself stays under `runs` and is never committed.

Then run `scripts\setup-task24-sources.ps1` with the D-drive Bun executable. The script redirects its temporary and Bun cache paths to Task24, resolves the latest stable official OpenCode release to an immutable commit, verifies the downloaded archive, checks the MIT license, and atomically publishes `toolchain\upstream-src` plus `toolchain\source-lock.json`. It will not replace a different valid lock.

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
