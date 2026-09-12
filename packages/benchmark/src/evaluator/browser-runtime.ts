import { createHash, randomBytes } from "node:crypto"
import fsSync from "node:fs"
import path from "node:path"
import { canonicalJson } from "../campaign/canonical"
import { Task24Root } from "../root"
import {
  BROWSER_PROTOCOL_VERSION,
  captureRelativePath,
  decodeBrowserResponseLine,
  FIXED_VIEWPORTS,
  type BrowserCaptureRequest,
  type InteractionScriptID,
  type ViewportID,
  validateGrant,
} from "./browser-protocol"
import { captureTarget, validateCaptureOutputRoot, verifyPublishedCapture, type PublishedEvidence } from "./capture"

const manifestName = "task24-browser-runtime.manifest.json"
const maxManifestBytes = 2 * 1024 * 1024
const maxOutputBytes = 256 * 1024
const maxErrorBytes = 64 * 1024
const cancelGraceMs = 2_000

export interface BrowserReleaseFile {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
}

export interface BrowserReleaseManifest {
  readonly schemaVersion: 1
  readonly protocolVersion: 1
  readonly buildSha256: string
  readonly nodeFile: string
  readonly helperFile: string
  readonly browserExecutableFile: string
  readonly files: readonly BrowserReleaseFile[]
}

export interface BrowserRelease {
  readonly root: string
  readonly nodeExecutable: string
  readonly helper: string
  readonly browserExecutable: string
  readonly buildSha256: string
  readonly verify: () => void
}

export interface BrowserInvocation {
  readonly executable: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly stdin: string
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

export interface BrowserProcessResult {
  readonly started: boolean
  readonly exit: number
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
}

export interface BrowserProcessRunner {
  readonly execute: (input: BrowserInvocation) => Promise<BrowserProcessResult>
}

export interface BrowserRuntime {
  readonly capture: (input: BrowserRuntimeCaptureInput) => Promise<PublishedEvidence>
}

export interface BrowserRuntimeCaptureInput {
  readonly runID: string
  readonly previewID: string
  readonly previewURL: string
  readonly viewportID: ViewportID
  readonly readySelector: string
  readonly interactionScriptID: InteractionScriptID
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

export class BrowserCaptureFailure extends Error {
  readonly disposition: "unstarted" | "uncertain"
  readonly code: string

