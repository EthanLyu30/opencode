import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { orchestratorFixture } from "../independent/fixture"
import { makePublicToolHost, requirePublicToolObservation } from "../../src/sandbox/public-tools"
import { sha256Text, sha256Bytes } from "../../src/hash"
import { verifyPublicToolTransition } from "../../src/sandbox/capability"

test("only controller-observed tools can attest changes, checks and readonly denial", async () => {
  const fixture = await orchestratorFixture()
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "production-tools-"))
  try {
    await fs.mkdir(path.join(root, "src"))
    await fs.writeFile(path.join(root, "src/math.js"), "before")
    const host = makePublicToolHost({
      workspace: root,
      profile: fixture.input.bundle.profile,
      maxCalls: 20,
      guard: async () => {},
      backend: {
        check: async (commandID) => ({
          status: "ok",
          candidateSha256: sha256Text("after"),
          commands: [{ id: commandID, exitCode: 0 }],
        }),
        preview: async () => {
          throw Error("not used")
        },
        capture: async () => {
          throw Error("not used")
        },
      },
    })
    const first = host.observation()
    requirePublicToolObservation(first, root)
    expect(() => requirePublicToolObservation({ ...first }, root)).toThrow("TASK24_PUBLIC_OBSERVATION_AUTHORITY")
    expect(() => requirePublicToolObservation(first, path.dirname(root))).toThrow("TASK24_PUBLIC_OBSERVATION_AUTHORITY")
    await host.write({ path: "src/math.js", baseSha256: sha256Text("before"), content: "after" })
    await host.check({ commandID: fixture.input.bundle.profile.checks[0]!.id })
    await expect(host.read({ path: "private/oracle.json", offset: 0, length: 10 })).rejects.toThrow()
    const main = host.observation()
    expect(main.writes).toEqual([
      { path: "src/math.js", beforeSha256: sha256Text("before"), afterSha256: sha256Text("after") },
    ])
    expect(main.checks).toHaveLength(1)
    expect(main.deniedReads).toBe(1)
    expect(
      verifyPublicToolTransition({ before: first, after: main, workspace: root, kind: "coding", readonly: false }),
    ).toBe(true)
    expect(
      verifyPublicToolTransition({ before: first, after: main, workspace: root, kind: "visual", readonly: false }),
    ).toBe(false)
    expect(() =>
      verifyPublicToolTransition({
        before: first,
        after: { ...main },
        workspace: root,
        kind: "coding",
        readonly: false,
      }),
    ).toThrow()
    await host.setReadonly()
    const readonlyBefore = host.observation()
    await expect(
      host.write({ path: "src/math.js", baseSha256: sha256Text("after"), content: "wrong" }),
    ).rejects.toThrow()
    const readonly = host.observation()
    expect(readonly.readonly).toBe(true)
    expect(readonly.deniedWrites).toBe(1)
    expect(readonly.writes).toEqual(main.writes)
    expect(
      verifyPublicToolTransition({
        before: readonlyBefore,
        after: readonly,
        workspace: root,
        kind: "coding",
        readonly: true,
      }),
    ).toBe(true)
    expect(
      verifyPublicToolTransition({ before: first, after: readonly, workspace: root, kind: "coding", readonly: false }),
    ).toBe(false)
    expect(first.writes).toEqual([])
    expect(Object.isFrozen(readonly.writes)).toBe(true)
    expect(await fs.readFile(path.join(root, "src/math.js"), "utf8")).toBe("after")
  } finally {
    await fs.rm(root, { recursive: true })
    await fixture.dispose()
  }
})

test("readonly transition drains and rejects a queued write before publication", async () => {
  const fixture = await orchestratorFixture()
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "production-tools-"))
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  let guards = 0
  try {
    await fs.mkdir(path.join(root, "src"))
    await fs.writeFile(path.join(root, "src/math.js"), "before")
    const host = makePublicToolHost({
      workspace: root,
      profile: fixture.input.bundle.profile,
      maxCalls: 5,
      async guard() {
        if (++guards === 2) {
          entered.resolve()
          await release.promise
        }
      },
      backend: { check: async () => null, preview: async () => null, capture: async () => null },
    })
    const write = host.write({ path: "src/math.js", baseSha256: sha256Text("before"), content: "wrong" })
    void write.catch(() => {})
    await entered.promise
    const transition = host.setReadonly()
    release.resolve()
    await expect(write).rejects.toThrow("TASK24_PUBLIC_PROTECTED")
    await transition
    expect(host.observation().writes).toEqual([])
    expect(host.observation().deniedWrites).toBe(1)
    expect(await fs.readFile(path.join(root, "src/math.js"), "utf8")).toBe("before")
  } finally {
    release.resolve()
    await fs.rm(root, { recursive: true })
    await fixture.dispose()
  }
})

