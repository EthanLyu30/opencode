import { describe, expect, test } from "bun:test"
import type { Task24Layout } from "../src/root"
import { runCli, type CliDependencies } from "../src/cli"

const sha = "a".repeat(64)
const layout: Task24Layout = {
  root: "D:\\OpenCode-Benchmark\\Task24",
  assets: "D:\\OpenCode-Benchmark\\Task24\\assets",
  cache: "D:\\OpenCode-Benchmark\\Task24\\cache",
  toolchain: "D:\\OpenCode-Benchmark\\Task24\\toolchain",
  workspaces: "D:\\OpenCode-Benchmark\\Task24\\workspaces",
  runs: "D:\\OpenCode-Benchmark\\Task24\\runs",
  reports: "D:\\OpenCode-Benchmark\\Task24\\reports",
  tmp: "D:\\OpenCode-Benchmark\\Task24\\tmp",
}

function harness(initial: Record<string, unknown> = {}) {
  const files = new Map(Object.entries(initial))
  const output: unknown[] = []
  const dependencies: CliDependencies = {
    root: () => layout,
    readJson: async (path) => {
      if (!files.has(path)) throw new Error("FILE_NOT_FOUND")
      return files.get(path)
    },
    writeImmutableJson: async (path, value) => {
      if (files.has(path)) throw new Error("CAMPAIGN_SEAL_CONFLICT")
      files.set(path, value)
    },
    writeCurrentJson: async (path, value) => {
      files.set(path, value)
    },
    seal: (value) => ({ ...(value as object), id: "fixture", sha256: sha }) as never,
    verify: (value) =>
      (value as { sha256?: string }).sha256 === sha
        ? ({ ok: true, campaign: value } as never)
        : { ok: false, reason: "CAMPAIGN_HASH_MISMATCH" },
    output: (value) => output.push(value),
  }
  return { dependencies, files, output }
}

describe("task24 CLI", () => {
  test("seals the candidate into an immutable campaign directory", async () => {
    const candidate = `${layout.runs}\\preregistration.candidate.json`
    const state = harness({ [candidate]: { id: "fixture" } })

    await runCli(["campaign", "seal", "--root", layout.root], state.dependencies)

    expect(state.files.get(`${layout.runs}\\fixture\\campaign.sealed.json`)).toMatchObject({
      id: "fixture",
      sha256: sha,
    })
    expect(state.files.get(`${layout.runs}\\current-campaign.json`)).toEqual({
      schemaVersion: 1,
      id: "fixture",
      sha256: sha,
    })
    expect(state.output).toEqual([{ command: "campaign.seal", id: "fixture", sha256: sha }])
  })

  test("verifies the current immutable seal", async () => {
    const state = harness({
      [`${layout.runs}\\current-campaign.json`]: { schemaVersion: 1, id: "fixture", sha256: sha },
      [`${layout.runs}\\fixture\\campaign.sealed.json`]: { id: "fixture", sha256: sha },
    })

    await runCli(["campaign", "verify", "--root", layout.root], state.dependencies)

    expect(state.output).toEqual([{ command: "campaign.verify", id: "fixture", sha256: sha, ok: true }])
  })

  test("rejects unsupported commands before reading campaign files", async () => {
    const state = harness()
    expect(runCli(["campaign", "spend"], state.dependencies)).rejects.toThrow("TASK24_COMMAND_INVALID")
  })

  test("routes status, staged run, resume, and cancellation commands without weakening stage parsing", async () => {
    const state = harness()
    const calls: string[] = []
    const dependencies: CliDependencies = {
      ...state.dependencies,
      runtime: {
        status: async () => (calls.push("status"), { command: "status" }),
        run: async (_layout, stage) => (calls.push(`run:${stage}`), { command: "run", stage }),
        resume: async () => (calls.push("resume"), { command: "resume" }),
        cancel: async (_layout, runID) => (calls.push(`cancel:${runID}`), { command: "cancel", runID }),
      },
    }
    await runCli(["status"], dependencies)
    await runCli(["run", "--stage", "offline"], dependencies)
    await runCli(["resume"], dependencies)
    await runCli(["cancel", "run-a"], dependencies)
    expect(calls).toEqual(["status", "run:offline", "resume", "cancel:run-a"])
    expect(state.output).toHaveLength(4)
    await expect(runCli(["run", "--stage", "pilot-ish"], dependencies)).rejects.toThrow("TASK24_COMMAND_INVALID")
  })
})
