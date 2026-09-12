export * as PlaywrightNodeRuntime from "./playwright-node-runtime"

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const PROTOCOL_VERSION = 1
const MANIFEST_NAME = "opencode-playwright-runtime.manifest.json"
const MAX_MANIFEST_BYTES = 16 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_OUTPUT_BYTES = 12 * 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024
const CANCEL_GRACE_MS = 2_000

export interface CaptureInput {
  readonly browserExecutablePath: string
  readonly tempRoot: string
  readonly browserRoot: string
  readonly url: string
  readonly viewport: { readonly width: number; readonly height: number }
  readonly readySelector: string
  readonly allowedOrigins: readonly string[]
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

export interface Invocation {
  readonly executable: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly stdin: string
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

export interface Result {
  readonly exit: number
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
}

export interface Runner {
  readonly execute: (input: Invocation) => Promise<Result>
}

interface SpawnedProcess {
  readonly stdin:
    | {
        readonly write: (value: string | Uint8Array) => unknown
        readonly flush?: () => unknown
        readonly end: () => unknown
      }
    | number
    | undefined
  readonly stdout: ReadableStream<Uint8Array> | number | undefined
  readonly stderr: ReadableStream<Uint8Array> | number | undefined
  readonly exited: Promise<number>
  readonly kill: () => unknown
}

export type Spawn = (
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

export interface Release {
  readonly nodeExecutablePath: string
  readonly helperPath: string
  readonly verify: () => void
}

export const productionRunner: Runner = makeRunner((command, options) => Bun.spawn([...command], options))

export function loadRelease(browserRoot: string): Release {
  const manifestPath = path.join(browserRoot, MANIFEST_NAME)
  const manifestIdentity = exactFileIdentity(browserRoot, manifestPath, "Playwright helper manifest")
  const bytes = fs.readFileSync(manifestPath)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new TypeError("Playwright helper manifest size is invalid")
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new TypeError("Playwright helper manifest is invalid")
  }
  if (!isRecord(value)) throw new TypeError("Playwright helper manifest is invalid")
  exactKeys(value, [
    "helperFile",
    "helperSha256",
    "nodeFile",
    "nodeSha256",
    "protocolVersion",
    "schemaVersion",
    "sourceSha256",
  ])
  if (value.schemaVersion !== 1 || value.protocolVersion !== PROTOCOL_VERSION) {
    throw new TypeError("Playwright helper manifest version is unsupported")
  }
  const helperFile = exactLeaf(value.helperFile, "helper")
  const nodeFile = exactLeaf(value.nodeFile, "node")
  const helperSha256 = exactSha256(value.helperSha256, "helper")
  const nodeSha256 = exactSha256(value.nodeSha256, "node")
  exactSha256(value.sourceSha256, "source")
  const helperPath = path.join(browserRoot, helperFile)
  const nodeExecutablePath = path.join(browserRoot, nodeFile)
  const helperIdentity = exactFileIdentity(browserRoot, helperPath, "Playwright helper")
  const nodeIdentity = exactFileIdentity(browserRoot, nodeExecutablePath, "Playwright Node runtime")
  if (sha256(helperPath) !== helperSha256 || sha256(nodeExecutablePath) !== nodeSha256) {
    throw new TypeError("Playwright helper release hash is invalid")
  }
  const verify = () => {
    if (
      exactFileIdentity(browserRoot, manifestPath, "Playwright helper manifest") !== manifestIdentity ||
      exactFileIdentity(browserRoot, helperPath, "Playwright helper") !== helperIdentity ||
      exactFileIdentity(browserRoot, nodeExecutablePath, "Playwright Node runtime") !== nodeIdentity
    ) {
      throw new TypeError("Playwright helper release identity changed")
    }
  }
  verify()
  return Object.freeze({ nodeExecutablePath, helperPath, verify })
}

export async function capture(
  release: Release,
  input: CaptureInput,
  runner: Runner = productionRunner,
): Promise<Uint8Array> {
  release.verify()
  const request = JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    browserExecutablePath: input.browserExecutablePath,
    tempRoot: input.tempRoot,
    url: input.url,
    viewport: input.viewport,
    readySelector: input.readySelector,
    allowedOrigins: input.allowedOrigins,
    timeoutMs: input.timeoutMs,
  })
  const result = await runner.execute({
    executable: release.nodeExecutablePath,
    argv: [release.helperPath],
    cwd: input.tempRoot,
    env: helperEnvironment(release.nodeExecutablePath, input.browserRoot, input.tempRoot),
    stdin: `${request}\n`,
    timeoutMs: Math.min(180_000, input.timeoutMs * 8 + 10_000),
    signal: input.signal,
  })
  release.verify()
  if (result.truncated) throw new Error("Playwright helper output exceeded its limit")
  if (result.exit !== 0) throw new Error(`Playwright helper failed: ${safeError(result.stderr)}`)
  let value: unknown
  try {
    value = JSON.parse(result.stdout.trim())
  } catch {
    throw new Error("Playwright helper returned invalid JSON")
  }
  if (!isRecord(value)) throw new Error("Playwright helper returned an invalid response")
  exactKeys(value, ["pngBase64", "protocolVersion"])
  if (value.protocolVersion !== PROTOCOL_VERSION || typeof value.pngBase64 !== "string") {
    throw new Error("Playwright helper returned an incompatible response")
  }
  const bytes = Buffer.from(value.pngBase64, "base64")
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES || bytes.toString("base64") !== value.pngBase64) {
    throw new Error("Playwright helper returned invalid image bytes")
  }
  release.verify()
  return Uint8Array.from(bytes)
}

