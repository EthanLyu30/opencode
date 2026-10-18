import path from "node:path"
import { directoryIdentity } from "../storage"
import { canonicalDesktopPath } from "./compatibility"

export async function desktopProbeEnvironment() {
  const temp = canonicalDesktopPath(process.env.TEMP ?? "")
  await directoryIdentity(temp)
  return {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    PATH: "C:\\Windows\\System32",
    HOME: temp,
    USERPROFILE: temp,
    APPDATA: temp,
    LOCALAPPDATA: temp,
    TEMP: temp,
    TMP: temp,
    PSModuleAnalysisCachePath: "NUL",
    NODE_DISABLE_COMPILE_CACHE: "1",
    BUN_INSTALL_CACHE_DIR: temp,
  }
}

/** A bounded transport, not a native provenance/launch factory. Callers fix the executable and arguments. */
export async function runDesktopProbe(input: {
  exe: string
  argv: readonly string[]
  input?: string
  timeoutMs: number
  stdoutLimit: number
  stderrLimit: number
  signal?: AbortSignal
  env?: Readonly<Record<string, string>>
}) {
  if (input.signal?.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
  canonicalDesktopPath(input.exe, /^[cC]:/.test(input.exe) ? "C" : "D")
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 45000 ||
    !Number.isInteger(input.stdoutLimit) ||
    input.stdoutLimit < 1 ||
    input.stdoutLimit > 1048576 ||
    !Number.isInteger(input.stderrLimit) ||
    input.stderrLimit < 1 ||
    input.stderrLimit > 65536 ||
    Buffer.byteLength(input.input ?? "") > 1048576
  )
    throw new TypeError("TASK24_DESKTOP_PROBE_OPTIONS")
  const env = await desktopProbeEnvironment()
  const allowed = new Set([
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_TERMINAL_PROMPT",
    "DOCKER_CONFIG",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "BUILDX_BUILDER",
    "BUILDKIT_HOST",
  ])
  if (Object.keys(input.env ?? {}).some((key) => !allowed.has(key))) throw new TypeError("TASK24_DESKTOP_PROBE_ENV")
  if (input.env?.DOCKER_CONFIG && !canonicalDesktopPath(input.env.DOCKER_CONFIG).startsWith(env.TEMP + path.sep))
    throw new TypeError("TASK24_DESKTOP_PROBE_ENV")
  if (input.signal?.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
  const child = Bun.spawn([input.exe, ...input.argv], {
    cwd: env.TEMP,
    env: { ...env, ...input.env },
    stdin: input.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  let timedOut = false
  const abort = () => child.kill()
  const timer = setTimeout(() => {
    timedOut = true
    abort()
  }, input.timeoutMs)
  input.signal?.addEventListener("abort", abort, { once: true })
  const read = async (stream: ReadableStream<Uint8Array>, maximum: number) => {
    const reader = stream.getReader(),
      chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) return Buffer.concat(chunks)
        size += next.value.byteLength
        if (size > maximum) throw new TypeError("TASK24_DESKTOP_PROBE_LIMIT")
        chunks.push(next.value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  const output = Promise.all([
    read(child.stdout, input.stdoutLimit),
    read(child.stderr, input.stderrLimit),
    child.exited,
  ])
  try {
    if (typeof child.stdin !== "number" && child.stdin) {
      child.stdin.write(input.input ?? "")
      child.stdin.end()
    }
    const [stdout, stderr, exitCode] = await output
    if (input.signal?.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
    if (timedOut) throw new TypeError("TASK24_DESKTOP_DEADLINE")
    return { stdout, stderr, exitCode }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", abort)
    child.kill()
    await child.exited
    // Attach a handler even if writing the small input stream failed before awaiting output.
    await output.catch(() => undefined)
  }
}
