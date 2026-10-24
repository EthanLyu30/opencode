import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { fileIdentity } from "../../src/sandbox/storage"
import { runWindowsSandbox } from "../../src/sandbox/host-isolation/windows"
import { BenchmarkAclProbe } from "../../../server/src/workflow/benchmark-acl-probe"
import { WorkflowBenchmarkTransport } from "../../../core/src/workflow/benchmark-transport"
import { withAclAuthorityFixture } from "./acl-authority-fixture"
import { benchmarkModelPacket } from "../../../server/test/fixtures/workflow-benchmark-models"

for (const withModels of [false, true])
  test.skipIf(process.platform !== "win32" || process.env.TASK24_WINDOWS_ISOLATION_LIVE !== "1")(
    `real native launch commits its exact ACL grant record into the actual package token and leaves default policy strict (models=${withModels})`,
    async () => {
      const parent = "D:\\OpenCode-Benchmark\\Task24\\workspaces"
      await withAclAuthorityFixture(parent, async (scope) => {
        const root = scope.root
        const work = path.join(root, "work")
        const roots = {
          deploymentRoot: work,
          dataRoot: path.join(work, "data"),
          browserRuntimeRoot: path.join(work, "runtime"),
          browserCacheRoot: path.join(work, "cache"),
          previewCapabilityRoot: path.join(work, "preview"),
          dockerConfigRoot: path.join(work, "config"),
          dockerTempRoot: path.join(work, "temp"),
        }
        for (const dir of [...Object.values(roots), path.join(root, "control"), path.join(root, "bin")])
          await fs.mkdir(dir)
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
              TEMP: root,
              TMP: root,
              TASK24_OWN_ACL_ROOTS: JSON.stringify(Object.values(roots)),
            },
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
          },
        )
        const prepareTimer = setTimeout(() => prepare.kill(), 5000)
        const [prepared, prepareError] = await Promise.all([
          prepare.exited,
          new Response(prepare.stderr).text(),
        ]).finally(() => clearTimeout(prepareTimer))
        expect({ prepared, prepareError }).toEqual({ prepared: 0, prepareError: "" })
        const baseline = Object.fromEntries(
          Object.values(roots).map((dir) => [dir, BenchmarkAclProbe.make({ tempRoot: root, guard() {} })(dir)]),
        )
        const module = fileURLToPath(
          new URL("../../../server/src/workflow/benchmark-acl-authority.ts", import.meta.url),
        )
        const policy = fileURLToPath(new URL("../../../server/src/workflow/host-root-policy.ts", import.meta.url))
        const runtime = fileURLToPath(
          new URL("../../../server/src/workflow/production-host-runtime.ts", import.meta.url),
        )
        const models = fileURLToPath(
          new URL("../../../server/src/workflow/benchmark-model-catalog.ts", import.meta.url),
        )
        const effect = fileURLToPath(import.meta.resolve("effect"))
        const selection = fileURLToPath(new URL("../../../core/src/workflow/model-selection.ts", import.meta.url))
        const modelRuntime = fileURLToPath(
          new URL("../../../server/src/workflow/model-catalog-runtime.ts", import.meta.url),
        )
        const modelAvailability = fileURLToPath(
          new URL("../../../core/src/workflow/model-availability.ts", import.meta.url),
        )
        const catalogueService = fileURLToPath(
          new URL("../../../core/src/workflow/model-catalog/service.ts", import.meta.url),
        )
        const credentialScope = fileURLToPath(
          new URL("../../../core/src/workflow/model-catalog/credential-scope.ts", import.meta.url),
        )
        const profile = {
          schemaVersion: 1,
          campaignID: "own-live-campaign",
          runID: "own-live-run",
          brokerOrigin: "http://127.0.0.1:12499",
          providerPaths: { kimi: "/v1/kimi", deepseek: "/v1/deepseek" },
          expiresAt: Date.now() + 300000,
          evidenceMode: "production",
          grant: "OWN_ZERO_PROVIDER_FIXTURE_".repeat(3),
        }
        const binding = WorkflowBenchmarkTransport.freezeProfile({
          authority: "server",
          profile,
          expectedCampaignID: profile.campaignID,
          expectedRunID: profile.runID,
        })
        const transport = path.join(work, "benchmark-transport.json")
        await fs.writeFile(transport, JSON.stringify(profile), { flag: "wx" })
        const engine = path.join(root, "bin", "docker.exe")
        await fs.writeFile(engine, "non-executable finite bridge artifact fixture", { flag: "wx" })
        await fs.writeFile(
          path.join(work, "benchmark-host.json"),
          JSON.stringify({
            schemaVersion: 1,
            campaignID: binding.campaignID,
            runID: binding.runID,
            bindingSha256: binding.bindingSha256,
            host: "127.0.0.1",
            port: 12501,
            capability: "b".repeat(64),
            expiresAt: binding.expiresAt,
            enginePath: engine,
          }),
          { flag: "wx" },
        )
        const environment = {
          OPENCODE_WORKFLOW_HOST_ROOT: work,
          OPENCODE_WORKFLOW_HOST_DATA: roots.dataRoot,
          OPENCODE_WORKFLOW_EVIDENCE_ROOT: roots.dataRoot,
          OPENCODE_WORKFLOW_HOST_RUNTIME: roots.browserRuntimeRoot,
          PLAYWRIGHT_BROWSERS_PATH: roots.browserRuntimeRoot,
          OPENCODE_WORKFLOW_HOST_CACHE: roots.browserCacheRoot,
          OPENCODE_WORKFLOW_HOST_TEMP: roots.previewCapabilityRoot,
          OPENCODE_WORKFLOW_SANDBOX_ENGINE: engine,
          OPENCODE_WORKFLOW_SANDBOX_IMAGE: "opencode/workflow-sandbox@sha256:" + "a".repeat(64),
          OPENCODE_WORKFLOW_SANDBOX_CONFIG: roots.dockerConfigRoot,
          OPENCODE_WORKFLOW_SANDBOX_TEMP: roots.dockerTempRoot,
          OPENCODE_BENCHMARK_TRANSPORT_FILE: transport,
          OPENCODE_BENCHMARK_RUN_DATA_ROOT: work,
          OPENCODE_BENCHMARK_CAMPAIGN_ID: binding.campaignID,
          OPENCODE_BENCHMARK_RUN_ID: binding.runID,
          OPENCODE_BENCHMARK_HOST_FILE: path.join(work, "benchmark-host.json"),
        }
        const source = `import fs from 'node:fs';import path from 'node:path';import {BenchmarkAclAuthority} from ${JSON.stringify(module)};import {HostRootPolicy} from ${JSON.stringify(policy)};import {ProductionHostRuntime} from ${JSON.stringify(runtime)};const roots=${JSON.stringify(roots)},binding=${JSON.stringify(binding)};const authority=BenchmarkAclAuthority.make({binding,tempRoot:roots.previewCapabilityRoot,guard(){}});const snapshot=authority.probe(roots.deploymentRoot);let originalRefused=false;try{HostRootPolicy.makeProduction({...roots,probe:authority.probe})}catch(e){originalRefused=e.message.includes('untrusted SID')};const p=HostRootPolicy.makeProduction({...roots,probe:authority.probe,benchmarkWriteGrant:authority.writeGrant});p.verifyAll();ProductionHostRuntime.load(process.env).contract.policy.verifyAll();let crossRunDenied=false;try{BenchmarkAclAuthority.make({binding:{...binding,runID:'other-run'},tempRoot:roots.previewCapabilityRoot,guard(){}})}catch{crossRunDenied=true};const proof=path.join(path.dirname(process.execPath),'benchmark-acl-authority.json');let recordWriteDenied=false;try{fs.appendFileSync(proof,'forbidden')}catch(e){recordWriteDenied=e.code==='EACCES'||e.code==='EPERM'};let connectionWriteDenied=false;try{fs.appendFileSync(process.env.OPENCODE_BENCHMARK_HOST_FILE,'forbidden')}catch(e){connectionWriteDenied=['EACCES','EPERM','EBUSY'].includes(e.code)};console.log(JSON.stringify({authorized:true,productionRuntime:true,originalRefused,crossRunDenied,recordWriteDenied,connectionWriteDenied,rawPackageAce:snapshot.aces.some(a=>a.sid.startsWith('S-1-15-2-')&&a.mask===0x1301bf)}));`
        const modelSource = `import {Effect,Layer} from ${JSON.stringify(effect)};import {BenchmarkModelCatalog} from ${JSON.stringify(models)};import {ModelSelection} from ${JSON.stringify(selection)};const modelSource=BenchmarkModelCatalog.load(process.env);if(${withModels}){if(!modelSource)throw Error('missing authenticated models');const snapshot=await Effect.runPromise(modelSource.snapshot());if(snapshot.routes.design.modelID!=='kimi-k3'||snapshot.routes.implement.modelID!=='deepseek-v4-pro')throw Error('wrong authenticated routes');await Effect.runPromise(modelSource.check(ModelSelection.freeze(snapshot,{directory:${JSON.stringify(work)}})))}else if(modelSource)throw Error('legacy acquired models');`
        const layerSource = `import {WorkflowModelCatalogRuntime} from ${JSON.stringify(modelRuntime)};import {ModelAvailability} from ${JSON.stringify(modelAvailability)};import {WorkflowModelCatalogService} from ${JSON.stringify(catalogueService)};import {WorkflowCredentialScope} from ${JSON.stringify(credentialScope)};if(${withModels})await Effect.runPromise(Effect.gen(function*(){const selected=yield*ModelSelection.Service;const available=yield*ModelAvailability.Service;const snapshot=yield*selected.snapshot();if(!snapshot)throw Error('runtime omitted authenticated snapshot');yield*available.check(ModelSelection.freeze(snapshot,{directory:${JSON.stringify(work)}}))}).pipe(Effect.provide(WorkflowModelCatalogRuntime.selectionNode.implementation),Effect.provide(WorkflowModelCatalogRuntime.availabilityLayer),Effect.provide(Layer.succeed(WorkflowModelCatalogService.Service,{snapshot:()=>Effect.die('real discovery forbidden'),checkPinned:()=>Effect.die('real discovery forbidden')})),Effect.provide(Layer.succeed(WorkflowCredentialScope.Service,{resolve:()=>Effect.die('real credential forbidden'),credential:()=>Effect.die('real credential forbidden')}))));`
        await fs.writeFile(path.join(root, "entry.ts"), modelSource + layerSource + source, { flag: "wx" })
        await fs.writeFile(path.join(root, "bunfig.toml"), "# own empty build configuration\n", { flag: "wx" })
        await fs.writeFile(
          path.join(root, "build.ts"),
          `const r=await Bun.build({entrypoints:[${JSON.stringify(path.join(root, "entry.ts"))}],target:'bun',minify:true,compile:{outfile:${JSON.stringify(path.join(root, "bin", "probe.exe"))},autoloadDotenv:false,autoloadBunfig:false,autoloadPackageJson:false,autoloadTsconfig:false}});if(!r.success){console.error(r.logs);process.exit(1)}`,
          { flag: "wx" },
        )
        const compiler = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            "--no-install",
            "--config=" + path.join(root, "bunfig.toml"),
            path.join(root, "build.ts"),
          ],
          {
            cwd: root,
            env: { SystemRoot: "C:\\Windows", TEMP: root, TMP: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
          },
        )
        const timer = setTimeout(() => compiler.kill(), 30000)
        const [compiled, compileError] = await Promise.all([
          compiler.exited,
          new Response(compiler.stderr).text(),
        ]).finally(() => clearTimeout(timer))
        expect({ compiled, compileError }).toEqual({ compiled: 0, compileError: "" })
        scope.launched()
        const result = await runWindowsSandbox({
          executable: await fileIdentity(path.join(root, "bin", "probe.exe")),
          argv: [],
          cwd: work,
          root: path.join(root, "control"),
          readonly: [path.join(root, "bin")],
          writable: Object.values(roots),
          ports: [12499, 12501],
          ancestorMetadata: true,
          benchmarkAcl: {
            campaignID: binding.campaignID,
            runID: binding.runID,
            bindingSha256: binding.bindingSha256,
            expiresAt: binding.expiresAt,
          },
          ...(withModels ? { benchmarkModels: benchmarkModelPacket() } : {}),
          benchmarkHost: {
            armID: "A",
            transport: await fileIdentity(transport),
            connection: await fileIdentity(environment.OPENCODE_BENCHMARK_HOST_FILE),
            engine: await fileIdentity(engine),
            image: environment.OPENCODE_WORKFLOW_SANDBOX_IMAGE,
          },
          environment,
          timeoutMs: 20000,
          maxStdoutBytes: 8192,
          maxStderrBytes: 16384,
          signal: new AbortController().signal,
        })
        await scope.retire(result.containment, async () => {
          expect(await fs.readdir(path.join(root, "control"))).toEqual([])
          for (const dir of Object.values(roots))
            expect(BenchmarkAclProbe.make({ tempRoot: root, guard() {} })(dir)).toEqual(baseline[dir])
        })
        expect({ exit: result.execution.exitCode, stderr: Buffer.from(result.execution.stderr).toString() }).toEqual({
          exit: 0,
          stderr: "",
        })
        expect(JSON.parse(Buffer.from(result.execution.stdout).toString())).toEqual({
          authorized: true,
          productionRuntime: true,
          originalRefused: true,
          crossRunDenied: true,
          recordWriteDenied: true,
          connectionWriteDenied: true,
          rawPackageAce: true,
        })
        expect(result.containment.cleanupCompleted).toBe(true)
      })
    },
    60000,
  )
