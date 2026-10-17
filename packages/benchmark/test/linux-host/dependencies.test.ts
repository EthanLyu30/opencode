import { test, expect } from "bun:test"
import { makeImageRecipe, dependencyAuditSource } from "../../src/sandbox/image-recipes"
import fs from "node:fs/promises"
import path from "node:path"
import { makeProcessRunner } from "../../src/sandbox/docker"
import { planLinuxPreparation, prepareLinuxArtifacts, resolveTaskDependency } from "../../src/sandbox/dependencies"
import { evaluationCatalogue } from "../../src/corpus/evaluation-catalogue"
import { sha256Text } from "../../src/hash"
import { hostFixture, sessionFixture } from "./fixture"
import { inspectLinuxHost, openLinuxSession, sessionState } from "../../src/sandbox/preflight"
import { canonicalJson } from "../../src/campaign/canonical"
import { validateTaskResolution } from "../../src/sandbox/linux-backend"

test("artifact preparation never admits user credential/config paths as build or load input", async () => {
  const f = await hostFixture()
  try {
    const task = evaluationCatalogue()[12]!,
      recipe = makeImageRecipe({
        task,
        sourceCommit: "a".repeat(40),
        sourceFiles: {},
        image: "example.invalid/runtime@sha256:" + "a".repeat(64),
        platform: "linux/amd64",
      })
    const inventory = await inspectLinuxHost({
      request: f.request,
      runner: f.runner,
      storageProbe: async () => f.storage,
    })
    expect(() =>
      planLinuxPreparation({
        request: f.request,
        inventory,
        catalogue: [task],
        available: [
          {
            id: "linux-runtime",
            recipe,
            source: { kind: "archive", path: "D:\\OpenCode-Audit\\packages\\llm\\.env.local", sha256: "a".repeat(64) },
            downloadBytes: 100,
            unpackedBytes: 200,
            volumes: [],
          },
        ],
      }),
    ).toThrow("TASK24_LINUX_ARTIFACT_SOURCE")
  } finally {
    await f.dispose()
  }
})

test("library recipes bind the real lockfile, family capabilities and fixed no-hook install command", () => {
  const catalogue = evaluationCatalogue()
  const sourceFiles = {
    "starter/package.json": Buffer.from('{"scripts":{"build":"known fixture build"}}'),
    "starter/yarn.lock": Buffer.from("known fixture lock"),
  }
  const chart = makeImageRecipe({
    task: catalogue[8]!,
    sourceCommit: "a".repeat(40),
    sourceFiles,
    image: "example.invalid/chart@sha256:" + "b".repeat(64),
    platform: "linux/amd64",
  })
  expect(chart.install.argv).toEqual(["yarn", "install", "--frozen-lockfile", "--ignore-scripts"])
  expect(chart.lockfiles[0]!.sha256).toBe(sha256Text("known fixture lock"))
  expect(chart.capabilities).toContain("canvas-probe")
  const pdf = makeImageRecipe({
    task: catalogue[10]!,
    sourceCommit: "a".repeat(40),
    sourceFiles,
    image: "example.invalid/pdf@sha256:" + "c".repeat(64),
    platform: "linux/amd64",
  })
  expect(pdf.capabilities).toContain("pdf-raster")
  expect(pdf.recipeSha256).not.toBe(chart.recipeSha256)
  const resolution = resolveTaskDependency({
    profile: {
      dependency: {
        kind: "locked",
        sourceCommit: chart.sourceCommit,
        lockfiles: [chart.lockfiles[0]!] as const,
        recipeSha256: chart.recipeSha256,
        requiredCapabilities: ["locked-build", "canvas-probe"],
      },
    },
    images: {
      tasks: [
        {
          artifactID: "chart",
          taskID: chart.taskID,
          recipe: chart,
          image: chart.image,
          imageID: "sha256:" + "d".repeat(64),
          platform: chart.platform,
          volumes: [],
          tools: ["bun", "node"],
          receiptSha256: sha256Text("fixture-receipt"),
          assurance: "fixture",
        },
      ],
    },
  })
  expect(resolution.kind).toBe("ready")
  if (resolution.kind === "ready" && resolution.value.kind === "resolved") {
    const image = {
      artifactID: "chart",
      taskID: chart.taskID,
      recipe: chart,
      image: chart.image,
      imageID: "sha256:" + "d".repeat(64),
      platform: chart.platform,
      volumes: [],
      tools: ["node", "bun"],
      receiptSha256: resolution.value.receiptSha256,
      assurance: "fixture" as const,
    }
    const profile = {
      dependency: {
        kind: "locked" as const,
        sourceCommit: chart.sourceCommit,
        lockfiles: [chart.lockfiles[0]!] as const,
        recipeSha256: chart.recipeSha256,
        requiredCapabilities: ["locked-build", "canvas-probe"],
      },
    }
    validateTaskResolution(profile, resolution.value, image)
    for (const key of ["image", "platform", "receiptSha256"])
      expect(() => validateTaskResolution(profile, { ...resolution.value, [key]: "wrong" }, image)).toThrow()
  }
  expect(() =>
    makeImageRecipe({
      task: catalogue[8]!,
      sourceCommit: "a".repeat(40),
      sourceFiles,
      image: "example.invalid/chart:latest",
      platform: "linux/amd64",
    }),
  ).toThrow()
  expect(() =>
    makeImageRecipe({
      task: catalogue[8]!,
      sourceCommit: "a".repeat(40),
      sourceFiles: { "starter/package.json": sourceFiles["starter/package.json"] },
      image: chart.image,
      platform: "linux/amd64",
    }),
  ).toThrow()
})

