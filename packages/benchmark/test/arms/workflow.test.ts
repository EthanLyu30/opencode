import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { collectWorkflowOutput, prepareWorkflowArm, workflowRoutes } from "../../src/arms/workflow"
import { Task24Root } from "../../src/root"
import { armInput } from "./fixture"

const cleanup: string[] = []
afterEach(async () => {
  while (cleanup.length > 0) await fs.rm(cleanup.pop()!, { recursive: true, force: true })
})

describe("Task24 workflow arm", () => {
  test("enters the unmodified production workflow command with trusted transport", async () => {
    const runRoot = path.join(Task24Root.ensure().tmp, `arms-workflow-${crypto.randomUUID()}`)
    cleanup.push(runRoot)
    for (const child of ["repo", "data", "config", "cache", "temp", "output"]) {
      await fs.mkdir(path.join(runRoot, child), { recursive: true })
    }
    await fs.mkdir(path.join(runRoot, "repo", "assets"))
    await fs.writeFile(path.join(runRoot, "repo", "assets", "reference.png"), "fixture")
    const input = armInput("A", runRoot, process.execPath)
    const launch = await prepareWorkflowArm(input)
    expect(launch.args).toEqual(["workflow", "run", input.prompt, "--format", "json"])
    expect(launch.environment.MOONSHOT_API_KEY).toBe(input.brokerGrant)
    expect(launch.environment.DEEPSEEK_API_KEY).toBe(input.brokerGrant)
    expect(launch.environment.OPENCODE_BENCHMARK_TRANSPORT_FILE).toBe(launch.transportFile)
    const transport = await Bun.file(launch.transportFile).text()
    expect(transport).toContain(input.brokerGrant)
    expect(JSON.stringify(launch.snapshot)).not.toContain(input.brokerGrant)
    expect(JSON.stringify(launch.snapshot)).not.toContain("CANARY_TASK_PROMPT")
  })

  test("collects only a successful terminal workflow with the sealed stage routes", () => {
    const stdout = JSON.stringify({
      workflow: { id: "wf-a", status: "succeeded", usage: {}, time: {} },
      response: {
        id: "resp-a",
        workflowID: "wf-a",
        status: "completed",
        background: true,
        store: true,
        createdAt: 1,
      },
      artifacts: [{ kind: "workflow.delivery", mime: "application/json", size: 10, timeCreated: 1 }],
    })
    const result = collectWorkflowOutput(stdout, {
      observedRoutes: workflowRoutes(),
      deliveryArtifactSha256: "b".repeat(64),
    })
    expect(result.workflowID).toBe("wf-a")
    expect(result.artifactSha256).toBe("b".repeat(64))
    expect(() => collectWorkflowOutput(stdout, { observedRoutes: [], deliveryArtifactSha256: "b".repeat(64) })).toThrow(
      /route|stage/i,
    )
  })
})
