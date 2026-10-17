import { test, expect } from "bun:test"
import { verifyBinaryCapabilities } from "../../src/sandbox/capability"
import { sessionFixture } from "./fixture"
test("no verified OS isolation means zero binary launches and no capability receipt", async () => {
  const f = await sessionFixture()
  let launches = 0
  try {
    const result = await verifyBinaryCapabilities({
      binary: f.cli,
      armID: "A",
      session: f.session,
      isolation: {
        verify: async () => ({ kind: "ready", value: { isolated: true } }),
        launch: async () => {
          launches++
          throw Error("must not launch")
        },
      } as never,
    } as never)
    expect(result).toMatchObject({ status: "blocked", code: "tool_capability_blocked" })
    expect(launches).toBe(0)
  } finally {
    await f.dispose()
  }
})
