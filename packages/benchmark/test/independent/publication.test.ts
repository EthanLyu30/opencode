import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { makeIndependentEvaluator } from "../../src/evaluator/independent"
import { publishIndependentEvaluation, verifyIndependentEvaluation } from "../../src/evaluator/independent/publication"
import { orchestratorFixture } from "./fixture"
test("immutable publication rechecks source, binds every identity and rereads every evidence byte", async () => {
  const f = await orchestratorFixture()
  try {
    const outcome = await makeIndependentEvaluator({ host: f.host }).evaluate(f.input)
    const published = await publishIndependentEvaluation({ root: f.resultRoot, outcome })
    const result = await verifyIndependentEvaluation({ root: f.resultRoot, manifest: published.manifest })
    expect(result).toMatchObject({ kind: "guardrail", functionalQualified: true, assurance: "fixture" })
    expect((await publishIndependentEvaluation({ root: f.resultRoot, outcome })).manifest).toEqual(published.manifest)
    expect(() => JSON.stringify(published)).not.toThrow()
    for (const field of ["runID", "attemptID", "leaseGeneration", "candidateSha256", "routeSha256"])
      await expect(
        verifyIndependentEvaluation({
          root: f.resultRoot,
          manifest: {
            ...published.manifest,
            identity: { ...published.manifest.identity, [field]: field === "leaseGeneration" ? 2 : "wrong" },
          },
        }),
      ).rejects.toThrow()
    await expect(
      publishIndependentEvaluation({ root: f.resultRoot, outcome: { ...outcome } as never }),
    ).rejects.toThrow()
    await fs.writeFile(path.join(f.resultRoot, "runtime.json"), "drift")
    await expect(verifyIndependentEvaluation({ root: f.resultRoot, manifest: published.manifest })).rejects.toThrow()
    await expect(publishIndependentEvaluation({ root: f.resultRoot, outcome })).rejects.toThrow()
  } finally {
    await f.dispose()
  }
})
test("blocked cannot publish scores and drift or links prevent publication", async () => {
  const f = await orchestratorFixture()
  try {
    await expect(
      publishIndependentEvaluation({
        root: f.resultRoot,
        outcome: { kind: "blocked", reason: "EVALUATION_HOST_UNAVAILABLE" },
      }),
    ).rejects.toThrow()
    const outcome = await makeIndependentEvaluator({ host: f.host }).evaluate(f.input)
    await fs.writeFile(path.join(f.sourceRoot, "src/math.js"), "drift")
    await expect(publishIndependentEvaluation({ root: f.resultRoot, outcome })).rejects.toThrow()
  } finally {
    await f.dispose()
  }
})
