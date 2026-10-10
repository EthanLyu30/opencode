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
    validateCandidate: async () => {
      throw new Error("UNEXPECTED_CANDIDATE_VALIDATION")
    },
    verifyBinaryLocks: async () => undefined,
    verifyAcceptance: async () => undefined,
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

  test("refuses to publish a seal before final binary locks verify", async () => {
    const candidate = `${layout.runs}\\preregistration.candidate.json`
    const state = harness({ [candidate]: { id: "fixture" } })
    const dependencies: CliDependencies = {
      ...state.dependencies,
      verifyBinaryLocks: async () => {
        throw new TypeError("CAMPAIGN_BINARY_LOCK_PROVISIONAL")
      },
    }

    await expect(runCli(["campaign", "seal", "--root", layout.root], dependencies)).rejects.toThrow(
      "CAMPAIGN_BINARY_LOCK_PROVISIONAL",
    )
    expect(state.files.has(`${layout.runs}\\fixture\\campaign.sealed.json`)).toBe(false)
    expect(state.files.has(`${layout.runs}\\current-campaign.json`)).toBe(false)
  })

  test("refuses to publish a seal before matching offline acceptance verifies", async () => {
    const candidate = `${layout.runs}\\preregistration.candidate.json`
    const state = harness({ [candidate]: { id: "fixture" } })
    const dependencies: CliDependencies = {
      ...state.dependencies,
      verifyAcceptance: async () => {
        throw new TypeError("TASK24_OFFLINE_ACCEPTANCE_RUN_POINTER_INVALID")
      },
    }

    await expect(runCli(["campaign", "seal", "--root", layout.root], dependencies)).rejects.toThrow(
      "TASK24_OFFLINE_ACCEPTANCE_RUN_POINTER_INVALID",
    )
    expect(state.files.has(`${layout.runs}\\fixture\\campaign.sealed.json`)).toBe(false)
    expect(state.files.has(`${layout.runs}\\current-campaign.json`)).toBe(false)
  })

  test("validates a candidate without creating the final campaign seal", async () => {
    const state = harness()
    let calls = 0
    const dependencies: CliDependencies = {
      ...state.dependencies,
      validateCandidate: async () => {
        calls += 1
        return {
          command: "campaign.validate" as const,
          id: "task24-candidate",
          candidateSha256: "b".repeat(64),
          wouldSealSha256: "c".repeat(64),
          taskCount: 16,
          ok: true as const,
        }
      },
    }

    await runCli(["campaign", "validate", "--root", layout.root], dependencies)

    expect(calls).toBe(1)
    expect(state.output).toEqual([
      {
        command: "campaign.validate",
        id: "task24-candidate",
        candidateSha256: "b".repeat(64),
        wouldSealSha256: "c".repeat(64),
        taskCount: 16,
        ok: true,
      },
    ])
    expect(state.files.has(`${layout.runs}\\current-campaign.json`)).toBe(false)
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
        preflight: async (_layout, stage) => (calls.push(`preflight:${stage}`), { command: "preflight", stage }),
        status: async () => (calls.push("status"), { command: "status" }),
        run: async (_layout, stage) => (calls.push(`run:${stage}`), { command: "run", stage }),
        report: async (_layout, stage) => (calls.push(`report:${stage}`), { command: "report", stage }),
        resume: async () => (calls.push("resume"), { command: "resume" }),
        cancel: async (_layout, runID) => (calls.push(`cancel:${runID}`), { command: "cancel", runID }),
      },
    }
    await runCli(["preflight", "--offline"], dependencies)
    await runCli(["status"], dependencies)
    await runCli(["run", "--stage", "offline"], dependencies)
    await runCli(["report", "--stage", "offline"], dependencies)
    await runCli(["resume"], dependencies)
    await runCli(["cancel", "run-a"], dependencies)
    expect(calls).toEqual(["preflight:offline", "status", "run:offline", "report:offline", "resume", "cancel:run-a"])
    expect(state.output).toHaveLength(6)
    await expect(runCli(["run", "--stage", "pilot-ish"], dependencies)).rejects.toThrow("TASK24_COMMAND_INVALID")
  })
})
