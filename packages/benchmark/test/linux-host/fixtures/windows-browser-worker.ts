import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { canonicalJson } from "../../../src/campaign/canonical"
import { sha256Text } from "../../../src/hash"
import { fileIdentity } from "../../../src/sandbox/storage"
import { desktopProbeBootstrap } from "../../../src/sandbox/desktop/probe-worker"
import {
  decodeWindowsBrowserNativeResult,
  readWindowsSupervisorStream,
} from "../../../src/sandbox/host-isolation/windows"
import { loadBrowserRelease } from "../../../src/evaluator/browser-runtime"

export async function runWindowsBrowserSmoke(input: { root: string; release: string }) {
  const parent = input.root
  const releaseRoot = input.release
  if (!/^D:\\OpenCode-Benchmark\\Task24\\tmp\\[^\\]+$/i.test(parent) || (await fs.realpath(parent)) !== parent)
    throw Error("own D-only browser test parent")
  const release = loadBrowserRelease(releaseRoot, { readOnly: true })
  let verifiedCleanup = false
  const root = await fs.mkdtemp(path.join(parent, "windows-browser-live-"))
  const initialRoot = await fs.lstat(root, { bigint: true })
  if ((await fs.realpath(root)) !== root || (await fs.lstat(root)).isSymbolicLink()) throw Error("private root alias")
  const protection = `$ErrorActionPreference='Stop';$root=[Console]::ReadLine();$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false);$user=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl.SetOwner($user);foreach($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};[IO.Directory]::SetAccessControl($root,$acl);[Console]::Write('PRIVATE_ROOT_OK')`
  const privateRoot = Bun.spawn(
    [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(protection, "utf16le").toString("base64"),
    ],
    {
      cwd: root,
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", TEMP: root, TMP: root },
      stdin: Buffer.from(root + "\n"),
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  if ((await privateRoot.exited) !== 0 || (await new Response(privateRoot.stdout).text()) !== "PRIVATE_ROOT_OK")
    throw Error("private ACL failed: " + (await new Response(privateRoot.stderr).text()))
  const owner = canonicalJson({
    purpose: "task24-owned-windows-browser-compatibility-smoke",
    nonce: path.basename(root),
    modelApiCallsAllowed: false,
    deploymentReplacementAllowed: false,
  })
  await fs.writeFile(path.join(root, "owner.json"), owner, { flag: "wx" })
  const runtime = path.join(root, "runtime"),
    browserRoot = path.join(root, "browser"),
    work = path.join(root, "work"),
    state = path.join(root, "state"),
    compiler = path.join(root, "compiler")
  for (const directory of [runtime, browserRoot, work, state, compiler]) await fs.mkdir(directory)
  const manifest = JSON.parse(await fs.readFile(path.join(releaseRoot, "task24-browser-runtime.manifest.json"), "utf8"))
  const prefix = "browser/chromium-1217/chrome-win64/"
  const sources = manifest.files.filter((file: { path: string }) => file.path.startsWith(prefix))
  for (const file of sources) {
    const target = path.join(browserRoot, file.path.slice(prefix.length))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(path.join(releaseRoot, file.path), target, fs.constants.COPYFILE_EXCL)
    if ((await fileIdentity(target)).sha256 !== file.sha256) throw Error("copied browser resource drift: " + file.path)
  }
  const browser = path.join(browserRoot, "chrome.exe"),
    exe = path.join(runtime, "node.exe")
  await fs.copyFile(release.nodeExecutable, exe, fs.constants.COPYFILE_EXCL)
  if (
    (await fileIdentity(exe)).sha256 !==
    manifest.files.find((file: { path: string }) => file.path === manifest.nodeFile)?.sha256
  )
    throw Error("copied node drift")
  const built = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "windows-browser-helper.ts")],
    target: "node",
    format: "cjs",
    outdir: runtime,
    naming: "helper.cjs",
    minify: false,
  })
  if (
    !built.success ||
    built.outputs.filter((output) => output.kind === "entry-point").length !== 1 ||
    built.outputs.some((output) => output.kind !== "entry-point" && (output.kind !== "asset" || output.size > 65536))
  )
    throw Error("trusted helper build failed: " + built.logs.join("\n"))
  const helper = path.join(runtime, "helper.cjs")
  const exact = async (file: string) => {
    const value = await fs.lstat(file, { bigint: true })
    return `${value.dev}:${value.ino}:${value.birthtimeNs}`
  }
  const pin = async (file: string) => ({ ...(await fileIdentity(file)), fileID: await exact(file) })
  const metadataNames = ["xr", "cdm", "net", "odm", "prnc", "pxy"].map(
    (type) => "cr.sb." + type + createHash("sha1").update(browser, "utf8").digest("hex").toUpperCase(),
  )
  await fs.writeFile(
    path.join(root, "metadata-intent.json"),
    canonicalJson({
      version: "147.0.7727.15",
      browser,
      metadataNames,
      source: "exact-tagged-Chromium-CreateProfile-existing-registration-branch",
      cleanup: "only-owned-security-registrations-no-file-deletion",
    }),
    { flag: "wx" },
  )
  let canaryHits = 0,
    previewHits = 0
  const canary = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      canaryHits++
      return new Response("DENIED_CANARY", { headers: { "access-control-allow-origin": "*" } })
    },
  })
  const preview = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      previewHits++
      return new Response(
        "<!doctype html><meta charset=\"utf-8\"><title>Task24 own smoke</title><h1>Windows Chromium sandbox</h1><button onclick=\"document.querySelector('output').textContent='clicked'\">Run</button><output>ready</output>",
        { headers: { "content-type": "text/html" } },
      )
    },
  })
  const file = path.join(root, "file-canary.txt")
  await fs.writeFile(file, "UNGRANTED_FILE_CANARY", { flag: "wx" })
  const environment = {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    PATH: "C:\\Windows\\System32",
    HOME: state,
    USERPROFILE: state,
    APPDATA: state,
    LOCALAPPDATA: state,
    TEMP: state,
    TMP: state,
    TMPDIR: state,
    XDG_DATA_HOME: state,
    XDG_CONFIG_HOME: state,
    XDG_CACHE_HOME: state,
    XDG_STATE_HOME: state,
    NODE_DISABLE_COMPILE_CACHE: "1",
    PSModuleAnalysisCachePath: path.join(state, "ModuleAnalysisCache"),
  }
  const source =
    (await fs.readFile(new URL("../../../src/sandbox/host-isolation/windows-native.cs", import.meta.url), "utf8")) +
    "\n" +
    (await fs.readFile(
      new URL("../../../src/sandbox/host-isolation/windows-policy-native.cs", import.meta.url),
      "utf8",
    )) +
    "\n" +
    (await fs.readFile(
      new URL("../../../src/sandbox/host-isolation/windows-browser-native.cs", import.meta.url),
      "utf8",
    ))
  const script = String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$p=[Console]::ReadLine()|ConvertFrom-Json
