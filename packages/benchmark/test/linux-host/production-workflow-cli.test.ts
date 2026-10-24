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
import { benchmarkModelPacket } from "../../../server/test/fixtures/workflow-benchmark-models"
import { withAclAuthorityFixture } from "./acl-authority-fixture"

// Exercise the existing production CLI, not a newly compiled module probe.
// This is a first-provider admission regression, not a full workflow or scoring receipt.
for (const withModels of [false, true])
  test.skipIf(process.platform !== "win32" || process.env.TASK24_WINDOWS_WORKFLOW_CLI_LIVE !== "1")(
    `genuine CLI reaches its closed provider and retires native resources (models=${withModels})`,
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
                choices: [{ index: 0, delta: { content: "{}" }, finish_reason: "stop" }],
              },
            },
          ],
        },
      ])
      // No command/browser is requested; this endpoint refuses every host operation.
      const host = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 403 }) })
      try {
        await withAclAuthorityFixture("D:\\OpenCode-Benchmark\\Task24\\workspaces", async (scope) => {
          const work = path.join(scope.root, "work")
          const roots = [
            work,
            ...["data", "runtime", "cache", "preview", "config", "temp"].map((name) => path.join(work, name)),
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
          const profile = {
            schemaVersion: 1,
            campaignID: "own-cli-admission",
            runID: "own-cli-admission",
            brokerOrigin: provider.origin,
            providerPaths: { kimi: "/v1/kimi", deepseek: "/v1/deepseek" },
            expiresAt: Date.now() + 300000,
            evidenceMode: "production",
            grant: provider.grant,
          }
          const binding = WorkflowBenchmarkTransport.freezeProfile({
            authority: "server",
            profile,
            expectedCampaignID: profile.campaignID,
            expectedRunID: profile.runID,
          })
          const transport = path.join(work, "benchmark-transport.json")
          const connection = path.join(work, "benchmark-host.json")
          const engine = path.join(scope.root, "bin", "docker.exe")
          await fs.writeFile(transport, JSON.stringify(profile), { flag: "wx" })
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
              capability: "b".repeat(64),
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
          const environment = {
            OPENCODE_WORKFLOW_HOST_ROOT: work,
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
            OPENCODE_BENCHMARK_RUN_DATA_ROOT: work,
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
          scope.launched()
          const result = await runWindowsSandbox({
            executable,
            argv: [
              "workflow",
              "run",
              "Review the fixture page",
              "--kind",
              "visual",
              "--format",
              "json",
              "--budget",
              '{"maxTokens":20000,"maxTurns":30,"maxToolCalls":20,"maxAttempts":3,"maxDurationMs":60000}',
            ],
            cwd: work,
            root: path.join(scope.root, "control"),
            readonly: [path.join(scope.root, "bin")],
            writable: roots,
            ports: [Number(new URL(provider.origin).port), host.port!],
            environment,
            ancestorMetadata: true,
            benchmarkAcl: {
              campaignID: binding.campaignID,
              runID: binding.runID,
              bindingSha256: binding.bindingSha256,
              expiresAt: binding.expiresAt,
            },
            ...(withModels ? { benchmarkModels: packet } : {}),
            benchmarkHost: {
              armID: "A",
              transport: await fileIdentity(transport),
              connection: await fileIdentity(connection),
              engine: await fileIdentity(engine),
              image: environment.OPENCODE_WORKFLOW_SANDBOX_IMAGE,
            },
            timeoutMs: 90000,
            maxStdoutBytes: 65536,
            maxStderrBytes: 65536,
            signal: new AbortController().signal,
          })
          await scope.retire(result.containment, async () => {
            expect(await fs.readdir(path.join(scope.root, "control"))).toEqual([])
            roots.forEach((directory, index) => expect(probe(directory)).toEqual(before[index]))
          })
          expect(provider.observation()).toEqual({ calls: 1, rejected: 0, complete: true })
          // The fixture's deliberately invalid business output must fail, not pass or request model approval.
          expect(result.execution.exitCode).toBe(1)
          const summary = JSON.parse(Buffer.from(result.execution.stdout).toString("utf8"))
          expect(summary.workflow.status).toBe("failed")
          // Observe admission persistence only; never use agent-writable DB rows as grading/tool receipts.
          const database = new Database(path.join(roots[1]!, "opencode", "opencode-task24.db"), { readonly: true })
          try {
            const row = database
              .query<{ input: string }, [string]>("SELECT input FROM workflow_run WHERE id = ?")
              .get(summary.workflow.id)
            const input: Record<string, unknown> = JSON.parse(row!.input)
            expect(Object.hasOwn(input, ModelSelection.RESERVED_INPUT_KEY)).toBe(withModels)
            if (withModels)
              expect(ModelSelection.validate(input[ModelSelection.RESERVED_INPUT_KEY]).snapshot.sha256).toBe(
                packet.snapshot.sha256,
              )
          } finally {
            database.close()
          }
        })
      } finally {
        await provider.stop()
        await host.stop(true)
      }
    },
    120000,
  )
