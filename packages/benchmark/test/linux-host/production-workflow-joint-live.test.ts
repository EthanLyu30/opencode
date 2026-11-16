import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { WorkflowRoleContract } from "../../../core/src/workflow/execution/contract"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text, sha256Bytes } from "../../src/hash"
import { fileIdentity } from "../../src/sandbox/storage"
import { decodeHostManifest, requestOf } from "../../src/sandbox/contracts"
import { inspectLinuxHost, openLinuxSession, revalidateSession } from "../../src/sandbox/preflight"
import { makeDockerRunner } from "../../src/sandbox/docker"
import { makeStorageProbe } from "../../src/sandbox/storage-source"
import { openProductionWorkflowHost } from "../../src/sandbox/production-workflow-host"
import { startFixtureCapabilityProvider, type FixtureReply } from "../../src/sandbox/fixture-provider"
import { prepareWorkflowArm } from "../../src/arms/workflow"
import { WorkflowWorkspaceMaterialization } from "../../../core/src/workflow/workspace-materialization"
import { CodingCheckLauncher } from "../../../server/src/workflow/coding-check-launcher"
import { DockerConfig } from "../../../server/src/workflow/docker-config"
import { BenchmarkAclProbe } from "../../../server/src/workflow/benchmark-acl-probe"
import { identity, independentFixture } from "../independent/fixture"
import { withAclAuthorityFixture } from "./acl-authority-fixture"
import { markPluginDependenciesReady } from "../../../opencode/test/fixture/plugin"
import { makeLinuxBrowser } from "../../src/sandbox/browser"
import { loadBrowserRelease } from "../../src/evaluator/browser-runtime"
import { FIXED_VIEWPORTS } from "../../src/evaluator/browser-protocol"
import {
  attachBrowserIsolationDispatch,
  loadHostIsolationAdapter,
  makeBrowserIsolationRunner,
  type HostIsolationAdapter,
} from "../../src/sandbox/capability"
import { createWindowsBrowserDispatch } from "../../src/sandbox/host-isolation/windows-browser-dispatch"

