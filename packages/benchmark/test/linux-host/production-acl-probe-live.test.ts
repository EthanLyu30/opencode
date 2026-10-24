import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { fileIdentity } from "../../src/sandbox/storage"
import { runWindowsSandbox } from "../../src/sandbox/host-isolation/windows"
import { BenchmarkAclProbe } from "../../../server/src/workflow/benchmark-acl-probe"

test.skipIf(process.platform !== "win32" || process.env.TASK24_WINDOWS_ISOLATION_LIVE !== "1")(
  "real LPAC native ACL collection returns actual metadata, preserves unsafe-root rejection and retires all native resources",
  async () => {
    const parent = process.env.TMPDIR!
    const root = await fs.mkdtemp(path.join(parent, "acl-transport-live-"))
    const identity = await fs.lstat(root, { bigint: true })
    let safe = true
    try {
      for (const dir of ["work", "control", "bin"]) await fs.mkdir(path.join(root, dir))
      // Only this fresh fixture is changed. Start with a real protected host
      // DACL; the existing isolation grant must remain visible to the policy.
      const prepare = Bun.spawn(
        [
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop';$acl=New-Object System.Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false);$user=[Security.Principal.WindowsIdentity]::GetCurrent().User;foreach($sid in @($user,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),(New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))};[IO.Directory]::SetAccessControl($env:TASK24_OWN_ACL_ROOT,$acl)",
        ],
        {
          env: { SystemRoot: "C:\\Windows", TEMP: root, TMP: root, TASK24_OWN_ACL_ROOT: path.join(root, "work") },
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        },
      )
      const prepareTimer = setTimeout(() => prepare.kill(), 5000)
      const [prepareExit, prepareError] = await Promise.all([
        prepare.exited,
        new Response(prepare.stderr).text(),
      ]).finally(() => clearTimeout(prepareTimer))
      expect({ exit: prepareExit, stderr: prepareError }).toEqual({ exit: 0, stderr: "" })
      const initial = BenchmarkAclProbe.make({ tempRoot: root, guard() {} })(path.join(root, "work"))
      expect(initial.protected).toBe(true)
      expect(initial.aces).toHaveLength(3)
      const probe = fileURLToPath(new URL("../../../server/src/workflow/benchmark-acl-probe.ts", import.meta.url))
      const policy = fileURLToPath(new URL("../../../server/src/workflow/host-root-policy.ts", import.meta.url))
      const source = `import fs from 'node:fs';import path from 'node:path';import {BenchmarkAclProbe} from ${JSON.stringify(probe)};import {HostRootPolicy} from ${JSON.stringify(policy)};const root=process.cwd();const probe=BenchmarkAclProbe.make({tempRoot:root,guard(){}});const value=probe(root);if(!/^S-1-/.test(value.currentUserSid)||!value.aces.length||value.reparsePoint!==false||!value.protected)throw Error('unverified metadata');const roots={deploymentRoot:root,dataRoot:path.join(root,'data'),browserRuntimeRoot:path.join(root,'runtime'),browserCacheRoot:path.join(root,'cache'),previewCapabilityRoot:path.join(root,'preview'),dockerConfigRoot:path.join(root,'config'),dockerTempRoot:path.join(root,'temp')};for(const dir of Object.values(roots))if(dir!==root)fs.mkdirSync(dir);let reason='';try{HostRootPolicy.makeProduction({...roots,probe})}catch(error){reason=error.message}console.log(JSON.stringify({outcome:'metadata',unsafeRefused:reason==='Workflow host ACL grants write authority to an untrusted SID',temporaryRemaining:fs.readdirSync(root).filter(n=>n.startsWith('acl-query-')).length}));`
      await fs.writeFile(path.join(root, "entry.ts"), source, { flag: "wx" })
      await fs.writeFile(path.join(root, "bunfig.toml"), "# empty own compiler configuration\n", { flag: "wx" })
      await fs.writeFile(
        path.join(root, "build.ts"),
        `const result=await Bun.build({entrypoints:[${JSON.stringify(path.join(root, "entry.ts"))}],target:'bun',minify:true,compile:{outfile:${JSON.stringify(path.join(root, "bin", "probe.exe"))},autoloadDotenv:false,autoloadBunfig:false,autoloadPackageJson:false,autoloadTsconfig:false}});if(!result.success){console.error(result.logs);process.exit(1)}`,
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
      const [exit, stderr] = await Promise.all([compiler.exited, new Response(compiler.stderr).text()]).finally(() =>
        clearTimeout(timer),
      )
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
      const result = await runWindowsSandbox({
        executable: await fileIdentity(path.join(root, "bin", "probe.exe")),
        argv: [],
        cwd: path.join(root, "work"),
        root: path.join(root, "control"),
        readonly: [],
        writable: [path.join(root, "work")],
        ports: [],
        ancestorMetadata: true,
        timeoutMs: 15000,
        maxStdoutBytes: 16384,
        maxStderrBytes: 16384,
        signal: new AbortController().signal,
      })
      safe =
        result.containment.cleanupCompleted &&
        result.containment.processTreeEnded &&
        result.containment.persistentPolicyRetired &&
        result.containment.ancestorMetadataRetired === true
      if (result.execution.exitCode !== 0)
        console.error("Owned native ACL child refused:", Buffer.from(result.execution.stderr).toString())
      expect({ exit: result.execution.exitCode, stderr: Buffer.from(result.execution.stderr).toString() }).toEqual({
        exit: 0,
        stderr: "",
      })
      const outcome = JSON.parse(Buffer.from(result.execution.stdout).toString())
      expect(outcome.outcome).toBe("metadata")
      expect(outcome).toMatchObject({ unsafeRefused: true, temporaryRemaining: 0 })
      console.info(`Native ACL probe outcome: ${outcome.outcome}; this is not A readiness evidence`)
      expect(result.containment).toMatchObject({
        appContainer: true,
        processTreeEnded: true,
        cleanupCompleted: true,
        persistentPolicyRetired: true,
        ancestorMetadataRetired: true,
      })
      expect(await fs.readdir(path.join(root, "control"))).toEqual([])
      // Both the OS grant and the read-only collector leave the original DACL unchanged.
      expect(BenchmarkAclProbe.make({ tempRoot: root, guard() {} })(path.join(root, "work"))).toEqual(initial)
    } catch (error) {
      if (error && typeof error === "object" && Reflect.get(error, "cleanupUncertain") === true) safe = false
      throw error
    } finally {
      const current = await fs.lstat(root, { bigint: true })
      if (
        safe &&
        path.dirname(root) === parent &&
        (await fs.realpath(root)) === root &&
        current.dev === identity.dev &&
        current.ino === identity.ino &&
        current.birthtimeNs === identity.birthtimeNs
      )
        await fs.rm(root, { recursive: true })
    }
  },
  60000,
)