  constructor(code: string, disposition: "unstarted" | "uncertain", message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "BrowserCaptureFailure"
    this.code = code
    this.disposition = disposition
  }
}

export const productionBrowserRunner: BrowserProcessRunner = makeBrowserProcessRunner((command, options) =>
  Bun.spawn([...command], options),
)

export function browserBuildSha256(input: Omit<BrowserReleaseManifest, "buildSha256">): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex")
}

export function loadBrowserRelease(releaseRoot: string): BrowserRelease {
  const layout = Task24Root.ensure()
  const browserRoot = path.join(layout.toolchain, "browser")
  const root = exactDirectory(browserRoot, releaseRoot, "TASK24_BROWSER_RELEASE_ROOT_INVALID")
  if (!/^[a-f0-9]{64}$/.test(path.basename(root))) throw new TypeError("TASK24_BROWSER_RELEASE_ROOT_INVALID")
  const manifestPath = path.join(root, manifestName)
  const manifestBytes = readBoundedFile(manifestPath, maxManifestBytes, "TASK24_BROWSER_MANIFEST_INVALID")
  const raw = parseManifest(manifestBytes)
  const unsigned = {
    schemaVersion: raw.schemaVersion,
    protocolVersion: raw.protocolVersion,
    nodeFile: raw.nodeFile,
    helperFile: raw.helperFile,
    browserExecutableFile: raw.browserExecutableFile,
    files: raw.files,
  } satisfies Omit<BrowserReleaseManifest, "buildSha256">
  const buildSha256 = browserBuildSha256(unsigned)
  if (raw.buildSha256 !== buildSha256 || path.basename(root) !== buildSha256) {
    throw new TypeError("TASK24_BROWSER_MANIFEST_BUILD_INVALID")
  }
  const actual = listReleaseFiles(root).filter((entry) => entry.path !== manifestName)
  if (canonicalJson(actual) !== canonicalJson(raw.files)) throw new TypeError("TASK24_BROWSER_RELEASE_FILES_INVALID")
  const files = new Map(actual.map((entry) => [entry.path, entry]))
  for (const field of [raw.nodeFile, raw.helperFile, raw.browserExecutableFile]) {
    if (!files.has(field)) throw new TypeError("TASK24_BROWSER_MANIFEST_ENTRY_INVALID")
  }
  const identities = new Map(
    [manifestName, ...actual.map((entry) => entry.path)].map((relative) => [relative, fileIdentity(root, relative)]),
  )
  const verify = () => {
    for (const [relative, identity] of identities) {
      if (fileIdentity(root, relative) !== identity) throw new TypeError("TASK24_BROWSER_RELEASE_IDENTITY_CHANGED")
    }
  }
  verify()
  const release: BrowserRelease = {
    root,
    nodeExecutable: path.join(root, ...raw.nodeFile.split("/")),
    helper: path.join(root, ...raw.helperFile.split("/")),
    browserExecutable: path.join(root, ...raw.browserExecutableFile.split("/")),
    buildSha256,
    verify,
  }
  return Object.freeze(release)
}

export function makeBrowserRuntime(input: {
  readonly release: BrowserRelease
  readonly outputRoot: string
  readonly tempRoot: string
  readonly runner?: BrowserProcessRunner
  readonly grant?: () => string
  readonly requestID?: () => string
}): BrowserRuntime {
  const outputRoot = validateCaptureOutputRoot(input.outputRoot)
  const tempRoot = exactTaskTemp(input.tempRoot)
  const runner = input.runner ?? productionBrowserRunner
  const grant = input.grant ?? (() => randomBytes(32).toString("base64url"))
  const requestID = input.requestID ?? (() => randomBytes(16).toString("hex"))
  const runtime: BrowserRuntime = {
    capture: async (capture) => {
      const id = requestID()
      const token = validateGrant(grant())
      const relative = captureRelativePath(capture.runID, capture.previewID, capture.viewportID)
      const request: BrowserCaptureRequest = {
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        authorization: `Bearer ${token}`,
        requestID: id,
        runID: capture.runID,
        previewID: capture.previewID,
        previewURL: capture.previewURL,
        viewportID: capture.viewportID,
        viewport: FIXED_VIEWPORTS[capture.viewportID],
        wait: { kind: "selector", selector: capture.readySelector, frames: 2 },
        interactionScriptID: capture.interactionScriptID,
        outputRelativePath: relative,
        timeoutMs: capture.timeoutMs,
      }
      const target = captureTarget(outputRoot, relative)
      if (fsSync.existsSync(target)) throw new TypeError("TASK24_BROWSER_EVIDENCE_ALREADY_PUBLISHED")
      let prior: BrowserCaptureFailure | undefined
      for (let attempt = 0; attempt < 2; attempt++) {
        if (fsSync.existsSync(target)) {
          throw new BrowserCaptureFailure(
            "TASK24_BROWSER_CAPTURE_DISPOSITION_UNCERTAIN",
            "uncertain",
            "Browser evidence appeared before a safe retry",
            prior ? { cause: prior } : undefined,
          )
        }
        try {
          return await invoke(input.release, runner, outputRoot, tempRoot, token, request, capture.signal)
        } catch (cause) {
          const failure = classifyFailure(cause)
          if (failure.disposition !== "unstarted" || attempt === 1) throw failure
          prior = failure
        }
      }
      throw new BrowserCaptureFailure("TASK24_BROWSER_INTERNAL", "uncertain", "Browser retry loop failed")
    },
  }
  return Object.freeze(runtime)
}

async function invoke(
  release: BrowserRelease,
  runner: BrowserProcessRunner,
  outputRoot: string,
  tempRoot: string,
  grant: string,
  request: BrowserCaptureRequest,
  signal: AbortSignal,
): Promise<PublishedEvidence> {
  release.verify()
  let result: BrowserProcessResult
  try {
    result = await runner.execute({
      executable: release.nodeExecutable,
      argv: [release.helper],
      cwd: tempRoot,
      env: helperEnvironment(release, outputRoot, tempRoot, grant),
      stdin: canonicalJson(request) + "\n",
      timeoutMs: Math.min(180_000, request.timeoutMs + 15_000),
      signal,
    })
  } catch (cause) {
    throw classifyFailure(cause)
  }
  release.verify()
  if (result.truncated) {
    throw new BrowserCaptureFailure(
      "TASK24_BROWSER_HELPER_OUTPUT_LIMIT",
      result.started ? "uncertain" : "unstarted",
      "Browser helper output exceeded its limit",
    )
  }
  let response
  try {
    response = decodeBrowserResponseLine(result.stdout.trim(), request.requestID)
  } catch (cause) {
    throw new BrowserCaptureFailure(
      "TASK24_BROWSER_HELPER_RESPONSE_INVALID",
      result.started ? "uncertain" : "unstarted",
      `Browser helper returned malformed output: ${safeError(result.stderr)}`,
      { cause },
    )
  }
  if (!response.ok) {
    throw new BrowserCaptureFailure(response.error.code, response.disposition, response.error.message)
  }
  if (response.evidence.captureRootRelativePath !== request.outputRelativePath) {
    throw new BrowserCaptureFailure(
      "TASK24_BROWSER_HELPER_RESPONSE_INVALID",
      "uncertain",
      "Browser helper published evidence under an unexpected identity",
    )
  }
  return verifyPublishedCapture({
    outputRoot,
    relative: response.evidence.captureRootRelativePath,
    screenshotSha256: response.evidence.screenshotSha256,
    evidenceSha256: response.evidence.evidenceSha256,
    screenshotBytes: response.evidence.screenshotBytes,
  })
}

interface SpawnedProcess {
  readonly stdin: { write(value: string): unknown; flush?(): unknown; end(): unknown } | number | undefined
  readonly stdout: ReadableStream<Uint8Array> | number | undefined
  readonly stderr: ReadableStream<Uint8Array> | number | undefined
  readonly exited: Promise<number>
  readonly kill: () => unknown
}

type Spawn = (
  command: readonly string[],
  options: {
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly stdin: "pipe"
    readonly stdout: "pipe"
    readonly stderr: "pipe"
    readonly windowsHide: true
  },
) => SpawnedProcess

export function makeBrowserProcessRunner(spawn: Spawn): BrowserProcessRunner {
  const runner: BrowserProcessRunner = {
    execute: async (invocation) => {
      if (invocation.signal.aborted) throw invocation.signal.reason
      let child: SpawnedProcess
      try {
        child = spawn([invocation.executable, ...invocation.argv], {
          cwd: invocation.cwd,
          env: invocation.env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        })
      } catch (cause) {
        throw new BrowserCaptureFailure(
          "TASK24_BROWSER_HELPER_START_FAILED",
          "unstarted",
          "Browser helper could not be started",
          { cause },
        )
      }
      const { stdin, stdout, stderr } = child
      if (
        !stdin ||
        typeof stdin === "number" ||
        !stdout ||
        typeof stdout === "number" ||
        !stderr ||
        typeof stderr === "number"
      ) {
        child.kill()
        throw new BrowserCaptureFailure(
          "TASK24_BROWSER_HELPER_PIPE_INVALID",
          "uncertain",
          "Browser helper pipes failed",
        )
      }
      let timedOut = false
      let forced = false
      let forceTimer: ReturnType<typeof setTimeout> | undefined
      const cancel = () => {
        try {
          stdin.write('{"cancel":true}\n')
          void Promise.resolve(stdin.flush?.()).catch(() => undefined)
        } catch {
          // The child may already have closed stdin.
        }
        forceTimer ??= setTimeout(() => {
          forced = true
          child.kill()
        }, cancelGraceMs)
      }
      const onAbort = () => cancel()
      invocation.signal.addEventListener("abort", onAbort, { once: true })
      const timer = setTimeout(() => {
        timedOut = true
        cancel()
      }, invocation.timeoutMs)
      try {
        stdin.write(invocation.stdin)
        await Promise.resolve(stdin.flush?.())
        const [exit, out, error] = await Promise.all([
          child.exited,
          readStream(stdout, maxOutputBytes),
          readStream(stderr, maxErrorBytes),
        ])
        if (invocation.signal.aborted) throw invocation.signal.reason
        if (timedOut) {
          throw new BrowserCaptureFailure(
            "TASK24_BROWSER_HELPER_TIMEOUT",
            "uncertain",
            `Browser helper timed out: ${safeError(error.text)}`,
          )
        }
        return {
          started: true,
          exit,
          stdout: out.text,
          stderr: error.text,
          truncated: out.truncated || error.truncated || forced,
        }
      } finally {
        clearTimeout(timer)
        if (forceTimer) clearTimeout(forceTimer)
        invocation.signal.removeEventListener("abort", onAbort)
        try {
          stdin.end()
        } catch {
          // Process settlement is already known.
        }
      }
    },
  }
  return Object.freeze(runner)
}

function parseManifest(bytes: Uint8Array): BrowserReleaseManifest {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new TypeError("TASK24_BROWSER_MANIFEST_INVALID")
  }
  if (!isRecord(value)) throw new TypeError("TASK24_BROWSER_MANIFEST_INVALID")
  exactKeys(value, [
    "schemaVersion",
    "protocolVersion",
    "buildSha256",
    "nodeFile",
    "helperFile",
    "browserExecutableFile",
    "files",
  ])
  if (
    value.schemaVersion !== 1 ||
    value.protocolVersion !== BROWSER_PROTOCOL_VERSION ||
    typeof value.buildSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.buildSha256) ||
    !releaseLeaf(value.nodeFile) ||
    !releaseRelative(value.helperFile) ||
    !releaseRelative(value.browserExecutableFile) ||
    !Array.isArray(value.files) ||
    value.files.length < 3 ||
    value.files.length > 20_000
  ) {
    throw new TypeError("TASK24_BROWSER_MANIFEST_INVALID")
  }
  const files = value.files.map((entry) => decodeReleaseFile(entry))
  if (canonicalJson(files) !== canonicalJson([...files].toSorted((a, b) => a.path.localeCompare(b.path)))) {
    throw new TypeError("TASK24_BROWSER_MANIFEST_FILES_INVALID")
  }
  if (new Set(files.map((entry) => entry.path)).size !== files.length) {
    throw new TypeError("TASK24_BROWSER_MANIFEST_FILES_INVALID")
  }
  return Object.freeze({
    schemaVersion: 1,
    protocolVersion: 1,
    buildSha256: value.buildSha256,
    nodeFile: value.nodeFile,
    helperFile: value.helperFile,
    browserExecutableFile: value.browserExecutableFile,
    files: Object.freeze(files),
  })
}

