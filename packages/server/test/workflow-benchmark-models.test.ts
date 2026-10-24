import { expect, test } from "bun:test"
import { BenchmarkModelCatalog } from "../src/workflow/benchmark-model-catalog"
import { WorkflowBusinessArtifact } from "@opencode-ai/core/workflow/artifacts/business"
import { benchmarkModelPacket } from "./fixtures/workflow-benchmark-models"

test("benchmark models validate a consistent closed three-model catalogue, policy and role snapshot", () => {
  const input = benchmarkModelPacket()
  expect(BenchmarkModelCatalog.validate(input)).toEqual(input)
})

test("benchmark models reject stale hashes, additional fields, missing models and unsupported Kimi", () => {
  const input = benchmarkModelPacket()
  for (const changed of [
    { ...input, kind: "production" },
    { ...input, extra: "not-admitted" },
    { ...input, catalogue: { ...input.catalogue, sha256: "f".repeat(64) } },
    { ...input, policy: { ...input.policy, sha256: "f".repeat(64) } },
    { ...input, snapshot: { ...input.snapshot, sha256: "f".repeat(64) } },
    { ...input, catalogue: { ...input.catalogue, models: input.catalogue.models.slice(1) } },
    {
      ...input,
      catalogue: {
        ...input.catalogue,
        models: input.catalogue.models.map((m) => (m.providerID === "kimi" ? { ...m, modelID: "kimi-k2.7" } : m)),
      },
    },
  ])
    expect(() => BenchmarkModelCatalog.validate(changed)).toThrow()
})

test("benchmark models reject rehashed route changes and cross-catalogue or cross-policy snapshots", () => {
  const input = benchmarkModelPacket()
  for (const changed of [
    { ...input.snapshot, catalogueSha256: "f".repeat(64) },
    { ...input.snapshot, policySha256: "f".repeat(64) },
    { ...input.snapshot, scopeSha256: "f".repeat(64) },
    {
      ...input.snapshot,
      routes: {
        ...input.snapshot.routes,
        implement: { ...input.snapshot.routes.implement, modelID: "deepseek-v4-flash" },
      },
    },
    {
      ...input.snapshot,
      routes: { ...input.snapshot.routes, design: { ...input.snapshot.routes.design, reasoningEffort: "low" } },
    },
    {
      ...input.snapshot,
      routes: { ...input.snapshot.routes, test: { ...input.snapshot.routes.test, priceSha256: "f".repeat(64) } },
    },
  ]) {
    const { sha256: _, ...content } = changed
    expect(() =>
      BenchmarkModelCatalog.validate({
        ...input,
        snapshot: { ...content, sha256: WorkflowBusinessArtifact.hash(content) },
      }),
    ).toThrow()
  }
})
