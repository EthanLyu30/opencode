import { describe, expect, test } from "bun:test"
import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowProductionHostPlan } from "@opencode-ai/core/workflow/production-host-plan"
import { Location } from "@opencode-ai/schema/location"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

describe("Workflow production host plan", () => {
  test("freezes an exact reserved v1 envelope and deterministically selects the admitted Bun test command", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "index.html"), "<!doctype html><title>test</title>")
    await fs.writeFile(path.join(tmp.path, "package.json"), JSON.stringify({ scripts: { test: "bun test unit" } }))
    const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
    const preview = PreviewPlan.freeze({ authority: "admission", location })
    const plan = WorkflowProductionHostPlan.freeze({ authority: "admission", location, preview })

    expect(WorkflowProductionHostPlan.RESERVED_INPUT_KEY).toBe("workflow.production-host-plan.v1")
    expect(plan).toMatchObject({
      kind: "workflow.production-host-plan.v1",
      previewConfigSha256: preview.configSha256,
      functionalTest: { argv: ["bun", "run", "test"], cwd: "." },
    })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.functionalTest.argv)).toBe(true)
    expect(WorkflowProductionHostPlan.decode(plan, location)).toEqual(plan)
    expect(() =>
      WorkflowProductionHostPlan.decode({ ...plan, previewConfigSha256: "0".repeat(64) }, location),
    ).toThrow()
    expect(() =>
      WorkflowProductionHostPlan.decode(
        { ...plan, functionalTest: { ...plan.functionalTest, policySha256: "0".repeat(64) } },
        location,
      ),
    ).toThrow()
  })

  test("uses exact bun test when no supported package test script was admitted", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "index.html"), "<!doctype html><title>test</title>")
    const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
    const preview = PreviewPlan.freeze({ authority: "admission", location })
    expect(
      WorkflowProductionHostPlan.freeze({ authority: "admission", location, preview }).functionalTest.argv,
    ).toEqual(["bun", "test"])
  })
})