function decodeReleaseFile(value: unknown): BrowserReleaseFile {
  if (!isRecord(value)) throw new TypeError("TASK24_BROWSER_MANIFEST_FILES_INVALID")
  exactKeys(value, ["path", "sha256", "bytes"])
  if (
    !releaseRelative(value.path) ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !nonnegativeInteger(value.bytes)
  ) {
    throw new TypeError("TASK24_BROWSER_MANIFEST_FILES_INVALID")
  }
  return Object.freeze({ path: value.path, sha256: value.sha256, bytes: value.bytes })
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function listReleaseFiles(root: string): BrowserReleaseFile[] {
  const result: BrowserReleaseFile[] = []
  const visit = (directory: string) => {
    for (const entry of fsSync.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join("/")
      if (entry.isSymbolicLink()) throw new TypeError("TASK24_BROWSER_RELEASE_FILES_INVALID")
      if (entry.isDirectory()) {
        if (fsSync.realpathSync.native(absolute) !== absolute)
          throw new TypeError("TASK24_BROWSER_RELEASE_FILES_INVALID")
        visit(absolute)
        continue
      }
      const stat = fsSync.lstatSync(absolute)
      if (!entry.isFile() || stat.nlink !== 1) throw new TypeError("TASK24_BROWSER_RELEASE_FILES_INVALID")
      result.push({ path: relative, sha256: sha256File(absolute), bytes: stat.size })
    }
  }
  visit(root)
  return result.toSorted((a, b) => a.path.localeCompare(b.path))
}

function helperEnvironment(
  release: BrowserRelease,
  outputRoot: string,
  tempRoot: string,
  grant: string,
): Readonly<Record<string, string>> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows"
  return Object.freeze({
    PATH: `${path.dirname(release.nodeExecutable)};${path.join(systemRoot, "System32")}`,
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    TEMP: tempRoot,
    TMP: tempRoot,
    PLAYWRIGHT_BROWSERS_PATH: release.root,
    NO_PROXY: "127.0.0.1,localhost",
    TASK24_BROWSER_GRANT: grant,
    TASK24_BROWSER_OUTPUT_ROOT: outputRoot,
    TASK24_BROWSER_EXECUTABLE: release.browserExecutable,
  })
}