test("failed or incomplete backends do not become successful check observations", async () => {
  const fixture = await orchestratorFixture()
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "production-tools-"))
  try {
    const host = makePublicToolHost({
      workspace: root,
      profile: fixture.input.bundle.profile,
      maxCalls: 5,
      guard: async () => {},
      backend: {
        check: async () => ({ exitCode: 0 }),
        preview: async () => {
          throw Error("own failure")
        },
        capture: async () => {
          throw Error("own failure")
        },
      },
    })
    await host.check({ commandID: fixture.input.bundle.profile.checks[0]!.id })
    expect(host.observation().checks).toEqual([])
    expect(host.observation().previews).toEqual([])
    expect(host.observation().captures).toEqual([])
  } finally {
    await fs.rm(root, { recursive: true })
    await fixture.dispose()
  }
})

test("a successful check before a later breaking write cannot attest the final candidate", async () => {
  const fixture = await orchestratorFixture()
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "production-tools-"))
  try {
    await fs.mkdir(path.join(root, "src"))
    await fs.writeFile(path.join(root, "src/math.js"), "seed")
    const host = makePublicToolHost({
      workspace: root,
      profile: fixture.input.bundle.profile,
      maxCalls: 10,
      guard: async () => {},
      backend: {
        check: async (commandID) => ({
          status: "ok",
          candidateSha256: sha256Text(await fs.readFile(path.join(root, "src/math.js"), "utf8")),
          commands: [{ id: commandID, exitCode: 0 }],
        }),
        preview: async () => null,
        capture: async () => null,
      },
    })
    const before = host.observation()
    await host.write({ path: "src/math.js", baseSha256: sha256Text("seed"), content: "correct" })
    await host.check({ commandID: fixture.input.bundle.profile.checks[0]!.id })
    expect(
      verifyPublicToolTransition({
        before,
        after: host.observation(),
        workspace: root,
        kind: "coding",
        readonly: false,
      }),
    ).toBe(true)
    await host.write({ path: "src/math.js", baseSha256: sha256Text("correct"), content: "broken" })
    expect(
      verifyPublicToolTransition({
        before,
        after: host.observation(),
        workspace: root,
        kind: "coding",
        readonly: false,
      }),
    ).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true })
    await fixture.dispose()
  }
})

test("baseline failure followed by repair and a successful final check remains acceptable", async () => {
  const fixture = await orchestratorFixture()
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "production-tools-"))
  try {
    await fs.mkdir(path.join(root, "src"))
    await fs.writeFile(path.join(root, "src/math.js"), "broken")
    const host = makePublicToolHost({
      workspace: root,
      profile: fixture.input.bundle.profile,
      maxCalls: 10,
      guard: async () => {},
      backend: {
        async check(commandID) {
          const content = await fs.readFile(path.join(root, "src/math.js"), "utf8")
          return {
            status: "ok",
            candidateSha256: sha256Text(content),
            commands: [{ id: commandID, exitCode: content === "correct" ? 0 : 1 }],
          }
        },
        preview: async () => null,
        capture: async () => null,
      },
    })
    const before = host.observation()
    await host.check({ commandID: fixture.input.bundle.profile.checks[0]!.id })
    await host.write({ path: "src/math.js", baseSha256: sha256Text("broken"), content: "correct" })
    await host.check({ commandID: fixture.input.bundle.profile.checks[0]!.id })
    expect(
      verifyPublicToolTransition({
        before,
        after: host.observation(),
        workspace: root,
        kind: "coding",
        readonly: false,
      }),
    ).toBe(true)
    expect(host.observation().checks[0]!.commands[0]!.exitCode).toBe(1)
  } finally {
    await fs.rm(root, { recursive: true })
    await fixture.dispose()
  }
})

