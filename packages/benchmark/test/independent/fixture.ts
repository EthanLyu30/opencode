import fs from "node:fs/promises"
import path from "node:path"
import { sha256Text } from "../../src/hash"

export async function independentFixture(label: string) {
  const parent = process.env.TMPDIR!
  if (!path.resolve(parent).toLowerCase().startsWith("d:\\opencode-benchmark\\task24\\tmp\\bprep1-")) throw Error("FIXTURE_ROOT")
  const root = await fs.mkdtemp(path.join(parent, `independent-${label}-`))
  const sourceRoot = path.join(root, "source")
  const workRoot = path.join(root, "work")
  const resultRoot = path.join(root, "results")
  const bundleRoot = path.join(root, "bundle")
  const source = "export const add = (a, b) => a + b\n"
  const oracleCanary = "PRIVATE_ORACLE_CANARY"
  const entry = { path: "public/src/math.js", sha256: sha256Text(source), size: Buffer.byteLength(source) }
  const profile = {
    schemaVersion: 2, taskID: "fixture-add", kind: "guardrail", stratum: "guardrail", executionKind: "coding-build",
    seedSha256: sha256Text(source), publicFixtureSha256: sha256Text("fixture"),
    publicInputs: [{ ...entry, purpose: "starter", origin: "task-public" }],
    sourceEntry: "src/math.js", probeModules: ["src/math.js"], protectedPaths: [], mutablePaths: ["src/math.js"],
    checks: [{ id: "test", cwd: ".", argv: ["bun", "--no-env-file", "test"], timeoutMs: 30000, required: true }],
    dependency: { kind: "none" }, preview: null,
  }
  const oracle = {
    schemaVersion: 2, taskID: "fixture-add", kind: "guardrail", privateFiles: [],
    cases: [{ id: "sum", module: "src/math.js", operations: [{ kind: "call", target: "add", args: [2, 3] }],
      expected: [{ comparator: "equal", value: 5 }], mandatory: true, weight: 1 }],
    requirements: [], quality: [], policy: [], visual: null,
    calibration: [{ id: "known-correct", kind: "correct", path: "private/correct.js" }],
    note: oracleCanary,
  }
  async function writeBundle() {
    await fs.mkdir(path.join(bundleRoot, "public/src"), { recursive: true })
    await fs.writeFile(path.join(bundleRoot, "public/src/math.js"), source)
    await fs.writeFile(path.join(bundleRoot, "profile.json"), JSON.stringify(profile))
    await fs.writeFile(path.join(bundleRoot, "oracle.json"), JSON.stringify(oracle))
  }
  await fs.mkdir(path.join(sourceRoot, "src"), { recursive: true })
  await fs.writeFile(path.join(sourceRoot, "src/math.js"), source)
  await writeBundle()
  return { root, sourceRoot, workRoot, resultRoot, bundleRoot, profile, oracle, oracleCanary, source, writeBundle,
    async dispose() {
      const resolved = await fs.realpath(root)
      if (resolved !== path.resolve(root) || path.dirname(resolved) !== path.resolve(parent)) throw Error("FIXTURE_OWNERSHIP")
      await fs.rm(resolved, { recursive: true })
    } }
}
