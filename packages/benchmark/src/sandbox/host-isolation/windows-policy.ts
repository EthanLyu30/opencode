import fs from "node:fs/promises"
import type { BigIntStats } from "node:fs"
import path from "node:path"
import { randomBytes, createHash } from "node:crypto"
import { Schema } from "effect"
import { FileIdentity, requireDPath } from "../contracts"
import { directoryIdentity } from "../storage"
import { canonicalJson } from "../../campaign/canonical"
import { sha256Text } from "../../hash"
import { desktopProbeBootstrap } from "../desktop/probe-worker"
import { decodeWindowsPolicyState, readWindowsIsolationSource, readWindowsSupervisorStream } from "./windows"

const Request = Schema.Struct({ journal: FileIdentity, root: Schema.String })
const scope = /^D:\\OpenCode-Benchmark\\Task24\\(?:tmp|workspaces)\\[^\\]+(?:\\.*)?$/i

export async function runWindowsPolicyOperation(raw: unknown, operation: "inspect" | "recover") {
  const signal = Reflect.get(Object(raw), "signal") as AbortSignal | undefined
  const parsed = Schema.decodeUnknownOption(Request)(
    Object.fromEntries(Object.entries(Object(raw)).filter(([key]) => key !== "signal")),
    { onExcessProperty: "error" },
  )
  if (parsed._tag !== "Some") throw new TypeError("TASK24_WINDOWS_POLICY_INPUT")
  const input = parsed.value
  try {
    requireDPath(input.root)
    requireDPath(input.journal.path)
    if (
      !scope.test(input.root) ||
      !scope.test(input.journal.path) ||
      path.basename(input.journal.path) !== "network-policy.intent.json" ||
      !(signal instanceof AbortSignal)
    )
      throw new Error("policy request")
  } catch {
    throw new TypeError("TASK24_WINDOWS_POLICY_INPUT")
  }
  if (signal.aborted) throw new Error("TASK24_WINDOWS_POLICY_ABORTED")
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("TASK24_ISOLATION_PLATFORM")
  await directoryIdentity(input.root)
  await directoryIdentity(path.dirname(input.journal.path))
  const stat = await fs.lstat(input.journal.path, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
    throw new Error("TASK24_WINDOWS_POLICY_JOURNAL_CHANGED")
  if (stat.size > 65536n) throw new Error("TASK24_WINDOWS_POLICY_JOURNAL_LIMIT")
  const handle = await fs.open(input.journal.path, "r")
  try {
    const opened = await handle.stat({ bigint: true })
    if (`${opened.dev}:${opened.ino}:${opened.birthtimeNs}` !== `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`)
      throw new Error("TASK24_WINDOWS_POLICY_JOURNAL_CHANGED")
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(8192)
    let length = 0
    for (;;) {
      if (signal.aborted) throw new Error("TASK24_WINDOWS_POLICY_ABORTED")
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, length)
      if (bytesRead === 0) break
      length += bytesRead
      if (length > 65536) throw new Error("TASK24_WINDOWS_POLICY_JOURNAL_LIMIT")
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = await fs.lstat(input.journal.path, { bigint: true }),
      legacy = await handle.stat()
    if (
      `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.size}:${stat.mtimeNs}` !==
        `${after.dev}:${after.ino}:${after.birthtimeNs}:${after.size}:${after.mtimeNs}` ||
      length !== Number(stat.size) ||
      input.journal.fileID !== `${legacy.dev}:${legacy.ino}:${legacy.birthtimeMs}` ||
      input.journal.sha256 !== hash.digest("hex")
    )
      throw new Error("TASK24_WINDOWS_POLICY_JOURNAL_CHANGED")
  } finally {
    await handle.close()
  }
  const pin = { ...input.journal, fileID: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` }
  const root = await fs.mkdtemp(path.join(input.root, "policy-operation-"))
  let original: BigIntStats | undefined
  const owner = canonicalJson({
    purpose: "task24-windows-policy-operation",
    nonce: randomBytes(16).toString("hex"),
    operation,
    journal: input.journal,
  })
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let ended = false,
    ownerWritten = false,
    failure: unknown
  let interrupt!: (error: Error) => void
  const interrupted = new Promise<never>((_, reject) => {
    interrupt = reject
  })
  void interrupted.catch(() => {})
  const stop = (reason: string) => {
    interrupt(new Error(reason))
    try {
      child?.kill()
    } catch {}
  }
  const cancel = () => stop("TASK24_WINDOWS_POLICY_ABORTED")
  try {
    original = await fs.lstat(root, { bigint: true })
    await fs.writeFile(path.join(root, "owner.json"), owner, { flag: "wx" })
    ownerWritten = true
    const compiler = path.join(root, "compiler"),
      state = path.join(root, "state")
    await fs.mkdir(compiler)
    await fs.mkdir(state)
    const source = await readWindowsIsolationSource()
    const script = String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$p=[Console]::ReadLine()|ConvertFrom-Json
${desktopProbeBootstrap}
try {
 Add-Type -TypeDefinition $p.source -ReferencedAssemblies @('System.Web.Extensions','System.Core')
 if($p.operation -eq 'inspect'){[Console]::Write([Task24NativeIsolation]::InspectPersistentPolicy([string]$p.pin))}
 elseif($p.operation -eq 'recover'){[Console]::Write([Task24NativeIsolation]::RecoverPersistentPolicy([string]$p.pin))}
 else {throw 'unknown exact policy operation'}
} catch {
 [Console]::Error.WriteLine($_.Exception.ToString());throw
} finally {
 $acl=[IO.Directory]::GetAccessControl([string]$p.compiler,[Security.AccessControl.AccessControlSections]::Access).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
 foreach($dir in [IO.Directory]::GetDirectories([string]$p.compiler)) {
  if(([IO.File]::GetAttributes($dir) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'compiler reparse point'}
  $restore=[Security.AccessControl.DirectorySecurity]::new();$restore.SetSecurityDescriptorSddlForm($acl,[Security.AccessControl.AccessControlSections]::Access);[IO.Directory]::SetAccessControl($dir,$restore)
 }
}`
    if (signal.aborted) throw new Error("TASK24_WINDOWS_POLICY_ABORTED")
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
        env: {
          SystemRoot: "C:\\Windows",
          WINDIR: "C:\\Windows",
          PATH: "C:\\Windows\\System32",
          HOME: state,
          USERPROFILE: state,
          APPDATA: state,
          LOCALAPPDATA: state,
          TEMP: compiler,
          TMP: compiler,
          TMPDIR: compiler,
          PSModuleAnalysisCachePath: path.join(state, "ModuleAnalysisCache"),
          NODE_DISABLE_COMPILE_CACHE: "1",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    timer = setTimeout(() => stop("TASK24_WINDOWS_POLICY_TIMEOUT"), 60000)
    signal.addEventListener("abort", cancel, { once: true })
    const complete = Promise.all([
      readWindowsSupervisorStream(child.stdout, 65536),
      readWindowsSupervisorStream(child.stderr, 65536),
      child.exited,
    ])
    void complete.catch(() => {})
    child.stdin.write(
      canonicalJson({
        cwd: root,
        tempIdentity: `${original.dev}:${original.ino}:${original.birthtimeNs}`,
        tempOwnerSha256: sha256Text(owner),
        source,
        compiler,
        operation,
        pin: canonicalJson(pin),
      }) + "\n",
    )
    await Promise.race([Promise.resolve(child.stdin.flush()), interrupted])
    await Promise.race([Promise.resolve(child.stdin.end()), interrupted])
    if (signal.aborted) cancel()
    const [stdout, stderr, exit] = await Promise.race([complete, interrupted])
    ended = true
    if (exit !== 0)
      throw new Error(
        "TASK24_WINDOWS_POLICY_NATIVE: " + exit + ": " + Buffer.from(stderr).toString("utf8").slice(-8192),
      )
    if (signal.aborted) throw new Error("TASK24_WINDOWS_POLICY_ABORTED")
    return decodeWindowsPolicyState(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout)), {
      journal: input.journal.path,
      recover: operation === "recover",
    })
  } catch (error) {
    failure = error
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", cancel)
    const errors: unknown[] = []
    if (child) {
      try {
        if (child.exitCode === null) child.kill()
      } catch (error) {
        errors.push(error)
      }
      let wait: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          child.exited,
          new Promise<never>((_, reject) => {
            wait = setTimeout(() => reject(new Error("TASK24_WINDOWS_POLICY_SUPERVISOR_DID_NOT_END")), 5000)
          }),
        ])
        ended = true
      } catch (error) {
        errors.push(error)
      } finally {
        clearTimeout(wait)
      }
    }
    if ((!child || ended) && errors.length === 0)
      try {
        const current = await fs.lstat(root, { bigint: true })
        if (
          !original ||
          current.dev !== original.dev ||
          current.ino !== original.ino ||
          current.birthtimeNs !== original.birthtimeNs ||
          (await fs.realpath(root)) !== root ||
          (ownerWritten && (await fs.readFile(path.join(root, "owner.json"), "utf8")) !== owner)
        )
          throw new Error("TASK24_WINDOWS_POLICY_TEMP_IDENTITY")
        let entries = 0
        const inspect = async (directory: string, depth: number): Promise<void> => {
          if (depth > 32) throw new Error("TASK24_WINDOWS_POLICY_TEMP_LIMIT")
          for await (const entry of await fs.opendir(directory)) {
            if (++entries > 4096) throw new Error("TASK24_WINDOWS_POLICY_TEMP_LIMIT")
            const file = path.join(directory, entry.name),
              stat = await fs.lstat(file)
            if (
              stat.isSymbolicLink() ||
              (await fs.realpath(file)) !== file ||
              (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
            )
              throw new Error("TASK24_WINDOWS_POLICY_TEMP_ALIAS")
            if (stat.isDirectory()) await inspect(file, depth + 1)
          }
        }
        await inspect(root, 0)
        await fs.rm(root, { recursive: true, force: true })
      } catch (error) {
        errors.push(error)
      }
    if (errors.length) {
      throw Object.assign(
        new AggregateError(failure ? [failure, ...errors] : errors, "TASK24_WINDOWS_POLICY_CLEANUP_UNCERTAIN: " + root),
        {
          cleanupUncertain: true,
          root,
          policyJournal: input.journal.path,
        },
      )
    }
  }
}