test("cached pinned images are audited through an owned initializer without a network operation", async () => {
  const f = await sessionFixture()
  try {
    const task = evaluationCatalogue()[12]!
    const recipe = makeImageRecipe({
      task,
      sourceCommit: "a".repeat(40),
      sourceFiles: {},
      image: f.image,
      platform: "linux/amd64",
    })
    const inventory = await inspectLinuxHost({
      request: f.request,
      runner: sessionState(f.session).inspection.runner,
      storageProbe: async () => f.storage,
    })
    const plan = planLinuxPreparation({
      request: f.request,
      inventory,
      catalogue: [task],
      available: [
        {
          id: "linux-runtime",
          recipe,
          source: { kind: "registry" },
          downloadBytes: 100,
          unpackedBytes: 1000,
          volumes: [],
        },
      ],
    })
    const manifest = { ...f.manifest, phase: "prepare", artifactManifestSha256: plan.planSha256 }
    const approval = {
      schemaVersion: 2,
      acceptanceID: manifest.acceptanceID,
      planSha256: manifest.planSha256,
      scope: "prepare",
      contextFingerprint: inventory.contextFingerprint,
      artifactManifestSha256: plan.planSha256,
      manifestSha256: sha256Text(canonicalJson(manifest)),
      allowedOperations: [
        "image-pull",
        "volume-prepare",
        "container-create",
        "container-start",
        "container-exec",
        "container-stop",
        "container-remove",
      ],
      storageRoots: Object.values(manifest.roots),
      maxDiskBytes: 67108864,
      expiresAt: Date.now() + 60000,
    }
    const opened = openLinuxSession({ manifest, approval, inventory })
    if (opened.kind !== "ready") throw Error("SESSION")
    const runner = {
      async execute(input: Parameters<typeof f.runner.execute>[0]) {
        if (input.argv[0] === "image" && input.argv[1] === "inspect") {
          f.calls.push(input)
          return {
            started: true,
            exitCode: 0,
            stdout: Buffer.from(
              JSON.stringify({
                Id: "sha256:" + "d".repeat(64),
                RepoDigests: [f.image],
                Os: "linux",
                Architecture: "amd64",
                Size: 50,
              }),
            ),
            stderr: new Uint8Array(),
            truncated: false,
          }
        }
        if (input.argv[0] === "container" && input.argv[1] === "exec") {
          f.calls.push(input)
          return {
            started: true,
            exitCode: 0,
            stdout: Buffer.from(
              JSON.stringify({
                platform: "linux/amd64",
                workerSha256: recipe.auditSha256,
                tools: ["bun", "node"],
                volumes: [],
              }),
            ),
            stderr: new Uint8Array(),
            truncated: false,
          }
        }
        return f.runner.execute(input)
      },
    }
    const images = await prepareLinuxArtifacts({ plan, approval, session: opened.value, runner, guard: async () => {} })
    expect(images.tasks).toHaveLength(1)
    expect(images.tasks[0]!.assurance).toBe("fixture")
    expect(images.tasks[0]!.tools).toEqual(["bun", "node"])
    expect(
      f.calls.filter((c) => c.argv.includes("pull") || c.argv.includes("build") || c.argv.includes("load")),
    ).toHaveLength(0)
    expect(f.state.removed).toBe(true)
  } finally {
    await f.dispose()
  }
})

