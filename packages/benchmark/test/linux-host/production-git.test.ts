import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { sha256Bytes } from "../../src/hash"
import { openProductionGit } from "../../src/sandbox/production-git"
import { startProductionCommandEndpoint } from "../../src/sandbox/production-command-http"
import { WorkflowBenchmarkGit } from "../../../core/src/workflow/benchmark-git"
import { WorkflowBenchmarkTransport } from "../../../core/src/workflow/benchmark-transport"

test.skipIf(process.platform !== "win32")(
  "finite Git transport captures real changed trees using private configuration, refuses escapes and shares the existing port",
  async () => {
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "production-git-"))
    const workspace = path.join(root, "repo"),
      snapshotsRoot = path.join(root, "snapshots")
    for (const dir of [workspace, snapshotsRoot]) await fs.mkdir(dir)
    const gitPath = "C:\\Program Files\\Git\\mingw64\\bin\\git.exe"
    const gitSha256 = sha256Bytes(await fs.readFile(gitPath))
    const run = async (args: string[]) => {
      const child = Bun.spawn([gitPath, ...args], {
        cwd: workspace,
        env: {
          SystemRoot: "C:\\Windows",
          PATH: "C:\\Windows\\System32",
          HOME: root,
          USERPROFILE: root,
          TEMP: root,
          TMP: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: path.join(root, "empty-config"),
          GIT_TERMINAL_PROMPT: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
      return stdout
    }
    await fs.writeFile(path.join(root, "empty-config"), "")
    await fs.writeFile(path.join(workspace, "index.html"), "<main>seed</main>")
    await run(["init", "--quiet"])
    await run(["add", "index.html"])
    await run([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost.invalid",
      "-c",
      "core.hooksPath=" + path.join(root, "no-hooks"),
      "commit",
      "--quiet",
      "-m",
      "seed",
    ])
    let delay: Promise<void> | undefined
    let onDelay: (() => void) | undefined
    const host = await openProductionGit({
      workspace,
      snapshotsRoot,
      cacheRoot: path.join(root, "private"),
      git: { path: gitPath, sha256: gitSha256 },
      states: [
        [{ path: "index.html", bytes: Buffer.from("<main>seed</main>") }],
        [{ path: "index.html", bytes: Buffer.from("<main>fixed</main>") }],
      ],
      guard: async () => {
        if (delay) {
          onDelay?.()
          await delay
        }
      },
    })
    const endpoint = await startProductionCommandEndpoint(
      {
        execute: async () => {
          throw Error("not a Git route")
        },
        outstanding: () => ({ containers: [], uncertainNames: [] }),
      },
      { git: host },
    )
    async function call(argv: string[], stdin?: string, cwd = workspace, extra = {}) {
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/task24/production-git`, {
        method: "POST",
        proxy: "",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capability: endpoint.capability,
          cwd,
          argv,
          ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin).toString("base64") }),
          ...extra,
        }),
      })
      return {
        status: response.status,
        body: (await response.json()) as { exit: number; stdout: string; stderr: string },
      }
    }
    try {
      const top = await call(["rev-parse", "--show-toplevel"])
      expect(top).toMatchObject({ status: 200, body: { exit: 0 } })
      expect(Buffer.from(top.body.stdout, "base64").toString().trim().replaceAll("/", "\\")).toBe(workspace)
      const worktrees = await call(["worktree", "list", "--porcelain"])
      expect(worktrees.status).toBe(200)
      expect(Buffer.from(worktrees.body.stdout, "base64").toString().replaceAll("/", "\\")).toContain(
        "worktree " + workspace,
      )
      const readonlyPrefix = [
        "--no-optional-locks",
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.longpaths=true",
        "-c",
        "core.symlinks=true",
        "-c",
        "core.quotepath=false",
      ]
      const branch = await call([...readonlyPrefix, "symbolic-ref", "--quiet", "--short", "HEAD"])
      expect(branch.status).toBe(200)
      expect(Buffer.from(branch.body.stdout, "base64").toString().trim()).not.toBe("")
      const data = path.join(root, "data")
      await fs.mkdir(data)
      const profile = {
        schemaVersion: 1,
        campaignID: "git-test",
        runID: "git-test",
        brokerOrigin: `http://127.0.0.1:${endpoint.port}`,
        providerPaths: { kimi: "/v1/kimi", deepseek: "/v1/deepseek" },
        evidenceMode: "production",
        expiresAt: Date.now() + 60000,
        grant: "g".repeat(64),
      }
      const binding = WorkflowBenchmarkTransport.freezeProfile({
        authority: "server",
        profile,
        expectedCampaignID: profile.campaignID,
        expectedRunID: profile.runID,
      })
      const transport = path.join(data, "benchmark-transport.json"),
        connection = path.join(data, "benchmark-host.json")
      await fs.writeFile(transport, JSON.stringify(profile), { flag: "wx" })
      await fs.writeFile(
        connection,
        JSON.stringify({
          schemaVersion: 1,
          campaignID: binding.campaignID,
          runID: binding.runID,
          bindingSha256: binding.bindingSha256,
          host: endpoint.host,
          port: endpoint.port,
          capability: endpoint.capability,
          expiresAt: profile.expiresAt,
          enginePath: path.join(root, "docker.exe"),
        }),
        { flag: "wx" },
      )
      const environment = {
        OPENCODE_BENCHMARK_HOST_FILE: connection,
        OPENCODE_BENCHMARK_RUN_DATA_ROOT: data,
        OPENCODE_BENCHMARK_TRANSPORT_FILE: transport,
        OPENCODE_BENCHMARK_CAMPAIGN_ID: profile.campaignID,
        OPENCODE_BENCHMARK_RUN_ID: profile.runID,
        OPENCODE_WORKFLOW_SANDBOX_ENGINE: path.join(root, "docker.exe"),
      }
      expect(WorkflowBenchmarkGit.load({ OPENCODE_BENCHMARK_RUN_DATA_ROOT: "C:\\must-not-read" })).toBeUndefined()
      const client = WorkflowBenchmarkGit.load(environment)!
      const discovery = await client.execute(
        { cwd: workspace, argv: ["rev-parse", "--show-toplevel"] },
        new AbortController().signal,
      )
      expect(discovery.exit).toBe(0)
      expect(discovery.stdout.toString().trim().replaceAll("/", "\\")).toBe(workspace)
      const processModule = path.resolve(import.meta.dir, "../../../core/src/process.ts").replaceAll("\\", "/")
      const layerModule = path.resolve(import.meta.dir, "../../../core/src/effect/layer-node.ts").replaceAll("\\", "/")
      const child = async (options: object) => {
        const script = `import {Effect,Exit} from 'effect';import {ChildProcess} from 'effect/unstable/process';import {AppProcess} from ${JSON.stringify(processModule)};import {LayerNode} from ${JSON.stringify(layerModule)};const result=await Effect.runPromise(Effect.gen(function*(){const proc=yield* AppProcess.Service;const exit=yield* Effect.exit(proc.run(ChildProcess.make('git',['rev-parse','--show-toplevel'],{cwd:${JSON.stringify(workspace)}}),${JSON.stringify(options)}));if(Exit.isFailure(exit))return {failed:true};const r=exit.value;return {failed:false,stdout:r.stdout.toString(),stderr:r.stderr.toString(),stdoutTruncated:r.stdoutTruncated,stderrTruncated:r.stderrTruncated}}).pipe(Effect.provide(LayerNode.compile(AppProcess.node))));process.stdout.write(JSON.stringify(result))`
        const process = Bun.spawn([globalThis.process.execPath, "--no-env-file", "--no-install", "--eval", script], {
          cwd: path.resolve(import.meta.dir, "../.."),
          env: { ...globalThis.process.env, ...environment },
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        })
        const [exit, out, err] = await Promise.all([
          process.exited,
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
        ])
        expect({ exit, err }).toEqual({ exit: 0, err: "" })
        return JSON.parse(out)
      }
      const bounded = await child({ maxOutputBytes: 3, maxErrorBytes: 2 })
      const unsupported = await child({ combineOutput: true })
      let release!: () => void
      delay = new Promise<void>((resolve) => {
        release = resolve
      })
      onDelay = () => {
        onDelay = undefined
        setTimeout(release, 500)
      }
      let timed
      try {
        timed = await child({ timeout: "20 millis" })
      } finally {
        release()
        delay = undefined
        onDelay = undefined
      }
      expect({ bounded, unsupported, timed }).toEqual({
        bounded: {
          failed: false,
          stdout: workspace.replaceAll("\\", "/").slice(0, 3),
          stderr: "",
          stdoutTruncated: true,
          stderrTruncated: false,
        },
        unsupported: { failed: true },
        timed: { failed: true },
      })
      const store = path.join(snapshotsRoot, "project", "worktree")
      await fs.mkdir(store, { recursive: true })
      const prefix = ["--git-dir", store, "--work-tree", workspace]
      expect((await call([...prefix, "init"])).body.exit).toBe(0)
      expect(
        (
          await call(
            [...prefix, "add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"],
            "index.html\0",
          )
        ).body.exit,
      ).toBe(0)
      const before = await call([...prefix, "write-tree"])
      const beforeID = Buffer.from(before.body.stdout, "base64").toString().trim()
      expect(beforeID).toMatch(/^[a-f0-9]{40}$/)
      await fs.writeFile(path.join(workspace, "index.html"), "<main>fixed</main>")
      expect(
        (
          await call(
            [...prefix, "add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"],
            "index.html\0",
          )
        ).body.exit,
      ).toBe(0)
      const after = await call([...prefix, "write-tree"])
      const afterID = Buffer.from(after.body.stdout, "base64").toString().trim()
      expect(afterID).not.toBe(beforeID)
      const changed = await call([...prefix, "diff", "--name-only", "-z", beforeID, afterID])
      expect(Buffer.from(changed.body.stdout, "base64").toString()).toBe("index.html\0")
      const blob = await call([...prefix, "show", afterID + ":index.html"])
      expect(Buffer.from(blob.body.stdout, "base64").toString()).toBe("<main>fixed</main>")
      // Corrupting the agent-writable Git config must not execute a hook/filter or affect the private store.
      await fs.writeFile(
        path.join(store, "config"),
        "[core]\n hooksPath = C:/untrusted\n[include]\n path = C:/private\n",
      )
      expect((await call([...prefix, "write-tree"])).body.stdout).toBe(after.body.stdout)
      for (const [argv, stdin, cwd, extra] of [
        [["fetch", "https://example.invalid"], undefined, workspace, {}],
        [["-c", "core.fsmonitor=evil", "status"], undefined, workspace, {}],
        [["rev-parse", "--show-toplevel"], undefined, root, {}],
        [["--git-dir", path.join(root, "outside"), "--work-tree", workspace, "init"], undefined, workspace, {}],
        [
          [...prefix, "add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"],
          "../private\0",
          workspace,
          {},
        ],
        [["rev-parse", "--show-toplevel"], undefined, workspace, { environment: { SECRET: "forbidden" } }],
      ] as const)
        expect((await call([...argv], stdin, cwd, extra)).status).toBe(403)
      await fs.writeFile(path.join(workspace, "index.html"), "not a frozen public state")
      expect((await call([...prefix, "write-tree"])).status).toBe(403)
      await fs.appendFile(connection, " ")
      await expect(
        client.execute({ cwd: workspace, argv: ["rev-parse", "--show-toplevel"] }, new AbortController().signal),
      ).rejects.toThrow("TASK24_BENCHMARK_GIT_STALE")
    } finally {
      await endpoint.close()
      expect(await fs.readdir(root)).not.toContain("private")
      if ((await fs.realpath(root)) === root && path.dirname(root) === process.env.TMPDIR)
        await fs.rm(root, { recursive: true })
    }
  },
)
