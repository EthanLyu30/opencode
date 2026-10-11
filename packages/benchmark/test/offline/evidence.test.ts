import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { bindEvidenceFile } from "../../src/evaluator/evidence"
import {
  verifyEvaluationEvidence,
  verifySecurityEvidenceCoverage,
  workspaceDirectoryExists,
} from "../../src/offline/evidence"
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

test("security coverage binds every log digest and ledger, including explicit empty-log receipts", () => {
  const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  const cases = [
    ["exact-modified-incomplete", "exact_binary_incomplete"],
    ["exact-upstream-failed", "exact_binary_failed"],
    ["exact-modified-network", "exact_binary_external_network"],
    ["evaluator-sandbox", "evaluator_sandbox_boundary"],
  ] as const
  const value = {
    exactBinaryChecks: cases.map(([, check]) => ({ check, stdoutSha256: "a".repeat(64), stderrSha256: empty })),
    retainedEvidence: cases.flatMap(([caseID]) => [
      {
        kind: "security-log",
        relativePath: `binary-evidence/${caseID}-stdout.jsonl`,
        sha256: "a".repeat(64),
        bytes: 1,
      },
      ...(caseID === "evaluator-sandbox"
        ? []
        : [
            {
              kind: "security-ledger",
              relativePath: `binary-evidence/${caseID}-broker.sqlite`,
              sha256: "b".repeat(64),
              bytes: 1,
            },
          ]),
    ]),
    emptyLogs: cases.map(([caseID]) => ({
      caseID,
      relativePath: `binary-evidence/${caseID}-stderr.log`,
      sha256: empty,
      bytes: 0,
    })),
  }
  expect(() => verifySecurityEvidenceCoverage(value)).not.toThrow()
  for (const bad of [
    { ...value, emptyLogs: value.emptyLogs.slice(1) },
    { ...value, emptyLogs: [...value.emptyLogs, value.emptyLogs[0]] },
    { ...value, emptyLogs: [{ ...value.emptyLogs[0], sha256: "c".repeat(64) }, ...value.emptyLogs.slice(1)] },
    { ...value, emptyLogs: [{ ...value.emptyLogs[0], bytes: 1 }, ...value.emptyLogs.slice(1)] },
    { ...value, emptyLogs: [{ ...value.emptyLogs[0], caseID: "forged" }, ...value.emptyLogs.slice(1)] },
    {
      ...value,
      retainedEvidence: value.retainedEvidence.filter(
        (item) => !item.relativePath.endsWith("exact-modified-incomplete-broker.sqlite"),
      ),
    },
    {
      ...value,
      retainedEvidence: [{ ...value.retainedEvidence[0], sha256: "c".repeat(64) }, ...value.retainedEvidence.slice(1)],
    },
    {
      ...value,
      retainedEvidence: [
        ...value.retainedEvidence,
        { ...value.retainedEvidence[0], relativePath: "binary-evidence/extra-stdout.jsonl" },
      ],
    },
    { ...value, exactBinaryChecks: [...value.exactBinaryChecks, value.exactBinaryChecks[0]] },
  ])
    expect(() => verifySecurityEvidenceCoverage(bad)).toThrow()
})
