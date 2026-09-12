import { describe, expect, test } from "bun:test"
import { Task24Root, Task24RootError } from "../src/root"

describe("Task24Root", () => {
  test("rejects every Task24 root outside the fixed D directory", () => {
    expect(() => Task24Root.make("C:\\temp\\Task24")).toThrow("TASK24_ROOT_OUTSIDE_D")
  })

  test("returns the complete fixed D-drive layout", () => {
    expect(Task24Root.make("D:\\OpenCode-Benchmark\\Task24")).toEqual({
      root: "D:\\OpenCode-Benchmark\\Task24",
      assets: "D:\\OpenCode-Benchmark\\Task24\\assets",
      cache: "D:\\OpenCode-Benchmark\\Task24\\cache",
      toolchain: "D:\\OpenCode-Benchmark\\Task24\\toolchain",
      workspaces: "D:\\OpenCode-Benchmark\\Task24\\workspaces",
      runs: "D:\\OpenCode-Benchmark\\Task24\\runs",
      reports: "D:\\OpenCode-Benchmark\\Task24\\reports",
      tmp: "D:\\OpenCode-Benchmark\\Task24\\tmp",
    })
  })

  test("rejects non-canonical spelling even when it normalizes to the fixed root", () => {
    expect(() => Task24Root.make("D:\\OpenCode-Benchmark\\other\\..\\Task24")).toThrow(
      new Task24RootError("TASK24_ROOT_NOT_CANONICAL"),
    )
  })

  test("creates the declared layout idempotently", () => {
    const first = Task24Root.ensure()
    const second = Task24Root.ensure()
    expect(second).toEqual(first)
  })
})
