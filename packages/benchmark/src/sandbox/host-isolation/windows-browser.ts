import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import { FileIdentity, requireDPath, type DockerInvocation } from "../contracts"
import { fileIdentity } from "../storage"
import { loadBrowserRelease } from "../../evaluator/browser-runtime"
import { directRoot } from "../../corpus/direct-root"
import { decodeEvaluationIdentity } from "../../corpus/evaluation-profile"
import { canonicalJson } from "../../campaign/canonical"
import { sha256Text } from "../../hash"
import { safeRelayPath } from "../relay-protocol"
import { validateBrowserAdmission, validateBrowserProbe, isAdmittedLinuxBrowserURL } from "../browser-contracts"
import { desktopProbeBootstrap } from "../desktop/probe-worker"
import { readWindowsIsolationSource, readWindowsSupervisorStream, decodeWindowsBrowserNativeResult } from "./windows"

const Input = Schema.Struct({
  root: Schema.String,
  releaseRoot: Schema.String,
  helper: FileIdentity,
  tempRoot: Schema.String,
  evidenceRoot: Schema.String,
  previewID: Schema.String,
  previewURL: Schema.String,
  invocation: Schema.Unknown,
})
const Frame = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  operation: Schema.Literals(["capture", "probe", "admission"]),
  identity: Schema.Unknown,
  base: Schema.String,
  previewID: Schema.String,
  paths: Schema.Array(Schema.String),
  browser: Schema.String,
  temp: Schema.String,
  evidence: Schema.String,
  plans: Schema.Array(Schema.Unknown),
  data: Schema.Unknown,
})
const under = (file: string, root: string) => file === root || file.startsWith(root + path.sep)
const ownRoot = /^D:\\OpenCode-Benchmark\\Task24\\(?:tmp|workspaces)\\[^\\]+(?:\\.*)?$/

async function exact(file: string) {
  const stat = await fs.lstat(file, { bigint: true })
  if (
    stat.isSymbolicLink() ||
    (await fs.realpath(file)) !== file ||
    (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))
  )
    throw new TypeError("TASK24_BROWSER_ISOLATION_IDENTITY")
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}
function retained(root: string, cause: unknown) {
  return Object.assign(new Error("TASK24_BROWSER_CLEANUP_UNCERTAIN: " + root, { cause }), {
    root,
    cleanupUncertain: true,
  })
}

/** Own a fresh directory before copying or starting any native worker. */
export async function createWindowsBrowserRoot(parent: string) {
  requireDPath(parent)
  if (!ownRoot.test(parent)) throw new TypeError("TASK24_BROWSER_ISOLATION_INPUT")
  await directRoot(parent)
  const root = await fs.mkdtemp(path.join(parent, "native-browser-"))
  let identity: string, owner: string
  try {
    identity = await exact(root)
    owner = canonicalJson({ purpose: "task24-production-browser-v2", nonce: randomBytes(16).toString("hex") })
    await fs.writeFile(path.join(root, "owner.json"), owner, { flag: "wx" })
  } catch (cause) {
    throw retained(root, cause)
  }
  return {
    root,
    identity,
    owner,
    async dispose() {
      try {
        if ((await exact(root)) !== identity || (await fs.readFile(path.join(root, "owner.json"), "utf8")) !== owner)
          throw new TypeError("TASK24_BROWSER_CLEANUP_IDENTITY")
        let entries = 0
        const walk = async (directory: string, depth: number): Promise<void> => {
          if (depth >= 128) throw new TypeError("TASK24_BROWSER_CLEANUP_DEPTH")
          await exact(directory)
          for await (const entry of await fs.opendir(directory)) {
            if (++entries > 25000) throw new TypeError("TASK24_BROWSER_CLEANUP_LIMIT")
            const file = path.join(directory, entry.name)
            await exact(file)
            if ((await fs.lstat(file)).isDirectory()) await walk(file, depth + 1)
          }
        }
        await walk(root, 0)
        await fs.rm(root, { recursive: true })
      } catch (cause) {
        throw retained(root, cause)
      }
    },
  }
}