test("concurrent check and write settle in order and invalidate the earlier check", async () => {
  const fixture = await orchestratorFixture()
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "production-tools-"))
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  try {
    await fs.mkdir(path.join(root, "src"))
    await fs.writeFile(path.join(root, "src/math.js"), "seed")
    const host = makePublicToolHost({
      workspace: root,
      profile: fixture.input.bundle.profile,
      maxCalls: 10,
      guard: async () => {},
      backend: {
        async check(commandID) {
          const content = await fs.readFile(path.join(root, "src/math.js"), "utf8")
          entered.resolve()
          await release.promise
          return { status: "ok", candidateSha256: sha256Text(content), commands: [{ id: commandID, exitCode: 0 }] }
        },
        preview: async () => null,
        capture: async () => null,
      },
    })
    const before = host.observation()
    await host.write({ path: "src/math.js", baseSha256: sha256Text("seed"), content: "correct" })
    const check = host.check({ commandID: fixture.input.bundle.profile.checks[0]!.id })
    await entered.promise
    const write = host.write({ path: "src/math.js", baseSha256: sha256Text("correct"), content: "broken" })
    release.resolve()
    await Promise.all([check, write])
    expect(host.observation().checks[0]!.candidateSha256).toBe(sha256Text("correct"))
    expect(
      verifyPublicToolTransition({
        before,
        after: host.observation(),
        workspace: root,
        kind: "coding",
        readonly: false,
      }),
    ).toBe(false)
  } finally {
    release.resolve()
    await fs.rm(root, { recursive: true })
    await fixture.dispose()
  }
})

test("visual success requires check preview and capture from the final candidate revision", async () => {
  const fixture = await orchestratorFixture()
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "production-tools-"))
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZAAAAABJRU5ErkJggg==",
    "base64",
  )
  let captureCandidate = sha256Text("correct")
  try {
    await fs.mkdir(path.join(root, "src"))
    await fs.writeFile(path.join(root, "src/math.js"), "seed")
    const candidate = async () => sha256Text(await fs.readFile(path.join(root, "src/math.js"), "utf8"))
    const host = makePublicToolHost({
      workspace: root,
      profile: {
        ...fixture.input.bundle.profile,
        kind: "primary",
        stratum: "private",
        executionKind: "visual-build",
        preview: { entry: "index.html", kind: "html", requiredCapabilities: [], interaction: "none", timeoutMs: 30000 },
      },
      maxCalls: 20,
      guard: async () => {},
      backend: {
        check: async (commandID) => ({
          status: "ok",
          candidateSha256: await candidate(),
          commands: [{ id: commandID, exitCode: 0 }],
        }),
        preview: async () => ({ previewID: "a".repeat(64), candidateSha256: await candidate() }),
        capture: async (previewID, viewportID) => ({
          screenshotSha256: sha256Bytes(png),
          evidenceSha256: "b".repeat(64),
          identity: { previewID, viewportID, candidateSha256: captureCandidate },
          image: { mimeType: "image/png", data: png.toString("base64"), bytes: png.length, sha256: sha256Bytes(png) },
        }),
      },
    })
    const before = host.observation()
    await host.write({ path: "src/math.js", baseSha256: sha256Text("seed"), content: "correct" })
    await host.check({ commandID: fixture.input.bundle.profile.checks[0]!.id })
    await host.preview({ entry: "index.html" })
    await host.capture({ previewID: "a".repeat(64), viewportID: "desktop" })
    expect(
      verifyPublicToolTransition({
        before,
        after: host.observation(),
        workspace: root,
        kind: "visual",
        readonly: false,
      }),
    ).toBe(true)
    await host.write({ path: "src/math.js", baseSha256: sha256Text("correct"), content: "changed" })
    expect(
      verifyPublicToolTransition({
        before,
        after: host.observation(),
        workspace: root,
        kind: "visual",
        readonly: false,
      }),
    ).toBe(false)
    await host.check({ commandID: fixture.input.bundle.profile.checks[0]!.id })
    await host.preview({ entry: "index.html" })
    await host.capture({ previewID: "a".repeat(64), viewportID: "desktop" })
    expect(
      verifyPublicToolTransition({
        before,
        after: host.observation(),
        workspace: root,
        kind: "visual",
        readonly: false,
      }),
    ).toBe(false)
    captureCandidate = await candidate()
    await host.capture({ previewID: "a".repeat(64), viewportID: "desktop" })
    expect(
      verifyPublicToolTransition({
        before,
        after: host.observation(),
        workspace: root,
        kind: "visual",
        readonly: false,
      }),
    ).toBe(true)
  } finally {
    await fs.rm(root, { recursive: true })
    await fixture.dispose()
  }
})
