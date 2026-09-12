import { describe, expect, test } from "bun:test"
import path from "node:path"
import { assertBinaryForArm } from "../../src/arms/upstream"
import { Task24Root } from "../../src/root"
import { binary } from "./fixture"

describe("Task24 runtime isolation", () => {
  test("binds D/E to frozen upstream and A/B/C to modified without importing benchmark code", () => {
    const root = Task24Root.ensure().toolchain
    const modified = binary("modified", path.join(root, "modified", "opencode.exe"))
    const upstream = binary("upstream", path.join(root, "upstream", "opencode.exe"))
    expect(assertBinaryForArm("A", modified)).toBe(modified)
    expect(assertBinaryForArm("D", upstream)).toBe(upstream)
    expect(() => assertBinaryForArm("D", modified)).toThrow(/runtime/i)
    expect(() => assertBinaryForArm("B", upstream)).toThrow(/runtime/i)
  })

  test("rejects binaries outside the Task24 D-drive toolchain", () => {
    expect(() => assertBinaryForArm("D", binary("upstream", "C:\\tools\\opencode.exe"))).toThrow(/binary|toolchain/i)
  })
})
