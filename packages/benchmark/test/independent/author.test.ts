import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  prepareEvaluationCorpus,
  validatePreparationRoots,
  prepareTaskMaterials,
} from "../../src/corpus/evaluation-author"
import { evaluationCatalogue } from "../../src/corpus/evaluation-catalogue"
import { independentFixture } from "./fixture"
import { sha256Text } from "../../src/hash"
import {
  decodeOracleAuthoring,
  authorIndependentTask,
  materializeCalibrationCandidate,
  verifyTaskAuthoring,
} from "../../src/corpus/evaluation-authoring"
import { applyControlPatch } from "../../src/corpus/evaluation-controls"
import { loadEvaluationBundle } from "../../src/corpus/evaluation-bundle"
import { evaluateFunctional } from "../../src/evaluator/independent/functional"
import { decodeProbeResponse, makeProbeRequest, probeWorkerSource } from "../../src/evaluator/independent/probe"
import { decodeTaskExecutionProfile, decodeEvaluationOracle } from "../../src/corpus/evaluation-profile"
import { bindEvidenceFile } from "../../src/evaluator/evidence"
import { identity, candidate } from "./fixture"

test("complete private authoring publishes a usable strict guardrail bundle while Linux remains blocked", async () => {
  const f = await independentFixture("guardrail-bundle")
  try {
    const task = {
      ...evaluationCatalogue()[12]!,
      taskID: "fixture-add",
      sourceEntry: "src/math.js",
      probeModules: ["src/math.js"],
      requiredOracleCases: ["sum"],
    }
    const authored = {
      schemaVersion: 2,
      taskID: "fixture-add",
      cases: f.oracle.cases,
      requirements: f.oracle.requirements,
      quality: [],
      policy: [],
      controls: [
        { kind: "seed", base: "seed", edits: [], expected: { functional: "fail", visual: null, policy: "pass" } },
        {
          kind: "correct",
          base: "seed",
          edits: [{ kind: "copy", from: "gold/expected/src/math.js", path: "src/math.js" }],
          expected: { functional: "pass", visual: null, policy: "pass" },
        },
        {
          kind: "alternate-correct",
          base: "correct",
          edits: [{ kind: "replace", path: "src/math.js", search: "a+b", replacement: "b+a" }],
          expected: { functional: "pass", visual: null, policy: "pass" },
        },
        {
          kind: "functional-bad",
          base: "correct",
          edits: [{ kind: "replace", path: "src/math.js", search: "a+b", replacement: "a*b" }],
          expected: { functional: "fail", visual: null, policy: "pass" },
        },
        {
          kind: "policy-bad",
          base: "correct",
          edits: [{ kind: "append", path: "src/math.js", text: "\n// controlled policy negative\n" }],
          expected: { functional: "not_observed", visual: null, policy: "fail" },
        },
      ],
    }
    const outputRoot = path.join(f.root, "published")
    const result = await prepareTaskMaterials({
      task,
      sourceFiles: {
        "starter/package.json": Buffer.from('{"type":"module"}'),
        "starter/src/math.js": Buffer.from("export const add=(a,b)=>0;\n"),
        "gold/expected/src/math.js": Buffer.from("export const add=(a,b)=>a+b;\n"),
      },
      outputRoot,
      sourceRevision: "fixture",
      sourceSha256: sha256Text("source"),
      authoring: authored,
    } as never)
    expect(result.oracleSha256).not.toBeNull()
    expect(result.missing).not.toContain("independent-oracle-cases")
    expect(result.missing).not.toContain("calibration-candidates")
    const bundle = await loadEvaluationBundle(outputRoot)
    expect(bundle.oracle.cases).toHaveLength(1)
    expect(result.status).toBe("blocked")
    expect(result.missing).toContain("linux-host-attestation")
  } finally {
    await f.dispose()
  }
})

