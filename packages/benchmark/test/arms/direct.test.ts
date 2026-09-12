import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { collectDirectOutput, prepareDirectArm } from "../../src/arms/direct"
import { Task24Root } from "../../src/root"
import { ArmLaunchSnapshot } from "../../src/schema"
import { armInput } from "./fixture"

const cleanup: string[] = []
afterEach(async () => {
  while (cleanup.length > 0) await fs.rm(cleanup.pop()!, { recursive: true, force: true })
})

describe("Task24 direct arms", () => {
  test.each(["B", "C", "D", "E"] as const)(
    "prepares arm %s without persisting prompts or provider keys",
    async (armID) => {
      const runRoot = path.join(Task24Root.ensure().tmp, `arms-direct-${crypto.randomUUID()}`)
      cleanup.push(runRoot)
      for (const child of ["repo", "data", "config", "cache", "temp", "output"]) {
        await fs.mkdir(path.join(runRoot, child), { recursive: true })
      }
      await fs.mkdir(path.join(runRoot, "repo", "assets"))
      await fs.writeFile(path.join(runRoot, "repo", "assets", "reference.png"), "fixture")
      const executable =
        armID === "D" || armID === "E"
          ? path.join(Task24Root.ensure().toolchain, "upstream", "opencode.exe")
          : process.execPath
      const launch = await prepareDirectArm(armInput(armID, runRoot, executable))
      const provider = armID === "B" || armID === "D" ? "deepseek" : "kimi"
      const model = provider === "deepseek" ? "deepseek-v4-pro" : "kimi-k3"

      expect(launch.executable).toBe(executable)
      expect(launch.args.slice(0, 9)).toEqual([
        "run",
        "--dir",
        path.join(runRoot, "repo"),
        "--model",
        `task24-${provider}/${model}`,
        "--variant",
        "max",
        "--format",
        "json",
      ])
      expect(launch.args).toContain("--auto")
      expect(launch.args).toContain("--file")
      expect(launch.args.at(-1)).toContain("CANARY_TASK_PROMPT")
      expect(launch.environment.TASK24_BROKER_GRANT).toBe("TASK24_BROKER_GRANT_abcdefghijklmnopqrstuvwxyz")
      expect(launch.environment.DEEPSEEK_API_KEY).toBeUndefined()
      expect(launch.environment.MOONSHOT_API_KEY).toBeUndefined()
      const persisted = JSON.stringify(launch.snapshot) + (await Bun.file(launch.configFile).text())
      expect(persisted).not.toContain("CANARY_TASK_PROMPT")
      expect(persisted).not.toContain("TASK24_BROKER_GRANT_abcdefghijklmnopqrstuvwxyz")
      expect(launch.snapshot.promptSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(Schema.is(ArmLaunchSnapshot)(launch.snapshot)).toBe(true)
    },
  )

  test("collects one successful JSONL session and rejects provider errors", () => {
    const output = [
      { type: "step_start", timestamp: 1, sessionID: "session-a", part: { type: "step-start" } },
      { type: "text", timestamp: 2, sessionID: "session-a", part: { type: "text", text: "done" } },
      { type: "step_finish", timestamp: 3, sessionID: "session-a", part: { type: "step-finish", reason: "stop" } },
    ]
      .map(JSON.stringify)
      .join("\n")
    expect(collectDirectOutput(output)).toEqual({ sessionID: "session-a", eventCount: 3, toolCalls: 0 })
    expect(() => collectDirectOutput(JSON.stringify({ type: "error", sessionID: "session-a", error: {} }))).toThrow(
      /direct|error/i,
    )
    expect(() =>
      collectDirectOutput(
        output +
          "\n" +
          JSON.stringify({
            type: "step_finish",
            timestamp: 4,
            sessionID: "session-a",
            part: { type: "step-finish", reason: "unknown" },
          }),
      ),
    ).toThrow(/terminal/i)
  })

  test("rejects any forged C-owned runtime root before writing config", async () => {
    const runRoot = path.join(Task24Root.ensure().tmp, `arms-direct-${crypto.randomUUID()}`)
    cleanup.push(runRoot)
    for (const child of ["repo", "data", "config", "cache", "temp", "output"]) {
      await fs.mkdir(path.join(runRoot, child), { recursive: true })
    }
    await fs.mkdir(path.join(runRoot, "repo", "assets"))
    await fs.writeFile(path.join(runRoot, "repo", "assets", "reference.png"), "fixture")
    const input = armInput("B", runRoot, process.execPath)
    await expect(prepareDirectArm({ ...input, roots: { ...input.roots, cache: "C:\\task24-cache" } })).rejects.toThrow(
      /root|forged/i,
    )
    expect(await Bun.file(path.join(runRoot, "config", "opencode.json")).exists()).toBe(false)
  })
})
