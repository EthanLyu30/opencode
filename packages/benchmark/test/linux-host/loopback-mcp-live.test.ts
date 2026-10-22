import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { fileIdentity } from "../../src/sandbox/storage"
import { runWindowsSandbox } from "../../src/sandbox/host-isolation/windows"
import { startPublicToolLoopback } from "../../src/sandbox/mcp-server"
import { buildPublicMcpExecutable } from "../../src/sandbox/public-mcp-build"
import { makePublicToolHost } from "../../src/sandbox/public-tools"
import { sha256Text } from "../../src/hash"
import { orchestratorFixture } from "../independent/fixture"

test.skipIf(process.platform !== "win32" || process.env.TASK24_WINDOWS_ISOLATION_LIVE !== "1")(
  "real restricted MCP uses production CAS writes and enforces the readonly transition",
  async () => {
    const parent = process.env.TMPDIR!
    const owner = JSON.parse(await fs.readFile(path.join(parent, "owner.json"), "utf8"))
    if (owner.nonce !== "bprep2-0786b1f11abc") throw Error("fixture owner")
    const fixture = await orchestratorFixture()
    const root = await fs.mkdtemp(path.join(parent, "mcp-live-"))
    const identity = await fs.lstat(root, { bigint: true })
    const work = path.join(root, "work"),
      runtime = path.join(root, "runtime"),
      control = path.join(root, "control")
    for (const directory of [work, runtime, control]) await fs.mkdir(directory)
    await fs.mkdir(path.join(work, "src"))
    await fs.writeFile(path.join(work, "src/math.js"), "wrong")
    await fs.writeFile(path.join(work, "package.json"), '{"private":true,"type":"module"}')
    await fs.writeFile(path.join(work, "bunfig.toml"), 'preload = ["./must-not-load.js"]')
    await fs.writeFile(path.join(work, "must-not-load.js"), 'throw Error("PROJECT_PRELOAD_MUST_NOT_RUN")')
    const denied = async () => {
      throw Error("unused method, not a real build or browser acceptance")
    }
    let readonly = false
    let writeFailure: unknown
    let directoryPinned = false
    const tools = makePublicToolHost({
      workspace: work,
      profile: fixture.input.bundle.profile,
      maxCalls: 20,
      guard: async () => {},
      backend: { check: denied, preview: denied, capture: denied },
    })
    const bridge = await startPublicToolLoopback({
      host: {
        ...tools,
        async write(raw) {
          if (readonly) throw Error("TASK24_PUBLIC_READONLY")
          try {
            await fs.rename(path.join(work, "src"), path.join(work, "moved"))
          } catch (error) {
            directoryPinned =
              (error as NodeJS.ErrnoException).code === "EBUSY" || (error as NodeJS.ErrnoException).code === "EPERM"
          }
          if (!directoryPinned) throw Error("mediated ancestry was not sealed")
          try {
            return await tools.write(raw)
          } catch (error) {
            writeFailure = error
            throw error
          }
        },
      },
    })
    let cleanup = true
    try {
      const packaged = await buildPublicMcpExecutable({ outputRoot: path.join(runtime, "packaged") })
      const helper = packaged.executable.path
      async function invoke(requests: readonly { name: string; arguments: unknown }[]) {
        cleanup = false
        const result = await runWindowsSandbox({
          executable: await fileIdentity(helper),
          argv: ["--loopback", String(bridge.port)],
          cwd: work,
          readonly: [runtime],
          mediated: [work],
          writable: [],
          root: control,
          ports: [bridge.port],
          environment: { TASK24_PUBLIC_TOOL_CAPABILITY: bridge.capability },
          stdin: Buffer.from(
            [
              {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "own", version: "1" } },
              },
              { jsonrpc: "2.0", method: "notifications/initialized" },
              ...requests.map((params, i) => ({ jsonrpc: "2.0", id: i + 2, method: "tools/call", params })),
            ]
              .map((request) => JSON.stringify(request) + "\n")
              .join(""),
          ),
          timeoutMs: 15000,
          maxStdoutBytes: 1048576,
          maxStderrBytes: 65536,
          signal: new AbortController().signal,
        })
        cleanup = result.containment.cleanupCompleted && !result.execution.cleanupUncertain
        expect({
          exit: result.execution.exitCode,
          stderr: Buffer.from(result.execution.stderr).toString("utf8"),
        }).toEqual({ exit: 0, stderr: "" })
        expect(result.containment).toMatchObject({
          appContainer: true,
          processTreeEnded: true,
          persistentPolicyRetired: true,
          cleanupCompleted: true,
        })
        return Buffer.from(result.execution.stdout)
          .toString("utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      }
      const changed = await invoke([
        { name: "write", arguments: { path: "src/math.js", baseSha256: sha256Text("wrong"), content: "correct-设计" } },
      ])
      expect({ writeFailure, response: changed.find((line) => line.id === 2).result.isError }).toEqual({
        writeFailure: undefined,
        response: undefined,
      })
      expect(JSON.parse(changed.find((line) => line.id === 2).result.content[0].text)).toEqual({
        sha256: sha256Text("correct-设计"),
        bytes: Buffer.byteLength("correct-设计"),
      })
      expect(await fs.readFile(path.join(work, "src/math.js"), "utf8")).toBe("correct-设计")
      readonly = true
      const readback = await invoke([
        {
          name: "write",
          arguments: { path: "src/math.js", baseSha256: sha256Text("correct-设计"), content: "must-not-write" },
        },
        { name: "read", arguments: { path: "src/math.js", offset: 0, length: 64 } },
      ])
      expect(readback.find((line) => line.id === 2).result.isError).toBe(true)
      expect(JSON.parse(readback.find((line) => line.id === 3).result.content[0].text).text).toBe("correct-设计")
      expect(await fs.readFile(path.join(work, "src/math.js"), "utf8")).toBe("correct-设计")
      expect(tools.journal().writtenPaths).toEqual(["src/math.js"])
      expect(directoryPinned).toBe(true)
      cleanup = false
      const file = path.join(work, "src/math.js")
      const probe = await runWindowsSandbox({
        executable: await fileIdentity(process.execPath),
        argv: [
          "--no-env-file",
          "-e",
          `const fs=require('fs');const blocked=f=>{try{f();return false}catch(e){return e.code==='EACCES'||e.code==='EPERM'||e.code==='EBUSY'}};console.log(JSON.stringify({text:fs.readFileSync(${JSON.stringify(file)},'utf8'),writeDenied:blocked(()=>fs.writeFileSync(${JSON.stringify(file)},'bad')),createDenied:blocked(()=>fs.writeFileSync(${JSON.stringify(path.join(work, "new"))},'bad')),deleteDenied:blocked(()=>fs.unlinkSync(${JSON.stringify(file)})),renameDenied:blocked(()=>fs.renameSync(${JSON.stringify(file)},${JSON.stringify(path.join(work, "moved-file"))}))}));`,
        ],
        cwd: work,
        readonly: [],
        mediated: [work],
        writable: [],
        root: control,
        ports: [],
        timeoutMs: 10000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        signal: new AbortController().signal,
      })
      cleanup = probe.containment.cleanupCompleted && !probe.execution.cleanupUncertain
      expect({ exit: probe.execution.exitCode, stderr: Buffer.from(probe.execution.stderr).toString("utf8") }).toEqual({
        exit: 0,
        stderr: "",
      })
      expect(JSON.parse(Buffer.from(probe.execution.stdout).toString("utf8"))).toEqual({
        text: "correct-设计",
        writeDenied: true,
        createDenied: true,
        deleteDenied: true,
        renameDenied: true,
      })
      expect(await fs.readFile(file, "utf8")).toBe("correct-设计")
      expect(packaged.record.compile).toEqual({
        autoloadDotenv: false,
        autoloadBunfig: false,
        autoloadPackageJson: false,
        autoloadTsconfig: false,
      })
    } finally {
      await bridge.close()
      await fixture.dispose()
      if (cleanup) {
        const current = await fs.lstat(root, { bigint: true })
        if (
          (await fs.realpath(root)) !== root ||
          current.dev !== identity.dev ||
          current.ino !== identity.ino ||
          current.birthtimeNs !== identity.birthtimeNs ||
          path.dirname(root) !== parent
        )
          throw Error("own cleanup identity")
        await fs.rm(root, { recursive: true })
      }
    }
  },
  120000,
)