${desktopProbeBootstrap}
try {
 Add-Type -TypeDefinition $p.source -ReferencedAssemblies @('System.Web.Extensions','System.Core')
 [Console]::Write([Task24NativeIsolation]::RunBrowser([string]$p.exe,[string[]]$p.argv,[string]$p.workingDirectory,[string]$p.environment,[string]$p.input,[int]$p.timeoutMs,[int]$p.stdoutLimit,[int]$p.stderrLimit,[string]$p.pins,[int[]]$p.ports))
} catch {
 [Console]::Error.WriteLine($_.Exception.ToString());throw
} finally {
 $acl=[IO.Directory]::GetAccessControl([string]$p.compiler,[Security.AccessControl.AccessControlSections]::Access).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
 foreach($dir in [IO.Directory]::GetDirectories([string]$p.compiler)) {
  if(([IO.File]::GetAttributes($dir) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'compiler reparse point'}
  $restore=[Security.AccessControl.DirectorySecurity]::new();$restore.SetSecurityDescriptorSddlForm($acl,[Security.AccessControl.AccessControlSections]::Access);[IO.Directory]::SetAccessControl($dir,$restore)
 }
}`
  const child = Bun.spawn(
    [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      cwd: root,
      env: { ...environment, TEMP: compiler, TMP: compiler },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const timer = setTimeout(() => {
    child.stdin.write("cancel\n")
    void child.stdin.flush()
  }, 60000)
  const emergency = setTimeout(() => child.kill(), 70000)
  try {
    const output = Promise.all([
      readWindowsSupervisorStream(child.stdout, 3 * 1048576 + 131072),
      readWindowsSupervisorStream(child.stderr, 65536),
      child.exited,
    ])
    void output.catch(() => {})
    child.stdin.write(
      canonicalJson({
        cwd: root,
        tempIdentity: await exact(root),
        tempOwnerSha256: sha256Text(owner),
        compiler,
        source,
        exe,
        argv: [helper],
        workingDirectory: work,
        environment: canonicalJson(environment),
        input: Buffer.from(
          canonicalJson({
            profile: path.join(work, "profile"),
            browser,
            preview: `http://127.0.0.1:${preview.port}/`,
            canary: `http://127.0.0.1:${canary.port}/`,
            file: new URL("file:///" + file.replaceAll("\\", "/")).href,
            screenshot: path.join(work, "screenshot.png"),
          }),
        ).toString("base64"),
        timeoutMs: 30000,
        stdoutLimit: 2097152,
        stderrLimit: 65536,
        ports: [preview.port],
        pins: canonicalJson({
          exe: await pin(exe),
          helper: await pin(helper),
          browser: await pin(browser),
          policyJournal: path.join(root, "network-policy.intent.json"),
          directories: await Promise.all(
            [root, runtime, browserRoot, work, state, compiler].map(async (directory) => ({
              path: directory,
              fileID: await exact(directory),
            })),
          ),
          readonlyRoots: [runtime, browserRoot],
        }),
      }) + "\n",
    )
    await child.stdin.flush()
    const [stdout, stderr, exitCode] = await output
    const raw = Buffer.from(stdout).toString("utf8")
    const native: unknown = exitCode === 0 ? JSON.parse(raw) : null
    const result = {
      purpose: "compatibility-smoke-not-runtime-readiness",
      root,
      nativeExit: exitCode,
      native,
      diagnostic: Buffer.from(stderr).toString("utf8"),
      previewHits,
      canaryHits,
      modelApiCalls: 0,
      deploymentReplaced: false,
    }
    await fs.writeFile(path.join(root, "result.json"), canonicalJson(result), { flag: "wx" })
    if (exitCode !== 0)
      throw Object.assign(new Error("Windows browser native failure: " + result.diagnostic), {
        root,
        cleanupUncertain: true,
      })
    const observed = decodeWindowsBrowserNativeResult(result.native, {
      browser,
      stdoutLimit: 2097152,
      stderrLimit: 65536,
    })
    verifiedCleanup = true
    return { ...result, observed, screenshot: await fs.readFile(path.join(work, "screenshot.png")) }
  } finally {
    clearTimeout(timer)
    clearTimeout(emergency)
    await Promise.resolve(child.stdin.end()).catch(() => {})
    await preview.stop(true)
    await canary.stop(true)
    if (verifiedCleanup) {
      if ((await fs.realpath(root)) !== root || (await fs.readFile(path.join(root, "owner.json"), "utf8")) !== owner)
        throw Error("own browser cleanup identity")
      const finalRoot = await fs.lstat(root, { bigint: true })
      if (
        initialRoot.dev !== finalRoot.dev ||
        initialRoot.ino !== finalRoot.ino ||
        initialRoot.birthtimeNs !== finalRoot.birthtimeNs
      )
        throw Error("own browser cleanup root changed")
      let entries = 0
      const inspect = async (directory: string, depth: number): Promise<void> => {
        if (depth > 128) throw Error("own browser cleanup depth")
        for await (const entry of await fs.opendir(directory)) {
          if (++entries > 25000) throw Error("own browser cleanup entries")
          const file = path.join(directory, entry.name)
          const stat = await fs.lstat(file)
          if (
            stat.isSymbolicLink() ||
            (await fs.realpath(file)) !== file ||
            (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
          )
            throw Error("own browser cleanup alias")
          if (stat.isDirectory()) await inspect(file, depth + 1)
        }
      }
      await inspect(root, 0)
      await fs.rm(root, { recursive: true, force: true })
    }
  }
}
