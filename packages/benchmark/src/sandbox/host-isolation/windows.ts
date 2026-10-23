import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { Schema } from "effect"
import { FileIdentity, requireDPath, type DockerExecution } from "../contracts"
import { fileIdentity, directoryIdentity } from "../storage"
import { canonicalJson } from "../../campaign/canonical"
import { sha256Text } from "../../hash"
import { desktopProbeBootstrap } from "../desktop/probe-worker"
export { runWindowsBrowserProtocol } from "./windows-browser"

const Request = Schema.Struct({
  executable: FileIdentity,
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  readonly: Schema.Array(Schema.String),
  mediated: Schema.optionalKey(Schema.Array(Schema.String)),
  writable: Schema.Array(Schema.String),
  ports: Schema.Array(Schema.Int),
  root: Schema.String,
  timeoutMs: Schema.Int,
  maxStdoutBytes: Schema.Int,
  maxStderrBytes: Schema.Int,
  environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  ancestorMetadata: Schema.optionalKey(Schema.Literal(true)),
})
const NativeResult = Schema.Struct({
  started: Schema.Boolean,
  exitCode: Schema.Int,
  stdout: Schema.String,
  stderr: Schema.String,
  truncated: Schema.Boolean,
  containment: Schema.Struct({
    appContainer: Schema.Boolean,
    sid: Schema.String,
    processTreeEnded: Schema.Literal(true),
    dynamicNetworkPolicy: Schema.Boolean,
    cleanupCompleted: Schema.Literal(true),
    persistentNetworkPolicy: Schema.Boolean,
    persistentPolicyRetired: Schema.Literal(true),
    policyJournal: Schema.String,
    profilePath: Schema.String,
    ancestorMetadataPaths: Schema.optionalKey(Schema.Array(Schema.String)),
    ancestorMetadataRetired: Schema.optionalKey(Schema.Literal(true)),
  }),
})
const BrowserNativeResult = Schema.Struct({
  started: Schema.Boolean,
  exitCode: Schema.Int,
  stdout: Schema.String,
  stderr: Schema.String,
  truncated: Schema.Boolean,
  containment: Schema.Struct({
    processTreeEnded: Schema.Literal(true),
    dynamicNetworkPolicy: Schema.Boolean,
    cleanupCompleted: Schema.Literal(true),
    persistentNetworkPolicy: Schema.Boolean,
    persistentPolicyRetired: Schema.Literal(true),
    policyJournal: Schema.String,
    browserPath: Schema.String,
    renderers: Schema.Array(
      Schema.Struct({
        pid: Schema.Int,
        appContainer: Schema.Boolean,
        restricted: Schema.Boolean,
        integrity: Schema.Int,
      }),
    ),
    metadataRegistrations: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        sid: Schema.String,
        defaultPathAbsent: Schema.Literal(true),
        unregistered: Schema.Literal(true),
      }),
    ),
  }),
})
const PolicyState = Schema.Struct({
  policyJournal: Schema.String,
  kind: Schema.Literals(["sid", "appid"]),
  jobName: Schema.String,
  jobState: Schema.Literals(["active", "empty", "absent"]),
  jobActiveProcesses: Schema.NullOr(Schema.Int),
  supervisorPID: Schema.Int,
  supervisorCreatedFileTime: Schema.String,
  supervisorState: Schema.Literals(["alive", "dead", "unknown"]),
  persistentNetworkPolicy: Schema.Boolean,
  persistentPolicyRetired: Schema.Boolean,
  objects: Schema.Struct({ sublayer: Schema.Boolean, ipv4: Schema.Boolean, ipv6: Schema.Boolean }),
  retirementPerformed: Schema.Boolean,
  recoveryScope: Schema.Literal("network-policy-only"),
})
const inside = (value: string, root: string) =>
  value.toLowerCase() === root.toLowerCase() || value.toLowerCase().startsWith(root.toLowerCase() + "\\")
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a)
const workspacePath = /^D:\\OpenCode-Benchmark\\Task24\\(?:tmp|workspaces)\\[^\\]+(?:\\.*)?$/i
const toolchainPath = /^D:\\OpenCode-Benchmark\\Task24\\toolchain\\[^\\]+(?:\\.*)?$/i
const pathEnvironment = new Set([
  "OPENCODE_TEST_HOME",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG",
  "OPENCODE_BENCHMARK_TRANSPORT_FILE",
  "OPENCODE_BENCHMARK_RUN_DATA_ROOT",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
])
const valueEnvironment = new Set([
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_DISABLE_DEFAULT_PLUGINS",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_MODELS_FETCH",
  "OPENCODE_DISABLE_PRUNE",
  "OPENCODE_PERMISSION",
  "OPENCODE_BENCHMARK_CAMPAIGN_ID",
  "OPENCODE_BENCHMARK_RUN_ID",
  "TASK24_BROKER_GRANT",
  "TASK24_PUBLIC_TOOL_CAPABILITY",
  "MOONSHOT_API_KEY",
  "DEEPSEEK_API_KEY",
])
const supervisorStdoutLimit = 3 * 1048576 + 131072
const supervisorStderrLimit = 65536
const cancelledBeforeStart = (): WindowsSandboxResult => ({
  execution: { started: false, exitCode: 130, stdout: new Uint8Array(), stderr: new Uint8Array(), truncated: false },
  containment: {
    appContainer: false,
    sid: "",
    processTreeEnded: true,
    dynamicNetworkPolicy: false,
    cleanupCompleted: true,
    persistentNetworkPolicy: false,
    persistentPolicyRetired: true,
    policyJournal: "",
    profilePath: "",
  },
})

