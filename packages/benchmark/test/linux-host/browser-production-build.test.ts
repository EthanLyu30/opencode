import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { loadBrowserRelease } from "../../src/evaluator/browser-runtime"

test("production browser packaging rejects invalid storage without creating a directory", async () => {
  const module = await import("../../src/sandbox/public-mcp-build")
  const build = Reflect.get(module, "buildBrowserProtocolHelper")
  expect(typeof build).toBe("function")
  await expect(build({ outputRoot: "C:\\not-allowed" })).rejects.toThrow("TASK24_PUBLIC_MCP_BUILD_ROOT")
})

test.skipIf(process.platform !== "win32" || process.env.TASK24_WINDOWS_BROWSER_LIVE !== "1")(
  "real frozen Node runs the versioned browser helper and rejects invalid input before browser creation",
  async () => {
    const module = await import("../../src/sandbox/public-mcp-build")
    const build = Reflect.get(module, "buildBrowserProtocolHelper")
    expect(typeof build).toBe("function")
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "browser-production-build-"))
    const release = loadBrowserRelease(process.env.TASK24_WINDOWS_BROWSER_RELEASE!, { readOnly: true })
    try {
      const packed = await build({ outputRoot: path.join(root, "helper") })
      const child = Bun.spawn([release.nodeExecutable, packed.executable.path], {
        cwd: root,
        env: { SystemRoot: "C:\\Windows", HOME: root, TEMP: root, TMP: root, NODE_DISABLE_COMPILE_CACHE: "1" },
        stdin: new TextEncoder().encode("{}"),
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ exit, stdout, stderr }).toEqual({ exit: 1, stdout: "", stderr: "TASK24_BROWSER_V2_FAILURE:input" })
      await expect(build({ outputRoot: path.join(root, "helper") })).rejects.toThrow()
    } finally {
      await fs.rm(root, { recursive: true })
    }
  },
  150000,
)