export function makeRunner(spawn: Spawn): Runner {
  return Object.freeze({
    execute: async (input: Invocation) => {
      if (input.signal.aborted) throw input.signal.reason
      let child: SpawnedProcess
      try {
        child = spawn([input.executable, ...input.argv], {
          cwd: input.cwd,
          env: input.env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        })
      } catch (cause) {
        throw new Error("Playwright helper could not be started", { cause })
      }
      const stdin = child.stdin
      const stdout = child.stdout
      const stderr = child.stderr
      if (
        stdin === undefined ||
        typeof stdin === "number" ||
        stdout === undefined ||
        typeof stdout === "number" ||
        stderr === undefined ||
        typeof stderr === "number"
      ) {
        child.kill()
        throw new Error("Playwright helper pipes are unavailable")
      }
      let cancelled = false
      let timedOut = false
      let forced = false
      let forceTimer: ReturnType<typeof setTimeout> | undefined
      const requestCancellation = () => {
        if (cancelled) return
        cancelled = true
        try {
          stdin.write('{"cancel":true}\n')
          void Promise.resolve(stdin.flush?.()).catch(() => undefined)
        } catch {
          // The helper may already have closed stdin. The bounded force timer remains authoritative.
        }
        forceTimer = setTimeout(() => {
          forced = true
          child.kill()
        }, CANCEL_GRACE_MS)
      }
      const onAbort = () => requestCancellation()
      input.signal.addEventListener("abort", onAbort, { once: true })
      if (input.signal.aborted) requestCancellation()
      const timer = setTimeout(() => {
        timedOut = true
        requestCancellation()
      }, input.timeoutMs)
      try {
        if (!cancelled) {
          stdin.write(input.stdin)
          await Promise.resolve(stdin.flush?.())
        }
        const [exit, capturedStdout, capturedStderr] = await Promise.all([
          child.exited,
          readBounded(stdout, MAX_OUTPUT_BYTES),
          readBounded(stderr, MAX_ERROR_BYTES),
        ])
        if (input.signal.aborted) throw input.signal.reason
        if (timedOut) throw new Error(`Playwright helper timed out: ${safeError(capturedStderr.text)}`)
        return {
          exit,
          stdout: capturedStdout.text,
          stderr: capturedStderr.text,
          truncated: capturedStdout.truncated || capturedStderr.truncated || forced,
        }
      } finally {
        clearTimeout(timer)
        if (forceTimer !== undefined) clearTimeout(forceTimer)
        input.signal.removeEventListener("abort", onAbort)
        try {
          stdin.end()
        } catch {
          // Process settlement is already known.
        }
      }
    },
  })
}

function helperEnvironment(nodeExecutablePath: string, browserRoot: string, tempRoot: string) {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows"
  const values: Record<string, string> = {
    PATH: `${path.dirname(nodeExecutablePath)};${path.join(systemRoot, "System32")}`,
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    TEMP: tempRoot,
    TMP: tempRoot,
    PLAYWRIGHT_BROWSERS_PATH: browserRoot,
    NO_PROXY: "127.0.0.1,localhost",
  }
  const comspec = process.env.ComSpec ?? process.env.COMSPEC
  if (comspec !== undefined) values.ComSpec = comspec
  return Object.freeze(values)
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number) {
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
  const bytes = new Uint8Array(retained)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(bytes), truncated }
}

function exactFileIdentity(root: string, value: string, name: string): string {
  if (!path.isAbsolute(value)) throw new TypeError(`${name} must be absolute`)
  const lexical = path.resolve(value)
  const canonical = fs.realpathSync.native(lexical)
  const relative = path.relative(root, canonical)
  const stat = fs.lstatSync(lexical, { bigint: true })
  if (
    lexical !== value ||
    canonical !== lexical ||
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n
  ) {
    throw new TypeError(`${name} must be one exact file inside the browser runtime root`)
  }
  return `${canonical}:${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.mtimeNs}:${stat.size}`
}

function exactLeaf(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    value !== path.basename(value) ||
    value === "." ||
    value === ".." ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`Playwright ${name} release filename is invalid`)
  }
  return value
}

function exactSha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`Playwright ${name} release hash is invalid`)
  }
  return value
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("Playwright helper payload contains unexpected fields")
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sha256(value: string) {
  return createHash("sha256").update(fs.readFileSync(value)).digest("hex")
}

function safeError(value: string) {
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, 4096)
  return sanitized === "" ? "unknown failure" : sanitized
}