// Internal native wire identities must never round NTFS's 64-bit file index through Number.
// Keep the external storage.ts identity contract unchanged; its check also validates ancestors.
async function exactDirectoryIdentity(directory: string): Promise<string> {
  await directoryIdentity(directory)
  const stat = await fs.lstat(directory, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("TASK24_ISOLATION_DIRECTORY_IDENTITY")
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}

/** Admission only: native repeats this walk with pinned handles before any inherited ACL mutation. */
async function assertWindowsGrantTrees(roots: readonly string[]): Promise<void> {
  let entries = 0
  const inspect = async (file: string) => {
    requireDPath(file)
    const stat = await fs.lstat(file)
    if (
      stat.isSymbolicLink() ||
      (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) ||
      (await fs.realpath(file)).toLowerCase() !== file.toLowerCase()
    )
      throw new TypeError("TASK24_ISOLATION_TREE")
    return stat
  }
  const walk = async (directory: string, depth: number): Promise<void> => {
    const names = new Set<string>()
    // Stream directory entries so an oversized directory cannot allocate an unbounded listing.
    for await (const entry of await fs.opendir(directory)) {
      if (++entries > 25000 || depth >= 128 || names.has(entry.name.toLowerCase()))
        throw new TypeError("TASK24_ISOLATION_TREE")
      names.add(entry.name.toLowerCase())
      const child = path.join(directory, entry.name)
      const stat = await inspect(child)
      if (stat.isDirectory()) await walk(child, depth + 1)
    }
  }
  try {
    for (const root of roots) {
      if (!(await inspect(root)).isDirectory()) throw new TypeError("TASK24_ISOLATION_TREE")
      await walk(root, 0)
    }
  } catch (cause) {
    throw new TypeError("TASK24_ISOLATION_TREE", { cause })
  }
}

export type WindowsSandboxResult = {
  execution: DockerExecution
  containment: {
    appContainer: boolean
    sid: string
    processTreeEnded: boolean
    dynamicNetworkPolicy: boolean
    cleanupCompleted: boolean
    persistentNetworkPolicy: boolean
    persistentPolicyRetired: boolean
    policyJournal: string
    profilePath: string
    ancestorMetadataPaths?: readonly string[]
    ancestorMetadataRetired?: true
  }
}

/** Bound the helper protocol itself, not only the candidate output nested inside it. */
export async function readWindowsSupervisorStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) return Buffer.concat(chunks, size)
      if (item.value.length > limit - size) {
        await reader.cancel().catch(() => {})
        throw new TypeError("TASK24_ISOLATION_STREAM_LIMIT")
      }
      size += item.value.length
      chunks.push(item.value)
    }
  } finally {
    reader.releaseLock()
  }
}