function chat(
  role: string,
  payload: unknown,
  verdict = "ready",
  tool?: { id: string; name: string; input: unknown },
): FixtureReply {
  if (role === "design" && payload && typeof payload === "object" && "spec" in payload)
    Schema.decodeUnknownSync(WorkflowRoleContract.DesignPayload)(payload)
  if (role === "decompose") Schema.decodeUnknownSync(WorkflowRoleContract.DecomposePayload)(payload)
  if (role === "visual_review") Schema.decodeUnknownSync(WorkflowRoleContract.VisualPayload)(payload)
  return {
    protocol: "chat_completions",
    model: "kimi-k3",
    events: [
      {
        data: {
          id: "chat_joint",
          choices: [
            {
              index: 0,
              delta: tool
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: tool.id,
                        type: "function",
                        function: { name: tool.name, arguments: JSON.stringify(tool.input) },
                      },
                    ],
                  }
                : {
                    role: "assistant",
                    content: JSON.stringify({
                      contractVersion: 1,
                      outcome: { schemaVersion: 1, role, revision: 0, verdict },
                      payload,
                    }),
                  },
              finish_reason: tool ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      },
    ],
  }
}
function responses(role: string, verdict: string, tool?: { id: string; name: string; input: unknown }): FixtureReply {
  const text = JSON.stringify({
    contractVersion: 1,
    outcome: { schemaVersion: 1, role, revision: 0, verdict },
    payload: { summary: "Recorded " + role },
  })
  const item = tool
    ? {
        type: "function_call",
        id: "fc_" + tool.id,
        call_id: tool.id,
        name: tool.name,
        arguments: JSON.stringify(tool.input),
        status: "completed",
      }
    : {
        type: "message",
        id: "msg_joint",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      }
  const events = [
    { type: "response.created", response: { id: "resp_joint", status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: tool ? { ...item, arguments: "", status: "in_progress" } : { ...item, content: [], status: "in_progress" },
    },
    ...(tool
      ? [
          {
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            output_index: 0,
            delta: JSON.stringify(tool.input),
          },
          {
            type: "response.function_call_arguments.done",
            item_id: item.id,
            output_index: 0,
            arguments: JSON.stringify(tool.input),
          },
        ]
      : [{ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text }]),
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_joint",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]
  return {
    protocol: "responses",
    model: role === "test" ? "deepseek-v4-flash" : "deepseek-v4-pro",
    events: events.map((event, sequence_number) => ({ event: event.type, data: { ...event, sequence_number } })),
  }
}

test.skipIf(process.platform !== "win32" || process.env.TASK24_A_JOINT_LIVE !== "1")(
  "A genuine production workflow and readonly review earn native execution and retirement evidence",
  async () => {
    const started = Date.now()
    const diagnostic = (phase: string, extra: object = {}) =>
      console.info(JSON.stringify({ diagnosticOnly: true, phase, elapsedMs: Date.now() - started, ...extra }))
    const configFile = process.env.TASK24_A_JOINT_CONFIG!
    if (!configFile.startsWith(process.env.TMPDIR! + path.sep)) throw Error("TASK24_JOINT_CONFIG_ROOT")
    const config = JSON.parse(await fs.readFile(configFile, "utf8"))
    const kind = config.kind === "visual" ? "visual" : "coding"
    for (const file of config.sourceIdentities) expect(await fileIdentity(file.path)).toEqual(file)
    const manifest = decodeHostManifest(config.manifest),
      request = requestOf(manifest)
    expect((await fileIdentity(fileURLToPath(import.meta.url))).sha256).toBe(manifest.testSha256)
    const inventory = await inspectLinuxHost({
      request,
      runner: makeDockerRunner({ request }),
      storageProbe: makeStorageProbe({ request, source: config.storageSource }),
    })
    expect(inventory.missing).toEqual([])
    const opened = openLinuxSession({ manifest, approval: config.approval, inventory })
    if (opened.kind !== "ready") throw Error("TASK24_JOINT_SESSION")
    const session = opened.value,
      runner = makeDockerRunner({
        request,
        session,
        guard: async () => {
          await revalidateSession(session)
        },
      })
    const artifact = (id: string) => {
      const file = manifest.artifacts.find((file) => file.id === id)
      if (!file?.path) throw Error("TASK24_JOINT_ARTIFACT")
      return file.path
    }
    const binary = await fileIdentity(artifact("modified")),
      engine = await fileIdentity(artifact("production-engine"))
    const models = JSON.parse(await fs.readFile(artifact("benchmark-models"), "utf8"))
    const code = "export const sum = (a: number, b: number) => a + b\n"
    const seed =
      kind === "coding"
        ? "export const sum = (a: number, b: number) => a - b\n"
        : "<!doctype html><html><body><main>Seed page</main></body></html>"
    const correct =
      kind === "coding"
        ? code
        : '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Implemented</title></head><body><main>Implemented page</main></body></html>'
    const reference =
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reference</title></head><body><main>Reference page</main></body></html>'
    const sourcePath = kind === "coding" ? "sum.ts" : "index.html"
    const tests =
      'import { expect, test } from "bun:test"\nimport { sum } from "./sum"\ntest("positive", () => expect(sum(2,3)).toBe(5))\ntest("negative", () => expect(sum(-2,3)).toBe(1))\n'
    const files = (source: string) => [
      { path: "package.json", bytes: Buffer.from('{"private":true,"type":"module"}') },
      { path: "sum.test.ts", bytes: Buffer.from(tests) },
      { path: "sum.ts", bytes: Buffer.from(kind === "coding" ? source : code) },
      ...(kind === "visual" ? [{ path: "index.html", bytes: Buffer.from(source) }] : []),
    ]
    const archive = await WorkflowWorkspaceMaterialization.seal(
      files(correct).map((file) => ({
        path: file.path,
        type: "file" as const,
        size: file.bytes.length,
        sha256: sha256Text(file.bytes.toString()),
      })),
      async (entry) => files(correct).find((file) => file.path === entry)!.bytes,
    )
    const payload = JSON.stringify(archive)
    const command =
      kind === "coding"
        ? [
            "bun",
            "--no-env-file",
            "-e",
            CodingCheckLauncher.source({
              argv: ["bun", "--no-env-file", "test"],
              id: "test",
              timeoutMs: Math.floor(DockerConfig.defaults.timeoutMs * 0.8),
              workspace: { cwd: ".", inputBytes: Buffer.byteLength(payload), inputSha256: sha256Text(payload) },
            }),
          ]
        : ["bun", "test"]
    const scripts =
      kind === "coding"
        ? [
            chat("design", {
              objective: "Repair sum",
              constraints: ["Keep tests and configuration unchanged"],
              interfaces: ["sum(a,b): number"],
              files: ["sum.ts"],
              risks: [],
              acceptanceCriteria: ["Both real tests pass"],
            }),
            chat("decompose", {
              acceptanceCriteria: ["Both real tests pass"],
              tasks: [
                {
                  id: "sum",
                  title: "Fix sum",
                  description: "Use addition",
                  files: ["sum.ts"],
                  dependsOn: [],
                  acceptanceCriteria: ["Positive and negative addition work"],
                },
              ],
            }),
            responses("implement", "ready", {
              id: "impl-write",
              name: "write",
              input: { path: "sum.ts", content: correct },
            }),
            responses("implement", "ready"),
            responses("test", "pass"),
            chat("code_review", {}, "pass", { id: "review-read", name: "read", input: { path: "sum.ts" } }),
            chat("code_review", { verdict: "pass", findings: [] }, "pass"),
            responses("deliver", "complete"),
            chat("design", {}, "ready", {
              id: "ro-write",
              name: "write",
              input: { path: "sum.ts", content: "forbidden" },
            }),
            chat("design", {}),
          ]
        : [
            chat("design", {
              spec: {
                schemaVersion: 1,
                goals: ["Render offline page"],
                routes: [{ path: "/", goal: "Show main" }],
                layoutConstraints: ["Keep main visible"],
                componentTree: [{ id: "root", component: "main", children: [] }],
                states: [{ name: "ready", description: "Page ready" }],
                typography: [{ token: "body", family: "sans-serif", weight: 400, sizePx: 16, lineHeight: 1.5 }],
                colors: [{ token: "background", value: "#ffffff" }],
                responsiveRules: Object.entries(FIXED_VIEWPORTS).map(([viewport, { width, height }]) => ({
                  viewport,
                  width,
                  height,
                  rules: ["Keep main visible"],
                })),
                accessibilityRules: ["Use semantic landmarks"],
                acceptanceCriteria: ["Main renders"],
                projectStack: ["HTML", "Bun"],
                referenceApp: {
                  entrypoint: "index.html",
                  readySelector: "main",
                  files: [{ path: "index.html", sha256: sha256Text(reference), size: Buffer.byteLength(reference) }],
                  viewports: Object.entries(FIXED_VIEWPORTS).map(([name, { width, height }]) => ({
                    name,
                    width,
                    height,
                  })),
                },
              },
              sources: [{ path: "index.html", content: reference }],
            }),
            chat("decompose", {
              acceptanceCriteria: ["Main renders"],
              tasks: [
                {
                  id: "page",
                  title: "Render page",
                  description: "Implement main",
                  files: ["index.html"],
                  dependsOn: [],
                  acceptanceCriteria: ["Main renders"],
                },
              ],
            }),
            responses("implement", "ready", {
              id: "impl-write",
              name: "write",
              input: { path: "index.html", content: correct },
            }),
            responses("implement", "ready"),
            responses("test", "pass"),
            chat("visual_review", { verdict: "pass", score: 100, findings: [] }, "pass"),
            responses("deliver", "complete"),
            chat("design", {}, "ready", {
              id: "ro-write",
              name: "write",
              input: { path: "index.html", content: "forbidden" },
            }),
            chat("design", {}),
          ]
    const provider = startFixtureCapabilityProvider(scripts)
    const profileFixture = await independentFixture("joint-profile")
    try {
      await withAclAuthorityFixture("D:\\OpenCode-Benchmark\\Task24\\workspaces", async (scope) => {
        const runRoot = path.join(scope.root, "run")
        const roots = {
          runRoot,
          ...Object.fromEntries(
            ["repo", "data", "config", "cache", "temp", "output"].map((name) => [name, path.join(runRoot, name)]),
          ),
        } as Parameters<typeof prepareWorkflowArm>[0]["roots"]
        for (const dir of Object.values(roots)) await fs.mkdir(dir, { recursive: true })
        const hostRoots = ["host-main", "host-readonly"].flatMap((name) => {
          const root = path.join(roots.data, name)
          return [
            root,
            ...["data", "runtime", "cache", "preview", "config", "temp"].map((name) => path.join(root, name)),
          ]
        })
        for (const dir of hostRoots) await fs.mkdir(dir)
        const prepare = Bun.spawn(
          [
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference='Stop';foreach($target in ($env:TASK24_OWN_ACL_ROOTS|ConvertFrom-Json)){$acl=New-Object System.Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false);$user=[Security.Principal.WindowsIdentity]::GetCurrent().User;foreach($sid in @($user,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),(New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))};[IO.Directory]::SetAccessControl($target,$acl)}",
          ],
          {
            env: {
              SystemRoot: "C:\\Windows",
              TEMP: scope.root,
              TMP: scope.root,
              TASK24_OWN_ACL_ROOTS: JSON.stringify(hostRoots),
            },
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
          },
        )
        expect(await Promise.all([prepare.exited, new Response(prepare.stderr).text()])).toEqual([0, ""])
        for (const dir of [
          roots.config,
          ...["host-main", "host-readonly"].map((name) => path.join(roots.data, name, "config", "opencode")),
        ])
          await markPluginDependenciesReady(dir)
        for (const file of files(seed)) await fs.writeFile(path.join(roots.repo, file.path), file.bytes, { flag: "wx" })
        for (const args of [
          ["init", "--quiet"],
          ["add", "."],
          [
            "-c",
            "user.name=Task24 fixture",
            "-c",
            "user.email=task24@localhost.invalid",
            "-c",
            "core.hooksPath=" + path.join(roots.temp, "no-hooks"),
            "commit",
            "--quiet",
            "-m",
            "public seed",
          ],
        ]) {
          const git = Bun.spawn(["C:\\Program Files\\Git\\cmd\\git.exe", "-c", "core.autocrlf=false", ...args], {
            cwd: roots.repo,
            env: process.env,
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
          })
          expect(await Promise.all([git.exited, new Response(git.stderr).text()])).toEqual([0, ""])
        }
        const base = await prepareWorkflowArm({
          armID: "A",
          campaignID: "joint-coding",
          runID: "joint-coding",
          roots,
          binary: {
            runtime: "modified",
            executable: binary.path,
            sha256: binary.sha256,
            version: config.binaryVersion,
          },
          prompt: "Fix sum.ts using the real tests. Keep configuration unchanged.",
          referenceFiles: [],
          brokerOrigin: provider.origin,
          brokerGrant: provider.grant,
          grantExpiresAt: Date.now() + (kind === "visual" ? 900000 : 300000),
          budget: {
            aggregateInputTokens: 20000,
            aggregateOutputTokens: 20000,
            maxToolCalls: 32,
            maxRetries: 1,
            maxDurationMs: kind === "visual" ? 600000 : 240000,
          },
        })
        const launch = {
          ...base,
          args: [
            ...base.args.slice(0, 3),
            "--kind",
            kind,
            ...base.args
              .slice(3)
              .filter(
                (_, i, args) =>
                  kind !== "coding" || (args[i] !== "--visual-budget" && args[i - 1] !== "--visual-budget"),
              ),
            "--print-logs",
            "--log-level",
            "DEBUG",
          ],
        }
        const profile = {
          ...profileFixture.profile,
          sourceEntry: "sum.ts",
          probeModules: ["sum.ts"],
          mutablePaths: ["sum.ts"],
          protectedPaths: ["package.json", "sum.test.ts"],
        }
        const profileSha256 = sha256Text(canonicalJson(profile))
        const data = {
          schemaVersion: 1,
          identity: identity({
            campaignID: "joint-coding",
            runID: "joint-coding",
            binarySha256: binary.sha256,
            profileSha256,
          }),
          image: manifest.artifacts.find((a) => a.id === "linux-runtime")!.image!,
          publicImage:
            "opencode-task24/runtime@" + manifest.artifacts.find((a) => a.id === "linux-runtime")!.image!.split("@")[1],
          readonlyToolCallID: "ro-write",
          commands: [
            kind === "coding"
              ? { argv: command, workdir: "/", interactive: true, stdinBase64: Buffer.from(payload).toString("base64") }
              : {
                  argv: command,
                  workdir: "/workspace",
                  sealedArchive: archive,
                  archiveSha256: sha256Bytes(WorkflowWorkspaceMaterialization.tarBytes(archive)),
                },
          ],
          previews:
            kind === "visual"
              ? [
                  {
                    entrypoint: "index.html",
                    root: "",
                    readySelector: "main",
                    files: [{ path: "index.html", contentBase64: Buffer.from(reference).toString("base64") }],
                  },
                  {
                    entrypoint: "index.html",
                    root: "",
                    readySelector: "main",
                    files: files(correct).map((f) => ({ path: f.path, contentBase64: f.bytes.toString("base64") })),
                  },
                ]
              : [],
          gitStates: [files(seed), files(correct)].map((state) =>
            state.map((f) => ({ path: f.path, contentBase64: f.bytes.toString("base64") })),
          ),
        }
        const probe = BenchmarkAclProbe.make({ tempRoot: scope.root, guard() {} }),
          before = hostRoots.map(probe)
        let guardCalls = 0,
          guardMs = 0
        const guard = async () => {
          const start = Date.now()
          await revalidateSession(session)
          guardMs += Date.now() - start
          diagnostic("guard", { guardCalls: ++guardCalls, guardMs })
        }
        diagnostic("prepared")
        let adapter: HostIsolationAdapter
        const baseBrowser = kind === "visual" ? loadBrowserRelease(config.browser.root, { readOnly: true }) : undefined
        const web = baseBrowser
          ? makeLinuxBrowser({
              release: { base: baseBrowser, helper: config.browser.helper, fontSha256: config.browser.font.sha256 },
              previewRegistry: {
                get() {
                  throw Error("unregistered")
                },
              },
              roots: { temp: manifest.roots.temp, evidence: manifest.roots.evidence, references: roots.repo },
              env: {},
              requirementPlans: {},
              async runner(lease) {
                return makeBrowserIsolationRunner({
                  session,
                  adapter,
                  helper: config.browser.helper,
                  browser: await fileIdentity(baseBrowser.browserExecutable),
                  node: await fileIdentity(baseBrowser.nodeExecutable),
                  cwd: manifest.roots.temp,
                  env: {},
                  previewID: lease.previewID,
                  previewURL: lease.url,
                })
              },
            })
          : undefined
        const native = await loadHostIsolationAdapter({
          session,
          file: await fileIdentity(artifact("host-isolation")),
          async workflow(request) {
            const host = await openProductionWorkflowHost({
              request,
              session,
              runner,
              guard,
              data,
              profileSha256,
              models,
              engine,
              browser: web,
              expectedFixtureCalls: request.readonly ? 2 : kind === "coding" ? 8 : 7,
              git: config.git,
            })
            diagnostic("host-open", { readonly: request.readonly })
            return {
              ...host,
              async observe(execution) {
                diagnostic("execution", {
                  readonly: request.readonly,
                  exitCode: execution.exitCode,
                  stdout: Buffer.from(execution.stdout).toString("utf8").slice(-8192),
                  stderr: Buffer.from(execution.stderr).toString("utf8").slice(-8192),
                })
                const database = path.join(
                  roots.data,
                  request.readonly ? "host-readonly" : "host-main",
                  "data",
                  "opencode",
                  "opencode-task24.db",
                )
                const db = new Database(database, { readonly: true })
                try {
                  diagnostic("stages", {
                    rows: db
                      .query("SELECT stage_type,status,error FROM workflow_stage ORDER BY ordinal")
                      .all()
                      .map((row) => {
                        const stage = row as { stage_type: string; status: string; error: string | null }
                        return {
                          role: stage.stage_type,
                          status: stage.status,
                          error: stage.error ? JSON.parse(stage.error) : null,
                        }
                      }),
                  })
                } finally {
                  db.close()
                }
                return host.observe(execution)
              },
            }
          },
        })
        adapter = baseBrowser
          ? attachBrowserIsolationDispatch({
              adapter: native,
              browser: await createWindowsBrowserDispatch(
                {
                  root: manifest.roots.temp,
                  evidenceRoot: manifest.roots.evidence,
                  releaseRoot: config.browser.root,
                  helper: config.browser.helper,
                  manifestSha256: session.manifestSha256,
                  allowedEvidenceRoots: [manifest.roots.evidence],
                },
                guard,
              ),
            })
          : native
        for (const readonly of [false, true]) {
          scope.launched()
          const result = await adapter.launch({
            launch,
            kind,
            readonly,
            signal: new AbortController().signal,
            fixture: provider,
          })
          const launchEvidence = result.evidence.find((ref) => ref.kind === "production-agent-workflow-launch")!
          const report = JSON.parse(
            await fs.readFile(path.join(manifest.roots.evidence, launchEvidence.relativePath), "utf8"),
          )
          await scope.retire(report.body.containment, async () =>
            hostRoots.forEach((dir, i) => expect(probe(dir)).toEqual(before[i])),
          )
          expect(result.ended).toBe(true)
          expect(result.canaryReads).toBe(0)
          expect(result.externalNetworkHits).toBe(0)
          expect(result.changed).toBe(!readonly)
          if (!readonly) expect(result.checkExit).toBe(0)
          if (!readonly && kind === "visual") expect([result.preview, result.capture]).toEqual([true, true])
          if (readonly) expect(result.readonlyDenied).toBe(true)
        }
        expect(await fs.readFile(path.join(roots.repo, sourcePath), "utf8")).toBe(correct)
        expect(provider.observation()).toEqual({ calls: kind === "coding" ? 10 : 9, rejected: 0, complete: true })
        if (kind === "coding")
          expect(provider.toolResults().find((result) => result.callID === "review-read")?.text).toContain("a + b")
        expect(provider.toolResults().find((result) => result.callID === "ro-write")?.text).toBe("Unknown tool: write")
      })
    } finally {
      await provider.stop()
      await profileFixture.dispose()
    }
  },
  1200000,
)
