import { test, expect } from "bun:test"
import {
  makeCalibrationSchedule,
  runCalibrationSchedule,
  semanticMeasurementSha256,
} from "../../src/sandbox/calibration"
import { finalizeLinuxCorpus, publicBuildDriverSource } from "../../src/corpus/evaluation-finalize"
import { sessionFixture } from "./fixture"
import { makeProcessRunner } from "../../src/sandbox/docker"
import { evaluationFactsFixture } from "../independent/fixture"
import { scoreIndependentEvaluation } from "../../src/evaluator/independent/result"
const controls = [
  "correct",
  "alternate-correct",
  "seed",
  "functional-bad",
  "visual-bad",
  "responsive-bad",
  "policy-bad",
] as const
const tasks = Array.from({ length: 16 }, (_, i) => ({
  taskID: "own-" + i,
  kind: i < 12 ? ("primary" as const) : ("guardrail" as const),
  controls: controls
    .filter((c) => i < 12 || !["visual-bad", "responsive-bad"].includes(c))
    .map((kind) => ({
      kind,
      treeSha256: (i.toString(16) + controls.indexOf(kind).toString(16)).padEnd(64, "0"),
      expected: { functional: "pass" as const, visual: i < 12 ? ("pass" as const) : null, policy: "pass" as const },
    })),
}))
test("frozen schedule contains104 distinct controls plus exactly16 correct repeats, with no task selection", () => {
  const plan = makeCalibrationSchedule(tasks)
  expect(plan.entries).toHaveLength(120)
  expect(plan.distinctControlCount).toBe(104)
  expect(plan.taskCount).toBe(16)
  expect(plan.primaryTasks).toBe(12)
  expect(plan.guardrailTasks).toBe(4)
  expect(() => makeCalibrationSchedule(tasks.slice(1))).toThrow()
  expect(() =>
    makeCalibrationSchedule(tasks.map((t, i) => (i ? t : { ...t, controls: t.controls.slice(1) }))),
  ).toThrow()
})
test("software loop serializes all evaluations, preserves harness failures and never promotes fixture results", async () => {
  const plan = makeCalibrationSchedule(tasks),
    result = scoreIndependentEvaluation(evaluationFactsFixture())
  const report = await runCalibrationSchedule(
    plan,
    async (item) => (item.repeat ? { kind: "harness_error", code: "OWN_FAULT" } : { kind: "evaluated", result }),
    new AbortController().signal,
  )
  expect(report.entries).toHaveLength(120)
  expect(report.realEvaluations).toBe(0)
  expect(report.corpusEngineReady).toBe(false)
  expect(report.unobservedRequiredChecks).toHaveLength(120)
  expect(report.entries.filter((e) => e.outcome.kind === "harness_error")).toHaveLength(16)
  const changed = { ...result, identity: { ...result.identity, runID: "different" }, semanticSha256: "a".repeat(64) }
  expect(semanticMeasurementSha256(changed)).toBe(semanticMeasurementSha256(result))
  expect(semanticMeasurementSha256({ ...result, functional: 0 })).not.toBe(semanticMeasurementSha256(result))
})
test("finalization refuses an unverified engine before creating any output tree", async () => {
  await expect(finalizeLinuxCorpus({} as never)).rejects.toThrow()
})
test("public build driver rejects empty or shell commands and actual own child failures cannot forge success", async () => {
  expect(() => publicBuildDriverSource([[]])).toThrow()
  expect(() => publicBuildDriverSource([["powershell.exe", "-Command", "bad"]])).toThrow()
  const f = await sessionFixture()
  try {
    const runner = makeProcessRunner({
      executable: process.execPath,
      argvPrefix: ["--no-env-file"],
      cwd: f.root,
      env: Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
      ),
    })
    for (const code of [0, 3]) {
      const result = await runner.execute({
        argv: [
          "-e",
          publicBuildDriverSource([
            [process.execPath, "--no-env-file", "-e", `console.log('not protocol');process.exit(${code})`],
          ]),
        ],
        timeoutMs: 5000,
        maxStdoutBytes: 1048576,
        maxStderrBytes: 65536,
        signal: new AbortController().signal,
      })
      expect(result.exitCode).toBe(code)
      expect(result.stdout.byteLength).toBe(0)
    }
  } finally {
    await f.dispose()
  }
})
