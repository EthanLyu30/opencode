import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { fileIdentity } from "../../src/sandbox/storage"
import { runWindowsSandbox } from "../../src/sandbox/host-isolation/windows"
import { startFixtureCapabilityProvider } from "../../src/sandbox/fixture-provider"
import { BenchmarkAclProbe } from "../../../server/src/workflow/benchmark-acl-probe"
import { WorkflowBenchmarkTransport } from "../../../core/src/workflow/benchmark-transport"
import { ModelSelection } from "../../../core/src/workflow/model-selection"
import { CodingModelSelection } from "../../../core/src/workflow/coding/model-selection"
import { benchmarkModelPacket } from "../../../server/test/fixtures/workflow-benchmark-models"
import { withAclAuthorityFixture } from "./acl-authority-fixture"
import { prepareWorkflowArm } from "../../src/arms/workflow"
import { planWindowsWorkflowLaunch } from "../../src/sandbox/host-isolation/production"
import { openProductionGit, type ProductionGit } from "../../src/sandbox/production-git"
import { startProductionCommandEndpoint } from "../../src/sandbox/production-command-http"

// Exercise the existing production CLI, not a newly compiled module probe.
// Admission and baseline regressions are not full workflow or scoring receipts.
const baselineSource = "<!doctype html><html><body><main>Offline probe</main></body></html>"
const baselineDesign = {
  contractVersion: 1,
  outcome: { schemaVersion: 1, role: "design", verdict: "ready", revision: 0 },
  payload: {
    spec: {
      schemaVersion: 1,
      goals: ["Render offline fixture"],
      routes: [{ path: "/", goal: "Show the fixture" }],
      layoutConstraints: ["Keep main visible"],
      componentTree: [{ id: "root", component: "main", children: [] }],
      states: [{ name: "ready", description: "The fixture is ready" }],
      typography: [{ token: "body", family: "sans-serif", weight: 400, sizePx: 16, lineHeight: 1.5 }],
      colors: [{ token: "background", value: "#ffffff" }],
      responsiveRules: [{ viewport: "desktop", width: 1280, height: 720, rules: ["Keep main visible"] }],
      accessibilityRules: ["Use semantic landmarks"],
      acceptanceCriteria: ["The fixture renders"],
      projectStack: ["HTML"],
      referenceApp: {
        entrypoint: "index.html",
        readySelector: "main",
        files: [
          {
            path: "index.html",
            sha256: new Bun.CryptoHasher("sha256").update(baselineSource).digest("hex"),
            size: Buffer.byteLength(baselineSource),
          },
        ],
        viewports: [{ name: "desktop", width: 1280, height: 720 }],
      },
    },
    sources: [{ path: "index.html", content: baselineSource }],
  },
}
const baselineDecompose = {
  contractVersion: 1,
  outcome: { schemaVersion: 1, role: "decompose", revision: 0, verdict: "ready" },
  payload: {
    acceptanceCriteria: ["The fixture renders"],
    tasks: [
      {
        id: "page",
        title: "Render page",
        description: "Render the fixture",
        files: ["index.html"],
        dependsOn: [],
        acceptanceCriteria: ["The fixture renders"],
      },
    ],
  },
}
for (const { kind, withModels, readonlyProbe, baselineProbe, gitProbe } of [
  { kind: "visual", withModels: false, readonlyProbe: false, baselineProbe: false, gitProbe: false },
  { kind: "visual", withModels: true, readonlyProbe: false, baselineProbe: false, gitProbe: false },
  { kind: "coding", withModels: true, readonlyProbe: false, baselineProbe: false, gitProbe: false },
  { kind: "visual", withModels: true, readonlyProbe: true, baselineProbe: false, gitProbe: false },
  { kind: "coding", withModels: true, readonlyProbe: true, baselineProbe: false, gitProbe: false },
  { kind: "visual", withModels: true, readonlyProbe: false, baselineProbe: true, gitProbe: true },
  { kind: "visual", withModels: true, readonlyProbe: false, baselineProbe: true, gitProbe: false },
] as const)
  test.skipIf(process.platform !== "win32" || process.env.TASK24_WINDOWS_WORKFLOW_CLI_LIVE !== "1")(
    `genuine ${kind} CLI reaches its closed provider and retires native resources (models=${withModels}, readonly=${readonlyProbe}, baseline=${baselineProbe}, git=${gitProbe})`,
    async () => {
      const binary = process.env.TASK24_WINDOWS_ADAPTER_CLI_EXE
      const expected = process.env.TASK24_WINDOWS_ADAPTER_CLI_SHA256
      if (!binary || !/^D:\\OpenCode-Benchmark\\Task24\\(?:tmp|toolchain)\\/.test(binary) || !expected)
        throw Error("TASK24_FIXTURE_CLI_IDENTITY_REQUIRED")
      const executable = await fileIdentity(binary)
      expect(executable.sha256).toBe(expected)
      const provider = startFixtureCapabilityProvider([
        {
          protocol: "chat_completions",
          model: "kimi-k3",
          events: [
            {
              data: {
                id: "own-admission",
                object: "chat.completion.chunk",
                model: "kimi-k3",
                choices: [
                  {
                    index: 0,
                    delta: readonlyProbe
                      ? {
                          tool_calls: [
                            {
                              index: 0,
                              id: "ro-write",
                              type: "function",
                              function: {
                                name: "write",
                                arguments: JSON.stringify({ path: "index.html", content: "forbidden" }),
                              },
                            },
                          ],
                        }
                      : { content: baselineProbe ? JSON.stringify(baselineDesign) : "{}" },
                    finish_reason: readonlyProbe ? "tool_calls" : "stop",
                  },
                ],
              },
            },
          ],
        },
        ...(readonlyProbe
          ? [
              {
                protocol: "chat_completions" as const,
                model: "kimi-k3" as const,
                events: [
                  {
                    data: {
                      id: "own-readonly-final",
                      object: "chat.completion.chunk",
                      model: "kimi-k3",
                      choices: [{ index: 0, delta: { content: "{}" }, finish_reason: "stop" }],
                    },
                  },
                ],
              },
            ]
          : []),
        ...(baselineProbe
          ? [
              {
                protocol: "chat_completions" as const,
                model: "kimi-k3" as const,
                events: [
                  {
                    data: {
                      id: "own-baseline-plan",
                      object: "chat.completion.chunk",
                      model: "kimi-k3",
                      choices: [
                        { index: 0, delta: { content: JSON.stringify(baselineDecompose) }, finish_reason: "stop" },
                      ],
                    },
                  },
                ],
              },
              ...(gitProbe
                ? [
                    {
                      protocol: "responses" as const,
                      model: "deepseek-v4-pro" as const,
                      events: [
                        {
                          event: "response.created",
                          data: {
                            type: "response.created",
                            sequence_number: 0,
                            response: {
                              id: "own-baseline-implementation",
                              object: "response",
                              status: "in_progress",
                              model: "deepseek-v4-pro",
                              output: [],
                            },
                          },
                        },
                        {
                          event: "response.completed",
                          data: {
                            type: "response.completed",
                            sequence_number: 1,
                            response: {
                              id: "own-baseline-implementation",
                              object: "response",
                              status: "completed",
                              model: "deepseek-v4-pro",
                              output: [
                                {
                                  id: "msg_baseline",
                                  type: "message",
                                  role: "assistant",
                                  status: "completed",
                                  content: [{ type: "output_text", text: "{}", annotations: [] }],
                                },
                              ],
                              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                            },
                          },
                        },
                      ],
                    },
                  ]
                : []),
            ]
          : []),
      ])
      // No command/browser is requested; this endpoint refuses every host operation.
      let gitHost: ProductionGit | undefined
      const gitCalls: unknown[] = []
      const host = await startProductionCommandEndpoint(
        {
          execute: async () => {
            throw Error("TASK24_FIXTURE_COMMAND_DENIED")
          },
          outstanding: () => ({ containers: [], uncertainNames: [] }),
        },
        gitProbe
          ? {
              git: {
                async execute(input, signal) {
                  if (!gitHost) throw Error("TASK24_FIXTURE_GIT_NOT_READY")
                  try {
                    const result = await gitHost.execute(input, signal)
                    gitCalls.push({
                      cwd: input.cwd,
                      argv: input.argv,
                      exit: result.exit,
                      stderr: Buffer.from(result.stderr, "base64").toString().slice(0, 2048),
                    })
                    return result
                  } catch (cause) {
                    gitCalls.push({
                      cwd: input.cwd,
                      argv: input.argv,
                      error: cause instanceof Error ? cause.message : "unknown",
                    })
                    throw cause
                  }
                },
                async close() {
                  await gitHost?.close()
                },
              },
            }
          : {},
      )
      try {
        await withAclAuthorityFixture("D:\\OpenCode-Benchmark\\Task24\\workspaces", async (scope) => {
          const runRoot = path.join(scope.root, "run")
          const runRoots = {
            runRoot,
            ...Object.fromEntries(
              ["repo", "data", "config", "cache", "temp", "output"].map((name) => [name, path.join(runRoot, name)]),
            ),
          } as Parameters<typeof prepareWorkflowArm>[0]["roots"]
          for (const directory of Object.values(runRoots)) await fs.mkdir(directory, { recursive: true })
          const work = runRoots.repo
          const hostRoot = path.join(runRoots.data, "host")
          const roots = [
            hostRoot,
            ...["data", "runtime", "cache", "preview", "config", "temp"].map((name) => path.join(hostRoot, name)),
          ]
          for (const directory of [...roots, path.join(scope.root, "bin"), path.join(scope.root, "control")])
            await fs.mkdir(directory)
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
                TASK24_OWN_ACL_ROOTS: JSON.stringify(roots),
              },
              stdout: "pipe",
              stderr: "pipe",
              windowsHide: true,
            },
          )
          const timer = setTimeout(() => prepare.kill(), 5000)
          expect(
            await Promise.all([prepare.exited, new Response(prepare.stderr).text()]).finally(() => clearTimeout(timer)),
          ).toEqual([0, ""])
          const probe = BenchmarkAclProbe.make({ tempRoot: scope.root, guard() {} })
          const before = roots.map(probe)
          const launch = await prepareWorkflowArm({
            armID: "A",
            campaignID: "own-cli-admission",
            runID: "own-cli-admission",
            roots: runRoots,
            binary: { runtime: "modified", executable: executable.path, sha256: executable.sha256, version: "own-cli" },
            prompt: "Review the fixture page",
            referenceFiles: [],
            brokerOrigin: provider.origin,
            grantExpiresAt: Date.now() + 300000,
            brokerGrant: provider.grant,
            budget: {
              aggregateInputTokens: 10000,
              aggregateOutputTokens: 10000,
              maxToolCalls: 20,
              maxRetries: 1,
              maxDurationMs: 90000,
            },
          })
          const profile = JSON.parse(await fs.readFile(launch.transportFile, "utf8"))
          const binding = WorkflowBenchmarkTransport.freezeProfile({
            authority: "server",
            profile,
            expectedCampaignID: profile.campaignID,
            expectedRunID: profile.runID,
          })
          const transport = launch.transportFile
          const connection = path.join(runRoots.data, "benchmark-host.json")
          const engine = path.join(scope.root, "bin", "docker.exe")
          await fs.writeFile(engine, "non-executable host artifact fixture; no command receipt", { flag: "wx" })
          await fs.writeFile(
            connection,
            JSON.stringify({
              schemaVersion: 1,
              campaignID: binding.campaignID,
              runID: binding.runID,
              bindingSha256: binding.bindingSha256,
              host: "127.0.0.1",
              port: host.port,
              capability: host.capability,
              expiresAt: binding.expiresAt,
              enginePath: engine,
            }),
            { flag: "wx" },
          )
          await fs.writeFile(path.join(work, "package.json"), '{"private":true,"type":"module"}', { flag: "wx" })
          await fs.writeFile(
            path.join(work, "index.html"),
            "<!doctype html><title>Own fixture</title><main>Fixture</main>",
            { flag: "wx" },
          )
          if (gitProbe) {
            for (const args of [
              ["init", "--quiet"],
              ["add", "package.json", "index.html"],
              [
                "-c",
                "user.name=Task24 fixture",
                "-c",
                "user.email=task24@localhost.invalid",
                "-c",
                "core.hooksPath=" + path.join(runRoots.temp, "no-hooks"),
                "commit",
                "--quiet",
                "-m",
                "owned baseline fixture",
              ],
            ]) {
              const git = Bun.spawn(["C:\\Program Files\\Git\\cmd\\git.exe", ...args], {
                cwd: work,
                env: process.env,
                stdout: "pipe",
                stderr: "pipe",
                windowsHide: true,
              })
              expect(await Promise.all([git.exited, new Response(git.stderr).text()])).toEqual([0, ""])
            }
            const gitPath = "C:\\Program Files\\Git\\mingw64\\bin\\git.exe"
            const snapshotsRoot = path.join(roots[1]!, "opencode", "snapshot")
            await fs.mkdir(snapshotsRoot, { recursive: true })
            gitHost = await openProductionGit({
              workspace: work,
              snapshotsRoot,
              cacheRoot: path.join(scope.root, "private-git"),
              git: {
                path: gitPath,
                sha256: new Bun.CryptoHasher("sha256").update(await fs.readFile(gitPath)).digest("hex"),
              },
              states: [
                [
                  { path: "index.html", bytes: await fs.readFile(path.join(work, "index.html")) },
                  { path: "package.json", bytes: await fs.readFile(path.join(work, "package.json")) },
                ],
              ],
              guard: async () => {},
            })
          }
          const environment = {
            ...launch.environment,
            OPENCODE_WORKFLOW_HOST_ROOT: hostRoot,
            OPENCODE_WORKFLOW_HOST_DATA: roots[1]!,
            OPENCODE_WORKFLOW_EVIDENCE_ROOT: roots[1]!,
            OPENCODE_WORKFLOW_HOST_RUNTIME: roots[2]!,
            PLAYWRIGHT_BROWSERS_PATH: roots[2]!,
            OPENCODE_WORKFLOW_HOST_CACHE: roots[3]!,
            OPENCODE_WORKFLOW_HOST_TEMP: roots[4]!,
            OPENCODE_WORKFLOW_SANDBOX_CONFIG: roots[5]!,
            OPENCODE_WORKFLOW_SANDBOX_TEMP: roots[6]!,
            OPENCODE_WORKFLOW_SANDBOX_ENGINE: engine,
            OPENCODE_WORKFLOW_SANDBOX_IMAGE: "opencode/workflow-sandbox@sha256:" + "a".repeat(64),
            OPENCODE_BENCHMARK_CAMPAIGN_ID: binding.campaignID,
            OPENCODE_BENCHMARK_RUN_ID: binding.runID,
            OPENCODE_BENCHMARK_RUN_DATA_ROOT: runRoots.data,
            OPENCODE_BENCHMARK_TRANSPORT_FILE: transport,
            OPENCODE_BENCHMARK_HOST_FILE: connection,
            MOONSHOT_API_KEY: provider.grant,
            DEEPSEEK_API_KEY: provider.grant,
            OPENCODE_TEST_HOME: roots[1]!,
            XDG_DATA_HOME: roots[1]!,
            XDG_STATE_HOME: roots[1]!,
            XDG_CONFIG_HOME: roots[5]!,
            XDG_CACHE_HOME: roots[3]!,
            OPENCODE_DISABLE_PROJECT_CONFIG: "1",
            OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
            OPENCODE_DISABLE_AUTOUPDATE: "1",
            OPENCODE_DISABLE_MODELS_FETCH: "1",
            OPENCODE_DISABLE_PRUNE: "1",
          }
          const packet = benchmarkModelPacket()
          const plan = await planWindowsWorkflowLaunch({
            launch: {
              ...launch,
              args: [
                ...launch.args.slice(0, 3),
                "--kind",
                kind,
                ...launch.args
                  .slice(3)
                  .filter(
                    (_, i, args) =>
                      kind !== "coding" || (args[i] !== "--visual-budget" && args[i - 1] !== "--visual-budget"),
                  ),
                ...(gitProbe ? ["--print-logs", "--log-level", "DEBUG"] : []),
              ],
              environment,
            },
            binary: executable,
            root: path.join(scope.root, "control"),
            readonly: readonlyProbe,
            port: host.port!,
            authority: {
              campaignID: binding.campaignID,
              runID: binding.runID,
              bindingSha256: binding.bindingSha256,
              expiresAt: binding.expiresAt,
            },
            host: {
              armID: "A",
              transport: await fileIdentity(transport),
              connection: await fileIdentity(connection),
              engine: await fileIdentity(engine),
              image: environment.OPENCODE_WORKFLOW_SANDBOX_IMAGE,
            },
          })
          scope.launched()
          const result = await runWindowsSandbox({
            ...plan,
            ...(withModels ? { benchmarkModels: packet } : {}),
            signal: new AbortController().signal,
          })
          await scope.retire(result.containment, async () => {
            expect(await fs.readdir(path.join(scope.root, "control"))).toEqual([])
            roots.forEach((directory, index) => expect(probe(directory)).toEqual(before[index]))
          })
          await gitHost?.close()
          gitHost = undefined
          if (baselineProbe) {
            console.info("TASK24_GIT_CALLS", JSON.stringify(gitCalls))
            console.info(
              "TASK24_BASELINE_EXECUTION",
              JSON.stringify({
                started: result.execution.started,
                exitCode: result.execution.exitCode,
                truncated: result.execution.truncated,
                stderr: Buffer.from(result.execution.stderr).toString("utf8").slice(0, 8192),
              }),
            )
            // Diagnostic only: do not treat the agent-writable database as execution evidence.
            const diagnostic = new Database(path.join(roots[1]!, "opencode", "opencode-task24.db"), { readonly: true })
            try {
              console.info(
                "TASK24_BASELINE_STAGES",
                JSON.stringify(
                  diagnostic.query("SELECT stage_type,status,error FROM workflow_stage ORDER BY ordinal").all(),
                ),
              )
            } finally {
              diagnostic.close()
            }
          }
          expect(provider.observation()).toEqual({
            calls: baselineProbe ? (gitProbe ? 3 : 2) : readonlyProbe ? 2 : 1,
            rejected: 0,
            complete: true,
          })
          if (readonlyProbe) {
            const result = provider.toolResults().find((reply) => reply.callID === "ro-write")
            expect(result).toMatchObject({ name: "write", text: "Unknown tool: write" })
            expect(await fs.readFile(path.join(work, "index.html"), "utf8")).toBe(
              "<!doctype html><title>Own fixture</title><main>Fixture</main>",
            )
          }
          // The fixture's deliberately invalid business output must fail, not pass or request model approval.
          expect(result.execution.exitCode).toBe(baselineProbe && !gitProbe ? 2 : 1)
          const summary = JSON.parse(Buffer.from(result.execution.stdout).toString("utf8"))
          expect(summary.workflow.status).toBe(baselineProbe && !gitProbe ? "waiting_approval" : "failed")
          // Observe admission persistence only; never use agent-writable DB rows as grading/tool receipts.
          const database = new Database(path.join(roots[1]!, "opencode", "opencode-task24.db"), { readonly: true })
          try {
            const row = database
              .query<{ input: string }, [string]>("SELECT input FROM workflow_run WHERE id = ?")
              .get(summary.workflow.id)
            const input: Record<string, unknown> = JSON.parse(row!.input)
            const key = kind === "coding" ? CodingModelSelection.RESERVED_INPUT_KEY : ModelSelection.RESERVED_INPUT_KEY
            expect(Object.hasOwn(input, key)).toBe(withModels)
            if (withModels) {
              const selection =
                kind === "coding"
                  ? CodingModelSelection.validate(input[key]).source
                  : ModelSelection.validate(input[key])
              expect(selection.snapshot.sha256).toBe(packet.snapshot.sha256)
            }
          } finally {
            database.close()
          }
        })
      } finally {
        await provider.stop()
        await host.close()
      }
    },
    120000,
  )
