import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { bindEvidenceFile } from "../../src/evaluator/evidence"
import { verifyEvaluationEvidence, workspaceDirectoryExists } from "../../src/offline/evidence"
import { Task24Root } from "../../src/root"

const cleanup: string[] = []
afterEach(async () => {
  for (const root of cleanup.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

test("recovery recognizes real workspace directories, not Bun file objects", async () => {
  const root = path.join(Task24Root.ensure().tmp, `evidence-${crypto.randomUUID()}`)
  cleanup.push(root)
  await fs.mkdir(root)
  expect(await workspaceDirectoryExists(root)).toBe(true)
  expect(await workspaceDirectoryExists(path.join(root, "absent"))).toBe(false)
})

test("verification rehashes every scored evidence file and rejects missing, changed or unbound evidence", async () => {
  const root = path.join(Task24Root.ensure().tmp, `evidence-${crypto.randomUUID()}`)
  cleanup.push(root)
  await fs.mkdir(root)
  const file = path.join(root, "candidate.png")
  await fs.writeFile(file, "image bytes")
  const evidence = [bindEvidenceFile(root, file, "candidate-screenshot")]
  const value = { evidence, score: { evidenceHashes: evidence.map((item) => item.sha256) } }
  verifyEvaluationEvidence(root, value)
  expect(() => verifyEvaluationEvidence(root, { ...value, evidence: [] })).toThrow()
  await fs.writeFile(file, "changed image")
  expect(() => verifyEvaluationEvidence(root, value)).toThrow("TASK24_EVIDENCE_IDENTITY_CHANGED")
  await fs.rm(file)
  expect(() => verifyEvaluationEvidence(root, value)).toThrow()
})
