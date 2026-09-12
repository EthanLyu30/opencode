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
