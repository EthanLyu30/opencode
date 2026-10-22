import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { buildPublicMcpExecutable } from "../../src/sandbox/public-mcp-build"
import { hostFixture } from "./fixture"

test("MCP packaging refuses C, existing directories and aliases without changing their contents", async () => {
  const f = await hostFixture()
  try {
    await expect(buildPublicMcpExecutable({ outputRoot: "C:\\not-allowed" })).rejects.toThrow(
      "TASK24_PUBLIC_MCP_BUILD_ROOT",
    )
    await expect(buildPublicMcpExecutable({ outputRoot: f.root })).rejects.toThrow()
    expect(await fs.readFile(f.cli.path, "utf8")).toBe("known non-executable Docker fixture")
    const alias = path.join(f.root, "alias")
    await fs.symlink(f.root, alias, "junction")
    await expect(buildPublicMcpExecutable({ outputRoot: path.join(alias, "new") })).rejects.toThrow()
    await fs.unlink(alias)
  } finally {
    await f.dispose()
  }
})