test("actual trusted audit worker hashes only admitted synthetic dependency bytes and rejects traversal", async () => {
  const f = await hostFixture()
  try {
    const directory = path.join(f.root, "dependency")
    await fs.mkdir(directory)
    await fs.writeFile(path.join(directory, "value.txt"), "hello")
    const worker = path.join(f.root, "audit.mjs")
    await fs.writeFile(worker, dependencyAuditSource())
    const runner = makeProcessRunner({
      executable: Bun.which("bun")!,
      argvPrefix: ["--no-env-file", "run"],
      cwd: f.root,
      env: { TEMP: f.request.roots.temp, TMP: f.request.roots.temp },
    })
    const common = {
      argv: [worker, f.root],
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
      maxStderrBytes: 4096,
      signal: new AbortController().signal,
    }
    const result = await runner.execute({
      ...common,
      stdin: Buffer.from(
        JSON.stringify({ volumes: [{ name: "fixture-dependency", target: directory }], maxBytes: 100 }),
      ),
    })
    expect(result.exitCode).toBe(0)
    const data = JSON.parse(Buffer.from(result.stdout).toString("utf8"))
    expect(data.workerSha256).toBe(sha256Text(dependencyAuditSource()))
    expect(data.volumes[0].treeSha256).toBe(
      sha256Text(canonicalJson([{ path: "value.txt", sha256: sha256Text("hello"), size: 5 }])),
    )
    const bad = await runner.execute({
      ...common,
      stdin: Buffer.from(
        JSON.stringify({ volumes: [{ name: "fixture-dependency", target: path.dirname(f.root) }], maxBytes: 100 }),
      ),
    })
    expect(bad.exitCode).not.toBe(0)
  } finally {
    await f.dispose()
  }
})

test("preparation plans report missing artifacts without downloading and deny all dispatch without scoped permission", async () => {
  const f = await hostFixture(),
    s = await sessionFixture()
  try {
    const inventory = await inspectLinuxHost({
      request: f.request,
      runner: f.runner,
      storageProbe: async () => f.storage,
    })
    const plan = planLinuxPreparation({
      request: f.request,
      inventory,
      catalogue: evaluationCatalogue(),
      available: [],
    })
    expect(plan.missing).toContain("linux-runtime")
    expect(plan.ready).toBe(false)
    await expect(
      prepareLinuxArtifacts({ plan, approval: null, session: s.session, runner: s.runner, guard: async () => {} }),
    ).rejects.toThrow()
    expect(s.calls).toHaveLength(0)
    expect(
      resolveTaskDependency({
        profile: {
          dependency: {
            kind: "locked",
            sourceCommit: "a".repeat(40),
            lockfiles: [] as never,
            recipeSha256: sha256Text("recipe"),
            requiredCapabilities: ["pdf-raster"],
          },
        },
        images: { tasks: [] },
      }),
    ).toMatchObject({ kind: "blocked", code: "dependency_unresolved" })
    expect(resolveTaskDependency({ profile: { dependency: { kind: "none" } }, images: { tasks: [] } })).toEqual({
      kind: "ready",
      value: { kind: "none" },
    })
  } finally {
    await f.dispose()
    await s.dispose()
  }
})
