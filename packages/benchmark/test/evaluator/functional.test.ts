import { afterEach, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { runFunctionalEvaluation, scoreFunctionalAssertions } from "../../src/evaluator/functional"
import { Task24Root } from "../../src/root"
import { evidence } from "./helpers"

const fixtureRoot = path.resolve(import.meta.dir, "../fixtures/evaluator")
const cleanup: string[] = []
afterEach(async () => {
  while (cleanup.length > 0) await fs.rm(cleanup.pop()!, { recursive: true, force: true })
})

describe("Task24 functional evaluation", () => {
  test("maps evaluator-owned mandatory and optional assertions to exactly 45 points", () => {
    const result = scoreFunctionalAssertions({
      assertions: [
        { id: "loads", mandatory: true, passed: true, weight: 3 },
        { id: "filters", mandatory: false, passed: false, weight: 1 },
      ],
      evidence: [evidence("functional")],
    })
    expect(result.points).toBe(33.75)
    expect(result.mandatoryPassed).toBe(true)
  })

  test("runs only a hash-bound evaluator command with a fixed child environment", async () => {
    const command = path.join(fixtureRoot, "functional-command.js")
    const commandSha256 = createHash("sha256")
      .update(await fs.readFile(command))
      .digest("hex")
    let received: { cwd: string; env: Readonly<Record<string, string>>; argv: readonly string[] } | undefined
    const result = await runFunctionalEvaluation({
      evaluatorRoot: fixtureRoot,
      workspaceRoot: fixtureRoot,
      tempRoot: fixtureRoot,
      executable: "D:\\OpenCode-Toolchain\\node.exe",
      commandRelativePath: "functional-command.js",
      commandSha256,
      timeoutMs: 5_000,
      evidence: [evidence("functional-process")],
      runner: async (invocation) => {
        received = invocation
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            schemaVersion: 1,
            assertions: [
              { id: "loads", mandatory: true, passed: true, weight: 3 },
              { id: "filters", mandatory: false, passed: false, weight: 1 },
            ],
          }),
          stderr: "",
          timedOut: false,
        }
      },
    })
    expect(result.points).toBe(33.75)
    expect(received?.cwd).toBe(fixtureRoot)
    expect(received?.argv).toEqual([command])
    expect(Object.keys(received?.env ?? {}).toSorted()).toEqual([
      "BUN_INSTALL_CACHE_DIR",
      "HOME",
      "LANG",
      "NO_COLOR",
      "TASK24_EVALUATOR",
      "TEMP",
      "TMP",
      "TMPDIR",
      "TZ",
      "USERPROFILE",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "npm_config_cache",
    ])
    expect(Object.values(received?.env ?? {}).some((value) => value.startsWith("C:\\"))).toBe(false)
  })

  test("rejects a substituted evaluator command before process start", async () => {
    let started = false
    await expect(
      runFunctionalEvaluation({
        evaluatorRoot: fixtureRoot,
        workspaceRoot: fixtureRoot,
        tempRoot: fixtureRoot,
        executable: "D:\\OpenCode-Toolchain\\node.exe",
        commandRelativePath: "functional-command.js",
        commandSha256: "0".repeat(64),
        timeoutMs: 5_000,
        evidence: [evidence("functional-process")],
        runner: async () => {
          started = true
          throw new Error("must not run")
        },
      }),
    ).rejects.toThrow("TASK24_FUNCTIONAL_COMMAND_IDENTITY_INVALID")
    expect(started).toBe(false)
  })

  test("executes the production runner with all task-owned homes and caches on D", async () => {
    const command = path.join(fixtureRoot, "functional-command.js")
    const commandSha256 = createHash("sha256")
      .update(await fs.readFile(command))
      .digest("hex")
    const tempRoot = path.join(Task24Root.ensure().tmp, `functional-${randomUUID()}`)
    cleanup.push(tempRoot)
    await fs.mkdir(tempRoot)
    const result = await runFunctionalEvaluation({
      evaluatorRoot: fixtureRoot,
      workspaceRoot: fixtureRoot,
      tempRoot,
      executable: "D:\\OpenCode-Toolchain\\bun-1.3.14\\bun-windows-x64\\bun.exe",
      commandRelativePath: "functional-command.js",
      commandSha256,
      timeoutMs: 5_000,
      evidence: [evidence("functional-production")],
    })
    expect(result).toMatchObject({ points: 33.75, mandatoryPassed: true })
  })
})