test("control patch applies actual context, including new files, and rejects path/context corruption", () => {
  const files = { "src/a.js": Buffer.from("one\ntwo\nthree\n") }
  const patch =
    "--- a/src/a.js\n+++ b/src/a.js\n@@ -1,3 +1,3 @@\n one\n-two\n+changed\n three\n--- /dev/null\n+++ b/src/new.js\n@@ -0,0 +1 @@\n+created\n"
  const changed = applyControlPatch(files, patch)
  expect(Buffer.from(changed["src/a.js"]!).toString()).toBe("one\nchanged\nthree\n")
  expect(Buffer.from(changed["src/new.js"]!).toString()).toBe("created\n")
  expect(() => applyControlPatch(files, patch.replaceAll("src/a.js", "../escape"))).toThrow()
  expect(() => applyControlPatch(files, patch.replace("-two", "-wrong"))).toThrow()
  expect(Buffer.from(files["src/a.js"]).toString()).toBe("one\ntwo\nthree\n")
  const offset = applyControlPatch(files, patch.replace("@@ -1,3 +1,3 @@", "@@ -3,3 +3,3 @@"))
  expect(Buffer.from(offset["src/a.js"]!).toString()).toBe("one\nchanged\nthree\n")
})

test("authored oracle and all calibration candidates contain real hash-bound bytes, not requirement lists", async () => {
  const f = await independentFixture("author-complete")
  try {
    const task = {
      ...evaluationCatalogue().find((t) => t.taskID === "guardrail-data-normalization")!,
      taskID: "fixture-add",
      sourceEntry: "src/math.js",
      probeModules: ["src/math.js"],
      requiredOracleCases: ["sum"],
    }
    const sourceFiles = {
      "starter/src/math.js": Buffer.from("export const add=(a,b)=>0;\n"),
      "gold/expected/src/math.js": Buffer.from("export const add=(a,b)=>a+b;\n"),
    }
    Object.assign(sourceFiles, {
      "gold/requirements.json": Buffer.from(
        JSON.stringify({ mandatory: ["must keep input immutable"], selectors: ["main"] }),
      ),
    })
    const authoring = {
      schemaVersion: 2,
      taskID: "fixture-add",
      cases: f.oracle.cases,
      requirements: f.oracle.requirements,
      quality: [],
      policy: [],
      controls: [
        { kind: "seed", base: "seed", edits: [], expected: { functional: "fail", visual: null, policy: "pass" } },
        {
          kind: "correct",
          base: "seed",
          edits: [{ kind: "copy", from: "gold/expected/src/math.js", path: "src/math.js" }],
          expected: { functional: "pass", visual: null, policy: "pass" },
        },
        {
          kind: "alternate-correct",
          base: "correct",
          edits: [{ kind: "replace", path: "src/math.js", search: "a+b", replacement: "b+a" }],
          expected: { functional: "pass", visual: null, policy: "pass" },
        },
        {
          kind: "functional-bad",
          base: "correct",
          edits: [{ kind: "replace", path: "src/math.js", search: "a+b", replacement: "a*b" }],
          expected: { functional: "fail", visual: null, policy: "pass" },
        },
        {
          kind: "policy-bad",
          base: "correct",
          edits: [{ kind: "append", path: "src/math.js", text: "\n// policy control, never executed here\n" }],
          expected: { functional: "not_observed", visual: null, policy: "fail" },
        },
      ],
    }
    const outputRoot = path.join(f.root, "authoring")
    const result = await authorIndependentTask({
      task,
      sourceFiles,
      publicFiles: { "src/math.js": sourceFiles["starter/src/math.js"] },
      outputRoot,
      authoring,
    })
    expect(result).toHaveProperty("canary.sha256")
    const normalizedOracle = JSON.parse(await fs.readFile(path.join(outputRoot, "oracle-authored.json"), "utf8"))
    expect(normalizedOracle.requirements).toHaveLength(3)
    expect(
      normalizedOracle.requirements.filter(
        (r: { id: string; mandatory: boolean }) => r.id.startsWith("source-") && r.mandatory,
      ),
    ).toHaveLength(2)
    expect(result.controls).toHaveLength(5)
    expect(new Set(result.controls.map((c) => c.treeSha256)).size).toBe(5)
    await verifyTaskAuthoring({ root: outputRoot, task })
    const target = path.join(f.root, "control-correct")
    await materializeCalibrationCandidate({ root: outputRoot, kind: "correct", destination: target })
    expect(await fs.readFile(path.join(target, "src/math.js"), "utf8")).toBe("export const add=(a,b)=>a+b;\n")
    expect(result.engineVerified).toBe(false)
    await expect(
      authorIndependentTask({
        task,
        sourceFiles,
        publicFiles: { "src/math.js": sourceFiles["starter/src/math.js"] },
        outputRoot: path.join(f.root, "absent-protected"),
        authoring,
        protectedPaths: ["package.json"],
      }),
    ).resolves.toMatchObject({ engineVerified: false })
    await expect(
      authorIndependentTask({
        task,
        sourceFiles,
        publicFiles: { "src/math.js": sourceFiles["starter/src/math.js"] },
        outputRoot: path.join(f.root, "protected-reject"),
        authoring,
        protectedPaths: ["src/math.js"],
      }),
    ).rejects.toThrow("TASK24_AUTHORING_PROTECTED_CONTROL_EDIT")
    const worker = path.join(f.root, "worker.ts")
    await fs.writeFile(worker, probeWorkerSource())
    const verdicts: Record<string, boolean> = {}
    for (const kind of ["correct", "alternate-correct", "seed", "functional-bad"] as const) {
      const destination = path.join(f.root, `exec-${kind}`)
      await materializeCalibrationCandidate({ root: outputRoot, kind, destination })
      const profile = decodeTaskExecutionProfile(f.profile)
      const request = makeProbeRequest({
        identity: identity(),
        profile,
        inputs: {
          candidate,
          module: "src/math.js",
          cases: authoring.cases.map((c) => ({ id: c.id, operations: c.operations })) as never,
        },
      })
      const process = Bun.spawn([Bun.which("bun")!, "--no-env-file", "run", worker, destination], {
        cwd: f.root,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      process.stdin.write(JSON.stringify(request))
      process.stdin.end()
      const bytes = await new Response(process.stdout).bytes()
      expect(await process.exited).toBe(0)
      const file = path.join(f.root, `${kind}-probe.json`)
      await fs.writeFile(file, bytes)
      const facts = evaluateFunctional({
        oracle: decodeEvaluationOracle(f.oracle),
        observation: decodeProbeResponse(bytes),
        evidence: [bindEvidenceFile(f.root, file, "probe")],
      })
      verdicts[kind] = facts.mandatoryPassed
    }
    expect(verdicts).toEqual({ correct: true, "alternate-correct": true, seed: false, "functional-bad": false })
    const recordFile = path.join(outputRoot, "authoring.json"),
      controlFile = path.join(outputRoot, "controls/correct.json")
    const recordBytes = await fs.readFile(recordFile, "utf8"),
      controlBytes = await fs.readFile(controlFile, "utf8")
    const alteredRecord = JSON.parse(recordBytes),
      alteredControl = JSON.parse(controlBytes)
    alteredRecord.controls.find((c: { kind: string }) => c.kind === "correct").expected.functional = "fail"
    alteredControl.expected.functional = "fail"
    await fs.writeFile(recordFile, JSON.stringify(alteredRecord))
    await fs.writeFile(controlFile, JSON.stringify(alteredControl))
    await expect(verifyTaskAuthoring({ root: outputRoot, task })).rejects.toThrow()
    await fs.writeFile(recordFile, recordBytes)
    await fs.writeFile(controlFile, controlBytes)
    const wrong = { ...authoring, cases: [] }
    expect(() => decodeOracleAuthoring(wrong, task)).toThrow()
    await fs.writeFile(
      path.join(outputRoot, "blobs", result.controls.find((c) => c.kind === "correct")!.overlays[0]!.sha256),
      "tampered",
    )
    await expect(verifyTaskAuthoring({ root: outputRoot, task })).rejects.toThrow()
  } finally {
    await f.dispose()
  }
})

test("private control patch authoring rejects traversal and protects unchanged source", async () => {
  const f = await independentFixture("author-patch")
  try {
    const task = {
      ...evaluationCatalogue()[0]!,
      taskID: "fixture-add",
      sourceEntry: "src/math.js",
      probeModules: ["src/math.js"],
      requiredOracleCases: ["sum"],
      kind: "guardrail" as const,
    }
    const data = {
      schemaVersion: 2,
      taskID: "fixture-add",
      cases: f.oracle.cases,
      requirements: [],
      quality: [],
      policy: [],
      controls: [],
    }
    expect(() => decodeOracleAuthoring(data, task)).toThrow()
  } finally {
    await f.dispose()
  }
})
test("primary authoring cannot claim completion without explicit keyboard and page-health oracles", async () => {
  const f = await independentFixture("interaction-authoring")
  try {
    const task = { ...evaluationCatalogue()[0]!, taskID: "fixture-add", requiredOracleCases: ["sum"] }
    const controls = [
      "correct",
      "alternate-correct",
      "seed",
      "functional-bad",
      "visual-bad",
      "responsive-bad",
      "policy-bad",
    ].map((kind) => ({
      kind,
      base: ["seed", "correct"].includes(kind) ? "seed" : "correct",
      edits: [],
      expected: {
        functional: kind === "seed" || kind === "functional-bad" ? "fail" : "pass",
        visual: ["seed", "visual-bad", "responsive-bad"].includes(kind) ? "fail" : "pass",
        policy: kind === "policy-bad" ? "fail" : "pass",
      },
    }))
    expect(() =>
      decodeOracleAuthoring(
        {
          schemaVersion: 2,
          taskID: "fixture-add",
          cases: f.oracle.cases,
          requirements: [],
          quality: [],
          policy: [],
          controls,
        },
        task,
      ),
    ).toThrow("TASK24_AUTHORING_INTERACTION_COVERAGE")
  } finally {
    await f.dispose()
  }
})
test("preparation roots reject reuse, overlap, deployment and arbitrary source roots before writes", async () => {
  const sourceRoot = "D:\\OpenCode-Benchmark\\Task24\\assets\\tasks"
  for (const outputRoot of [
    sourceRoot,
    "D:\\",
    "D:\\OpenCode-Local",
    "D:\\OpenCode-Benchmark\\Task24\\runs\\new",
    "D:\\OpenCode-Benchmark\\Task24\\assets",
  ])
    await expect(validatePreparationRoots({ sourceRoot, outputRoot })).rejects.toThrow()
  const f = await independentFixture("author-roots")
  try {
    await expect(
      prepareEvaluationCorpus({ sourceRoot: f.sourceRoot, outputRoot: path.join(f.root, "new") }),
    ).rejects.toThrow()
    await expect(validatePreparationRoots({ sourceRoot, outputRoot: f.root })).rejects.toThrow()
    expect(await fs.readFile(path.join(f.sourceRoot, "src/math.js"), "utf8")).toBe(f.source)
  } finally {
    await f.dispose()
  }
})
test("material author keeps raw hidden tests private and missing true engine assets blocked, never fake hashes", async () => {
  const f = await independentFixture("author-material")
  try {
    const task = evaluationCatalogue().find((t) => t.taskID === "guardrail-data-normalization")!
    const sourceFiles = {
      "starter/package.json": Buffer.from('{"type":"module"}'),
      "starter/src/usage.js": Buffer.from("export const normalizeUsage=()=>[]"),
      "gold/functional.test.ts": Buffer.from(f.oracleCanary),
      "LICENSES.json": Buffer.from("[]"),
    }
    const item = await prepareTaskMaterials({
      task,
      outputRoot: path.join(f.root, "prepared"),
      sourceFiles,
      sourceRevision: "fixture",
      sourceSha256: sha256Text("source"),
    })
    expect(item.status).toBe("blocked")
    expect(item.oracleSha256).toBeNull()
    expect(item.missing).toContain("independent-oracle-cases")
    const publicText = await fs.readFile(path.join(f.root, "prepared/public/.task24/smoke.test.ts"), "utf8")
    expect(publicText).not.toContain(f.oracleCanary)
    expect(await fs.readFile(path.join(f.root, "prepared/private/legacy/functional.test.ts"), "utf8")).toBe(
      f.oracleCanary,
    )
    const controls = JSON.parse(await fs.readFile(path.join(f.root, "prepared/private/calibration-plan.json"), "utf8"))
    expect(controls.required).toEqual(["correct", "alternate-correct", "seed", "functional-bad", "policy-bad"])
    expect(controls.executed).toBe(false)
  } finally {
    await f.dispose()
  }
})
