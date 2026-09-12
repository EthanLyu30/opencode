import fs from "node:fs/promises"
import path from "node:path"
import { sha256File } from "../hash"
import { Task24Root } from "../root"

export type ProcessClassification = "exited" | "timeout" | "cancelled" | "lease_loss" | "signal"

export interface ProcessResult {
  readonly classification: ProcessClassification
  readonly pid: number
  readonly startedAt: string
  readonly executableSha256: string
  readonly exitCode: number | null
  readonly durationMs: number
  readonly stdoutBytes: number
  readonly stdoutCapturedBytes: number
  readonly stdoutTruncated: boolean
  readonly stderrBytes: number
  readonly stderrCapturedBytes: number
  readonly stderrTruncated: boolean
}

export async function superviseProcess(input: {
  readonly executable: string
  readonly expectedExecutableSha256: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly stdoutFile: string
  readonly stderrFile: string
  readonly maximumCaptureBytes: number
  readonly maximumDurationMs: number
  readonly signal?: AbortSignal
  readonly cancellationClass?: "cancelled" | "lease_loss"
}): Promise<ProcessResult> {
  validate(input)
  const executableSha256 = await sha256File(input.executable)
  if (executableSha256 !== input.expectedExecutableSha256) throw new TypeError("TASK24_PROCESS_BINARY_HASH_MISMATCH")
  const stdout = await fs.open(input.stdoutFile, "wx")
  const stderr = await fs.open(input.stderrFile, "wx").catch(async (cause) => {
    await stdout.close()
    throw cause
  })
  const started = performance.now()
  const startedAt = new Date().toISOString()
  const child = Bun.spawn([input.executable, ...input.args], {
    cwd: input.cwd,
    env: input.environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdoutDrain = drain(child.stdout, stdout, input.maximumCaptureBytes)
  const stderrDrain = drain(child.stderr, stderr, input.maximumCaptureBytes)
  let classification: ProcessClassification = "exited"
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const termination = new Promise<ProcessClassification>((resolve) => {
    timer = setTimeout(() => resolve("timeout"), input.maximumDurationMs)
    onAbort = () => resolve(input.cancellationClass ?? "cancelled")
    input.signal?.addEventListener("abort", onAbort, { once: true })
    if (input.signal?.aborted) onAbort()
  })
  try {
    const outcome = await Promise.race([
      child.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
      termination.then((kind) => ({ kind })),
    ])
    if (outcome.kind !== "exit") {
      classification = outcome.kind
      await terminateTree(child)
    }
    const exitCode = await child.exited
    if (classification === "exited" && exitCode < 0) classification = "signal"
    const [stdoutResult, stderrResult] = await Promise.all([stdoutDrain, stderrDrain])
    return Object.freeze({
      classification,
      pid: child.pid,
      startedAt,
      executableSha256,
      exitCode,
      durationMs: Math.ceil(performance.now() - started),
      stdoutBytes: stdoutResult.total,
      stdoutCapturedBytes: stdoutResult.captured,
      stdoutTruncated: stdoutResult.total > stdoutResult.captured,
      stderrBytes: stderrResult.total,
      stderrCapturedBytes: stderrResult.captured,
      stderrTruncated: stderrResult.total > stderrResult.captured,
    })
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) input.signal?.removeEventListener("abort", onAbort)
    await Promise.allSettled([stdout.close(), stderr.close()])
  }
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  file: Awaited<ReturnType<typeof fs.open>>,
  limit: number,
): Promise<{ readonly total: number; readonly captured: number }> {
  let total = 0
  let captured = 0
  const reader = stream.getReader()
  while (true) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    const remaining = limit - captured
    if (remaining <= 0) continue
    const bytes = next.value.subarray(0, remaining)
    await file.write(bytes)
    captured += bytes.byteLength
  }
  return { total, captured }
}

async function terminateTree(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe")
    const killer = Bun.spawn([taskkill, "/PID", String(child.pid), "/T", "/F"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    await killer.exited
    return
  }
  child.kill("SIGTERM")
  const graceful = await Promise.race([child.exited.then(() => true), delay(1_000).then(() => false)])
  if (!graceful) child.kill("SIGKILL")
}

function validate(input: {
  readonly executable: string
  readonly expectedExecutableSha256: string
  readonly cwd: string
  readonly stdoutFile: string
  readonly stderrFile: string
  readonly maximumCaptureBytes: number
  readonly maximumDurationMs: number
}): void {
  for (const value of [input.executable, input.cwd, input.stdoutFile, input.stderrFile]) {
    if (!path.isAbsolute(value)) throw new TypeError("TASK24_PROCESS_PATH_INVALID")
  }
  if (
    path.parse(input.executable).root.toLowerCase() !== "d:\\" ||
    path.parse(input.cwd).root.toLowerCase() !== "d:\\"
  ) {
    throw new TypeError("TASK24_PROCESS_PATH_OUTSIDE_D")
  }
  if (!/^[a-f0-9]{64}$/.test(input.expectedExecutableSha256)) throw new TypeError("TASK24_PROCESS_BINARY_HASH_INVALID")
  const layout = Task24Root.ensure()
  const owned = [layout.workspaces, layout.tmp, layout.runs].map((root) => path.resolve(root) + path.sep)
  for (const file of [input.stdoutFile, input.stderrFile]) {
    if (path.parse(file).root.toLowerCase() !== "d:\\") throw new TypeError("TASK24_PROCESS_OUTPUT_OUTSIDE_D")
    if (!owned.some((root) => path.resolve(file).startsWith(root))) throw new TypeError("TASK24_PROCESS_OUTPUT_UNOWNED")
  }
  if (
    !Number.isSafeInteger(input.maximumCaptureBytes) ||
    input.maximumCaptureBytes <= 0 ||
    !Number.isSafeInteger(input.maximumDurationMs) ||
    input.maximumDurationMs <= 0
  ) {
    throw new TypeError("TASK24_PROCESS_LIMIT_INVALID")
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
