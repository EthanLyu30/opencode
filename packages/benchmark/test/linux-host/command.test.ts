import { test, expect } from "bun:test"
import path from "node:path"
import { sessionFixture } from "./fixture"
import { makeProcessRunner } from "../../src/sandbox/docker"
import { verifyLinuxReadiness } from "../../src/sandbox/command"
import { parseWslSwap, decodeLegacyRegistration } from "../../src/sandbox/storage-source"
import { decodeLinuxRuntimeConfig } from "../../src/sandbox/runtime"
import { decodeReadinessIndex, readControllerJson } from "../../src/sandbox/readiness"
import fs from "node:fs/promises"
import { publishImmutable } from "../../src/offline/atomic"
import { independentFixture, identity } from "../independent/fixture"

test("runtime accepts only fixed installed Git and frozen A composition data, never executable code or expected scores", async () => {
  const f = await sessionFixture(),
    task = await independentFixture("runtime-composition")
  try {
    const roots = Object.fromEntries(
      ["runRoot", "repo", "data", "config", "cache", "temp", "output"].map((name) => [
        name,
        path.join(f.root, "run", name),
      ]),
    )
    const image = "own/runtime@sha256:" + "a".repeat(64)
    const production = {
      schemaVersion: 1,
      identity: identity(),
      image,
      publicImage: image,
      readonlyToolCallID: "ro-write",
      commands: [{ argv: ["bun", "test"], workdir: "/workspace" }],
      previews: [],
      gitStates: [[{ path: "src/math.js", contentBase64: Buffer.from(task.source).toString("base64") }]],
    }
    const config = {
      schemaVersion: 2,
      git: { path: "C:\\Program Files\\Git\\mingw64\\bin\\git.exe", sha256: "a".repeat(64) },
      browser: { root: f.root, helper: f.cli, fonts: [f.cli], fontRegistrySha256: "a".repeat(64) },
      profiles: [],
      projects: [],
      capabilities: [
        {
          armID: "A",
          binary: f.cli,
          cases: [
            {
              kind: "coding",
              input: {
                armID: "A",
                campaignID: "fixture",
                runID: "run-1",
                binary: { runtime: "modified", executable: f.cli.path, sha256: f.cli.sha256, version: "fixture" },
                roots,
                prompt: "public fixture",
                referenceFiles: [],
                brokerOrigin: "http://127.0.0.1:12345",
                brokerGrant: "g".repeat(64),
                grantExpiresAt: Date.now() + 60000,
                budget: {
                  aggregateInputTokens: 100,
                  aggregateOutputTokens: 100,
                  maxToolCalls: 10,
                  maxRetries: 1,
                  maxDurationMs: 30000,
                },
              },
              scripts: {
                main: [{ protocol: "chat_completions", model: "kimi-k3", events: [] }],
                readonly: [{ protocol: "chat_completions", model: "kimi-k3", events: [] }],
              },
              profile: task.profile,
              outputs: [],
              production,
            },
          ],
        },
      ],
      corpus: {
        authoredRoot: f.root,
        outputRoot: f.root,
        executionPlans: {},
        requirementPlans: {},
        interactionAssertions: {},
        referencePlans: {},
        references: {},
      },
    }
    expect(decodeLinuxRuntimeConfig(config).capabilities[0]!.cases[0]!.production?.gitStates).toEqual(
      production.gitStates,
    )
    expect(() => decodeLinuxRuntimeConfig({ ...config, git: { ...config.git, path: "D:\\arbitrary.exe" } })).toThrow()
    expect(() =>
      decodeLinuxRuntimeConfig({ ...config, git: { ...config.git, environment: { PRIVATE: "forbidden" } } }),
    ).toThrow()
  } finally {
    await task.dispose()
    await f.dispose()
  }
})
test("actual command subprocess rejects unknown modes/flags and blocks absent authority without Docker", async () => {
  const f = await sessionFixture()
  try {
    const runner = makeProcessRunner({
      executable: process.execPath,
      argvPrefix: ["--no-env-file", "run", path.resolve("script/linux-host.ts")],
      cwd: f.root,
      env: Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
      ),
    })
    for (const [argv, exit] of [
      [["paid"], 1],
      [[], 2],
      [["accept", "--bogus"], 1],
      [["accept", "--manifest", f.cli.path], 2],
      [["calibrate", "--manifest", f.cli.path], 2],
      [["verify", "--root", f.root], 2],
    ] as const) {
      const r = await runner.execute({
        argv,
        timeoutMs: 5000,
        maxStdoutBytes: 1048576,
        maxStderrBytes: 65536,
        signal: new AbortController().signal,
      })
      expect(r.exitCode).toBe(exit)
      const output = JSON.parse(Buffer.from(r.stdout).toString("utf8"))
      expect(output.engine_verified ?? false).toBe(false)
      expect(output).not.toHaveProperty("stack")
    }
    expect(await verifyLinuxReadiness({ root: f.manifest.roots.evidence, manifest: f.manifest })).toMatchObject({
      kind: "blocked",
    })
  } finally {
    await f.dispose()
  }
})
test("versioned storage parser never guesses swap or applies legacy paths to managed VHD versions", () => {
  expect(parseWslSwap("[wsl2]\nswap=0\n")).toEqual({ kind: "disabled" })
  expect(() => parseWslSwap("[wsl2]\nmemory=2GB")).toThrow()
  expect(() => parseWslSwap("[wsl2]\nswap=1GB\nswapFile=C:\\swap.vhdx")).toThrow()
  expect(() =>
    decodeLegacyRegistration({ version: "4.85.0", distributionName: "docker-desktop-data", basePath: "D:\\docker" }),
  ).toThrow()
  expect(
    decodeLegacyRegistration({ version: "4.29.0", distributionName: "docker-desktop-data", basePath: "D:\\docker" })
      .basePath,
  ).toBe("D:\\docker")
})
test("runtime configuration rejects nested executable, expected-value and malformed dispatch inputs before a launch", () => {
  for (const config of [
    { schemaVersion: 2 },
    { schemaVersion: 2, profiles: [{ run: "shell" }], projects: [], capabilities: [], browser: {}, corpus: {} },
    {
      schemaVersion: 2,
      profiles: [],
      projects: [{ kind: "chart", build: { expected: "secret" } }],
      capabilities: [],
      browser: {},
      corpus: {},
    },
  ])
    expect(() => decodeLinuxRuntimeConfig(config)).toThrow()
})
test("readiness cannot resurrect fixture receipts, reuse another manifest, accept malformed indices or overwrite evidence", async () => {
  const f = await sessionFixture()
  try {
    for (const index of [
      {},
      {
        schemaVersion: 2,
        manifestSha256: "a".repeat(64),
        engineSha256: "a".repeat(64),
        capabilitySha256: [],
        corpusSha256: "a".repeat(64),
        calibrationSha256: "a".repeat(64),
      },
    ])
      expect(() => decodeReadinessIndex(index)).toThrow()
    const hashes = ["a", "b", "c", "d", "e"].map((v) => v.repeat(64)),
      index = {
        schemaVersion: 2 as const,
        manifestSha256: "f".repeat(64),
        engineSha256: hashes[0]!,
        capabilitySha256: hashes,
        corpusSha256: hashes[0]!,
        calibrationSha256: hashes[0]!,
      }
    expect(
      await verifyLinuxReadiness({ root: f.manifest.roots.evidence, manifest: f.manifest, session: f.session, index }),
    ).toMatchObject({ kind: "blocked", code: "TASK24_READINESS_STALE" })
    expect(f.calls).toHaveLength(0)
    const file = path.join(f.root, "immutable.json")
    await publishImmutable(file, "{}")
    await expect(publishImmutable(file, '{"ready":true}')).rejects.toThrow()
    expect(await readControllerJson(file)).toEqual({})
    await fs.writeFile(path.join(f.root, "truncated.json"), "{")
    await expect(readControllerJson(path.join(f.root, "truncated.json"))).rejects.toThrow()
  } finally {
    await f.dispose()
  }
})
