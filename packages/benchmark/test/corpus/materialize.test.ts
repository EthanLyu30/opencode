import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { materializeTask, treeHash } from "../../src/corpus/materialize"
import { taskFixture } from "./fixture"

const cleanup: string[] = []
const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  while (disposals.length > 0) await disposals.pop()!()
  while (cleanup.length > 0) {
    const target = path.resolve(cleanup.pop()!)
    const root = path.resolve("D:\\OpenCode-Benchmark\\Task24\\workspaces") + path.sep
    if (!target.startsWith(root)) throw new TypeError("Unsafe materialization cleanup")
    await fs.rm(target, { recursive: true, force: true })
  }
})

describe("Task24 workspace materialization", () => {
  test("creates fresh D-only process roots and never copies hidden gold", async () => {
    const fixture = await taskFixture("materialize")
    disposals.push(() => fixture.dispose())
    const campaignID = `campaign-${crypto.randomUUID()}`
    cleanup.push(path.join(fixture.layout.workspaces, campaignID))

    const result = await materializeTask({
      layout: fixture.layout,
      bundleRoot: fixture.bundle,
      campaignID,
      runID: "run-a",
    })

    for (const value of Object.values(result.roots)) expect(path.parse(value).root.toLowerCase()).toBe("d:\\")
    expect(await Bun.file(path.join(result.roots.repo, "index.html")).text()).toBe(fixture.starterText)
    expect(await Bun.file(path.join(result.roots.repo, "assets", "reference.bin")).bytes()).toEqual(fixture.assetBytes)
    expect(await Bun.file(path.join(result.runRoot, "gold")).exists()).toBe(false)
    expect(result.preRunTreeSha256).toBe(await treeHash(result.roots.repo))
  })

  test("reproduces identical trees in separate runs and rejects dirty reuse", async () => {
    const fixture = await taskFixture("replay")
    disposals.push(() => fixture.dispose())
    const campaignID = `campaign-${crypto.randomUUID()}`
    cleanup.push(path.join(fixture.layout.workspaces, campaignID))
    const first = await materializeTask({
      layout: fixture.layout,
      bundleRoot: fixture.bundle,
      campaignID,
      runID: "run-a",
    })
    const second = await materializeTask({
      layout: fixture.layout,
      bundleRoot: fixture.bundle,
      campaignID,
      runID: "run-b",
    })

    expect(second.preRunTreeSha256).toBe(first.preRunTreeSha256)
    await expect(
      materializeTask({ layout: fixture.layout, bundleRoot: fixture.bundle, campaignID, runID: "run-a" }),
    ).rejects.toThrow(/fresh|reuse/i)
  })

  test("rejects a forged layout before creating a C-owned process root", async () => {
    const fixture = await taskFixture("forged-layout")
    disposals.push(() => fixture.dispose())
    await expect(
      materializeTask({
        layout: { ...fixture.layout, workspaces: "C:\\task24-forged" },
        bundleRoot: fixture.bundle,
        campaignID: "campaign-forged",
        runID: "run-a",
      }),
    ).rejects.toThrow(/forged/i)
  })
})
