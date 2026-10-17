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
    const owned = await createOwnedContainer(input)
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
