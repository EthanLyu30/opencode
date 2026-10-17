import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { sessionFixture } from "./fixture"
import { orchestratorFixture } from "../independent/fixture"
import { makePublicToolHost } from "../../src/sandbox/public-tools"
import { sha256Text } from "../../src/hash"
import { startPublicToolPipe, callPublicToolPipe } from "../../src/sandbox/mcp-server"

test("public tools enforce CAS, frozen commands, protected paths, bounded reads and revoked authority", async () => {
  const f = await sessionFixture(),
    c = await orchestratorFixture()
  let valid = true
  try {
    const root = path.join(f.manifest.roots.work, "tools")
    await fs.mkdir(root)
    await fs.mkdir(path.join(root, "src"))
    await fs.writeFile(path.join(root, "src/math.js"), "wrong")
    const host = makePublicToolHost({
      workspace: root,
      profile: c.input.bundle.profile,
      guard: async () => {
        if (!valid) throw Error("revoked")
      },
      maxCalls: 30,
      backend: {
        check: async () => ({ exitCode: 0 }),
        preview: async () => ({ previewID: "a".repeat(64) }),
        capture: async () => ({ sha256: "b".repeat(64) }),
      },
    })
    expect((await host.read({ path: "src/math.js", offset: 0, length: 5 })).text).toBe("wrong")
    await expect(
      host.write({ path: "src/math.js", baseSha256: sha256Text("stale"), content: "correct" }),
    ).rejects.toThrow()
    await host.write({ path: "src/math.js", baseSha256: sha256Text("wrong"), content: "correct" })
    expect(await fs.readFile(path.join(root, "src/math.js"), "utf8")).toBe("correct")
    for (const name of ["../private/key", ".opencode/config.json", "package.json", "tests/test.js", "yarn.lock"])
      await expect(host.write({ path: name, baseSha256: null, content: "bad" })).rejects.toThrow()
    await expect(host.check({ commandID: "arbitrary" })).rejects.toThrow()
    valid = false
    await expect(host.read({ path: "src/math.js", offset: 0, length: 1 })).rejects.toThrow()
    expect(host.journal().toolCalls).toBe(10)
  } finally {
    await c.dispose()
    await f.dispose()
  }
})

test("MCP real stdio publishes only five tools and reports rejected path calls without stdout contamination", async () => {
  const f = await sessionFixture()
  try {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "run", path.resolve("test/linux-host/mcp-fixture.ts"), f.manifest.roots.work],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env },
    )
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "own-fixture", version: "1" } },
      }) + "\n",
    )
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n")
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "read", arguments: { path: "../private", offset: 0, length: 10, capability: "a".repeat(64) } },
      }) + "\n",
    )
    child.stdin.end()
    const text = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    const lines = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    expect(lines.find((l) => l.id === 2).result.tools.map((t: { name: string }) => t.name)).toEqual([
      "read",
      "write",
      "check",
      "preview",
      "capture",
    ])
    expect(lines.find((l) => l.id === 3).result.isError).toBe(true)
  } finally {
    await f.dispose()
  }
})

test("owned named pipe forwards only admitted public methods and rejects a foreign capability", async () => {
  const pipe = await startPublicToolPipe({
    host: {
      read: async () => ({ text: "own", sha256: sha256Text("own"), totalBytes: 3 }),
      write: async () => {
        throw Error("no")
      },
      check: async () => ({ exitCode: 0 }),
      preview: async () => {
        throw Error("no")
      },
      capture: async () => {
        throw Error("no")
      },
    },
  })
  try {
    expect(
      await callPublicToolPipe({ ...pipe, name: "read", parameters: { path: "src/x", offset: 0, length: 3 } }),
    ).toMatchObject({ text: "own" })
    await expect(
      callPublicToolPipe({ ...pipe, capability: "0".repeat(64), name: "read", parameters: {} }),
    ).rejects.toThrow()
  } finally {
    await pipe.close()
  }
})
