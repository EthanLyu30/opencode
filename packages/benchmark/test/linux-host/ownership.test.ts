import { test, expect } from "bun:test"
import { createOwnedContainer, cleanupOwnedContainer } from "../../src/sandbox/ownership"
import { sessionFixture } from "./fixture"

test("owned lifecycle validates actual inspect policy and never stops a substituted owner", async () => {
  const f = await sessionFixture()
  try {
    let current = true,
      guards = 0
    const guard = async () => {
      guards++
      if (!current) throw Error("STALE_OWNER")
    }
    const input = {
      session: f.session,
      runner: f.runner,
      owner: f.owner,
      spec: { image: f.image, argv: ["/opt/task24/worker"] },
      guard,
      signal: new AbortController().signal,
    }
    await expect(
      createOwnedContainer({ ...input, spec: { ...input.spec, preparingDependencies: true } }),
    ).rejects.toThrow("TASK24_LINUX_CONTAINER_SPEC")
    const owned = await createOwnedContainer(input)
    const created = f.calls.find((c) => c.argv.includes("create"))!
    expect(created.argv[created.argv.indexOf("--entrypoint") + 1]).toBe("/opt/task24/worker")
    expect(f.state.running).toBe(true)
    expect(guards).toBeGreaterThanOrEqual(2)
    f.state.foreign = true
    expect(await cleanupOwnedContainer({ ...input, owner: owned })).toEqual({ ended: false, removed: false })
    expect(f.calls.filter((c) => c.argv.includes("stop") || c.argv.includes("rm"))).toHaveLength(0)
    f.state.foreign = false
    current = false
    expect(await cleanupOwnedContainer({ ...input, owner: owned })).toEqual({ ended: false, removed: false })
    current = true
    expect(await cleanupOwnedContainer({ ...input, owner: owned })).toEqual({ ended: true, removed: true })
    f.state.readOnly = false
    await expect(createOwnedContainer({ ...input, owner: { ...f.owner, operationID: "next" } })).rejects.toThrow()
  } finally {
    await f.dispose()
  }
})

for (const failure of ["empty", "throw"] as const)
  test(`a ${failure} create response discovers only the exact nonce and cleans the orphan without recreating`, async () => {
    const f = await sessionFixture()
    try {
      const runner = {
        async execute(input: Parameters<typeof f.runner.execute>[0]) {
          const result = await f.runner.execute(input)
          if (input.argv.includes("create")) {
            if (failure === "throw") throw Error("connection reset")
            return { ...result, stdout: new Uint8Array() }
          }
          if (input.argv.includes("ls")) return { ...result, stdout: Buffer.from(f.id + "\n") }
          return result
        },
      }
      await expect(
        createOwnedContainer({
          session: f.session,
          runner,
          owner: f.owner,
          spec: { image: f.image, argv: ["/opt/task24/worker"] },
          guard: async () => {},
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("TASK24_LINUX_CREATE_UNCERTAIN")
      expect(f.state.removed).toBe(true)
      expect(f.calls.filter((c) => c.argv.includes("create"))).toHaveLength(1)
      expect(f.calls.filter((c) => c.argv.includes("start"))).toHaveLength(0)
    } finally {
      await f.dispose()
    }
  })
import { assertRequestedMounts } from "../../src/sandbox/ownership"
test("owned creation attests the exact requested mounts, including protected read-only drivers", () => {
  const spec = {
    image: "example.invalid/runtime@sha256:" + "a".repeat(64),
    argv: ["/usr/local/bin/node"],
    workspace: { source: "D:\\OpenCode-Benchmark\\Task24\\workspaces\\own\\candidate", readonly: false },
    protectedFiles: [
      {
        source: "D:\\OpenCode-Benchmark\\Task24\\workspaces\\own\\candidate\\.task24\\driver.mjs",
        target: "/workspace/.task24/driver.mjs",
      },
    ],
  }
  const mounts = [
    { Type: "bind", Source: spec.workspace.source, Destination: "/workspace", RW: true },
    { Type: "bind", Source: spec.protectedFiles[0]!.source, Destination: "/workspace/.task24/driver.mjs", RW: false },
  ]
  expect(() => assertRequestedMounts(mounts, spec)).not.toThrow()
  for (const changed of [
    mounts.slice(0, 1),
    [mounts[0]!, { ...mounts[1]!, RW: true }],
    [{ ...mounts[0]!, Source: spec.workspace.source + "-other" }, mounts[1]!],
  ])
    expect(() => assertRequestedMounts(changed, spec)).toThrow()
})
