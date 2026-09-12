import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Task24Root } from "../../src/root"
import { bindEvidenceFile, verifyEvidenceFile } from "../../src/evaluator/evidence"

const cleanup: string[] = []
afterEach(async () => {
  while (cleanup.length > 0) await fs.rm(cleanup.pop()!, { recursive: true, force: true })
})

describe("Task24 evidence binding", () => {
  test("binds a direct file to its path, byte count, and content hash", async () => {
    const root = path.join(Task24Root.ensure().tmp, `evidence-${crypto.randomUUID()}`)
    cleanup.push(root)
    await fs.mkdir(root)
    const file = path.join(root, "functional.json")
    await fs.writeFile(file, '{"passed":true}\n')
    const reference = bindEvidenceFile(root, file, "functional")
    expect(reference.relativePath).toBe("functional.json")
    expect(reference.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(verifyEvidenceFile(root, reference)).toEqual(reference)
  })

  test("detects evidence mutation and traversal", async () => {
    const root = path.join(Task24Root.ensure().tmp, `evidence-${crypto.randomUUID()}`)
    cleanup.push(root)
    await fs.mkdir(root)
    const file = path.join(root, "policy.json")
    await fs.writeFile(file, "before")
    const reference = bindEvidenceFile(root, file, "policy")
    await fs.writeFile(file, "after")
    expect(() => verifyEvidenceFile(root, reference)).toThrow("TASK24_EVIDENCE_IDENTITY_CHANGED")
    expect(() => bindEvidenceFile(root, path.join(root, "..", "outside.json"), "policy")).toThrow(
      "TASK24_EVIDENCE_FILE_INVALID",
    )
  })
})
