import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import template from "../../../../benchmarks/task24/campaign.template.json"
import { evaluateOfflineWorkspace, offlineEvaluatorSha256 } from "../../src/offline/evaluator"
import { verifyEvaluationEvidence } from "../../src/offline/evidence"
import { materializeTask } from "../../src/corpus/materialize"
import { validateTaskBundle } from "../../src/corpus/validate"
import { taskFixture } from "../corpus/fixture"
import { binary } from "../arms/fixture"

test("fallback functional evidence is shared once and absent visual evidence fails closed", async () => {
  const fixture = await taskFixture("evaluation-fallback")
  const runID = `run-${crypto.randomUUID()}`
  const materialized = await materializeTask({
    layout: fixture.layout,
    bundleRoot: fixture.bundle,
    campaignID: "evaluator-fallback-test",
    runID,
  })
  try {
    const result = await evaluateOfflineWorkspace({
      layout: fixture.layout,
      campaign: {
        createdAt: "2026-10-10T00:00:00.000Z",
        evaluator: { ...template.evaluator, sha256: await offlineEvaluatorSha256() },
      },
      bundle: await validateTaskBundle(fixture.bundle),
      runID,
      armID: "B",
      binary: binary("modified", process.execPath),
      roots: materialized.roots,
      preRunTreeSha256: materialized.preRunTreeSha256,
      postRunTreeSha256: materialized.preRunTreeSha256,
      evaluationRoot: path.join(fixture.root, "evaluation"),
      browserReleaseRoot: path.join(fixture.layout.toolchain, "unused"),
    })
    expect(result.captures).toBe(0)
    expect(result.score.qualifiedSuccess).toBe(false)
    expect(result.score.disqualifications).toContain("VISUAL_COMPOSITE_BELOW_75")
    const evidence = await Bun.file(result.evidenceFile).json()
    expect(evidence.evidence).toHaveLength(1)
    verifyEvaluationEvidence(path.dirname(result.evidenceFile), evidence)
  } finally {
    if (path.dirname(materialized.runRoot) !== path.join(fixture.layout.workspaces, "evaluator-fallback-test"))
      throw new Error("unsafe cleanup")
    await fs.rm(materialized.runRoot, { recursive: true, force: true })
    await fixture.dispose()
  }
})
