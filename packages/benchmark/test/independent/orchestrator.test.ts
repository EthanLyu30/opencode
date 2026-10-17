import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { makeIndependentEvaluator } from "../../src/evaluator/independent"
import { fixtureObservation } from "../../src/evaluator/independent/host"
import { orchestratorFixture } from "./fixture"
test("default host blocks; real bundle and snapshot compose with guardrail preview count zero", async () => {
  const f = await orchestratorFixture()
  try {
    expect(await makeIndependentEvaluator({}).evaluate(f.input)).toEqual({
      kind: "blocked",
      reason: "EVALUATION_HOST_UNAVAILABLE",
    })
    const result = await makeIndependentEvaluator({ host: f.host }).evaluate(f.input)
    expect(result).toMatchObject({
      kind: "evaluated",
      result: { kind: "guardrail", functionalQualified: true, diagnosticTotal: null },
    })
    expect(f.calls).toEqual(["build", "probe"])
    expect(JSON.stringify(f.requests)).not.toMatch(/expected|PRIVATE_ORACLE_CANARY|private\//)
    expect(await fs.readFile(path.join(f.sourceRoot, "src/math.js"), "utf8")).toBe(f.source)
    const bad = await makeIndependentEvaluator({
      host: {
        ...f.host,
        probe: async () => {
          throw Error("secret-driver-detail")
        },
      },
    }).evaluate(f.input)
    expect(bad).toEqual({ kind: "harness_error", code: "EVALUATION_DRIVER_FAILURE" })
    expect(JSON.stringify(bad)).not.toContain("secret-driver-detail")
  } finally {
    await f.dispose()
  }
})
test("candidate functional/build failure measured; forged identity/authority is harness error", async () => {
  const f = await orchestratorFixture(6)
  try {
    expect(await makeIndependentEvaluator({ host: f.host }).evaluate(f.input)).toMatchObject({
      kind: "evaluated",
      result: { functionalQualified: false },
    })
    const failed = await orchestratorFixture()
    try {
      const failure = {
        ...failed.host,
        build: async (r: Parameters<typeof failed.host.build>[0]) =>
          fixtureObservation(r, { kind: "candidate_failure", reason: "BUILD_EXIT_1" }),
      }
      expect(await makeIndependentEvaluator({ host: failure }).evaluate(failed.input)).toMatchObject({
        kind: "evaluated",
        result: { functionalQualified: false, functional: null },
      })
    } finally {
      await failed.dispose()
    }
    for (const field of ["runID", "attemptID", "leaseGeneration", "candidateSha256", "routeSha256"]) {
      const host = {
        ...f.host,
        probe: async (r: Parameters<typeof f.host.probe>[0]) => {
          const o = await f.host.probe(r)
          return { ...o, identity: { ...o.identity, [field]: field === "leaseGeneration" ? 2 : "wrong" } }
        },
      }
      expect((await makeIndependentEvaluator({ host }).evaluate(f.input)).kind).toBe("harness_error")
    }
  } finally {
    await f.dispose()
  }
})