/** Native success is evidence only when every containment cleanup has completed. */
export function decodeWindowsNativeResult(
  raw: unknown,
  expected: { stdoutLimit: number; stderrLimit: number; state: string },
): WindowsSandboxResult {
  const decoded = Schema.decodeUnknownOption(NativeResult)(raw, { onExcessProperty: "error" })
  if (decoded._tag !== "Some") throw new TypeError("TASK24_ISOLATION_PROTOCOL")
  const value = decoded.value
  const sid = value.containment.sid
  if (!value.containment.appContainer || !value.containment.dynamicNetworkPolicy) {
    if (
      value.started ||
      value.exitCode !== 130 ||
      value.stdout !== "" ||
      value.stderr !== "" ||
      value.truncated ||
      value.containment.appContainer ||
      value.containment.dynamicNetworkPolicy ||
      value.containment.persistentNetworkPolicy ||
      value.containment.policyJournal !== "" ||
      sid !== "" ||
      value.containment.profilePath !== ""
    )
      throw new TypeError("TASK24_ISOLATION_PROTOCOL")
    return cancelledBeforeStart()
  }
  try {
    requireDPath(value.containment.profilePath)
    if (
      !value.containment.profilePath.toLowerCase().startsWith(expected.state.toLowerCase() + "\\") ||
      !/^S-1-15-2-(?:\d+-){6}\d+$/.test(sid) ||
      sid
        .split("-")
        .slice(4)
        .some((part) => Number(part) > 0xffffffff) ||
      !value.started ||
      !value.containment.persistentNetworkPolicy ||
      value.containment.policyJournal !== path.join(path.dirname(expected.state), "network-policy.intent.json") ||
      value.exitCode < -2147483648 ||
      value.exitCode > 2147483647
    )
      throw new Error("native identity")
    const bytes = (text: string, limit: number) => {
      if (
        text.length > Math.ceil(limit / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
      )
        throw new Error("native base64")
      const result = Buffer.from(text, "base64")
      if (result.length > limit || result.toString("base64") !== text) throw new Error("native output size")
      return result
    }
    return {
      execution: {
        started: value.started,
        exitCode: value.exitCode,
        stdout: bytes(value.stdout, expected.stdoutLimit),
        stderr: bytes(value.stderr, expected.stderrLimit),
        truncated: value.truncated,
      },
      containment: value.containment,
    }
  } catch {
    throw new TypeError("TASK24_ISOLATION_PROTOCOL")
  }
}

/** Validates native observations, not browser/helper trust or full runtime readiness. */
export function decodeWindowsBrowserNativeResult(
  raw: unknown,
  expected: { browser: string; stdoutLimit: number; stderrLimit: number },
) {
  try {
    requireDPath(expected.browser)
    const decoded = Schema.decodeUnknownOption(BrowserNativeResult)(raw, { onExcessProperty: "error" })
    if (decoded._tag !== "Some") throw new Error("browser native shape")
    const value = decoded.value
    const renderers = value.containment.renderers
    const metadata = value.containment.metadataRegistrations
    const suffix = createHash("sha1").update(expected.browser, "utf8").digest("hex").toUpperCase()
    const names = new Set(["xr", "cdm", "net", "odm", "prnc", "pxy"].map((type) => "cr.sb." + type + suffix))
    if (
      value.containment.browserPath !== expected.browser ||
      (value.containment.persistentNetworkPolicy
        ? value.containment.policyJournal !==
          path.join(path.dirname(path.dirname(expected.browser)), "network-policy.intent.json")
        : value.containment.policyJournal !== "") ||
      value.containment.persistentNetworkPolicy !== value.containment.dynamicNetworkPolicy ||
      value.exitCode < -2147483648 ||
      value.exitCode > 2147483647 ||
      (value.started && (!value.containment.dynamicNetworkPolicy || metadata.length !== 6)) ||
      (!value.started &&
        (value.exitCode !== 130 ||
          value.stdout !== "" ||
          value.stderr !== "" ||
          value.truncated ||
          renderers.length !== 0 ||
          (value.containment.dynamicNetworkPolicy ? metadata.length !== 6 : metadata.length !== 0))) ||
      (value.started && value.exitCode === 0 && !value.truncated && renderers.length === 0) ||
      renderers.length > 4096 ||
      new Set(renderers.map((renderer) => renderer.pid)).size !== renderers.length ||
      renderers.some(
        (renderer) =>
          renderer.pid < 1 ||
          renderer.pid > 0xffffffff ||
          renderer.integrity < 0 ||
          renderer.integrity > 2147483647 ||
          !(renderer.appContainer || (renderer.restricted && renderer.integrity <= 4096)),
      ) ||
      (metadata.length !== 0 && metadata.length !== 6) ||
      new Set(metadata.map((item) => item.name)).size !== metadata.length ||
      new Set(metadata.map((item) => item.sid)).size !== metadata.length ||
      metadata.some(
        (item) =>
          !names.has(item.name) ||
          !/^S-1-15-2-(?:\d+-){6}\d+$/.test(item.sid) ||
          item.sid
            .split("-")
            .slice(4)
            .some((part) => Number(part) > 0xffffffff),
      )
    )
      throw new Error("browser native observations")
    const bytes = (text: string, limit: number, maximum: number) => {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > maximum ||
        text.length > Math.ceil(limit / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
      )
        throw new Error("browser native output")
      const result = Buffer.from(text, "base64")
      if (result.length > limit || result.toString("base64") !== text) throw new Error("browser native output size")
      return result
    }
    return {
      execution: {
        started: value.started,
        exitCode: value.exitCode,
        stdout: bytes(value.stdout, expected.stdoutLimit, 2097152),
        stderr: bytes(value.stderr, expected.stderrLimit, 65536),
        truncated: value.truncated,
      },
      containment: value.containment,
    }
  } catch {
    throw new TypeError("TASK24_BROWSER_NATIVE_PROTOCOL")
  }
}

/** A missing job is an observation, never proof permitting recovery. */
export function decodeWindowsPolicyState(raw: unknown, expected: { journal: string; recover: boolean }) {
  try {
    requireDPath(expected.journal)
    const decoded = Schema.decodeUnknownOption(PolicyState)(raw, { onExcessProperty: "error" })
    if (decoded._tag !== "Some") throw new Error("policy shape")
    const value = decoded.value
    if (
      value.policyJournal !== expected.journal ||
      !/^Global\\opencode-task24-policy-[a-f0-9]{32}$/.test(value.jobName) ||
      value.supervisorPID < 1 ||
      value.supervisorPID > 0xffffffff ||
      !/^[1-9][0-9]{0,19}$/.test(value.supervisorCreatedFileTime) ||
      BigInt(value.supervisorCreatedFileTime) > 0xffffffffffffffffn ||
      (value.jobState === "active"
        ? value.jobActiveProcesses === null || value.jobActiveProcesses < 1 || value.jobActiveProcesses > 64
        : value.jobState === "empty"
          ? value.jobActiveProcesses !== 0
          : value.jobActiveProcesses !== null) ||
      !Object.values(value.objects).every((present) => present === value.persistentNetworkPolicy) ||
      value.persistentPolicyRetired === value.persistentNetworkPolicy ||
      (!expected.recover && value.retirementPerformed) ||
      (expected.recover &&
        (value.supervisorState !== "dead" || value.jobState !== "empty" || !value.persistentPolicyRetired))
    )
      throw new Error("policy observations")
    return value
  } catch {
    throw new TypeError("TASK24_WINDOWS_POLICY_PROTOCOL")
  }
}

export async function inspectWindowsNetworkPolicy(raw: unknown) {
  const { runWindowsPolicyOperation } = await import("./windows-policy")
  return runWindowsPolicyOperation(raw, "inspect")
}

export async function recoverWindowsNetworkPolicy(raw: unknown) {
  const { runWindowsPolicyOperation } = await import("./windows-policy")
  return runWindowsPolicyOperation(raw, "recover")
}

export async function readWindowsIsolationSource() {
  return (
    await Promise.all(
      ["windows-native.cs", "windows-policy-native.cs", "windows-browser-native.cs"].map((file) =>
        fs.readFile(path.join(import.meta.dir, file), "utf8"),
      ),
    )
  ).join("\n")
}

/**
 * Low-level Windows worker, not a HostIsolationAdapter or an acceptance receipt.
 * Cooperative cancellation unwinds its owned SID grants, registration and WFP session.
 * A forced supervisor failure stays blocked and preserves the ownership record; it does
 * not imply successful crash recovery. Chromium's main broker is not admitted by this API.
 */
export async function runWindowsSandbox(raw: unknown): Promise<WindowsSandboxResult> {
  const signal = Reflect.get(Object(raw), "signal") as AbortSignal | undefined
  const stdin = Reflect.get(Object(raw), "stdin") as Uint8Array | undefined
  const filtered = Object.fromEntries(
    Object.entries(Object(raw)).filter(([key]) => key !== "signal" && key !== "stdin"),
  )
  const parsed = Schema.decodeUnknownOption(Request)(filtered, { onExcessProperty: "error" })
  if (parsed._tag !== "Some") throw new TypeError("TASK24_ISOLATION_INPUT")
  const input = parsed.value
  const mediated = input.mediated ?? []
  const dirs = [input.root, input.cwd, ...input.readonly, ...mediated, ...input.writable]
  if (
    dirs.some((dir) => {
      try {
        requireDPath(dir)
      } catch {
        return true
      }
      return (
        dir.length > 4096 || !(workspacePath.test(dir) || (input.readonly.includes(dir) && toolchainPath.test(dir)))
      )
    }) ||
    !workspacePath.test(input.root) ||
    !workspacePath.test(input.cwd) ||
    input.writable.some((dir) => !workspacePath.test(dir)) ||
    input.readonly.length + mediated.length > 64 ||
    input.writable.length > 64 ||
    new Set([...input.readonly, ...mediated, ...input.writable].map((dir) => dir.toLowerCase())).size !==
      input.readonly.length + mediated.length + input.writable.length ||
    [...input.readonly, ...mediated, ...input.writable].some((dir) => overlaps(input.root, dir)) ||
    ![...input.readonly, ...mediated, ...input.writable].some((dir) => inside(input.cwd, dir)) ||
    input.ports.length > 64 ||
    !input.ports.every((port) => port >= 1024 && port <= 65535) ||
    new Set(input.ports).size !== input.ports.length ||
    input.executable.path.length > 4096 ||
    input.argv.length > 256 ||
    input.argv.some((arg) => arg.includes("\0")) ||
    input.executable.path.length * 2 + input.argv.reduce((length, arg) => length + arg.length * 2 + 3, 2) > 32766 ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 600000 ||
    input.maxStdoutBytes < 1 ||
    input.maxStdoutBytes > 2097152 ||
    input.maxStderrBytes < 1 ||
    input.maxStderrBytes > 65536 ||
    !(signal instanceof AbortSignal) ||
    !(stdin === undefined || stdin instanceof Uint8Array) ||
    (stdin?.length ?? 0) > 2097152 ||
    input.readonly.some((read) => input.writable.some((write) => overlaps(read, write))) ||
    mediated.some((read) => [...input.readonly, ...input.writable].some((other) => overlaps(read, other))) ||
    mediated.some((read, i) => mediated.some((other, j) => i !== j && overlaps(read, other))) ||
    Object.keys(input.environment ?? {}).length > 64 ||
    Object.entries(input.environment ?? {}).some(
      ([key, value]) =>
        (!pathEnvironment.has(key) && !valueEnvironment.has(key)) ||
        (key === "TASK24_PUBLIC_TOOL_CAPABILITY" && !/^[a-f0-9]{64}$/.test(value)) ||
        value.includes("\0") ||
        value.length > 65536 ||
        (pathEnvironment.has(key) &&
          (() => {
            try {
              requireDPath(value)
            } catch {
              return true
            }
            return value.length > 4096 || !input.writable.some((dir) => inside(value, dir))
          })()),
    ) ||
    Object.entries(input.environment ?? {}).reduce((size, [key, value]) => size + key.length + value.length + 2, 0) >
      262144
  )
    throw new TypeError("TASK24_ISOLATION_INPUT")
  if (process.platform !== "win32" || process.arch !== "x64") throw new TypeError("TASK24_ISOLATION_PLATFORM")
  if (signal.aborted) return cancelledBeforeStart()
  const admittedDirectories = await Promise.all(
    [...new Set(dirs)].map(async (dir) => ({ path: dir, fileID: await exactDirectoryIdentity(dir) })),
  )
  await assertWindowsGrantTrees([...input.readonly, ...mediated, ...input.writable])
  if (canonicalJson(await fileIdentity(input.executable.path)) !== canonicalJson(input.executable))
    throw new TypeError("TASK24_ISOLATION_BINARY_CHANGED")
  if (signal.aborted) return cancelledBeforeStart()
  const nonce = randomBytes(16).toString("hex")
  const profile = "opencode.task24." + nonce
  const owner = canonicalJson({ purpose: "task24-windows-native-isolation", nonce, profile })
  let root: string | undefined,
    rootIdentity: string | undefined,
    ownerWritten = false
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined, emergencyTimer: ReturnType<typeof setTimeout> | undefined
  let initialSent = false,
    cancellationRequested = false,
    cancelSent = false,
    emergencyTerminated = false
  let cleanupVerified = true,
    failure: unknown
  const cancel = () => {
    cancellationRequested = true
    if (!child || !initialSent || cancelSent) return
    cancelSent = true
    emergencyTimer = setTimeout(() => {
      emergencyTerminated = true
      child?.kill()
    }, 10000)
    try {
      child.stdin.write("cancel\n")
      void Promise.resolve(child.stdin.flush()).catch(() => {
        if (child) void Promise.resolve(child.stdin.end()).catch(() => {})
      })
    } catch {
      void Promise.resolve(child.stdin.end()).catch(() => {})
    }
  }
  try {
    root = await fs.mkdtemp(path.join(input.root, "native-isolation-"))
    rootIdentity = await exactDirectoryIdentity(root)
    await fs.writeFile(path.join(root, "owner.json"), owner, { flag: "wx" })
    ownerWritten = true
    const runtime = path.join(root, "runtime"),
      state = path.join(root, "state"),
      compiler = path.join(root, "compiler")
    await fs.mkdir(runtime)
    await fs.mkdir(state)
    await fs.mkdir(compiler)
    const exe = path.join(runtime, path.basename(input.executable.path))
    await fs.copyFile(input.executable.path, exe, fs.constants.COPYFILE_EXCL)
    const exeIdentity = await fileIdentity(exe)
    if (exeIdentity.sha256 !== input.executable.sha256) throw new TypeError("TASK24_ISOLATION_BINARY_CHANGED")
    const exactExe = await fs.lstat(exe, { bigint: true })
    if (!exactExe.isFile() || exactExe.isSymbolicLink() || exactExe.nlink !== 1n)
      throw new TypeError("TASK24_ISOLATION_BINARY_CHANGED")
    const nativeExeIdentity = { ...exeIdentity, fileID: `${exactExe.dev}:${exactExe.ino}:${exactExe.birthtimeNs}` }
    const directories = [
      ...admittedDirectories,
      { path: root, fileID: rootIdentity },
      ...(await Promise.all(
        [runtime, state, compiler].map(async (dir) => ({ path: dir, fileID: await exactDirectoryIdentity(dir) })),
      )),
    ]
    const nativeSource = await readWindowsIsolationSource()
    const script = String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$p=[Console]::ReadLine()|ConvertFrom-Json
${desktopProbeBootstrap}
try {
 Add-Type -TypeDefinition $p.source -ReferencedAssemblies @('System.Web.Extensions','System.Core')
 [Console]::Write([Task24NativeIsolation]::Run([string]$p.exe,[string[]]$p.argv,[string]$p.workingDirectory,[string[]]$p.readonly,[string[]]$p.writable,[int[]]$p.ports,[string]$p.environment,[string]$p.input,[int]$p.timeoutMs,[int]$p.stdoutLimit,[int]$p.stderrLimit,[string]$p.pins))
} catch {
 [Console]::Error.WriteLine($_.Exception.ToString());throw
} finally {
 # CodeDOM can leave an empty protected DACL on its own private temp directories. Restore only
 # immediate compiler children in this fresh controller-owned directory; candidates cannot access it.
 $acl=[IO.Directory]::GetAccessControl([string]$p.compiler,[Security.AccessControl.AccessControlSections]::Access).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
 foreach($dir in [IO.Directory]::GetDirectories([string]$p.compiler)) {
  if(([IO.File]::GetAttributes($dir) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'compiler reparse point'}
  $restore=[Security.AccessControl.DirectorySecurity]::new()
  $restore.SetSecurityDescriptorSddlForm($acl,[Security.AccessControl.AccessControlSections]::Access)
  [IO.Directory]::SetAccessControl($dir,$restore)
 }
}`
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
      BUN_OPTIONS: "--no-env-file",
      BUN_INSTALL_CACHE_DIR: state,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      npm_config_cache: state,
      XDG_DATA_HOME: state,
      XDG_CONFIG_HOME: state,
      XDG_CACHE_HOME: state,
      XDG_STATE_HOME: state,
      NODE_DISABLE_COMPILE_CACHE: "1",
      PSModuleAnalysisCachePath: path.join(state, "ModuleAnalysisCache"),
    }
    if (signal.aborted) return cancelledBeforeStart()
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
    timer = setTimeout(cancel, input.timeoutMs + 20000)
    signal.addEventListener("abort", cancel, { once: true })
    const completed = Promise.all([
      readWindowsSupervisorStream(child.stdout, supervisorStdoutLimit),
      readWindowsSupervisorStream(child.stderr, supervisorStderrLimit),
      child.exited,
    ])
    void completed.catch(() => {}) // Observe a pipe failure even while the initial stdin flush is pending.
    // Once the request can reach native code, only verified native cleanup permits directory removal.
    cleanupVerified = false
    child.stdin.write(
      canonicalJson({
        cwd: root,
        tempIdentity: rootIdentity,
        tempOwnerSha256: sha256Text(owner),
        source: nativeSource,
        exe,
        argv: input.argv,
        workingDirectory: input.cwd,
        compiler,
        readonly: [runtime, ...input.readonly, ...mediated],
        writable: [state, ...input.writable],
        ports: input.ports,
        environment: canonicalJson({ ...environment, ...input.environment }),
        input: Buffer.from(stdin ?? []).toString("base64"),
        timeoutMs: input.timeoutMs,
        stdoutLimit: input.maxStdoutBytes,
        stderrLimit: input.maxStderrBytes,
        pins: canonicalJson({
          exe: nativeExeIdentity,
          directories,
          profile,
          mediatedRoots: mediated,
          ancestorMetadata: input.ancestorMetadata === true,
          policyJournal: path.join(root, "network-policy.intent.json"),
        }),
      }) + "\n",
    )
    initialSent = true
    if (signal.aborted || cancellationRequested) cancel()
    await child.stdin.flush()
    if (signal.aborted || cancellationRequested) cancel()
    // Keep stdin open: native interprets controller EOF, or an explicit cancel line, as cancellation.
    const [output, errorOutput, exit] = await completed
    if (emergencyTerminated || exit !== 0)
      throw new TypeError(
        "TASK24_ISOLATION_NATIVE: exit=" +
          exit +
          " emergency=" +
          emergencyTerminated +
          ": " +
          Buffer.from(errorOutput).toString("utf8").slice(-8192),
      )
    let rawResult: unknown
    try {
      rawResult = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output))
    } catch {
      throw new TypeError("TASK24_ISOLATION_PROTOCOL")
    }
    const result = decodeWindowsNativeResult(rawResult, {
      stdoutLimit: input.maxStdoutBytes,
      stderrLimit: input.maxStderrBytes,
      state,
    })
    cleanupVerified = true
    return signal.aborted || cancellationRequested
      ? { ...result, execution: { ...result.execution, exitCode: 130, truncated: true } }
      : result
  } catch (error) {
    failure = error
    if (!cleanupVerified)
      throw Object.assign(new Error("TASK24_ISOLATION_CLEANUP_UNCERTAIN: " + root, { cause: error }), {
        cleanupUncertain: true,
        root,
        profile,
      })
    throw error
  } finally {
    clearTimeout(timer)
    clearTimeout(emergencyTimer)
    signal.removeEventListener("abort", cancel)
    if (child) {
      const finalizationFailures: unknown[] = []
      try {
        void Promise.resolve(child.stdin.end()).catch(() => {})
      } catch {}
      try {
        if (child.exitCode === null) child.kill()
      } catch (error) {
        finalizationFailures.push(error)
      }
      let waitTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          child.exited,
          new Promise<never>((_, reject) => {
            waitTimer = setTimeout(() => reject(new Error("TASK24_ISOLATION_SUPERVISOR_DID_NOT_END")), 5000)
          }),
        ])
      } catch (error) {
        finalizationFailures.push(error)
      } finally {
        clearTimeout(waitTimer)
      }
      if (finalizationFailures.length) {
        cleanupVerified = false
        throw Object.assign(
          new AggregateError(
            failure ? [failure, ...finalizationFailures] : finalizationFailures,
            "TASK24_ISOLATION_CLEANUP_UNCERTAIN: " + root,
          ),
          { cleanupUncertain: true, root, profile },
        )
      }
    }
    if (root && cleanupVerified) {
      try {
        if (
          !rootIdentity ||
          (await exactDirectoryIdentity(root)) !== rootIdentity ||
          (await fs.realpath(root)).toLowerCase() !== root.toLowerCase() ||
          (ownerWritten && (await fileIdentity(path.join(root, "owner.json"))).sha256 !== sha256Text(owner))
        )
          throw new Error("TASK24_ISOLATION_CLEANUP_IDENTITY: " + root)
        await fs.rm(root, { recursive: true, force: true })
      } catch (error) {
        throw failure ? new AggregateError([failure, error], "isolation and own cleanup failed") : error
      }
    }
  }
}