function exactTaskTemp(value: string): string {
  const layout = Task24Root.ensure()
  return exactDirectory(layout.tmp, value, "TASK24_BROWSER_TEMP_ROOT_INVALID")
}

function exactDirectory(parent: string, value: string, code: string): string {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) throw new TypeError(code)
  const resolved = path.resolve(value)
  const relative = path.relative(path.resolve(parent), resolved)
  const stat = fsSync.lstatSync(resolved)
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fsSync.realpathSync.native(resolved) !== resolved
  ) {
    throw new TypeError(code)
  }
  return resolved
}

function fileIdentity(root: string, relative: string): string {
  if (!releaseRelative(relative) && relative !== manifestName)
    throw new TypeError("TASK24_BROWSER_RELEASE_FILES_INVALID")
  const value = path.join(root, ...relative.split("/"))
  const stat = fsSync.lstatSync(value, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || fsSync.realpathSync.native(value) !== value) {
    throw new TypeError("TASK24_BROWSER_RELEASE_FILES_INVALID")
  }
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.mtimeNs}:${stat.size}`
}

function releaseLeaf(value: unknown): value is string {
  return typeof value === "string" && value === path.basename(value) && releaseRelative(value)
}

function releaseRelative(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f\\:*?"<>|]/u.test(value) &&
    !value.includes("//") &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  )
}

function readBoundedFile(value: string, maximum: number, code: string): Uint8Array {
  const stat = fsSync.lstatSync(value)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum) {
    throw new TypeError(code)
  }
  return fsSync.readFileSync(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (canonicalJson(Object.keys(value).toSorted()) !== canonicalJson([...expected].toSorted())) {
    throw new TypeError("TASK24_BROWSER_MANIFEST_INVALID")
  }
}

function sha256File(value: string): string {
  return createHash("sha256").update(fsSync.readFileSync(value)).digest("hex")
}

async function readStream(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let retained = 0
  let truncated = false
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const remaining = Math.max(0, limit - retained)
      if (next.value.byteLength > remaining) truncated = true
      if (remaining > 0) {
        const chunk = next.value.subarray(0, remaining)
        chunks.push(chunk)
        retained += chunk.byteLength
      }
    }
  } finally {
    reader.releaseLock()
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated }
}

function safeError(value: string): string {
  const safe = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, 2048)
  return safe === "" ? "unknown failure" : safe
}

function classifyFailure(cause: unknown): BrowserCaptureFailure {
  if (cause instanceof BrowserCaptureFailure) return cause
  return new BrowserCaptureFailure(
    "TASK24_BROWSER_CAPTURE_DISPOSITION_UNCERTAIN",
    "uncertain",
    "Browser capture disposition is uncertain",
    { cause },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
