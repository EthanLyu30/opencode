import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { WorkflowModelCatalogStore } from "../src/workflow/model-catalog/store"
import { fixtureCatalogue, fixturePolicy, fixtureScope } from "./fixtures/workflow-model-catalog"
import { tmpdir } from "./fixture/tmpdir"
import { Flock } from "../src/util/flock"
import { Hash } from "../src/util/hash"

const worker = path.join(import.meta.dir, "workflow-model-catalog-store-worker.ts")
function child(root: string, mode: string, expected: string | null, time: number) {
  const queue: unknown[] = []
  const pending: Array<(value: unknown) => void> = []
  const process = Bun.spawn([Bun.argv[0]!, worker, root, mode, expected ?? "null", String(time)], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    ipc(message) {
      const next = pending.shift()
      if (next) next(message)
      else queue.push(message)
    },
  })
  return {
    process,
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift())
        : new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("worker readiness deadline")), 10_000)
            pending.push((value) => {
              clearTimeout(timer)
              resolve(value)
            })
          }),
  }
}

describe("workflow catalogue store", () => {
  test("CAS publication is immutable, canonical and independently rehashed on restart", async () => {
    await using tmp = await tmpdir()
    const store = await WorkflowModelCatalogStore.open(tmp.path, fixtureScope)
    expect((await store.read()).head).toBeNull()
    const catalogue = fixtureCatalogue()
    const policy = fixturePolicy(catalogue)
    const head = await store.publish({ expectedHeadSha256: null, catalogue, policy })
    await expect(store.publish({ expectedHeadSha256: null, catalogue, policy })).rejects.toMatchObject({
      code: "selection_conflict",
    })
    expect((await (await WorkflowModelCatalogStore.open(tmp.path, fixtureScope)).read()).head).toEqual(head)
    expect((await (await WorkflowModelCatalogStore.open(tmp.path, "d".repeat(64))).read()).head).toBeNull()
    const file = path.join(tmp.path, "scopes", fixtureScope, "catalogues", `${catalogue.sha256}.json`)
    await fs.writeFile(file, JSON.stringify({ ...catalogue, observedAt: 99 }))
    await expect(store.read()).rejects.toMatchObject({ code: "snapshot_corrupt" })
  })

  test("tampered input, head or policy never produces a partial publication", async () => {
    await using tmp = await tmpdir()
    const store = await WorkflowModelCatalogStore.open(tmp.path, fixtureScope)
    const catalogue = fixtureCatalogue()
    const policy = fixturePolicy(catalogue)
    await expect(
      store.publish({ expectedHeadSha256: null, catalogue: { ...catalogue, sha256: "d".repeat(64) }, policy }),
    ).rejects.toMatchObject({ code: "snapshot_corrupt" })
    expect((await store.read()).head).toBeNull()
    const head = await store.publish({ expectedHeadSha256: null, catalogue, policy })
    const headFile = path.join(tmp.path, "scopes", fixtureScope, "head.json")
    await fs.writeFile(headFile, JSON.stringify({ ...head, generation: 999 }))
    await expect(store.read()).rejects.toMatchObject({ code: "snapshot_corrupt" })
    await fs.writeFile(headFile, "null")
    await expect(store.read()).rejects.toMatchObject({ code: "snapshot_corrupt" })
  })

  test("normalized snapshots are bounded before publication, not after head replacement", async () => {
    await using tmp = await tmpdir()
    const store = await WorkflowModelCatalogStore.open(tmp.path, fixtureScope)
    const nearReplyLimit = fixtureCatalogue({
      models: [{ ...fixtureCatalogue().models[0]!, displayName: "x".repeat(2 * 1024 * 1024 - 256) }],
    })
    const policy = fixturePolicy(nearReplyLimit)
    const head = await store.publish({ expectedHeadSha256: null, catalogue: nearReplyLimit, policy })
    expect((await store.read()).head).toEqual(head)
    const oversized = fixtureCatalogue({
      models: [{ ...nearReplyLimit.models[0]!, displayName: "x".repeat(4 * 1024 * 1024) }],
    })
    await expect(
      store.publish({ expectedHeadSha256: head.sha256, catalogue: oversized, policy }),
    ).rejects.toMatchObject({ code: "invalid_metadata" })
    expect((await store.read()).head).toEqual(head)
  })

  test("real sibling processes race a single CAS head, exactly one wins", async () => {
    await using tmp = await tmpdir()
    const one = child(tmp.path, "race", null, 1)
    const two = child(tmp.path, "race", null, 2)
    try {
      expect(await one.next()).toEqual({ phase: "ready" })
      expect(await two.next()).toEqual({ phase: "ready" })
      one.process.send("go")
      two.process.send("go")
      const results = await Promise.all([one.next(), two.next()])
      expect(
        results.filter((result) => typeof result === "object" && result !== null && "head" in result),
      ).toHaveLength(1)
      expect(results).toContainEqual({ code: "selection_conflict" })
      await Promise.all([one.process.exited, two.process.exited])
      expect((await (await WorkflowModelCatalogStore.open(tmp.path, fixtureScope)).read()).head?.generation).toBe(1)
    } finally {
      one.process.kill()
      two.process.kill()
      await Promise.all([one.process.exited, two.process.exited])
    }
  }, 30_000)

  test.each(["before_head", "after_head"])(
    "kill writer at %s leaves old or complete new pair",
    async (phase) => {
      await using tmp = await tmpdir()
      const store = await WorkflowModelCatalogStore.open(tmp.path, fixtureScope)
      const catalogue = fixtureCatalogue()
      const old = await store.publish({ expectedHeadSha256: null, catalogue, policy: fixturePolicy(catalogue) })
      const writer = child(tmp.path, phase, old.sha256, 100)
      try {
        expect(await writer.next()).toEqual({ phase: "ready" })
        writer.process.send("go")
        expect(await writer.next()).toEqual({ phase })
        writer.process.kill()
        await writer.process.exited
        const restarted = await (await WorkflowModelCatalogStore.open(tmp.path, fixtureScope)).read()
        expect(restarted.head?.generation).toBe(phase === "before_head" ? 1 : 2)
        expect(restarted.catalogue?.observedAt).toBe(phase === "before_head" ? 0 : 100)
        expect(restarted.head?.catalogueSha256).toBe(restarted.catalogue?.sha256)
        expect(restarted.head?.policySha256).toBe(restarted.policy?.sha256)
        // Owner is dead; advance its heartbeat metadata rather than sleeping for stale recovery.
        const heartbeat = path.join(
          tmp.path,
          "scopes",
          fixtureScope,
          "locks",
          `${Hash.fast(`workflow-model-catalog:${fixtureScope}`)}.lock`,
          "heartbeat",
        )
        const stale = new Date(Date.now() - 120_000)
        await fs.utimes(heartbeat, stale, stale)
        const next = fixtureCatalogue({ observedAt: 101 })
        expect(
          (
            await store.publish({
              expectedHeadSha256: restarted.head!.sha256,
              catalogue: next,
              policy: fixturePolicy(next),
            })
          ).generation,
        ).toBe(restarted.head!.generation + 1)
      } finally {
        writer.process.kill()
        await writer.process.exited
      }
    },
    30_000,
  )

  test("root, child and lock-directory links reject without touching outside", async () => {
    await using tmp = await tmpdir()
    const outside = path.join(tmp.path, "outside")
    const linked = path.join(tmp.path, "linked")
    await fs.mkdir(outside)
    await fs.symlink(outside, linked, process.platform === "win32" ? "junction" : "dir")
    await expect(WorkflowModelCatalogStore.open(linked, fixtureScope)).rejects.toMatchObject({
      code: "snapshot_corrupt",
    })
    const root = path.join(tmp.path, "catalogue")
    const store = await WorkflowModelCatalogStore.open(root, fixtureScope)
    const catalogue = fixtureCatalogue()
    const directory = path.join(root, "scopes", fixtureScope, "catalogues")
    await fs.rmdir(directory)
    await fs.symlink(outside, directory, process.platform === "win32" ? "junction" : "dir")
    await expect(
      store.publish({ expectedHeadSha256: null, catalogue, policy: fixturePolicy(catalogue) }),
    ).rejects.toMatchObject({ code: "snapshot_corrupt" })
    expect(await fs.readdir(outside)).toEqual([])
    const otherRoot = path.join(tmp.path, "lock-guard")
    const otherStore = await WorkflowModelCatalogStore.open(otherRoot, fixtureScope)
    const lockDirectory = path.join(otherRoot, "scopes", fixtureScope, "locks")
    await fs.symlink(
      outside,
      path.join(lockDirectory, "forged.lock"),
      process.platform === "win32" ? "junction" : "dir",
    )
    await expect(
      otherStore.publish({ expectedHeadSha256: null, catalogue, policy: fixturePolicy(catalogue) }),
    ).rejects.toMatchObject({ code: "snapshot_corrupt" })
    expect(await fs.readdir(outside)).toEqual([])
    await expect(WorkflowModelCatalogStore.open(tmp.path, "../escape")).rejects.toMatchObject({
      code: "snapshot_corrupt",
    })
  })

  test("lock wait is bounded and cancellation cannot publish", async () => {
    await using tmp = await tmpdir()
    const controller = new AbortController()
    const store = await WorkflowModelCatalogStore.open(tmp.path, fixtureScope, {
      signal: controller.signal,
      lockTimeoutMs: 50,
    })
    const directory = path.join(tmp.path, "scopes", fixtureScope, "locks")
    await using lock = await Flock.acquire(`workflow-model-catalog:${fixtureScope}`, { dir: directory })
    const catalogue = fixtureCatalogue()
    await expect(
      store.publish({ expectedHeadSha256: null, catalogue, policy: fixturePolicy(catalogue) }),
    ).rejects.toMatchObject({ code: "selection_conflict" })
    controller.abort()
    await expect(
      store.publish({ expectedHeadSha256: null, catalogue, policy: fixturePolicy(catalogue) }),
    ).rejects.toMatchObject({ code: "selection_conflict" })
    expect((await store.read()).head).toBeNull()
    expect((await fs.readdir(directory)).includes(`${Hash.fast(`workflow-model-catalog:${fixtureScope}`)}.lock`)).toBe(
      true,
    )
  })
})
