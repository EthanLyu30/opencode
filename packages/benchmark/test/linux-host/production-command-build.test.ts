import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { buildProductionDockerExecutable, buildPublicMcpExecutable } from "../../src/sandbox/public-mcp-build"
import { startProductionCommandEndpoint } from "../../src/sandbox/production-command-http"

test("production Docker shim packaging refuses existing roots, C storage and nonlocal authority", async () => {
  const connection = { host: "127.0.0.1", port: 12345, capability: "a".repeat(64), expiresAt: Date.now() + 60000 }
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "production-build-"))
  try {
    await expect(buildProductionDockerExecutable({ outputRoot: root, connection })).rejects.toThrow()
    await expect(buildProductionDockerExecutable({ outputRoot: "C:\\temp\\production", connection })).rejects.toThrow()
    await expect(
      buildProductionDockerExecutable({
        outputRoot: path.join(root, "fresh"),
        connection: { ...connection, host: "192.168.1.1" },
      }),
    ).rejects.toThrow()
    expect(await fs.readdir(root)).toEqual([])
  } finally {
    await fs.rm(root, { recursive: true })
  }
})

test.skipIf(process.platform !== "win32" || process.env.TASK24_WINDOWS_ISOLATION_LIVE !== "1")(
  "standalone production shim preserves the production CLI argv and stdin without loading project configuration",
  async () => {
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "production-client-"))
    const calls: unknown[] = []
    const bridge = await startProductionCommandEndpoint({
      async execute(value) {
        calls.push({ argv: value.argv, stdin: value.stdin ? Buffer.from(value.stdin).toString() : null })
        return { exit: 7, stdout: "", stderr: "own stderr", truncated: false }
      },
      outstanding: () => ({ containers: [], uncertainNames: [] }),
    })
    try {
      await fs.writeFile(path.join(root, "bunfig.toml"), '[run]\npreload = ["./poison.ts"]\n')
      await fs.writeFile(path.join(root, "poison.ts"), 'throw Error("owned hostile preload executed")\n')
      const result = await buildProductionDockerExecutable({
        outputRoot: path.join(root, "runtime"),
        connection: {
          host: bridge.host,
          port: bridge.port,
          capability: bridge.capability,
          expiresAt: Date.now() + 60000,
        },
      })
      // A controller must be able to package more than one admitted arm in its
      // lifetime, including after loading the actual production command code.
      await import("../../../server/src/workflow/command-sandbox")
      const second = await buildProductionDockerExecutable({
        outputRoot: path.join(root, "runtime-second"),
        connection: {
          host: bridge.host,
          port: bridge.port,
          capability: bridge.capability,
          expiresAt: Date.now() + 60000,
        },
      })
      expect(second.executable.path).toBe(path.join(root, "runtime-second", "docker.exe"))
      const mcp = await buildPublicMcpExecutable({ outputRoot: path.join(root, "mcp") })
      expect(mcp.executable.path).toBe(path.join(root, "mcp", "public-mcp.exe"))
      const child = Bun.spawn(
        [
          result.executable.path,
          "container",
          "create",
          "--interactive",
          "bun",
          "--no-env-file",
          "-e",
          "console.log('source')",
        ],
        {
          cwd: root,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            DOCKER_CONFIG: root,
            DOCKER_CONTEXT: "default",
            DOCKER_HOST: "",
            DOCKER_TLS_VERIFY: "",
            DOCKER_CERT_PATH: "",
            BUILDX_BUILDER: "",
            BUILDKIT_HOST: "",
            PATH: path.dirname(result.executable.path),
            TEMP: root,
            TMP: root,
          },
        },
      )
      child.stdin.write("own stdin")
      await child.stdin.end()
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ exit, stdout, stderr }).toEqual({ exit: 7, stdout: "", stderr: "own stderr" })
      expect(calls).toEqual([
        {
          argv: ["container", "create", "--interactive", "bun", "--no-env-file", "-e", "console.log('source')"],
          stdin: "own stdin",
        },
      ])
    } finally {
      await bridge.close()
      await fs.rm(root, { recursive: true })
    }
  },
  // Three separately bounded 120s compiler processes plus cold module loading.
  390000,
)
