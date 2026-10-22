import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text, sha256Bytes } from "../../src/hash"
import { fileIdentity } from "../../src/sandbox/storage"
import { decodeHostManifest, requestOf } from "../../src/sandbox/contracts"
import { inspectLinuxHost, openLinuxSession } from "../../src/sandbox/preflight"
import { makeDockerRunner } from "../../src/sandbox/docker"
import { makeStorageProbe } from "../../src/sandbox/storage-source"
import { startProductionCommandBridge } from "../../src/sandbox/production-command-bridge"
import { buildProductionDockerExecutable } from "../../src/sandbox/public-mcp-build"
import { makeNativeAttestedWsl2Transport } from "../../src/sandbox/wsl2-independent"

test.skipIf(process.env.TASK24_PRODUCTION_WSL_LIVE !== "1")(
  "original production owned command launcher and coding check envelope run through the finite WSL bridge",
  async () => {
    const configFile = process.env.TASK24_WSL_BRIDGE_LIVE_CONFIG!
    expect(configFile.startsWith(process.env.TMPDIR! + path.sep)).toBe(true)
    const config = JSON.parse(await fs.readFile(configFile, "utf8"))
    const manifest = decodeHostManifest(config.manifest)
    const request = requestOf(manifest)
    const runner = makeDockerRunner({ request })
    const inventory = await inspectLinuxHost({
      request,
      runner,
      storageProbe: makeStorageProbe({ request, source: config.storageSource }),
    })
    expect(inventory.missing).toEqual([])
    const opened = openLinuxSession({ manifest, approval: config.approval, inventory })
    expect(opened.kind).toBe("ready")
    if (opened.kind !== "ready") throw Error("live session blocked")
    const session = opened.value
    const trusted = makeDockerRunner({ request, session, guard: async () => {} })
    const { WorkflowCommandSandboxServer } = await import("../../../server/src/workflow/command-sandbox")
    const { Docker } = await import("../../../server/src/workflow/docker")
    const { DockerConfig } = await import("../../../server/src/workflow/docker-config")
    const { CodingCheckLauncher } = await import("../../../server/src/workflow/coding-check-launcher")
    const { WorkflowWorkspaceMaterialization } = await import("../../../core/src/workflow/workspace-materialization")
    expect(typeof WorkflowCommandSandboxServer.runOwned).toBe("function")
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "production-live-"))
    const code =
      'import { test, expect } from "bun:test";test("real sealed production addition",()=>expect(2+3).toBe(5))'
    const archive = await WorkflowWorkspaceMaterialization.seal(
      [{ path: "sum.test.ts", type: "file", size: Buffer.byteLength(code), sha256: sha256Text(code) }],
      async () => Buffer.from(code),
    )
    const payload = JSON.stringify(archive)
    const argv = [
      "bun",
      "--no-env-file",
      "-e",
      CodingCheckLauncher.source({
        argv: ["bun", "--no-env-file", "test"],
        id: "test",
        timeoutMs: 30000,
        workspace: { cwd: ".", inputBytes: Buffer.byteLength(payload), inputSha256: sha256Text(payload) },
      }),
    ]
    const actualImage = manifest.artifacts.find((a) => a.id === "linux-runtime")!.image!
    const publicImage = "opencode-task24/runtime@" + actualImage.split("@")[1]
    const candidate = await fs.mkdtemp(path.join(manifest.roots.work, "production-readonly-"))
    await fs.writeFile(path.join(candidate, "sum.test.ts"), code)
    const readonlySource = `const fs=require('fs');if(!fs.readFileSync('/workspace/sum.test.ts','utf8').includes('real sealed production addition'))process.exit(7);try{fs.writeFileSync('/workspace/sum.test.ts','forbidden');process.exit(8)}catch(e){if(e.code!=='EROFS'&&e.code!=='EACCES')throw e}console.log('readonly-real')`
    const readonlyArgv = ["node", "-e", readonlySource]
    const tar = WorkflowWorkspaceMaterialization.tarBytes(archive)
    const bridge = await startProductionCommandBridge({
      session,
      runner: trusted,
      guard: async () => {},
      commands: [
        { image: actualImage, publicImage, argv, workdir: "/", interactive: true, stdin: Buffer.from(payload) },
        {
          image: actualImage,
          publicImage,
          argv: readonlyArgv,
          workdir: "/workspace",
          workspace: { source: candidate, readonly: true },
        },
        {
          image: actualImage,
          publicImage,
          argv: readonlyArgv,
          workdir: "/workspace",
          archiveSha256: sha256Bytes(tar),
          sealedArchive: archive,
        },
      ],
    })
    let settled = false
    try {
      const packaged = await buildProductionDockerExecutable({
        outputRoot: path.join(root, "engine"),
        connection: {
          host: bridge.host,
          port: bridge.port,
          capability: bridge.capability,
          expiresAt: Date.now() + 600000,
        },
      })
      const dockerConfig = path.join(root, "config"),
        temp = path.join(root, "temp")
      await fs.mkdir(dockerConfig)
      await fs.mkdir(temp)
      const validated = await DockerConfig.validate({
        enginePath: packaged.executable.path,
        image: publicImage,
        dockerConfig,
        temp,
        limits: DockerConfig.defaults,
      })
      const labels = Object.fromEntries(
        ["workflow", "stage", "call", "role", "policy", "session", "agent", "lease"].map((key) => [
          "io.opencode.workflow." + key,
          sha256Text(root + key),
        ]),
      )
      let finalGates = 0
      const engine = {
        async execute(value: Parameters<typeof Docker.production.execute>[0]) {
          const result = await Docker.production.execute(value)
          if (result.exit !== 0)
            console.error("own production diagnostic", value.argv.slice(0, 2), result.exit, result.stderr)
          return result
        },
      }
      const result = await WorkflowCommandSandboxServer.runOwned(
        engine,
        validated,
        { role: "test", argv, stdin: payload, disposableCodingWorkspace: true },
        {
          workspace: { canonical: "", device: 0, inode: 0 },
          workdir: { canonical: "", device: 0, inode: 0 },
          relativeWorkdir: ".",
        },
        { name: "ocw-" + sha256Text(root).slice(0, 48), labels },
        new AbortController().signal,
        async () => {
          finalGates++
        },
        archive,
      )
      expect(result.exit).toBe(0)
      expect(result.truncated).toBe(false)
      const envelope = CodingCheckLauncher.decode(result.output, result.exit)
      expect(envelope.exitCode).toBe(0)
      expect(envelope.report).toContain("real sealed production addition")
      expect(finalGates).toBe(1)
      const paths = {
        workspace: { canonical: candidate, device: 0, inode: 0 },
        workdir: { canonical: candidate, device: 0, inode: 0 },
        relativeWorkdir: ".",
      }
      for (const [kind, snapshot] of [
        ["readonly-bind", undefined],
        ["sealed-tar", archive],
      ] as const) {
        const result = await WorkflowCommandSandboxServer.runOwned(
          engine,
          validated,
          { role: "test", argv: readonlyArgv },
          paths,
          { name: "ocw-" + sha256Text(root + kind).slice(0, 48), labels },
          new AbortController().signal,
          async () => {
            finalGates++
          },
          snapshot,
        )
        expect(result).toEqual({ exit: 0, output: "readonly-real\n", truncated: false })
      }
      expect(await fs.readFile(path.join(candidate, "sum.test.ts"), "utf8")).toBe(code)
      await bridge.close()
      settled = true
      const evidence = {
        scope: "production-command-and-coding-launcher-only-not-full-A-or-readiness",
        providerCalls: 0,
        engineID: inventory.engine!.serverID,
        manifestSha256: session.manifestSha256,
        shim: packaged.executable,
        launcher: await fileIdentity(path.resolve("../server/src/workflow/command-sandbox.ts")),
        result: { exit: result.exit, truncated: result.truncated, reportSha256: sha256Text(envelope.report!) },
        finalGates,
        cases: ["sealed-coding-envelope", "readonly-bind", "sealed-tar-import"],
        cleanup: "verified-owned-containers-removed",
      }
      await fs.writeFile(
        path.join(process.env.TMPDIR!, path.basename(root) + "-evidence.json"),
        canonicalJson(evidence),
        { flag: "wx" },
      )
    } finally {
      await bridge.close()
      if (settled && root.startsWith(process.env.TMPDIR! + path.sep)) await fs.rm(root, { recursive: true })
      if (settled && candidate.startsWith(manifest.roots.work + path.sep)) await fs.rm(candidate, { recursive: true })
    }
  },
  120000,
)

test.skipIf(process.env.TASK24_PRODUCTION_WSL_LIVE !== "1")(
  "fresh same-invocation WSL proof rejects a stale storage binding without creating resources",
  async () => {
    const config = JSON.parse(await fs.readFile(process.env.TASK24_WSL_BRIDGE_LIVE_CONFIG!, "utf8"))
    const request = requestOf(decodeHostManifest(config.manifest))
    const runner = makeNativeAttestedWsl2Transport(request, {
      ...config.manifest.storage,
      settingsSha256: "f".repeat(64),
    })
    await expect(
      runner.execute({
        argv: ["info", "--format", "{{json .}}"],
        timeoutMs: 5000,
        maxStdoutBytes: 1048576,
        maxStderrBytes: 65536,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("FRAME")
  },
  15000,
)
