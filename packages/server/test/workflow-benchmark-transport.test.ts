import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ProductionHostRuntime } from "../src/workflow/production-host-runtime"

const root = "D:\\OpenCode-Benchmark\\Task24\\runs\\transport-loader-tests"
const campaignID = "task24-campaign-001"
const runID = "task24-run-001"
const grant = "task24-broker-grant-that-is-long-and-random-000001"

const profile = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  schemaVersion: 1,
  campaignID,
  runID,
  brokerOrigin: "http://127.0.0.1:43191",
  providerPaths: { kimi: "/v1/kimi", deepseek: "/v1/deepseek" },
  expiresAt: Date.now() + 60_000,
  grant,
  ...overrides,
})

const environment = (file: string, runDataRoot = root) => ({
  OPENCODE_BENCHMARK_TRANSPORT_FILE: file,
  OPENCODE_BENCHMARK_RUN_DATA_ROOT: runDataRoot,
  OPENCODE_BENCHMARK_CAMPAIGN_ID: campaignID,
  OPENCODE_BENCHMARK_RUN_ID: runID,
})

const writeProfile = async (name: string, value = profile()) => {
  const directory = path.join(root, name)
  await fs.mkdir(directory, { recursive: true })
  const file = path.join(directory, "transport.json")
  await Bun.write(file, JSON.stringify(value))
  return { directory, file }
}

afterAll(async () => {
  if (path.resolve(root) !== root || !root.startsWith("D:\\OpenCode-Benchmark\\Task24\\runs\\")) {
    throw new TypeError("Unexpected Task24 transport test root")
  }
  await fs.rm(root, { recursive: true, force: true })
})

describe("ProductionHostRuntime benchmark transport", () => {
  test("is disabled with no environment contract", () => {
    expect(ProductionHostRuntime.loadBenchmarkTransport({})).toBeUndefined()
  })

  test("loads an exact profile only from its isolated run data root", async () => {
    const fixture = await writeProfile("valid")
    const binding = ProductionHostRuntime.loadBenchmarkTransport(environment(fixture.file, fixture.directory))

    expect(binding).toMatchObject({
      campaignID,
      runID,
      brokerOrigin: "http://127.0.0.1:43191",
      providerPaths: { kimi: "/v1/kimi", deepseek: "/v1/deepseek" },
    })
    expect(JSON.stringify(binding)).not.toContain(grant)
  })

  test("fails closed for partial configuration or a file outside the run root", async () => {
    const fixture = await writeProfile("outside")
    const other = path.join(root, "other")
    await fs.mkdir(other, { recursive: true })

    expect(() =>
      ProductionHostRuntime.loadBenchmarkTransport({ OPENCODE_BENCHMARK_TRANSPORT_FILE: fixture.file }),
    ).toThrow()
    expect(() => ProductionHostRuntime.loadBenchmarkTransport(environment(fixture.file, other))).toThrow(/inside/i)
  })

  test("rejects an expired profile and a wrong campaign identity", async () => {
    const expired = await writeProfile("expired", profile({ expiresAt: Date.now() - 1 }))
    const wrong = await writeProfile("wrong-campaign", profile({ campaignID: "another-campaign" }))

    expect(() => ProductionHostRuntime.loadBenchmarkTransport(environment(expired.file, expired.directory))).toThrow(
      /expired/i,
    )
    expect(() => ProductionHostRuntime.loadBenchmarkTransport(environment(wrong.file, wrong.directory))).toThrow(
      /campaign/i,
    )
  })

  test("rejects file and directory link escapes", async () => {
    const outside = path.join(root, "outside-target")
    const isolated = path.join(root, "linked")
    await fs.mkdir(outside, { recursive: true })
    await fs.mkdir(isolated, { recursive: true })
    const target = path.join(outside, "transport.json")
    await Bun.write(target, JSON.stringify(profile()))
    const linkedFile = path.join(isolated, "transport.json")
    await fs.symlink(target, linkedFile, "file")

    expect(() => ProductionHostRuntime.loadBenchmarkTransport(environment(linkedFile, isolated))).toThrow(
      /link|reparse|inside/i,
    )

    const linkedRoot = path.join(root, "linked-root")
    await fs.symlink(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir")
    expect(() =>
      ProductionHostRuntime.loadBenchmarkTransport(environment(path.join(linkedRoot, "transport.json"), linkedRoot)),
    ).toThrow(/link|reparse|alias/i)
  })
})