/** Fixed protocol-v2 helper only. Page code executes in Chromium's observed renderer sandbox, never Node. */
export async function runWindowsBrowserProtocol(raw: unknown) {
  const parsed = Schema.decodeUnknownOption(Input)(raw, { onExcessProperty: "error" })
  if (parsed._tag !== "Some") throw new TypeError("TASK24_BROWSER_ISOLATION_INPUT")
  const input = parsed.value
  for (const root of [input.root, input.tempRoot, input.evidenceRoot]) {
    requireDPath(root)
    if (!ownRoot.test(root)) throw new TypeError("TASK24_BROWSER_ISOLATION_INPUT")
  }
  const invocation = input.invocation as DockerInvocation
  if (
    !invocation ||
    !(invocation.signal instanceof AbortSignal) ||
    !(invocation.stdin instanceof Uint8Array) ||
    invocation.stdin.length > 2097152 ||
    canonicalJson(invocation.argv) !== canonicalJson([input.helper.path]) ||
    !Number.isSafeInteger(invocation.timeoutMs) ||
    invocation.timeoutMs < 1 ||
    invocation.timeoutMs > 30000 ||
    !Number.isSafeInteger(invocation.maxStdoutBytes) ||
    invocation.maxStdoutBytes < 1 ||
    invocation.maxStdoutBytes > 2097152 ||
    !Number.isSafeInteger(invocation.maxStderrBytes) ||
    invocation.maxStderrBytes < 1 ||
    invocation.maxStderrBytes > 65536
  )
    throw new TypeError("TASK24_BROWSER_ISOLATION_INPUT")
  invocation.signal.throwIfAborted()
  if (process.platform !== "win32" || process.arch !== "x64") throw new TypeError("TASK24_BROWSER_ISOLATION_PLATFORM")
  const release = loadBrowserRelease(input.releaseRoot, { readOnly: true })
  const frame = Schema.decodeUnknownSync(Frame)(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(invocation.stdin)),
    { onExcessProperty: "error" },
  )
  const identity = decodeEvaluationIdentity(frame.identity)
  const base = new URL(input.previewURL)
  if (
    !/^[a-f0-9]{64}$/.test(input.previewID) ||
    frame.previewID !== input.previewID ||
    frame.base !== input.previewURL ||
    base.origin !== `http://127.0.0.1:${base.port}` ||
    Number(base.port) < 1024 ||
    !/^\/[a-f0-9]{64}\/$/.test(base.pathname) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    frame.browser !== release.browserExecutable ||
    !under(frame.temp, input.tempRoot) ||
    !under(frame.evidence, input.evidenceRoot) ||
    frame.paths.length > 20000 ||
    !frame.paths.length
  )
    throw new TypeError("TASK24_BROWSER_ISOLATION_BINDING")
  for (const value of frame.paths) safeRelayPath(value)
  if (frame.operation === "admission") validateBrowserAdmission(frame.data)
  if (frame.operation === "probe") {
    validateBrowserProbe(frame.data)
    if (
      canonicalJson(frame.data.identity) !== canonicalJson(identity) ||
      !frame.paths.includes("/" + frame.data.module)
    )
      throw new TypeError("TASK24_BROWSER_ISOLATION_BINDING")
  }
  if (frame.operation === "capture") {
    const capture = Schema.decodeUnknownSync(
      Schema.Struct({
        runID: Schema.String,
        previewID: Schema.String,
        previewURL: Schema.String,
        viewportID: Schema.Literals(["mobile", "tablet", "desktop"]),
        readySelector: Schema.String,
        interactionScriptID: Schema.Literals(["none", "primary-click", "menu-toggle"]),
        timeoutMs: Schema.Int,
      }),
    )(frame.data, { onExcessProperty: "error" })
    if (
      capture.runID !== identity.runID ||
      capture.previewID !== input.previewID ||
      capture.timeoutMs !== invocation.timeoutMs ||
      !isAdmittedLinuxBrowserURL(capture.previewURL, frame.base, frame.paths)
    )
      throw new TypeError("TASK24_BROWSER_ISOLATION_BINDING")
  }
  for (const directory of [input.root, frame.temp, frame.evidence]) await directRoot(directory)
  if (canonicalJson(await fileIdentity(input.helper.path)) !== canonicalJson(input.helper))
    throw new TypeError("TASK24_BROWSER_HELPER_DRIFT")
  const pin = async (file: string) => ({ ...(await fileIdentity(file)), fileID: await exact(file) })
  const scope = await createWindowsBrowserRoot(input.root)
  const { root, identity: rootIdentity, owner } = scope
  let cleanupSafe = true,
    child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined, emergency: ReturnType<typeof setTimeout> | undefined
  let sent = false,
    cancelled = false
  const cancel = () => {
    cancelled = true
    if (!child || !sent) return
    sent = false
    try {
      child.stdin.write("cancel\n")
      void Promise.resolve(child.stdin.flush()).catch(() => {})
    } catch {}
    emergency = setTimeout(() => child?.kill(), 10000)
  }
  try {
    const runtime = path.join(root, "runtime"),
      browserRoot = path.join(root, "browser"),
      work = path.join(root, "work"),
      state = path.join(root, "state"),
      compiler = path.join(root, "compiler")
    for (const directory of [runtime, browserRoot, work, state, compiler]) await fs.mkdir(directory)
    const exe = path.join(runtime, "node.exe"),
      helper = path.join(runtime, "helper.cjs"),
      browser = path.join(browserRoot, "chrome.exe")
    await fs.copyFile(release.nodeExecutable, exe, fs.constants.COPYFILE_EXCL)
    await fs.copyFile(input.helper.path, helper, fs.constants.COPYFILE_EXCL)
    if (
      (await fileIdentity(helper)).sha256 !== input.helper.sha256 ||
      (await fileIdentity(exe)).sha256 !== (await fileIdentity(release.nodeExecutable)).sha256
    )
      throw new TypeError("TASK24_BROWSER_HELPER_DRIFT")
    const manifest = JSON.parse(
      await fs.readFile(path.join(input.releaseRoot, "task24-browser-runtime.manifest.json"), "utf8"),
    ) as { files: { path: string; sha256: string }[] }
    const prefix = path.relative(input.releaseRoot, path.dirname(release.browserExecutable)).replaceAll("\\", "/") + "/"
    for (const file of manifest.files.filter((file) => file.path.startsWith(prefix))) {
      const target = path.join(browserRoot, file.path.slice(prefix.length))
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.copyFile(path.join(input.releaseRoot, file.path), target, fs.constants.COPYFILE_EXCL)
      if ((await fileIdentity(target)).sha256 !== file.sha256) throw new TypeError("TASK24_BROWSER_RESOURCE_DRIFT")
    }
    for (const asset of (await fs.readdir(path.dirname(input.helper.path))).filter((file) =>
      /^appIcon-[a-z0-9]+\.png$/.test(file),
    )) {
      const source = path.join(path.dirname(input.helper.path), asset)
      const before = await fileIdentity(source)
      if ((await fs.stat(source)).size > 65536) throw new TypeError("TASK24_BROWSER_RESOURCE_DRIFT")
      await fs.copyFile(source, path.join(runtime, asset), fs.constants.COPYFILE_EXCL)
      if ((await fileIdentity(path.join(runtime, asset))).sha256 !== before.sha256)
        throw new TypeError("TASK24_BROWSER_RESOURCE_DRIFT")
    }
    release.verify()
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
    const source = await readWindowsIsolationSource()
    const script = String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$p=[Console]::ReadLine()|ConvertFrom-Json
${desktopProbeBootstrap}
try {
 $private=[Security.AccessControl.DirectorySecurity]::new();$private.SetAccessRuleProtection($true,$false);$user=[Security.Principal.WindowsIdentity]::GetCurrent().User;$private.SetOwner($user)
 foreach($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$private.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};[IO.Directory]::SetAccessControl([string]$p.cwd,$private)
 Add-Type -TypeDefinition $p.source -ReferencedAssemblies @('System.Web.Extensions','System.Core')
 [Console]::Write([Task24NativeIsolation]::RunBrowser([string]$p.exe,[string[]]$p.argv,[string]$p.workingDirectory,[string]$p.environment,[string]$p.input,[int]$p.timeoutMs,[int]$p.stdoutLimit,[int]$p.stderrLimit,[string]$p.pins,[int[]]$p.ports))
} catch { [Console]::Error.WriteLine($_.Exception.ToString());throw } finally {
 $acl=[IO.Directory]::GetAccessControl([string]$p.compiler,[Security.AccessControl.AccessControlSections]::Access).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
 foreach($dir in [IO.Directory]::GetDirectories([string]$p.compiler)) {if(([IO.File]::GetAttributes($dir) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'compiler reparse point'};$restore=[Security.AccessControl.DirectorySecurity]::new();$restore.SetSecurityDescriptorSddlForm($acl,[Security.AccessControl.AccessControlSections]::Access);[IO.Directory]::SetAccessControl($dir,$restore)}
}`
    const pins = {
      exe: await pin(exe),
      helper: await pin(helper),
      browser: await pin(browser),
      policyJournal: path.join(root, "network-policy.intent.json"),
      directories: await Promise.all(
        [...new Set([root, runtime, browserRoot, work, state, compiler, frame.evidence])].map(async (directory) => ({
          path: directory,
          fileID: await exact(directory),
        })),
      ),
      readonlyRoots: [runtime, browserRoot],
    }
    invocation.signal.throwIfAborted()
    child = Bun.spawn(
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
    invocation.signal.addEventListener("abort", cancel, { once: true })
    timer = setTimeout(cancel, invocation.timeoutMs + 20000)
    const output = Promise.all([
      readWindowsSupervisorStream(child.stdout, 3 * 1048576 + 131072),
      readWindowsSupervisorStream(child.stderr, 65536),
      child.exited,
    ])
    void output.catch(() => {})
    cleanupSafe = false
    child.stdin.write(
      canonicalJson({
        cwd: root,
        tempIdentity: rootIdentity,
        tempOwnerSha256: sha256Text(owner),
        compiler,
        source,
        exe,
        argv: [helper],
        workingDirectory: work,
        environment: canonicalJson(environment),
        input: Buffer.from(canonicalJson({ ...frame, browser, temp: work })).toString("base64"),
        timeoutMs: invocation.timeoutMs,
        stdoutLimit: invocation.maxStdoutBytes,
        stderrLimit: invocation.maxStderrBytes,
        ports: [Number(base.port)],
        pins: canonicalJson(pins),
      }) + "\n",
    )
    sent = true
    if (invocation.signal.aborted || cancelled) cancel()
    await child.stdin.flush()
    const [stdout, stderr, exit] = await output
    if (exit !== 0) throw new Error("TASK24_BROWSER_NATIVE: " + Buffer.from(stderr).toString("utf8").slice(-8192))
    const result = decodeWindowsBrowserNativeResult(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout)),
      {
        browser,
        stdoutLimit: invocation.maxStdoutBytes,
        stderrLimit: invocation.maxStderrBytes,
      },
    )
    cleanupSafe = true
    if (canonicalJson(await fileIdentity(input.helper.path)) !== canonicalJson(input.helper))
      throw new TypeError("TASK24_BROWSER_HELPER_DRIFT")
    return invocation.signal.aborted || cancelled
      ? { ...result, execution: { ...result.execution, exitCode: 130, truncated: true } }
      : result
  } catch (cause) {
    if (!cleanupSafe)
      throw Object.assign(new Error("TASK24_BROWSER_CLEANUP_UNCERTAIN: " + root, { cause }), {
        root,
        cleanupUncertain: true,
      })
    throw cause
  } finally {
    clearTimeout(timer)
    clearTimeout(emergency)
    invocation.signal.removeEventListener("abort", cancel)
    if (child) {
      void Promise.resolve(child.stdin.end()).catch(() => {})
      if (child.exitCode === null) child.kill()
      let wait: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          child.exited,
          new Promise<never>((_, reject) => {
            wait = setTimeout(() => reject(new Error("TASK24_BROWSER_SUPERVISOR_UNSETTLED")), 5000)
          }),
        ])
      } catch (cause) {
        cleanupSafe = false
        throw Object.assign(new Error("TASK24_BROWSER_CLEANUP_UNCERTAIN: " + root, { cause }), {
          root,
          cleanupUncertain: true,
        })
      } finally {
        clearTimeout(wait)
      }
    }
    if (cleanupSafe) await scope.dispose()
  }
}
