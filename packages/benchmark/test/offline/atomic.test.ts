import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { publishImmutable, recoverAtomicDirectory } from "../../src/offline/atomic"
import { sha256Text } from "../../src/hash"
import { Task24Root } from "../../src/root"

const cleanup: string[] = []
afterEach(async () => {
  while (cleanup.length > 0) await fs.rm(cleanup.pop()!, { recursive: true, force: true })
})

describe("Task24 immutable atomic publication", () => {
  test("publishes complete bytes and accepts only identical replay", async () => {
    const root = path.join(Task24Root.ensure().tmp, `atomic-${crypto.randomUUID()}`)
    cleanup.push(root)
    await fs.mkdir(root)
    const target = path.join(root, "result.json")
    await publishImmutable(target, '{"ok":true}\n')
    await publishImmutable(target, '{"ok":true}\n')
    await expect(publishImmutable(target, '{"ok":false}\n')).rejects.toThrow("TASK24_ATOMIC_TARGET_CONFLICT")
    expect(await fs.readFile(target, "utf8")).toBe('{"ok":true}\n')
  })

  test("promotes a complete crash staging file and removes an incomplete one", async () => {
    const root = path.join(Task24Root.ensure().tmp, `atomic-${crypto.randomUUID()}`)
    cleanup.push(root)
    await fs.mkdir(root)
    const body = '{"recovered":true}\n'
    const target = path.join(root, "summary.json")
    await fs.writeFile(`${target}.task24-${sha256Text(body)}-${crypto.randomUUID()}.tmp`, body)
    await fs.writeFile(`${target}.task24-${"f".repeat(64)}-${crypto.randomUUID()}.tmp`, "partial")
    const result = await recoverAtomicDirectory(root)
    expect(result).toEqual({ promoted: 1, discarded: 1 })
    expect(await fs.readFile(target, "utf8")).toBe(body)
  })

  test("never replaces an immutable target when concurrent publishers race", async () => {
    const root = path.join(Task24Root.ensure().tmp, `atomic-${crypto.randomUUID()}`)
    cleanup.push(root)
    await fs.mkdir(root)
    const target = path.join(root, "race.json")
    const results = await Promise.allSettled([
      publishImmutable(target, '{"writer":1}\n'),
      publishImmutable(target, '{"writer":2}\n'),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect([`{"writer":1}\n`, `{"writer":2}\n`]).toContain(await fs.readFile(target, "utf8"))
  })
})
