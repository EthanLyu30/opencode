export * as Docker from "./docker"

export interface Invocation {
  readonly executable: string
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly stdin?: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly signal?: AbortSignal
}

export interface Result {
  readonly exit: number
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
}

export interface Engine {
  readonly execute: (input: Invocation) => Promise<Result>
}

export class Unavailable extends Error {
  readonly _tag = "Docker.Unavailable"
}

export class Cancelled extends Error {
  readonly _tag = "Docker.Cancelled"
}

export class Timeout extends Error {
  readonly _tag = "Docker.Timeout"
}

export const production: Engine = Object.freeze({ execute })

async function execute(input: Invocation): Promise<Result> {
  if (input.signal?.aborted) throw new Cancelled("Docker invocation was cancelled")
  let process: ReturnType<typeof Bun.spawn>
  try {
    process = Bun.spawn([input.executable, ...input.argv], {
      env: { ...input.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
  } catch (cause) {
    throw new Unavailable("Docker CLI could not be started", { cause })
  }
  const stdin = process.stdin
  const stdoutStream = process.stdout
  const stderrStream = process.stderr
  if (
    stdin === undefined ||
    typeof stdin === "number" ||
    stdoutStream === undefined ||
    typeof stdoutStream === "number" ||
    stderrStream === undefined ||
    typeof stderrStream === "number"
  ) {
    process.kill()
    throw new Unavailable("Docker CLI pipes are unavailable")
  }

  const state = { cancelled: false, timedOut: false }
  const abort = () => {
    state.cancelled = true
    process.kill()
  }
  input.signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => {
    state.timedOut = true
    process.kill()
  }, input.timeoutMs)

  try {
    if (input.stdin !== undefined) stdin.write(input.stdin)
    stdin.end()
    const budget = { remaining: input.maxOutputBytes, truncated: false }
    const [exit, stdout, stderr] = await Promise.all([
      process.exited,
      readBounded(stdoutStream, budget),
      readBounded(stderrStream, budget),
    ])
    if (state.cancelled || input.signal?.aborted) throw new Cancelled("Docker invocation was cancelled")
    if (state.timedOut) throw new Timeout("Docker invocation timed out")
    return {
      exit,
      stdout,
      stderr,
      truncated: budget.truncated,
    }
  } catch (cause) {
    if (cause instanceof Cancelled || cause instanceof Timeout) throw cause
    throw new Unavailable("Docker CLI failed before settlement", { cause })
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", abort)
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, budget: { remaining: number; truncated: boolean }) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let retained = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    const remaining = budget.remaining
    if (next.value.byteLength > remaining) budget.truncated = true
    if (remaining === 0) continue
    const chunk = next.value.subarray(0, remaining)
    chunks.push(chunk)
    retained += chunk.byteLength
    budget.remaining -= chunk.byteLength
  }
  const bytes = new Uint8Array(retained)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}
