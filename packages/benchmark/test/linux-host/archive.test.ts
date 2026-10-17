import { expect, test } from "bun:test"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text } from "../../src/hash"
import { decodeCandidateArchive, outputPolicy, assertSourceUnchanged } from "../../src/sandbox/archive"
import { orchestratorFixture } from "../independent/fixture"

test("sealed archives reject metadata, traversal, collisions and changed bytes before materialization", () => {
  const entry = { path: "src/add.js", size: 1, sha256: sha256Text("x"), base64: Buffer.from("x").toString("base64") }
  const read = (files: unknown[]) => {
    const bytes = Buffer.from(canonicalJson({ schemaVersion: 2, files }))
    return decodeCandidateArchive(bytes, sha256Text(bytes.toString()))
  }
  expect(read([entry]).map((f) => f.path)).toEqual(["src/add.js"])
  for (const bad of ["../x", "/etc/passwd", "C:/x", "NUL", "src/X.", "private/canary.txt"])
    expect(() => read([{ ...entry, path: bad }])).toThrow()
  for (const type of ["symlink", "hardlink", "device"]) expect(() => read([{ ...entry, type }])).toThrow()
  expect(() => read([entry, { ...entry, path: "SRC/ADD.js" }])).toThrow()
  expect(() => read([{ ...entry, base64: "eQ==" }])).toThrow()
  expect(() => read([{ ...entry, size: 8 * 1024 * 1024 + 1 }])).toThrow()
  expect(() => decodeCandidateArchive(Buffer.from("{}"), "0".repeat(64))).toThrow()
})

test("registered build outputs cannot cover source and checks cannot rewrite even a mutable source", async () => {
  const f = await orchestratorFixture()
  try {
    expect(() => outputPolicy(f.input.bundle.profile, ["src"])).toThrow()
    outputPolicy(f.input.bundle.profile, ["dist"])
    const before = [{ path: "src/math.js", sha256: sha256Text("source"), size: 6 }]
    expect(() => assertSourceUnchanged(before, [{ ...before[0]!, sha256: sha256Text("rewritten") }])).toThrow()
    assertSourceUnchanged(before, [...before, { path: "dist/page.html", sha256: sha256Text("built"), size: 5 }])
  } finally {
    await f.dispose()
  }
})
