import path from "node:path"
import { canonicalJson } from "../../campaign/canonical"
import type { FileIdentity } from "../contracts"
import { canonicalDesktopPath } from "./compatibility"
import { desktopProbeEnvironment, revalidateDesktopProbeEnvironment, readDesktopProbeRootProof } from "./probe-root"
import { desktopProbeWorker, desktopProbeWorkerCode } from "./probe-worker"
import { desktopProbeSupervisor, readDesktopProbeImage } from "./probe-image"
export { desktopProbeEnvironment } from "./probe-root"

/** A bounded transport, not a native provenance/launch factory. Callers fix the executable and arguments. */
export async function runDesktopProbe(input: {
  exe: string
  image?: FileIdentity
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
  const image = Object.freeze({ ...(input.image ?? (await readDesktopProbeImage(input.exe))) })
  if (image.path !== input.exe || canonicalJson(image) !== canonicalJson(await readDesktopProbeImage(input.exe)))
    throw new TypeError("TASK24_DESKTOP_PROBE_IMAGE_DRIFT")
  const supervisor = await readDesktopProbeImage(desktopProbeSupervisor)
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
  await revalidateDesktopProbeEnvironment(env)
  const child = Bun.spawn(
    [
      desktopProbeSupervisor,
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(desktopProbeWorker, "utf16le").toString("base64"),
    ],
    {
      cwd: env.TEMP,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const readers = [child.stdout.getReader(), child.stderr.getReader()]
  let rejectLimit: (error: Error) => void = () => {}
  const limit = new Promise<never>((_, reject) => {
    rejectLimit = reject
  })
  const stop = (code: string) => {
    child.kill()
    for (const reader of readers) void reader.cancel().catch(() => undefined)
    rejectLimit(new TypeError(code))
  }
  const abort = () => stop("TASK24_DESKTOP_CANCELLED")
  const timer = setTimeout(() => stop("TASK24_DESKTOP_DEADLINE"), input.timeoutMs)
  input.signal?.addEventListener("abort", abort, { once: true })
  const read = async (reader: ReadableStreamDefaultReader<Uint8Array>, maximum: number) => {
    const chunks: Uint8Array[] = []
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
  const stderr = read(readers[1]!, input.stderrLimit)
  const operation = async () => {
    child.stdin.write(
      JSON.stringify({
        exe: input.exe,
        supervisor: desktopProbeSupervisor,
        argv: input.argv,
        cwd: env.TEMP,
        env: { ...env, ...input.env },
        input: Buffer.from(input.input ?? "").toString("base64"),
        timeoutMs: input.timeoutMs,
        workerSource: desktopProbeWorkerCode,
        tempIdentity: readDesktopProbeRootProof(env).identity,
        tempOwnerSha256: readDesktopProbeRootProof(env).ownerSha256,
      }) + "\n",
    )
    await child.stdin.flush()
    const header: Uint8Array[] = []
    let length = 0
    while (true) {
      const part = await readers[0]!.read()
      if (part.done) throw new TypeError("TASK24_DESKTOP_PROBE_CONTAINMENT_UNAVAILABLE")
      header.push(part.value)
      length += part.value.byteLength
      if (length > 128) throw new TypeError("TASK24_DESKTOP_PROBE_PROTOCOL")
      const value = Buffer.concat(header).toString("utf8")
      if (!value.endsWith("\n")) continue
      if (value.trim() !== "TASK24_PROBE_PINNED") throw new TypeError("TASK24_DESKTOP_PROBE_PROTOCOL")
      break
    }
    // The worker now holds all image/cwd ancestors. Compare original snapshots before granting it execution.
    await revalidateDesktopProbeEnvironment(env)
    if (
      canonicalJson(await readDesktopProbeImage(input.exe)) !== canonicalJson(image) ||
      canonicalJson(await readDesktopProbeImage(desktopProbeSupervisor)) !== canonicalJson(supervisor)
    )
      throw new TypeError("TASK24_DESKTOP_PROBE_IMAGE_DRIFT")
    if (input.signal?.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
    child.stdin.write("continue\n")
    child.stdin.end()
    return Promise.all([read(readers[0]!, input.stdoutLimit), stderr, child.exited])
  }
  const output = operation()
  void output.catch(() => undefined)
  void stderr.catch(() => undefined)
  try {
    const [stdout, stderr, exitCode] = await Promise.race([output, limit])
    if (input.signal?.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
    if (exitCode === 248) throw new TypeError("TASK24_DESKTOP_DEADLINE")
    if (exitCode === 249) throw new TypeError("TASK24_DESKTOP_PROBE_CONTAINMENT_UNAVAILABLE")
    return { stdout, stderr, exitCode }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", abort)
    child.kill()
    for (const reader of readers) void reader.cancel().catch(() => undefined)
    // Neither inherited pipes nor a failed helper may extend cancellation indefinitely.
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled([child.exited, output, stderr]),
      new Promise((resolve) => {
        cleanupTimer = setTimeout(resolve, 1000)
      }),
    ])
    clearTimeout(cleanupTimer)
    for (const reader of readers) {
      try {
        reader.releaseLock()
      } catch {}
    }
  }
}
